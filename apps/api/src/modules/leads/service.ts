import {
  EMPTY_FACTS,
  LEAD_PIPELINES,
  landingPageKeysOf,
  matchSourceRule,
  normalizeBrazilianPhone,
  normalizeEmail,
  WINGS_CLIENT_ID,
  type EnrichmentFacts,
  type FoundLink,
  type Lead,
  type LeadChannel,
  type LeadEvent,
  type LeadLegalBasis,
  type LeadListItem,
  type LeadPipeline,
  type LeadSource,
  type LeadSourceRuleKind,
  type ScoreCriterion,
} from '@wings/shared';
import { and, asc, desc, eq, isNull, or, sql } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import {
  clients,
  jobs,
  leadEnrichmentLedger,
  leadEvents,
  leadSourceRules,
  leadTrackingLinks,
  leads,
} from '../../db/schema/index.js';

export type LeadRow = typeof leads.$inferSelect;
type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];
type Executor = Database | Tx;

// --- source rules -------------------------------------------------------------

export interface ClientResolution {
  clientId: string;
  mapped: boolean;
  ruleId: string | null;
  /** The funnel the rule sends the lead to, when it says. */
  pipeline: LeadPipeline | null;
  /** The brand the rule names, even when it is not yet a client. */
  brand: string | null;
}

const UNMAPPED: ClientResolution = {
  clientId: WINGS_CLIENT_ID,
  mapped: false,
  ruleId: null,
  pipeline: null,
  brand: null,
};

/**
 * The client, funnel and brand a conversion belongs to, by the rules people
 * keep in Administração → Clientes and Integrações. A rule naming a brand that
 * is not a client yet files the lead under Wings Company, unmapped, and still
 * says the funnel and the brand.
 */
export async function resolveClient(
  db: Executor,
  kind: LeadSourceRuleKind,
  keys: readonly string[],
): Promise<ClientResolution> {
  if (keys.length === 0) return UNMAPPED;
  const rules = await db
    .select({
      id: leadSourceRules.id,
      kind: leadSourceRules.kind,
      pattern: leadSourceRules.pattern,
      clientId: leadSourceRules.clientId,
      pipeline: leadSourceRules.pipeline,
      brand: leadSourceRules.brand,
      clientName: clients.name,
    })
    .from(leadSourceRules)
    .leftJoin(clients, eq(clients.id, leadSourceRules.clientId))
    .where(
      and(
        eq(leadSourceRules.kind, kind),
        eq(leadSourceRules.active, true),
        or(isNull(leadSourceRules.clientId), eq(clients.active, true)),
      ),
    );
  const rule = matchSourceRule(
    rules.map((row) => ({ ...row, kind: row.kind as LeadSourceRuleKind })),
    kind,
    keys,
  );
  if (!rule) return UNMAPPED;
  const pipeline = (LEAD_PIPELINES as readonly string[]).includes(rule.pipeline ?? '')
    ? (rule.pipeline as LeadPipeline)
    : null;
  const brand =
    rule.brand ?? (rule.clientId && rule.clientId !== WINGS_CLIENT_ID ? rule.clientName : null);
  return rule.clientId
    ? { clientId: rule.clientId, mapped: true, ruleId: rule.id, pipeline, brand }
    : { ...UNMAPPED, ruleId: rule.id, pipeline, brand };
}

export function resolveLandingPage(
  db: Executor,
  input: { url?: string | null; identifier?: string | null },
): Promise<ClientResolution> {
  return resolveClient(db, 'landing_page', landingPageKeysOf(input));
}

/** A form rule wins over a campaign rule: it is the more specific of the two. */
export async function resolveMetaSource(
  db: Executor,
  input: { formId?: string | null; campaignId?: string | null },
): Promise<ClientResolution> {
  if (input.formId) {
    const byForm = await resolveClient(db, 'meta_form', [input.formId]);
    if (byForm.ruleId) return byForm;
  }
  if (input.campaignId) {
    const byCampaign = await resolveClient(db, 'meta_campaign', [input.campaignId]);
    if (byCampaign.ruleId) return byCampaign;
  }
  return UNMAPPED;
}

// --- tracking links -----------------------------------------------------------

export async function trackingLinkByCode(db: Executor, code: string) {
  return db.query.leadTrackingLinks.findFirst({ where: eq(leadTrackingLinks.code, code) });
}

// --- upsert -------------------------------------------------------------------

export interface IncomingLead {
  source: LeadSource;
  name?: string | null;
  email?: string | null;
  phone?: string | null;
  clientId: string;
  clientMapped: boolean;
  channel?: LeadChannel | null;
  landingPage?: string | null;
  campaignId?: string | null;
  campaignName?: string | null;
  formId?: string | null;
  trackingLinkId?: string | null;
  externalId?: string | null;
  firstMessage?: string | null;
  whatsappProfileName?: string | null;
  whatsappPhotoUrl?: string | null;
  legalBasis?: LeadLegalBasis | null;
  consentedAt?: Date | null;
  consentSource?: string | null;
  consentText?: string | null;
  ownerEmployeeId?: string | null;
  pipeline?: LeadPipeline | null;
  brand?: string | null;
  /** An import (RD CRM) does not queue the paid research for every lead it brings. */
  skipResearch?: boolean;
  /** First touch: kept only when the lead has none yet, and then as a whole. */
  attribution?: LeadAttribution | null;
  /** The timeline entry for this arrival. `detail` carries ids and codes, never personal data. */
  event: { kind: string; detail?: Record<string, unknown>; actorEmployeeId?: string | null };
}

/** UTMs, click ids and ad ids as the conversion carried them (spec §1.4). */
export interface LeadAttribution {
  utmSource?: string | null;
  utmMedium?: string | null;
  utmCampaign?: string | null;
  utmContent?: string | null;
  utmTerm?: string | null;
  gclid?: string | null;
  fbclid?: string | null;
  gbraid?: string | null;
  wbraid?: string | null;
  adPlatform?: 'meta' | 'google' | null;
  adCampaignExternalId?: string | null;
  adSetExternalId?: string | null;
  adExternalId?: string | null;
  referrer?: string | null;
}

const ATTRIBUTION_KEYS = [
  'utmSource',
  'utmMedium',
  'utmCampaign',
  'utmContent',
  'utmTerm',
  'gclid',
  'fbclid',
  'gbraid',
  'wbraid',
  'adPlatform',
  'adCampaignExternalId',
  'adSetExternalId',
  'adExternalId',
  'referrer',
] as const satisfies readonly (keyof LeadAttribution & keyof LeadRow)[];

/** The attribution columns to write, trimmed and capped; empty when the conversion carried none. */
export function attributionColumns(
  attribution: LeadAttribution | null | undefined,
): Partial<LeadRow> {
  const columns: Partial<Record<(typeof ATTRIBUTION_KEYS)[number], string>> = {};
  for (const key of ATTRIBUTION_KEYS) {
    const value = attribution?.[key]?.trim();
    if (value) columns[key] = value.slice(0, 500);
  }
  return columns as Partial<LeadRow>;
}

const hasAttribution = (row: LeadRow) => ATTRIBUTION_KEYS.some((key) => row[key] !== null);

export interface UpsertResult {
  lead: LeadRow;
  created: boolean;
  /** True when a research job was queued by this call. */
  researchQueued: boolean;
}

/** Only the gaps: an existing value is never overwritten by a later arrival. */
function fillGaps(existing: LeadRow, incoming: IncomingLead): Partial<typeof leads.$inferInsert> {
  const patch: Partial<typeof leads.$inferInsert> = {};
  const name = incoming.name?.trim() || null;
  if (!existing.name && name) patch.name = name;
  const email = normalizeEmail(incoming.email);
  if (!existing.email && email) patch.email = email;
  const phone = normalizeBrazilianPhone(incoming.phone);
  if (!existing.phone && phone) patch.phone = phone;
  if (!existing.whatsappProfileName && incoming.whatsappProfileName) {
    patch.whatsappProfileName = incoming.whatsappProfileName;
  }
  if (!existing.whatsappPhotoUrl && incoming.whatsappPhotoUrl)
    patch.whatsappPhotoUrl = incoming.whatsappPhotoUrl;
  if (!existing.firstMessage && incoming.firstMessage) patch.firstMessage = incoming.firstMessage;
  if (!existing.legalBasis && incoming.legalBasis) {
    patch.legalBasis = incoming.legalBasis;
    patch.consentedAt = incoming.consentedAt ?? null;
    patch.consentSource = incoming.consentSource ?? null;
    patch.consentText = incoming.consentText ?? null;
  }
  // A lead nobody had mapped takes the client and channel of a later, mapped arrival.
  if (!existing.clientMapped && incoming.clientMapped) {
    patch.clientId = incoming.clientId;
    patch.clientMapped = true;
  }
  if (!existing.channel && incoming.channel) patch.channel = incoming.channel;
  if (!existing.trackingLinkId && incoming.trackingLinkId)
    patch.trackingLinkId = incoming.trackingLinkId;
  if (!existing.landingPage && incoming.landingPage) patch.landingPage = incoming.landingPage;
  if (!existing.campaignId && incoming.campaignId) {
    patch.campaignId = incoming.campaignId;
    patch.campaignName = incoming.campaignName ?? null;
  }
  if (!existing.formId && incoming.formId) patch.formId = incoming.formId;
  if (!existing.pipeline && incoming.pipeline) patch.pipeline = incoming.pipeline;
  if (!existing.brand && incoming.brand) patch.brand = incoming.brand;
  if (!hasAttribution(existing)) Object.assign(patch, attributionColumns(incoming.attribution));
  return patch;
}

/**
 * Creates the lead, or finds the one it already is: same external id (a
 * retried webhook), else same phone, else same e-mail. A found lead gets its
 * gaps filled and the arrival on its timeline; a new one gets a research job.
 * A found lead whose research never ran, or failed, gets one too.
 */
export async function upsertLead(db: Database, incoming: IncomingLead): Promise<UpsertResult> {
  return db.transaction(async (tx) => {
    const phone = normalizeBrazilianPhone(incoming.phone);
    const email = normalizeEmail(incoming.email);

    // Two arrivals of the same person at once (webhook + import) must not both
    // create: each key is locked for the transaction, always in the same order.
    const keys = [
      incoming.externalId ? `lead:ext:${incoming.source}:${incoming.externalId}` : null,
      phone ? `lead:phone:${phone}` : null,
      email ? `lead:email:${email}` : null,
    ]
      .filter((key): key is string => key !== null)
      .sort();
    for (const key of keys) await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${key}))`);

    let existing: LeadRow | undefined;
    if (incoming.externalId) {
      existing = await tx.query.leads.findFirst({
        where: and(eq(leads.source, incoming.source), eq(leads.externalId, incoming.externalId)),
      });
    }
    if (!existing && phone) {
      existing = await tx.query.leads.findFirst({
        where: eq(leads.phone, phone),
        orderBy: asc(leads.createdAt),
      });
    }
    if (!existing && email) {
      existing = await tx.query.leads.findFirst({
        where: eq(leads.email, email),
        orderBy: asc(leads.createdAt),
      });
    }

    if (existing) {
      const patch = fillGaps(existing, incoming);
      const [updated] = await tx
        .update(leads)
        .set({ ...patch, updatedAt: new Date() })
        .where(eq(leads.id, existing.id))
        .returning();
      const lead = updated ?? existing;
      await tx.insert(leadEvents).values({
        leadId: lead.id,
        kind: incoming.event.kind,
        actorEmployeeId: incoming.event.actorEmployeeId ?? null,
        detail: {
          ...(incoming.event.detail ?? {}),
          matched: 'existing',
          filled: Object.keys(patch),
        },
      });
      const needsResearch =
        !incoming.skipResearch &&
        (lead.enrichmentState === 'none' || lead.enrichmentState === 'failed');
      const researched = needsResearch ? await enqueueResearch(tx, lead.id, null) : null;
      return { lead: researched ?? lead, created: false, researchQueued: researched !== null };
    }

    const [created] = await tx
      .insert(leads)
      .values({
        clientId: incoming.clientId,
        clientMapped: incoming.clientMapped,
        name: incoming.name?.trim() || null,
        email,
        phone,
        ownerEmployeeId: incoming.ownerEmployeeId ?? null,
        source: incoming.source,
        channel: incoming.channel ?? null,
        landingPage: incoming.landingPage ?? null,
        campaignId: incoming.campaignId ?? null,
        campaignName: incoming.campaignName ?? null,
        formId: incoming.formId ?? null,
        trackingLinkId: incoming.trackingLinkId ?? null,
        externalId: incoming.externalId ?? null,
        firstMessage: incoming.firstMessage ?? null,
        whatsappProfileName: incoming.whatsappProfileName ?? null,
        whatsappPhotoUrl: incoming.whatsappPhotoUrl ?? null,
        legalBasis: incoming.legalBasis ?? null,
        consentedAt: incoming.consentedAt ?? null,
        consentSource: incoming.consentSource ?? null,
        consentText: incoming.consentText ?? null,
        pipeline: incoming.pipeline ?? null,
        brand: incoming.brand ?? null,
        ...attributionColumns(incoming.attribution),
      })
      .returning();
    if (!created) throw new Error('lead insert returned no row');
    await tx.insert(leadEvents).values({
      leadId: created.id,
      kind: incoming.event.kind,
      actorEmployeeId: incoming.event.actorEmployeeId ?? null,
      detail: {
        ...(incoming.event.detail ?? {}),
        matched: 'new',
        clientMapped: incoming.clientMapped,
      },
    });
    if (incoming.skipResearch) return { lead: created, created: true, researchQueued: false };
    const researched = await enqueueResearch(tx, created.id, null);
    return { lead: researched ?? created, created: true, researchQueued: true };
  });
}

/** Queues the worker's `enrich_lead` job and marks the lead as waiting for it. */
export async function enqueueResearch(
  db: Executor,
  leadId: string,
  actorEmployeeId: string | null,
): Promise<LeadRow | null> {
  const [job] = await db
    .insert(jobs)
    .values({ type: 'enrich_lead', input: { leadId } })
    .returning({ id: jobs.id });
  if (!job) return null;
  const [lead] = await db
    .update(leads)
    .set({
      enrichmentState: 'pending',
      enrichmentJobId: job.id,
      enrichmentError: null,
      updatedAt: new Date(),
    })
    .where(eq(leads.id, leadId))
    .returning();
  await db.insert(leadEvents).values({
    leadId,
    kind: 'research.queued',
    actorEmployeeId,
    detail: { jobId: job.id },
  });
  return lead ?? null;
}

// --- reading --------------------------------------------------------------------

const asCriteria = (value: unknown): ScoreCriterion[] =>
  Array.isArray(value) ? (value as ScoreCriterion[]) : [];
const asLinks = (value: unknown): FoundLink[] =>
  Array.isArray(value) ? (value as FoundLink[]) : [];
const asFacts = (value: unknown): EnrichmentFacts | null =>
  value && typeof value === 'object'
    ? { ...EMPTY_FACTS, ...(value as Partial<EnrichmentFacts>) }
    : null;

export function toLead(
  row: LeadRow,
  extra: { clientName: string; trackingCode: string | null; costUsdMicro: number },
): Lead {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    phone: row.phone,
    status: 'new',
    ownerEmployeeId: row.ownerEmployeeId,
    firstMessage: row.firstMessage,
    whatsapp:
      row.whatsappProfileName || row.whatsappPhotoUrl
        ? { profileName: row.whatsappProfileName, photoUrl: row.whatsappPhotoUrl }
        : null,
    origin: {
      clientId: row.clientId,
      clientName: extra.clientName,
      clientMapped: row.clientMapped,
      source: row.source as LeadSource,
      channel: (row.channel as LeadChannel | null) ?? null,
      landingPage: row.landingPage,
      campaignId: row.campaignId,
      campaignName: row.campaignName,
      formId: row.formId,
      trackingCode: extra.trackingCode,
      externalId: row.externalId,
    },
    consent: {
      legalBasis: (row.legalBasis as LeadLegalBasis | null) ?? null,
      consentedAt: row.consentedAt?.toISOString() ?? null,
      source: row.consentSource,
      text: row.consentText,
    },
    research: {
      state: row.enrichmentState as Lead['research']['state'],
      summary: row.enrichmentSummary,
      score: row.enrichmentScore,
      criteria: asCriteria(row.enrichmentCriteria),
      links: asLinks(row.enrichmentLinks),
      facts: asFacts(row.enrichmentFacts),
      error: row.enrichmentError,
      updatedAt: row.enrichedAt?.toISOString() ?? null,
      costUsd: extra.costUsdMicro / 1_000_000,
    },
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function loadLead(
  db: Database,
  id: string,
): Promise<{ lead: Lead; events: LeadEvent[] } | null> {
  const row = await db.query.leads.findFirst({ where: eq(leads.id, id) });
  if (!row) return null;
  const [client, link, cost, events] = await Promise.all([
    db.query.clients.findFirst({ where: eq(clients.id, row.clientId) }),
    row.trackingLinkId
      ? db.query.leadTrackingLinks.findFirst({
          where: eq(leadTrackingLinks.id, row.trackingLinkId),
        })
      : Promise.resolve(undefined),
    db
      .select({ total: sql<number>`coalesce(sum(${leadEnrichmentLedger.usdMicro}), 0)::int` })
      .from(leadEnrichmentLedger)
      .where(eq(leadEnrichmentLedger.leadId, row.id)),
    db
      .select()
      .from(leadEvents)
      .where(eq(leadEvents.leadId, row.id))
      .orderBy(desc(leadEvents.at))
      .limit(50),
  ]);
  return {
    lead: toLead(row, {
      clientName: client?.name ?? 'Cliente',
      trackingCode: link?.code ?? null,
      costUsdMicro: cost[0]?.total ?? 0,
    }),
    events: events.map((event) => ({
      id: event.id,
      at: event.at.toISOString(),
      kind: event.kind,
      detail: (event.detail ?? {}) as Record<string, unknown>,
    })),
  };
}

export interface LeadListFilter {
  q?: string;
  clientId?: string;
  source?: LeadSource;
  /** Set when the caller's scope is `own`. */
  ownerEmployeeId?: string;
}

export async function listLeads(db: Database, filter: LeadListFilter): Promise<LeadListItem[]> {
  const conditions = [];
  if (filter.ownerEmployeeId) conditions.push(eq(leads.ownerEmployeeId, filter.ownerEmployeeId));
  if (filter.clientId) conditions.push(eq(leads.clientId, filter.clientId));
  if (filter.source) conditions.push(eq(leads.source, filter.source));
  if (filter.q) {
    const needle = `%${filter.q.toLowerCase()}%`;
    const digits = filter.q.replace(/\D/g, '');
    conditions.push(
      digits.length >= 4
        ? sql`(lower(coalesce(${leads.name}, '')) like ${needle} or coalesce(${leads.email}, '') like ${needle} or coalesce(${leads.phone}, '') like ${`%${digits}%`})`
        : sql`(lower(coalesce(${leads.name}, '')) like ${needle} or coalesce(${leads.email}, '') like ${needle})`,
    );
  }
  const rows = await db
    .select({
      id: leads.id,
      name: leads.name,
      email: leads.email,
      phone: leads.phone,
      clientName: clients.name,
      clientMapped: leads.clientMapped,
      source: leads.source,
      channel: leads.channel,
      score: leads.enrichmentScore,
      researchState: leads.enrichmentState,
      createdAt: leads.createdAt,
    })
    .from(leads)
    .innerJoin(clients, eq(clients.id, leads.clientId))
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(leads.createdAt))
    .limit(200);
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    email: row.email,
    phone: row.phone,
    clientName: row.clientName,
    clientMapped: row.clientMapped,
    source: row.source as LeadSource,
    channel: (row.channel as LeadChannel | null) ?? null,
    score: row.score,
    researchState: row.researchState as LeadListItem['researchState'],
    createdAt: row.createdAt.toISOString(),
  }));
}
