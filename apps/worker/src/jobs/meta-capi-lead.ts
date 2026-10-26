import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Job } from '../queue.js';
import type { JobContext, JobHandler } from './types.js';

/**
 * Meta's Conversions API: one site-form lead, sent as a `Lead` event to the
 * pixel (dataset) with hashed data (docs/ads/conversions-api.md).
 *
 * Sends only when META_CAPI_ENABLED is "true" and the lead's legal basis is
 * consent with its moment recorded. What goes: the e-mail and phone hashed
 * (SHA-256, normalised as Meta asks), the lead id hashed as `external_id`,
 * `fbc` built from the click id when the visit had one, and the browser's user
 * agent (Meta requires it for website events). No name, no IP, no CPF, no
 * answer of the form. The event id is the one the page sent to the browser
 * pixel, so Meta counts the lead once; that is also why a retry is safe: Meta
 * drops a repeated event id. The token travels in a header, never in a URL or
 * a log, and the job's output and error carry codes, never the payload.
 */

const GRAPH = 'https://graph.facebook.com/v23.0';
const TIMEOUT_MS = 15_000;
/** Meta refuses website events older than 7 days. */
const MAX_AGE_SECONDS = 7 * 24 * 3600;

const inputSchema = z.object({
  leadId: z.uuid(),
  eventId: z.string().min(1).max(100),
  eventTime: z.number().int().positive(),
  userAgent: z.string().max(400).nullable(),
  sourceUrl: z.string().max(500).nullable(),
});

interface LeadRow {
  email: string | null;
  phone: string | null;
  fbclid: string | null;
  legal_basis: string | null;
  consented_at: Date | null;
}

export interface MetaCapiLeadOutput {
  leadId: string;
  eventId: string;
  skipped?: 'disabled' | 'not_configured' | 'no_consent' | 'too_old' | 'no_identifier';
  /** What Meta said it received (`events_received`). */
  eventsReceived?: number;
}

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

/** Meta's normalisation: trimmed and lower-cased e-mail; phone as digits with the country code. */
export function userDataOf(
  lead: Pick<LeadRow, 'email' | 'phone' | 'fbclid'>,
  leadId: string,
  eventTime: number,
  userAgent: string | null,
): Record<string, unknown> {
  const data: Record<string, unknown> = { external_id: [sha256(leadId)] };
  const email = lead.email?.trim().toLowerCase();
  if (email) data.em = [sha256(email)];
  const phone = lead.phone?.replace(/\D/g, '');
  if (phone) data.ph = [sha256(phone)];
  // fbc is the click id itself, not personal data, and Meta asks for it unhashed.
  if (lead.fbclid) data.fbc = `fb.1.${eventTime * 1000}.${lead.fbclid}`;
  if (userAgent) data.client_user_agent = userAgent;
  return data;
}

export const runMetaCapiLeadJob: JobHandler = async (job: Job, ctx: JobContext) => {
  const input = inputSchema.parse(job.input);
  const base = { leadId: input.leadId, eventId: input.eventId };
  const config = ctx.metaCapi;
  if (!config?.enabled) return { ...base, skipped: 'disabled' } satisfies MetaCapiLeadOutput;
  if (!config.pixelId || !config.token) {
    return { ...base, skipped: 'not_configured' } satisfies MetaCapiLeadOutput;
  }
  const now = Math.floor((ctx.now?.() ?? new Date()).getTime() / 1000);
  if (now - input.eventTime > MAX_AGE_SECONDS) {
    return { ...base, skipped: 'too_old' } satisfies MetaCapiLeadOutput;
  }

  const found = await ctx.db.query<LeadRow>(
    `select email, phone, fbclid, legal_basis, consented_at from leads where id = $1`,
    [input.leadId],
  );
  const lead = found.rows[0];
  if (!lead) throw new Error('lead_not_found');
  // LGPD: only what the person agreed to on the form goes to Meta.
  if (lead.legal_basis !== 'consent' || !lead.consented_at) {
    return { ...base, skipped: 'no_consent' } satisfies MetaCapiLeadOutput;
  }
  if (!lead.email && !lead.phone) {
    return { ...base, skipped: 'no_identifier' } satisfies MetaCapiLeadOutput;
  }

  const body: Record<string, unknown> = {
    data: [
      {
        event_name: 'Lead',
        event_time: input.eventTime,
        event_id: input.eventId,
        action_source: 'website',
        ...(input.sourceUrl ? { event_source_url: input.sourceUrl } : {}),
        user_data: userDataOf(lead, input.leadId, input.eventTime, input.userAgent),
      },
    ],
  };
  // Events Manager's "Testar eventos": shown there, not counted in the ads.
  if (config.testEventCode) body.test_event_code = config.testEventCode;

  const fetchImpl = config.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(`${GRAPH}/${config.pixelId}/events`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${config.token}`,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    // The event may or may not have arrived; a retry is safe because Meta drops a repeated id.
    throw new Error('meta_capi_unreachable');
  }
  const answer = (await response.json().catch(() => null)) as {
    events_received?: unknown;
    error?: { code?: unknown; error_subcode?: unknown };
  } | null;
  if (!response.ok) {
    // Meta's codes only: its message can quote what was sent.
    const code = typeof answer?.error?.code === 'number' ? answer.error.code : 'none';
    const subcode =
      typeof answer?.error?.error_subcode === 'number' ? answer.error.error_subcode : 'none';
    throw new Error(`meta_capi_http_${response.status} code=${code} subcode=${subcode}`);
  }
  return {
    ...base,
    eventsReceived: typeof answer?.events_received === 'number' ? answer.events_received : 0,
  } satisfies MetaCapiLeadOutput;
};
