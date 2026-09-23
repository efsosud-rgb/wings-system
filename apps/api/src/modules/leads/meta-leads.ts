import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Meta Lead Ads (leadgen). The webhook only says *that* a lead exists (ids);
 * the answers of the form are read from the Graph API with a token that holds
 * `leads_retrieval`. Read-only: one GET per lead, never a write.
 *
 * NOT verified live yet: the field names below follow Meta's published
 * reference (field_data, campaign_name, ...). The API logs the shape of every
 * answer (`shapeOf`), never the values, so the day the first real lead
 * arrives the format can be checked against the log.
 */

export const META_GRAPH_VERSION = 'v23.0';

/** `X-Hub-Signature-256: sha256=<hex>` over the raw body, keyed with the app secret. */
export function metaSignatureValid(appSecret: string, rawBody: Buffer, header: string | undefined): boolean {
  if (!header || !header.startsWith('sha256=')) return false;
  const given = Buffer.from(header.slice('sha256='.length), 'hex');
  const expected = createHmac('sha256', appSecret).update(rawBody).digest();
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export interface MetaLeadgenEvent {
  leadgenId: string;
  formId: string | null;
  pageId: string | null;
  adId: string | null;
  adgroupId: string | null;
  createdTime: Date | null;
}

const asString = (value: unknown): string | null =>
  typeof value === 'string' && value.length > 0 ? value : typeof value === 'number' ? String(value) : null;

/** Every leadgen change in a webhook body, whatever else the body carries. */
export function leadgenEventsOf(body: unknown): MetaLeadgenEvent[] {
  const events: MetaLeadgenEvent[] = [];
  const entries = (body as { entry?: unknown })?.entry;
  if (!Array.isArray(entries)) return events;
  for (const entry of entries) {
    const changes = (entry as { changes?: unknown })?.changes;
    if (!Array.isArray(changes)) continue;
    for (const change of changes) {
      const field = (change as { field?: unknown })?.field;
      const value = (change as { value?: Record<string, unknown> })?.value;
      if (field !== 'leadgen' || !value) continue;
      const leadgenId = asString(value.leadgen_id);
      if (!leadgenId) continue;
      const created = typeof value.created_time === 'number' ? new Date(value.created_time * 1000) : null;
      events.push({
        leadgenId,
        formId: asString(value.form_id),
        pageId: asString(value.page_id),
        adId: asString(value.ad_id),
        adgroupId: asString(value.adgroup_id),
        createdTime: created && !Number.isNaN(created.getTime()) ? created : null,
      });
    }
  }
  return events;
}

export interface MetaLeadDetails {
  name: string | null;
  email: string | null;
  phone: string | null;
  city: string | null;
  campaignId: string | null;
  campaignName: string | null;
  adName: string | null;
  formId: string | null;
  createdTime: Date | null;
  /** True when the lead came from the organic form, not an ad. */
  organic: boolean;
}

interface FieldDatum {
  name?: string;
  values?: unknown[];
}

const NAME_FIELDS = ['full_name', 'name', 'nome', 'nome_completo'];
const EMAIL_FIELDS = ['email', 'e-mail', 'e_mail'];
const PHONE_FIELDS = ['phone_number', 'phone', 'telefone', 'whatsapp', 'celular', 'mobile'];
const CITY_FIELDS = ['city', 'cidade'];

function firstValue(data: FieldDatum[], names: string[]): string | null {
  for (const datum of data) {
    const key = (datum.name ?? '').toLowerCase();
    if (names.includes(key)) {
      const value = datum.values?.[0];
      if (typeof value === 'string' && value.trim()) return value.trim();
    }
  }
  return null;
}

/** The form's answers, as the Graph API returns them. */
export function parseMetaLead(payload: unknown): MetaLeadDetails {
  const body = (payload ?? {}) as Record<string, unknown>;
  const data = Array.isArray(body.field_data) ? (body.field_data as FieldDatum[]) : [];
  const first = firstValue(data, ['first_name', 'primeiro_nome']);
  const last = firstValue(data, ['last_name', 'sobrenome']);
  const name = firstValue(data, NAME_FIELDS) ?? (first ? [first, last].filter(Boolean).join(' ') : null);
  const created = typeof body.created_time === 'string' ? new Date(body.created_time) : null;
  return {
    name,
    email: firstValue(data, EMAIL_FIELDS),
    phone: firstValue(data, PHONE_FIELDS),
    city: firstValue(data, CITY_FIELDS),
    campaignId: asString(body.campaign_id),
    campaignName: asString(body.campaign_name),
    adName: asString(body.ad_name),
    formId: asString(body.form_id),
    createdTime: created && !Number.isNaN(created.getTime()) ? created : null,
    organic: body.is_organic === true,
  };
}

export class MetaLeadFetchError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'MetaLeadFetchError';
    this.status = status;
  }
}

/** One GET, with the token in a header (never in the URL, which could reach a log). */
export async function fetchMetaLead(
  leadgenId: string,
  options: { accessToken: string; fetchImpl?: typeof fetch; timeoutMs?: number; version?: string },
): Promise<{ details: MetaLeadDetails; raw: unknown }> {
  const url = new URL(`https://graph.facebook.com/${options.version ?? META_GRAPH_VERSION}/${leadgenId}`);
  url.searchParams.set(
    'fields',
    'id,created_time,field_data,campaign_id,campaign_name,ad_id,ad_name,adset_id,adset_name,form_id,platform,is_organic',
  );
  const response = await (options.fetchImpl ?? fetch)(url, {
    headers: { Authorization: `Bearer ${options.accessToken}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(options.timeoutMs ?? 8_000),
  });
  const text = await response.text();
  let raw: unknown = null;
  try {
    raw = text ? JSON.parse(text) : null;
  } catch {
    raw = null;
  }
  if (!response.ok) throw new MetaLeadFetchError(response.status, `Graph API answered ${response.status}`);
  return { details: parseMetaLead(raw), raw };
}
