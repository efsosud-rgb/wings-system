import { shapeOf } from '../media/kairogen-adapter.js';
import {
  googleEmail,
  googlePhone,
  metaEmail,
  metaPhone,
  sha256Hex,
} from './crm-conversions-hash.js';

/**
 * The two doors of a CRM stage event (docs/ads/fechar-ciclo.md): Meta's
 * Conversions API (CRM integration, "Conversion Leads") and Google's Data
 * Manager API. One event per request, so one bad event never takes others
 * with it (Meta drops the whole batch for one stale event; Google fails the
 * whole request). Formats from the public docs read on 02/11/2026, not yet
 * checked against the live platforms: "não verificado" until the first test.
 *
 * Tokens travel in a header only. Errors become codes (the HTTP status and the
 * platform's code), never the platform's message, which can quote what was sent.
 */

export const META_GRAPH = 'https://graph.facebook.com/v26.0';
export const GOOGLE_INGEST = 'https://datamanager.googleapis.com/v1/events:ingest';
const GOOGLE_TOKEN = 'https://oauth2.googleapis.com/token';
const TIMEOUT_MS = 15_000;
/** Meta's `lead_event_source`: the CRM the events come from. */
const CRM_NAME = 'Wings System';

export type IdentifierKind = 'meta_lead_id' | 'click_id' | 'hashed';

/** What the lead offers to match it; e-mail and phone are read at send time and live only here. */
export interface MatchKeys {
  leadId: string;
  metaLeadId: string | null;
  fbc: string | null;
  fbp: string | null;
  gclid: string | null;
  gbraid: string | null;
  wbraid: string | null;
  email: string | null;
  phone: string | null;
}

export interface StageEvent {
  /** The outbox row's id: Meta's `event_id`, Google's `transactionId`. */
  sendId: string;
  eventName: string;
  eventTime: Date;
}

export interface BuiltEvent {
  identifierKind: IdentifierKind;
  /** Names of the user fields, never values. */
  fields: string[];
  body: string;
  /**
   * Sent to Google with `validateOnly`: a 200 records nothing. Meta's test event code is not one:
   * "Events sent with test_event_code are not dropped" (they count), so it is a real send.
   */
  rehearsal: boolean;
}

export type SendOutcome =
  | { kind: 'sent'; requestId: string | null; shape: unknown }
  /** The platform did not take it and a new try is safe. */
  | { kind: 'retry'; code: string; shape?: unknown }
  /** Refused, or it may have arrived and a new try could count it twice. */
  | { kind: 'failed'; code: string; shape?: unknown }
  /** The token or its permission was refused: nothing of the batch was taken, it all waits. */
  | { kind: 'auth'; code: string; shape?: unknown };

/** Meta's lead id is digits only; anything else is not used (it would also break the JSON below). */
const META_LEAD_ID = /^\d{5,25}$/;

/**
 * Meta. With the instant form's lead id, the CRM integration's event (the id unhashed, as a
 * number). Without it, the browser ids, and e-mail and phone hashed only when `hashed` is on.
 * Null when nothing matches the lead.
 */
export function metaEventOf(
  event: StageEvent,
  keys: MatchKeys,
  options: { hashed: boolean; testEventCode: string | null },
): BuiltEvent | null {
  const userData: Record<string, unknown> = {};
  let identifierKind: IdentifierKind;
  const metaLeadId = keys.metaLeadId && META_LEAD_ID.test(keys.metaLeadId) ? keys.metaLeadId : null;
  if (metaLeadId) {
    userData.lead_id = metaLeadId;
    identifierKind = 'meta_lead_id';
  } else {
    if (keys.fbc) userData.fbc = keys.fbc;
    if (keys.fbp) userData.fbp = keys.fbp;
    identifierKind = 'click_id';
    if (options.hashed) {
      const em = metaEmail(keys.email);
      const ph = metaPhone(keys.phone);
      if (em) userData.em = [sha256Hex(em)];
      if (ph) userData.ph = [sha256Hex(ph)];
      if (em || ph) userData.external_id = [sha256Hex(keys.leadId)];
      if (!keys.fbc && !keys.fbp) identifierKind = 'hashed';
    }
    if (!userData.fbc && !userData.fbp && !userData.em && !userData.ph) return null;
  }
  const body = {
    data: [
      {
        event_name: event.eventName,
        event_time: Math.floor(event.eventTime.getTime() / 1000),
        event_id: event.sendId,
        action_source: 'system_generated',
        user_data: userData,
        custom_data: { event_source: 'crm', lead_event_source: CRM_NAME },
      },
    ],
    ...(options.testEventCode ? { test_event_code: options.testEventCode } : {}),
  };
  let json = JSON.stringify(body);
  // Meta's lead id is an integer of 15-17 digits, past what a JS number holds exactly.
  if (metaLeadId) {
    json = json.replace(`"lead_id":"${metaLeadId}"`, `"lead_id":${metaLeadId}`);
  }
  return {
    identifierKind,
    fields: Object.keys(userData),
    body: json,
    rehearsal: false,
  };
}

/**
 * Google. The click ids whenever there are any; e-mail and phone hashed (hex) only when `hashed` is
 * on. Null when nothing matches the lead.
 */
export function googleEventOf(
  event: StageEvent,
  keys: MatchKeys,
  destination: { customerId: string; conversionActionId: string },
  options: { hashed: boolean; validateOnly: boolean },
): BuiltEvent | null {
  const adIdentifiers: Record<string, string> = {};
  if (keys.gclid) adIdentifiers.gclid = keys.gclid;
  if (keys.gbraid) adIdentifiers.gbraid = keys.gbraid;
  if (keys.wbraid) adIdentifiers.wbraid = keys.wbraid;
  const userIdentifiers: Record<string, string>[] = [];
  if (options.hashed) {
    const email = googleEmail(keys.email);
    const phone = googlePhone(keys.phone);
    if (email) userIdentifiers.push({ emailAddress: sha256Hex(email) });
    if (phone) userIdentifiers.push({ phoneNumber: sha256Hex(phone) });
  }
  const clicks = Object.keys(adIdentifiers);
  if (clicks.length === 0 && userIdentifiers.length === 0) return null;
  const body = {
    destinations: [
      {
        operatingAccount: {
          accountType: 'GOOGLE_ADS',
          accountId: destination.customerId.replace(/\D/g, ''),
        },
        productDestinationId: destination.conversionActionId,
      },
    ],
    encoding: 'HEX',
    validateOnly: options.validateOnly,
    events: [
      {
        transactionId: event.sendId,
        eventTimestamp: event.eventTime.toISOString(),
        // shortcut: the docs name no value for a CRM stage; OTHER until Google's diagnostics say otherwise.
        eventSource: 'OTHER',
        ...(clicks.length ? { adIdentifiers } : {}),
        ...(userIdentifiers.length ? { userData: { userIdentifiers } } : {}),
      },
    ],
  };
  return {
    identifierKind: clicks.length ? 'click_id' : 'hashed',
    fields: [...clicks, ...userIdentifiers.flatMap((id) => Object.keys(id))],
    body: JSON.stringify(body),
    rehearsal: options.validateOnly,
  };
}

/** Network errors that prove nothing left this machine: a new try cannot count twice. */
const NEVER_SENT = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ENETUNREACH']);

function thrownOutcome(error: unknown, retryWhenUnsure: boolean): SendOutcome {
  const name = error instanceof Error ? error.name : '';
  const cause = (error as { cause?: { code?: unknown } } | null)?.cause?.code;
  if (typeof cause === 'string' && NEVER_SENT.has(cause))
    return { kind: 'retry', code: 'unreachable' };
  const code = name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'connection_lost';
  return retryWhenUnsure ? { kind: 'retry', code } : { kind: 'failed', code };
}

/** Meta answers an expired or revoked token with error code 190 (OAuthException), often as a 400. */
function answeredOutcome(status: number, code: string, shape: unknown): SendOutcome {
  const full = code ? `http_${status}:${code}` : `http_${status}`;
  if (status === 401 || status === 403 || code === '190' || code.startsWith('190.')) {
    return { kind: 'auth', code: full, shape };
  }
  return status === 429 || status >= 500
    ? { kind: 'retry', code: full, shape }
    : { kind: 'failed', code: full, shape };
}

/**
 * Meta does not document that a repeated server event with the same `event_id` is dropped, so a
 * call that may have arrived (timeout, connection lost midway) is not tried again: it is
 * `failed` with its code, for a person to check in the Events Manager.
 */
export async function sendMetaEvent(
  fetchImpl: typeof fetch,
  config: { datasetId: string; token: string },
  built: BuiltEvent,
): Promise<SendOutcome> {
  let response: Response;
  try {
    response = await fetchImpl(`${META_GRAPH}/${config.datasetId}/events`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${config.token}`,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: built.body,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    return thrownOutcome(error, false);
  }
  const answer = (await response.json().catch(() => null)) as {
    fbtrace_id?: unknown;
    error?: { code?: unknown; error_subcode?: unknown; fbtrace_id?: unknown };
  } | null;
  const shape = shapeOf(answer);
  if (!response.ok) {
    const code = typeof answer?.error?.code === 'number' ? String(answer.error.code) : '';
    const sub =
      typeof answer?.error?.error_subcode === 'number' ? `.${answer.error.error_subcode}` : '';
    return answeredOutcome(response.status, `${code}${code ? sub : ''}`, shape);
  }
  const trace = answer?.fbtrace_id;
  return { kind: 'sent', requestId: typeof trace === 'string' ? trace.slice(0, 100) : null, shape };
}

/** An access token for the Data Manager scope; a code when Google refused it. */
export async function googleAccessToken(
  fetchImpl: typeof fetch,
  config: { clientId: string; clientSecret: string; refreshToken: string },
): Promise<{ token: string } | { error: string }> {
  try {
    const response = await fetchImpl(GOOGLE_TOKEN, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        refresh_token: config.refreshToken,
        grant_type: 'refresh_token',
      }).toString(),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const answer = (await response.json().catch(() => null)) as {
      access_token?: unknown;
      error?: unknown;
    } | null;
    if (response.ok && typeof answer?.access_token === 'string') {
      return { token: answer.access_token };
    }
    const reason = typeof answer?.error === 'string' ? `:${answer.error.slice(0, 40)}` : '';
    return { error: `google_auth_${response.status}${reason}` };
  } catch {
    return { error: 'google_auth_unreachable' };
  }
}

/** Google keeps the first event of a `transactionId` per conversion action: a new try is safe. */
export async function sendGoogleEvent(
  fetchImpl: typeof fetch,
  accessToken: string,
  built: BuiltEvent,
): Promise<SendOutcome> {
  let response: Response;
  try {
    response = await fetchImpl(GOOGLE_INGEST, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${accessToken}`,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: built.body,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    return thrownOutcome(error, true);
  }
  const answer = (await response.json().catch(() => null)) as {
    requestId?: unknown;
    error?: { status?: unknown };
  } | null;
  const shape = shapeOf(answer);
  if (!response.ok) {
    const status =
      typeof answer?.error?.status === 'string' ? answer.error.status.slice(0, 40) : '';
    return answeredOutcome(response.status, status, shape);
  }
  const requestId = answer?.requestId;
  return {
    kind: 'sent',
    requestId: typeof requestId === 'string' ? requestId.slice(0, 100) : null,
    shape,
  };
}
