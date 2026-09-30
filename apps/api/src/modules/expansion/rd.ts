import { utmsOfTrafficSource, type Utms } from '../ads/campaign-leads-sync.js';

/**
 * The two RD Station products the expansion intake talks to. Both classes take
 * their fetch and credentials from the caller, hold no state on disk, and
 * throw errors that name a path and a status only: RD's answers carry names,
 * e-mails and phones, so no body ever reaches a message.
 *
 * Verified live on 2026-09-28 against the Wings accounts: the "Todos os
 * contatos" segmentation lists every contact (page_size 125, no ordering, so
 * it is walked whole and filtered on `last_conversion_date`); contact events
 * carry `payload.conversion_identifier` and `payload.traffic_source`; the CRM
 * answers `/contacts?email=` and `?phone=` with the contact's deals inside.
 */

const MKT = 'https://api.rd.services';
const CRM = 'https://crm.rdstation.com/api/v1';

/** "Todos os contatos da base de Leads" in RD Marketing. */
export const ALL_CONTACTS_SEGMENTATION = '13942586';

export interface RdMarketingCredentials {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}

export interface Conversion {
  contactUuid: string;
  /** RD's conversion identifier: the landing page or form that was submitted. */
  identifier: string;
  occurredAt: Date;
  name: string | null;
  email: string | null;
  phone: string | null;
  company: string | null;
  utms: Utms | null;
  /** Host and path of the page, never its query string. */
  page: string | null;
  /** RD's event type (a form conversion is CONVERSION; anything else is not a form). */
  eventType: string | null;
  /** Which ad platform the visit came from: a click id or the UTM source says so. */
  ads: 'google' | 'meta' | null;
}

async function withRetry(call: () => Promise<Response>, what: string): Promise<Response> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const response = await call();
    if (response.status === 429) {
      // RD Marketing's limit is per minute: wait a little longer each time.
      await new Promise((resolve) => setTimeout(resolve, 3000 * (attempt + 1)));
      continue;
    }
    return response;
  }
  throw new Error(`${what} kept answering 429`);
}

function pageOfTrafficSource(trafficSource: string | null | undefined): string | null {
  if (!trafficSource) return null;
  try {
    const raw = trafficSource.startsWith('encoded_') ? trafficSource.slice(8) : trafficSource;
    const decoded = JSON.parse(Buffer.from(raw, 'base64').toString('utf8')) as {
      current_session?: { value?: string };
      first_session?: { value?: string };
    };
    for (const value of [decoded.current_session?.value, decoded.first_session?.value]) {
      if (!value) continue;
      const url = new URL(value);
      return `${url.host}${url.pathname}`;
    }
  } catch {
    // "(direct)" and the like: no page.
  }
  return null;
}

/** 'google' for a gclid or a Google UTM source, 'meta' for an fbclid or a Meta one; else null. */
export function adsOfTrafficSource(
  trafficSource: string | null | undefined,
): 'google' | 'meta' | null {
  if (!trafficSource) return null;
  try {
    const raw = trafficSource.startsWith('encoded_') ? trafficSource.slice(8) : trafficSource;
    const decoded = JSON.parse(Buffer.from(raw, 'base64').toString('utf8')) as {
      current_session?: { value?: string; extra_params?: Record<string, unknown> };
      first_session?: { value?: string; extra_params?: Record<string, unknown> };
    };
    let found: 'google' | 'meta' | null = null;
    for (const session of [decoded.current_session, decoded.first_session]) {
      const params = new Map<string, string>();
      try {
        if (session?.value)
          for (const [k, v] of new URL(session.value).searchParams) params.set(k, v);
      } catch {
        // "(direct)" and the like.
      }
      for (const [k, v] of Object.entries(session?.extra_params ?? {})) {
        if (typeof v === 'string' && !params.has(k)) params.set(k, v);
      }
      const source = (params.get('utm_source') ?? '').toLowerCase();
      if (params.has('gclid') || /google|adwords|gads/.test(source)) return 'google';
      if (params.has('fbclid') || /facebook|instagram|meta|^fb$|^ig$/.test(source))
        found = found ?? 'meta';
    }
    return found;
  } catch {
    return null;
  }
}

export class RdMarketing {
  private token: string | null = null;

  constructor(
    private readonly credentials: RdMarketingCredentials,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async accessToken(): Promise<string> {
    if (this.token) return this.token;
    const response = await this.fetchImpl(`${MKT}/auth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        client_id: this.credentials.clientId,
        client_secret: this.credentials.clientSecret,
        refresh_token: this.credentials.refreshToken,
      }),
      signal: AbortSignal.timeout(20_000),
    });
    const body = (await response.json().catch(() => ({}))) as { access_token?: string };
    if (!response.ok || !body.access_token) {
      throw new Error(`RD Marketing token refused (${response.status})`);
    }
    this.token = body.access_token;
    return this.token;
  }

  private async get<T>(path: string): Promise<T> {
    const response = await withRetry(
      async () =>
        this.fetchImpl(`${MKT}${path}`, {
          headers: { authorization: `Bearer ${await this.accessToken()}` },
          signal: AbortSignal.timeout(30_000),
        }),
      'RD Marketing',
    );
    if (!response.ok)
      throw new Error(`RD Marketing ${path.split('?')[0]} answered ${response.status}`);
    return (await response.json()) as T;
  }

  /** Contacts whose latest conversion is at or after `since` (the whole segmentation is walked). */
  async contactsConvertedSince(since: Date): Promise<string[]> {
    const uuids: string[] = [];
    for (let page = 1; page <= 200; page += 1) {
      const body = await this.get<{ contacts?: { uuid: string; last_conversion_date?: string }[] }>(
        `/platform/segmentations/${ALL_CONTACTS_SEGMENTATION}/contacts?page=${page}&page_size=125`,
      );
      const contacts = body.contacts ?? [];
      if (contacts.length === 0) break;
      for (const contact of contacts) {
        if (
          contact.last_conversion_date &&
          Date.parse(contact.last_conversion_date) >= since.getTime()
        ) {
          uuids.push(contact.uuid);
        }
      }
    }
    return uuids;
  }

  /** A contact's own data, to find or make its CRM twin. Never logged or returned to a screen. */
  async contactOf(
    uuid: string,
  ): Promise<{ name: string | null; email: string | null; phone: string | null }> {
    const contact = await this.get<{
      name?: string;
      email?: string;
      mobile_phone?: string;
      personal_phone?: string;
    }>(`/platform/contacts/${uuid}`);
    return {
      name: contact.name?.trim() || null,
      email: contact.email?.trim().toLowerCase() || null,
      phone: (contact.mobile_phone ?? contact.personal_phone)?.trim() || null,
    };
  }

  /** The contact's conversions at or after `since`, dated by the event, not by the contact. */
  async conversionsOf(uuid: string, since: Date): Promise<Conversion[]> {
    const events = await this.get<
      {
        event_type?: string;
        event_identifier?: string;
        event_timestamp?: string;
        payload?: {
          conversion_identifier?: string;
          name?: string;
          email?: string;
          mobile_phone?: string;
          personal_phone?: string;
          company_name?: string;
          traffic_source?: string;
        };
      }[]
    >(`/platform/contacts/${uuid}/events?event_type=CONVERSION`);
    const conversions: Conversion[] = [];
    for (const event of Array.isArray(events) ? events : []) {
      const occurredAt = new Date(event.event_timestamp ?? '');
      const identifier = (
        event.payload?.conversion_identifier ??
        event.event_identifier ??
        ''
      ).trim();
      if (Number.isNaN(occurredAt.getTime()) || occurredAt < since || !identifier) continue;
      const payload = event.payload ?? {};
      conversions.push({
        contactUuid: uuid,
        identifier,
        occurredAt,
        name: payload.name?.trim() || null,
        email: payload.email?.trim().toLowerCase() || null,
        phone: (payload.mobile_phone ?? payload.personal_phone)?.trim() || null,
        company: payload.company_name?.trim() || null,
        utms: utmsOfTrafficSource(payload.traffic_source),
        page: pageOfTrafficSource(payload.traffic_source),
        eventType: event.event_type ?? null,
        ads: adsOfTrafficSource(payload.traffic_source),
      });
    }
    return conversions;
  }
}

export interface CrmDealRef {
  id: string;
  win: boolean | null;
}

export interface CrmContact {
  id: string;
  deals: CrmDealRef[];
}

export interface CrmMap {
  /** pipeline name -> { id, stage name -> id } */
  pipelines: Map<string, { id: string; stages: Map<string, string> }>;
  customFields: Map<string, string>;
  sources: Map<string, string>;
  campaigns: Map<string, string>;
}

export interface NewDeal {
  name: string;
  stageId: string;
  contact: { name: string; email: string | null; phone: string | null };
  sourceId: string | null;
  campaignId: string | null;
  /** RD CRM user id of the deal's owner; null leaves it unassigned. */
  ownerId: string | null;
  customFields: { id: string; value: string }[];
}

export class RdCrm {
  constructor(
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private url(path: string, params: Record<string, string> = {}): string {
    const url = new URL(`${CRM}${path}`);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    // RD CRM takes the token in the query string; the URL is never logged or thrown.
    url.searchParams.set('token', this.token);
    return url.toString();
  }

  private async get<T>(path: string, params: Record<string, string> = {}): Promise<T> {
    const response = await withRetry(
      async () => this.fetchImpl(this.url(path, params), { signal: AbortSignal.timeout(30_000) }),
      `RD CRM ${path}`,
    );
    if (!response.ok)
      throw new Error(
        `RD CRM ${path.replace(/\/[0-9a-f]{24}/g, '/:id')} answered ${response.status}`,
      );
    return (await response.json()) as T;
  }

  async map(): Promise<CrmMap> {
    const [pipelines, fields, sources, campaigns] = await Promise.all([
      this.get<{ id: string; name: string; deal_stages: { id: string; name: string }[] }[]>(
        '/deal_pipelines',
      ),
      this.get<{ custom_fields?: { id?: string; _id?: string; label: string }[] }>(
        '/custom_fields',
        { for: 'deal', limit: '200' },
      ),
      this.get<{ deal_sources?: { id?: string; _id?: string; name: string }[] }>('/deal_sources', {
        limit: '200',
      }),
      this.get<{ campaigns?: { id?: string; _id?: string; name: string }[] }>('/campaigns', {
        limit: '200',
      }),
    ]);
    const idOf = (row: { id?: string; _id?: string }) => (row.id ?? row._id) as string;
    return {
      pipelines: new Map(
        pipelines.map((pipeline) => [
          pipeline.name,
          {
            id: pipeline.id,
            stages: new Map(pipeline.deal_stages.map((stage) => [stage.name, stage.id])),
          },
        ]),
      ),
      customFields: new Map(
        (fields.custom_fields ?? []).map((field) => [field.label, idOf(field)]),
      ),
      sources: new Map((sources.deal_sources ?? []).map((row) => [row.name, idOf(row)])),
      campaigns: new Map((campaigns.campaigns ?? []).map((row) => [row.name, idOf(row)])),
    };
  }

  /** The contact with this e-mail or phone, or null; its deals come inside. */
  async findContact(email: string | null, phone: string | null): Promise<CrmContact | null> {
    const attempts: [string, string][] = [];
    if (email) attempts.push(['email', email]);
    if (phone) {
      const digits = phone.replace(/\D/g, '');
      const national = digits.startsWith('55') && digits.length > 11 ? digits.slice(2) : digits;
      if (national.length >= 10) {
        attempts.push(['phone', `+55${national}`], ['phone', national]);
      }
    }
    for (const [key, value] of attempts) {
      const body = await this.get<{
        contacts?: {
          id?: string;
          _id?: string;
          deals?: { id?: string; _id?: string; win: boolean | null }[];
        }[];
      }>('/contacts', { [key]: value });
      const contact = body.contacts?.[0];
      if (contact) {
        return {
          id: (contact.id ?? contact._id) as string,
          deals: (contact.deals ?? []).map((deal) => ({
            id: (deal.id ?? deal._id) as string,
            win: deal.win,
          })),
        };
      }
    }
    return null;
  }

  /** Where a deal sits: when RD created it, its funnel and its stage (names only). */
  async dealPlacement(
    dealId: string,
  ): Promise<{ createdAt: Date | null; pipeline: string; stage: string }> {
    const deal = await this.get<{
      created_at?: string;
      deal_pipeline?: { name?: string };
      deal_stage?: { name?: string };
    }>(`/deals/${dealId}`);
    return {
      createdAt: deal.created_at ? new Date(deal.created_at) : null,
      pipeline: deal.deal_pipeline?.name ?? '?',
      stage: deal.deal_stage?.name ?? '?',
    };
  }

  /** When RD created the deal (the contact's embedded deals carry no date). */
  async dealCreatedAt(dealId: string): Promise<Date | null> {
    const deal = await this.get<{ created_at?: string }>(`/deals/${dealId}`);
    return deal.created_at ? new Date(deal.created_at) : null;
  }

  /**
   * One attempt, never retried: an answer lost on the way is caught by the
   * next run's duplicate check. The contact goes in whole (name, e-mail,
   * phone) and RD matches it by e-mail; `deal_source` and `campaign` are
   * top-level `{ _id }` objects, not ids inside `deal` (RD ignores those
   * silently, which is how the first 12 deals of 2026-09-28 lost their
   * source and campaign).
   */
  async createDeal(input: NewDeal): Promise<string> {
    const response = await this.fetchImpl(this.url('/deals'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        deal: {
          name: input.name,
          deal_stage_id: input.stageId,
          ...(input.ownerId ? { user_id: input.ownerId } : {}),
          deal_custom_fields: input.customFields.map((field) => ({
            custom_field_id: field.id,
            value: field.value,
          })),
        },
        contacts: [
          {
            name: input.contact.name,
            ...(input.contact.email ? { emails: [{ email: input.contact.email }] } : {}),
            ...(input.contact.phone
              ? { phones: [{ phone: input.contact.phone, type: 'cellphone' }] }
              : {}),
          },
        ],
        ...(input.sourceId ? { deal_source: { _id: input.sourceId } } : {}),
        ...(input.campaignId ? { campaign: { _id: input.campaignId } } : {}),
      }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`RD CRM POST /deals answered ${response.status}`);
    const body = (await response.json()) as { id?: string; _id?: string };
    return (body.id ?? body._id) as string;
  }

  /** A task on a deal for one user, due at the end of `dueDay` (São Paulo). One attempt. */
  async createTask(input: {
    dealId: string;
    userId: string;
    subject: string;
    dueDay: Date;
  }): Promise<void> {
    const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(
      input.dueDay,
    );
    const response = await this.fetchImpl(this.url('/tasks'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        task: {
          deal_id: input.dealId,
          subject: input.subject,
          type: 'task',
          date: day,
          hour: '23:59',
          user_ids: [input.userId],
        },
      }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`RD CRM POST /tasks answered ${response.status}`);
  }

  /** One write attempt, never retried; answers the status and nothing of the body. */
  private async write(method: 'PUT' | 'POST', path: string, body: unknown): Promise<number> {
    const response = await this.fetchImpl(this.url(path), {
      method,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    return response.status;
  }

  /**
   * Ties a person to a deal that has no contact, trying the ways RD CRM offers
   * one after the other and reading the deal back after each: the first that
   * shows a contact on the deal wins, the rest are not tried. Whether RD keeps
   * a contact sent inside `POST /deals` depends on it already knowing that
   * person, which is why this exists. Statuses only in the answer (never a
   * body, never a person). Not verified live before 2026-09-30: the audit
   * trail says which way worked.
   */
  async linkContact(
    dealId: string,
    person: { name: string | null; email: string | null; phone: string | null },
    existing: CrmContact | null,
  ): Promise<{ linked: boolean; attempts: { strategy: string; status: number }[] }> {
    const attempts: { strategy: string; status: number }[] = [];
    const named = {
      name: person.name ?? person.email ?? 'Lead',
      ...(person.email ? { emails: [{ email: person.email }] } : {}),
      ...(person.phone ? { phones: [{ phone: person.phone, type: 'cellphone' }] } : {}),
    };
    const ways: { strategy: string; run: () => Promise<number> }[] = [];
    if (existing) {
      // Keeps every deal the contact already has: the list is replaced, not added to.
      const dealIds = [...new Set([...existing.deals.map((deal) => deal.id), dealId])];
      ways.push({
        strategy: 'contact.deal_ids',
        run: () =>
          this.write('PUT', `/contacts/${existing.id}`, { contact: { deal_ids: dealIds } }),
      });
      ways.push({
        strategy: 'deal.contacts_id',
        run: () => this.write('PUT', `/deals/${dealId}`, { contacts: [{ _id: existing.id }] }),
      });
    } else {
      ways.push({
        strategy: 'contact.create_with_deal',
        run: () => this.write('POST', '/contacts', { contact: { ...named, deal_ids: [dealId] } }),
      });
    }
    ways.push({
      strategy: 'deal.contacts_full',
      run: () => this.write('PUT', `/deals/${dealId}`, { contacts: [named] }),
    });
    for (const way of ways) {
      let status: number;
      try {
        status = await way.run();
      } catch {
        status = 0;
      }
      attempts.push({ strategy: way.strategy, status });
      if (status >= 200 && status < 300) {
        const back = await this.checkDeal(dealId).catch(() => null);
        if (back?.hasContact) return { linked: true, attempts };
      }
    }
    return { linked: false, attempts };
  }

  /**
   * Reads a deal back: does it have a contact and a source? Booleans only.
   * The contacts come from `GET /deals/:id/contacts`, the endpoint RD documents
   * for them (the deal itself may not carry them), with the deal's own list as
   * a second witness.
   */
  async checkDeal(dealId: string): Promise<{ hasContact: boolean; hasSource: boolean }> {
    const [deal, listed] = await Promise.all([
      this.get<{ contacts?: unknown[]; deal_source?: unknown }>(`/deals/${dealId}`),
      this.get<{ contacts?: unknown[]; total?: number }>(`/deals/${dealId}/contacts`).catch(
        () => null,
      ),
    ]);
    const count = Math.max(
      deal.contacts?.length ?? 0,
      listed?.contacts?.length ?? 0,
      listed?.total ?? 0,
    );
    return { hasContact: count > 0, hasSource: Boolean(deal.deal_source) };
  }
}
