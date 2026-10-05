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
export function metaSignatureValid(
  appSecret: string,
  rawBody: Buffer,
  header: string | undefined,
): boolean {
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
  /** The change as Meta sent it (ids and times, no answers), kept 90 days in the queue. */
  raw: unknown;
}

const asString = (value: unknown): string | null =>
  typeof value === 'string' && value.length > 0
    ? value
    : typeof value === 'number'
      ? String(value)
      : null;

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
      const created =
        typeof value.created_time === 'number' ? new Date(value.created_time * 1000) : null;
      events.push({
        leadgenId,
        formId: asString(value.form_id),
        pageId: asString(value.page_id),
        adId: asString(value.ad_id),
        adgroupId: asString(value.adgroup_id),
        createdTime: created && !Number.isNaN(created.getTime()) ? created : null,
        raw: value,
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
  adsetId: string | null;
  adsetName: string | null;
  adId: string | null;
  adName: string | null;
  formId: string | null;
  /** fb | ig | ..., as Meta names where the form was shown. */
  platform: string | null;
  createdTime: Date | null;
  /** True when the lead came from the organic form, not an ad. */
  organic: boolean;
  /**
   * The other answers of the form (question name -> answer), without the
   * name, e-mail, phone and city fields above. Shown to the seller on the
   * lead; never logged.
   */
  answers: Record<string, string>;
}

interface FieldDatum {
  name?: string;
  values?: unknown[];
}

const NAME_FIELDS = ['full_name', 'name', 'nome', 'nome_completo'];
const EMAIL_FIELDS = ['email', 'e-mail', 'e_mail'];
const PHONE_FIELDS = ['phone_number', 'phone', 'telefone', 'whatsapp', 'celular', 'mobile'];
const CITY_FIELDS = ['city', 'cidade'];
const CONTACT_FIELDS = new Set([
  ...NAME_FIELDS,
  ...EMAIL_FIELDS,
  ...PHONE_FIELDS,
  ...CITY_FIELDS,
  'first_name',
  'primeiro_nome',
  'last_name',
  'sobrenome',
]);
const ANSWER_MAX = 500;

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
  const name =
    firstValue(data, NAME_FIELDS) ?? (first ? [first, last].filter(Boolean).join(' ') : null);
  const created = typeof body.created_time === 'string' ? new Date(body.created_time) : null;
  const answers: Record<string, string> = {};
  for (const datum of data) {
    const key = (datum.name ?? '').trim();
    if (!key || CONTACT_FIELDS.has(key.toLowerCase())) continue;
    const values = (datum.values ?? []).filter(
      (value): value is string => typeof value === 'string' && value.trim().length > 0,
    );
    if (values.length > 0) answers[key.slice(0, 120)] = values.join(', ').slice(0, ANSWER_MAX);
  }
  return {
    name,
    email: firstValue(data, EMAIL_FIELDS),
    phone: firstValue(data, PHONE_FIELDS),
    city: firstValue(data, CITY_FIELDS),
    campaignId: asString(body.campaign_id),
    campaignName: asString(body.campaign_name),
    adsetId: asString(body.adset_id),
    adsetName: asString(body.adset_name),
    adId: asString(body.ad_id),
    adName: asString(body.ad_name),
    formId: asString(body.form_id),
    platform: asString(body.platform),
    createdTime: created && !Number.isNaN(created.getTime()) ? created : null,
    organic: body.is_organic === true,
    answers,
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
  const url = new URL(
    `https://graph.facebook.com/${options.version ?? META_GRAPH_VERSION}/${leadgenId}`,
  );
  url.searchParams.set(
    'fields',
    'id,created_time,field_data,campaign_id,campaign_name,ad_id,ad_name,adset_id,adset_name,form_id,platform,is_organic',
  );
  const response = await (options.fetchImpl ?? fetch)(url, {
    headers: { Authorization: `Bearer ${options.accessToken}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(options.timeoutMs ?? 8_000),
  });
  const text = await response.text();
  if (!response.ok)
    throw new MetaLeadFetchError(response.status, `Graph API answered ${response.status}`);
  const raw = parseJsonOrNull(text);
  return { details: parseMetaLead(raw), raw };
}

function parseJsonOrNull(text: string): unknown {
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

export const META_LEAD_FIELDS =
  'id,created_time,field_data,campaign_id,campaign_name,ad_id,ad_name,adset_id,adset_name,form_id,platform,is_organic';

export interface FormLeadRef {
  leadgenId: string;
  createdTime: Date | null;
  adId: string | null;
  adsetId: string | null;
  campaignId: string | null;
}

/**
 * The leads of one form since `since` (Meta keeps them 90 days), ids and
 * ad ids only: each is then read one by one by the queue, like a webhook
 * event. Pages by cursor (`paging.cursors.after`), never by `paging.next`,
 * whose URL carries the token. Reads only.
 */
export async function fetchFormLeads(
  formId: string,
  options: {
    accessToken: string;
    since: Date;
    fetchImpl?: typeof fetch;
    version?: string;
    maxPages?: number;
    timeoutMs?: number;
  },
): Promise<{ leads: FormLeadRef[]; pages: number; truncated: boolean }> {
  const leads: FormLeadRef[] = [];
  let after: string | null = null;
  let pages = 0;
  const maxPages = options.maxPages ?? 50;
  do {
    const url = new URL(
      `https://graph.facebook.com/${options.version ?? META_GRAPH_VERSION}/${formId}/leads`,
    );
    url.searchParams.set('fields', 'id,created_time,ad_id,adset_id,campaign_id');
    url.searchParams.set('limit', '100');
    url.searchParams.set(
      'filtering',
      JSON.stringify([
        {
          field: 'time_created',
          operator: 'GREATER_THAN',
          value: Math.floor(options.since.getTime() / 1000),
        },
      ]),
    );
    if (after) url.searchParams.set('after', after);
    const response = await (options.fetchImpl ?? fetch)(url, {
      headers: { Authorization: `Bearer ${options.accessToken}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(options.timeoutMs ?? 15_000),
    });
    const text = await response.text();
    if (!response.ok)
      throw new MetaLeadFetchError(response.status, `Graph API answered ${response.status}`);
    const body = (parseJsonOrNull(text) ?? {}) as {
      data?: Record<string, unknown>[];
      paging?: { cursors?: { after?: string }; next?: string };
    };
    for (const item of body.data ?? []) {
      const id = asString(item.id);
      if (!id) continue;
      const created = typeof item.created_time === 'string' ? new Date(item.created_time) : null;
      leads.push({
        leadgenId: id,
        createdTime: created && !Number.isNaN(created.getTime()) ? created : null,
        adId: asString(item.ad_id),
        adsetId: asString(item.adset_id),
        campaignId: asString(item.campaign_id),
      });
    }
    pages += 1;
    after = body.paging?.next && body.paging.cursors?.after ? body.paging.cursors.after : null;
  } while (after && pages < maxPages);
  return { leads, pages, truncated: after !== null };
}
