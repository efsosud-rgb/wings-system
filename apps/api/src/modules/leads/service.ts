import {
  EMPTY_FACTS,
  INACTIVE_OWNER,
  LEAD_PIPELINES,
  NO_OWNER,
  landingPageKeysOf,
  matchSourceRule,
  normalizeBrazilianPhone,
  normalizeEmail,
  rdDealUrl,
  WINGS_CLIENT_ID,
  type EnrichmentFacts,
  type FoundLink,
  type Lead,
  type LeadActivity,
  type LeadChannel,
  type LeadEvent,
  type LeadLegalBasis,
  type FunnelSummary,
  type LeadListItem,
  type LeadNote,
  type LeadOutcome,
  type LeadStageHistoryEntry,
  type LeadTask,
  type LeadPipeline,
  type LeadSource,
  type LeadSourceRuleKind,
  type ScoreCriterion,
} from '@wings/shared';
import { and, asc, desc, eq, gte, isNotNull, isNull, lt, or, sql } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import {
  clients,
  crmCompanies,
  employees,
  jobs,
  leadEnrichmentLedger,
  leadEvents,
  leadSourceRules,
  leadTrackingLinks,
  leads,
  rdCrmDeals,
  rdUserMap,
} from '../../db/schema/index.js';
import { activitiesOf } from './activities.js';
import { announceNewLead } from './crm-alerts.js';
import { attachLeadContact, contactsOfLead, findOrCreateCompany } from './contacts.js';
import {
  announceStageEntered,
  ensureFirstContactTask,
  entryStageOf,
  nextInRotation,
  notesOf,
  stageHistoryOf,
  tasksOf,
} from './crm.js';

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
 * keep in Formatação → Clientes and Integrações. A rule naming a brand that
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

/** The brand a link names in its text; Wings Company's own links carry just the code. */
export const brandOfLink = (client: { id: string; name: string }) =>
  client.id === WINGS_CLIENT_ID ? null : client.name;

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
  city?: string | null;
  /** A form's other answers (question -> answer), without the contact fields. */
  formAnswers?: Record<string, string> | null;
  legalBasis?: LeadLegalBasis | null;
  consentedAt?: Date | null;
  consentSource?: string | null;
  consentText?: string | null;
  ownerEmployeeId?: string | null;
  pipeline?: LeadPipeline | null;
  brand?: string | null;
  /** The company the deal is with, found or made by name/CNPJ (CRM núcleo). */
  company?: { name: string; cnpj?: string | null; city?: string | null } | null;
  valueCents?: number | null;
  /** When the person actually arrived, if earlier than now (an imported RD deal's creation); used only for a new lead. */
  arrivedAt?: Date | null;
  /**
   * When the platform says the lead was made (Meta's `created_time`), if the system reads it
   * later. Older than STALE_ARRIVAL_HOURS: the lead still gets its owner from the rotation, but
   * no first-contact task and no arrival notice (a backfill is announced once per read instead).
   */
  originCreatedAt?: Date | null;
  /** The import run creating the lead (`leads.import_batch_id`); used only for a new lead. */
  importBatchId?: string | null;
  /** An import (RD CRM) does not queue the paid research for every lead it brings. */
  skipResearch?: boolean;
  /**
   * A new lead with a funnel and no owner goes to the next seller of the
   * funnel's rotation and gets the first-contact task (CRM Fase 1). Off for
   * the RD import (RD says the owner) and for Sofia's leads until she hands
   * them over. Default on.
   */
  distribute?: boolean;
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
  /** Columns this call filled on a lead that already existed (names only). */
  filled: string[];
  /** The seller the rotation gave a new lead to, when it did. */
  assignedTo?: string | null;
  /** A new lead that was already old when read (see `originCreatedAt`). */
  stale?: boolean;
}

/** A lead older than this when the system reads it is a backfill, not an arrival. */
export const STALE_ARRIVAL_HOURS = 24;

export function isStaleArrival(
  incoming: { originCreatedAt?: Date | null },
  now = new Date(),
): boolean {
  return (
    incoming.originCreatedAt != null &&
    now.getTime() - incoming.originCreatedAt.getTime() > STALE_ARRIVAL_HOURS * 3_600_000
  );
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
  if (!existing.city && incoming.city) patch.city = incoming.city.trim().slice(0, 120);
  if (!existing.formAnswers && incoming.formAnswers) patch.formAnswers = incoming.formAnswers;
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
  if (existing.valueCents === null && typeof incoming.valueCents === 'number')
    patch.valueCents = incoming.valueCents;
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
  const result = await upsertLeadTx(db, incoming);
  // A lead born in a stage starts that stage's automation rules, as entering it
  // would; an import and the RD mirror never do (they can bring thousands).
  if (
    result.created &&
    result.lead.stageId &&
    !incoming.importBatchId &&
    incoming.source !== 'rd_crm'
  )
    await announceStageEntered(result.lead);
  if (result.created && !incoming.importBatchId && !result.stale)
    await announceNewLead(db, result.lead);
  return result;
}

async function upsertLeadTx(db: Database, incoming: IncomingLead): Promise<UpsertResult> {
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
      if (!existing.companyId && incoming.company?.name) {
        const company = await findOrCreateCompany(
          tx,
          incoming.company,
          incoming.event.actorEmployeeId ?? null,
        );
        if (company) patch.companyId = company.company.id;
      }
      const [updated] = await tx
        .update(leads)
        .set({ ...patch, updatedAt: new Date() })
        .where(eq(leads.id, existing.id))
        .returning();
      const lead = updated ?? existing;
      await attachLeadContact(tx, lead, incoming.event.actorEmployeeId ?? null);
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
      return {
        lead: researched ?? lead,
        created: false,
        researchQueued: researched !== null,
        filled: Object.keys(patch),
      };
    }

    // A lead born here starts in the first stage of its funnel and, with no
    // owner, goes to the next seller in the funnel's rotation.
    const pipeline = incoming.pipeline ?? null;
    const distribute =
      incoming.distribute ?? (!incoming.importBatchId && incoming.source !== 'rd_crm');
    const entryStage =
      pipeline && !incoming.importBatchId && incoming.source !== 'rd_crm'
        ? await entryStageOf(tx, pipeline)
        : undefined;
    const assignedTo =
      distribute && pipeline && !incoming.ownerEmployeeId
        ? await nextInRotation(tx, pipeline)
        : null;
    const company = incoming.company?.name
      ? await findOrCreateCompany(tx, incoming.company, incoming.event.actorEmployeeId ?? null)
      : null;
    const [created] = await tx
      .insert(leads)
      .values({
        clientId: incoming.clientId,
        clientMapped: incoming.clientMapped,
        name: incoming.name?.trim() || null,
        email,
        phone,
        ownerEmployeeId: incoming.ownerEmployeeId ?? assignedTo ?? null,
        ...(entryStage && !incoming.importBatchId && incoming.source !== 'rd_crm'
          ? {
              stageId: entryStage.id,
              stage: entryStage.name,
              stageOrder: entryStage.position,
              stageChangedAt: new Date(),
            }
          : {}),
        // Run from here from birth when the Wings System decided something
        // (its entry stage, its owner); else RD's follow-up still mirrors it.
        managedBy: incoming.source !== 'rd_crm' && (entryStage || assignedTo) ? 'wings' : 'rd',
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
        city: incoming.city?.trim().slice(0, 120) || null,
        formAnswers: incoming.formAnswers ?? null,
        legalBasis: incoming.legalBasis ?? null,
        consentedAt: incoming.consentedAt ?? null,
        consentSource: incoming.consentSource ?? null,
        consentText: incoming.consentText ?? null,
        pipeline: incoming.pipeline ?? null,
        brand: incoming.brand ?? null,
        companyId: company?.company.id ?? null,
        valueCents: typeof incoming.valueCents === 'number' ? incoming.valueCents : null,
        ...attributionColumns(incoming.attribution),
        ...(incoming.arrivedAt ? { createdAt: incoming.arrivedAt } : {}),
        importBatchId: incoming.importBatchId ?? null,
      })
      .returning();
    if (!created) throw new Error('lead insert returned no row');
    await attachLeadContact(tx, created, incoming.event.actorEmployeeId ?? null);
    await tx.insert(leadEvents).values({
      leadId: created.id,
      kind: incoming.event.kind,
      actorEmployeeId: incoming.event.actorEmployeeId ?? null,
      detail: {
        ...(incoming.event.detail ?? {}),
        matched: 'new',
        clientMapped: incoming.clientMapped,
        ...(created.stageId ? { stageId: created.stageId } : {}),
      },
    });
    if (assignedTo) {
      await tx.insert(leadEvents).values({
        leadId: created.id,
        kind: 'lead.owner_changed',
        detail: { from: null, to: assignedTo, source: 'rotation' },
      });
    }
    const stale = isStaleArrival(incoming);
    if (distribute && created.ownerEmployeeId && !stale) {
      await ensureFirstContactTask(tx, created, incoming.event.actorEmployeeId ?? null);
    }
    if (incoming.skipResearch)
      return { lead: created, created: true, researchQueued: false, filled: [], assignedTo, stale };
    const researched = await enqueueResearch(tx, created.id, null);
    return {
      lead: researched ?? created,
      created: true,
      researchQueued: true,
      filled: [],
      assignedTo,
      stale,
    };
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

const iso = (date: Date | null) => date?.toISOString() ?? null;

export function toLead(
  row: LeadRow,
  extra: {
    clientName: string;
    trackingCode: string | null;
    costUsdMicro: number;
    ownerName?: string | null;
    company?: Lead['company'];
    contacts?: Lead['contacts'];
  },
): Lead {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    phone: row.phone,
    city: row.city,
    formAnswers:
      row.formAnswers && typeof row.formAnswers === 'object'
        ? (row.formAnswers as Record<string, string>)
        : null,
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
    pipeline: (row.pipeline as LeadPipeline | null) ?? null,
    brand: row.brand,
    valueCents: row.valueCents,
    expectedCloseAt: row.expectedCloseAt,
    company: extra.company ?? null,
    contacts: extra.contacts ?? [],
    work: {
      stageId: row.stageId,
      stage: row.stage,
      stageChangedAt: iso(row.stageChangedAt),
      won: row.won,
      closedAt: iso(row.closedAt),
      lostReason: row.lostReason,
      ownerName: extra.ownerName ?? null,
      managedBy: row.managedBy === 'rd' ? 'rd' : 'wings',
    },
    crm: row.rdDealId
      ? {
          rdDealId: row.rdDealId,
          rdUrl: rdDealUrl(row.rdDealId),
          rdPipeline: row.rdPipeline,
          stage: row.stage,
          stageOrder: row.stageOrder,
          stageChangedAt: iso(row.stageChangedAt),
          firstContactAt: iso(row.firstContactAt),
          won: row.won,
          closedAt: iso(row.closedAt),
          lostReason: row.lostReason,
          ownerName: extra.ownerName ?? null,
          syncedAt: iso(row.rdSyncedAt),
        }
      : null,
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
    aiSummary:
      row.aiSummary && typeof row.aiSummary === 'object'
        ? (row.aiSummary as Lead['aiSummary'])
        : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export interface LoadedLead {
  lead: Lead;
  events: LeadEvent[];
  notes: LeadNote[];
  tasks: LeadTask[];
  history: LeadStageHistoryEntry[];
  activities: LeadActivity[];
}

export async function loadLead(db: Database, id: string): Promise<LoadedLead | null> {
  const row = await db.query.leads.findFirst({ where: eq(leads.id, id) });
  if (!row) return null;
  const [notes, tasks, history, activities, contacts, company] = await Promise.all([
    notesOf(db, row.id),
    tasksOf(db, row.id),
    stageHistoryOf(db, row.id),
    activitiesOf(db, row.id),
    contactsOfLead(db, row.id),
    row.companyId
      ? db.query.crmCompanies.findFirst({
          where: eq(crmCompanies.id, row.companyId),
          columns: { id: true, name: true, clientId: true },
        })
      : Promise.resolve(undefined),
  ]);
  const [client, link, cost, events, owner] = await Promise.all([
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
    row.ownerEmployeeId
      ? db.query.employees.findFirst({
          where: eq(employees.id, row.ownerEmployeeId),
          columns: { fullName: true },
        })
      : Promise.resolve(undefined),
  ]);
  return {
    lead: toLead(row, {
      clientName: client?.name ?? 'Cliente',
      trackingCode: link?.code ?? null,
      costUsdMicro: cost[0]?.total ?? 0,
      ownerName: owner?.fullName ?? null,
      company: company ?? null,
      contacts,
    }),
    events: events.map((event) => ({
      id: event.id,
      at: event.at.toISOString(),
      kind: event.kind,
      detail: (event.detail ?? {}) as Record<string, unknown>,
    })),
    notes,
    tasks,
    history,
    activities,
  };
}

export interface LeadListFilter {
  q?: string;
  clientId?: string;
  source?: LeadSource;
  pipeline?: LeadPipeline;
  stage?: string;
  /** An employee id, or INACTIVE_OWNER. */
  owner?: string;
  outcome?: LeadOutcome;
  staleDays?: number;
  createdFrom?: string;
  createdTo?: string;
  activityDays?: number;
  campaign?: string;
  sort?: 'recent' | 'oldest' | 'value_desc' | 'value_asc' | 'stage_time' | 'next_task' | 'name';
  /** Set when the caller's scope is `own`, or when the caller asked for "Minhas". */
  ownerEmployeeId?: string;
}

/** The next open task of a lead (title and due time), as a JSON subquery. */
export const nextTaskSql = sql<{
  title: string;
  dueAt: string;
} | null>`(select json_build_object('title', t.title, 'dueAt', to_char(t.due_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')) from lead_tasks t where t.lead_id = ${leads.id} and t.done_at is null order by t.due_at asc limit 1)`;
export const lastActivitySql = sql<
  string | null
>`(select max(e.at) from lead_events e where e.lead_id = ${leads.id})`;
export const contactNameSql = sql<
  string | null
>`(select c.name from lead_contacts lc join crm_contacts cc on cc.id = lc.contact_id join crm_contacts c on c.id = coalesce(cc.merged_into_id, cc.id) where lc.lead_id = ${leads.id} order by lc."primary" desc, lc.created_at asc limit 1)`;

export function listOrder(sort: LeadListFilter['sort']) {
  switch (sort) {
    case 'oldest':
      return [asc(leads.createdAt)];
    case 'value_desc':
      return [sql`${leads.valueCents} desc nulls last`, desc(leads.createdAt)];
    case 'value_asc':
      return [sql`${leads.valueCents} asc nulls last`, desc(leads.createdAt)];
    case 'stage_time':
      return [sql`${leads.stageChangedAt} asc nulls last`, desc(leads.createdAt)];
    case 'next_task':
      return [
        sql`(select min(t.due_at) from lead_tasks t where t.lead_id = ${leads.id} and t.done_at is null) asc nulls last`,
        desc(leads.createdAt),
      ];
    case 'name':
      return [sql`lower(coalesce(${leads.name}, '')) asc`];
    default:
      return [desc(leads.createdAt)];
  }
}

export const LEAD_LIST_LIMIT = 200;

/**
 * An RD deal whose owner is no one of ours who still works it (Eric, 01/10):
 * no owner, an RD user inactive in RD or marked as gone, or one not linked to
 * an employee. Nothing is reassigned; this only names them.
 */
const ownerInactive = sql<boolean>`(${leads.rdDealId} is not null and (${leads.ownerEmployeeId} is null or exists (select 1 from ${rdUserMap} where ${rdUserMap.rdUserId} = ${leads.rdOwnerId} and (not ${rdUserMap.rdActive} or ${rdUserMap.departedAt} is not null))))`;

export function listConditions(filter: LeadListFilter) {
  const conditions = [];
  if (filter.createdFrom)
    conditions.push(gte(leads.createdAt, new Date(`${filter.createdFrom}T00:00:00-03:00`)));
  if (filter.createdTo)
    conditions.push(lt(leads.createdAt, new Date(`${filter.createdTo}T23:59:59.999-03:00`)));
  if (filter.activityDays)
    conditions.push(
      sql`${lastActivitySql} >= ${new Date(Date.now() - filter.activityDays * 86_400_000)}`,
    );
  if (filter.campaign) {
    const needle = `%${filter.campaign.toLowerCase()}%`;
    conditions.push(
      sql`(lower(coalesce(${leads.campaignName}, '')) like ${needle} or coalesce(${leads.campaignId}, '') = ${filter.campaign} or lower(coalesce(${leads.utmCampaign}, '')) like ${needle})`,
    );
  }
  if (filter.ownerEmployeeId) conditions.push(eq(leads.ownerEmployeeId, filter.ownerEmployeeId));
  if (filter.owner === INACTIVE_OWNER) conditions.push(ownerInactive);
  else if (filter.owner === NO_OWNER) conditions.push(isNull(leads.ownerEmployeeId));
  else if (filter.owner) conditions.push(eq(leads.ownerEmployeeId, filter.owner));
  if (filter.clientId) conditions.push(eq(leads.clientId, filter.clientId));
  if (filter.source) conditions.push(eq(leads.source, filter.source));
  if (filter.pipeline) conditions.push(eq(leads.pipeline, filter.pipeline));
  if (filter.stage) conditions.push(eq(leads.stage, filter.stage));
  if (filter.outcome === 'open') conditions.push(isNull(leads.won));
  if (filter.outcome === 'won') conditions.push(eq(leads.won, true));
  if (filter.outcome === 'lost') conditions.push(eq(leads.won, false));
  if (filter.staleDays) {
    // Only open leads whose stage time is known: an unknown one is not "stale", it is unknown.
    conditions.push(isNull(leads.won));
    conditions.push(lt(leads.stageChangedAt, new Date(Date.now() - filter.staleDays * 86_400_000)));
  }
  if (filter.q) {
    const needle = `%${filter.q.toLowerCase()}%`;
    const digits = filter.q.replace(/\D/g, '');
    conditions.push(
      digits.length >= 4
        ? sql`(lower(coalesce(${leads.name}, '')) like ${needle} or coalesce(${leads.email}, '') like ${needle} or coalesce(${leads.phone}, '') like ${`%${digits}%`} or exists (select 1 from crm_companies c where c.id = ${leads.companyId} and lower(c.name) like ${needle}))`
        : sql`(lower(coalesce(${leads.name}, '')) like ${needle} or coalesce(${leads.email}, '') like ${needle} or exists (select 1 from crm_companies c where c.id = ${leads.companyId} and lower(c.name) like ${needle}))`,
    );
  }
  return conditions.length > 0 ? and(...conditions) : undefined;
}

export async function listLeads(
  db: Database,
  filter: LeadListFilter,
  limit = LEAD_LIST_LIMIT,
): Promise<{ leads: LeadListItem[]; total: number }> {
  const where = listConditions(filter);
  const [rows, total] = await Promise.all([
    db
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
        pipeline: leads.pipeline,
        brand: leads.brand,
        stage: leads.stage,
        won: leads.won,
        valueCents: leads.valueCents,
        expectedCloseAt: leads.expectedCloseAt,
        companyName: crmCompanies.name,
        city: leads.city,
        campaignName: leads.campaignName,
        lastActivityAt: lastActivitySql,
        nextTask: nextTaskSql,
        ownerEmployeeId: leads.ownerEmployeeId,
        ownerName: employees.fullName,
        ownerInactive,
        stageChangedAt: leads.stageChangedAt,
      })
      .from(leads)
      .innerJoin(clients, eq(clients.id, leads.clientId))
      .leftJoin(employees, eq(employees.id, leads.ownerEmployeeId))
      .leftJoin(crmCompanies, eq(crmCompanies.id, leads.companyId))
      .where(where)
      .orderBy(...listOrder(filter.sort))
      .limit(limit),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(leads)
      .where(where),
  ]);
  return {
    total: total[0]?.count ?? 0,
    leads: rows.map((row) => ({
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
      pipeline: (row.pipeline as LeadPipeline | null) ?? null,
      brand: row.brand,
      stage: row.stage,
      won: row.won,
      valueCents: row.valueCents,
      expectedCloseAt: row.expectedCloseAt,
      companyName: row.companyName,
      city: row.city,
      campaignName: row.campaignName,
      lastActivityAt: row.lastActivityAt ? new Date(row.lastActivityAt).toISOString() : null,
      nextTask: row.nextTask,
      ownerEmployeeId: row.ownerEmployeeId,
      ownerName: row.ownerInactive ? null : row.ownerName,
      ownerInactive: Boolean(row.ownerInactive),
      stageChangedAt: iso(row.stageChangedAt),
    })),
  };
}

/**
 * The mini-funnel at the top of the Funil: per Expansão brand and for
 * Formatação, the leads that arrived in the last `days` days and how far they
 * got. "Reunião" comes from the RD mirror (`rd_crm_deals.reached_meeting`:
 * current stage at "Reunião realizada" or later, or won); a lead with no RD
 * deal counts as arrived only.
 */
export async function funnelSummary(
  db: Database,
  input: { days: number; ownerEmployeeId?: string },
): Promise<FunnelSummary> {
  const since = new Date(Date.now() - input.days * 86_400_000);
  const scope = input.ownerEmployeeId
    ? eq(leads.ownerEmployeeId, input.ownerEmployeeId)
    : undefined;
  const label = sql<string>`case when ${leads.pipeline} = 'formatacao' then 'Formatação' else coalesce(${leads.brand}, '(sem marca)') end`;
  const [rows, owners, stages, synced, inactive] = await Promise.all([
    db
      .select({
        pipeline: leads.pipeline,
        label,
        arrived: sql<number>`count(*)::int`,
        worked: sql<number>`(count(*) filter (where ${leads.stageOrder} > 1 or ${leads.won} is not null))::int`,
        meeting: sql<number>`(count(*) filter (where ${rdCrmDeals.reachedMeeting}))::int`,
        won: sql<number>`(count(*) filter (where ${leads.won} = true))::int`,
      })
      .from(leads)
      .leftJoin(rdCrmDeals, eq(rdCrmDeals.rdId, leads.rdDealId))
      .where(and(gte(leads.createdAt, since), isNotNull(leads.pipeline), scope))
      .groupBy(leads.pipeline, label),
    db
      .selectDistinct({ id: employees.id, name: employees.fullName })
      .from(leads)
      .innerJoin(employees, eq(employees.id, leads.ownerEmployeeId))
      .where(scope),
    db
      .selectDistinct({ pipeline: leads.pipeline, stage: leads.stage, order: leads.stageOrder })
      .from(leads)
      .where(and(isNotNull(leads.stage), isNotNull(leads.pipeline), scope)),
    db.select({ at: sql<string | null>`max(${leads.rdSyncedAt})` }).from(leads),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(leads)
      .where(and(ownerInactive, isNull(leads.won), scope)),
  ]);
  const syncedAt = synced[0]?.at ? new Date(synced[0].at) : null;
  return {
    days: input.days,
    rows: rows
      .map((row) => ({ ...row, pipeline: row.pipeline as LeadPipeline }))
      .sort((a, b) => a.pipeline.localeCompare(b.pipeline) || b.arrived - a.arrived),
    owners: owners.sort((a, b) => a.name.localeCompare(b.name, 'pt-BR')),
    inactiveOwnerOpen: inactive[0]?.count ?? 0,
    stages: stages
      .map((row) => ({
        pipeline: row.pipeline as LeadPipeline,
        stage: row.stage ?? '',
        order: row.order ?? 0,
      }))
      .sort((a, b) => a.pipeline.localeCompare(b.pipeline) || a.order - b.order),
    syncedAt: syncedAt?.toISOString() ?? null,
  };
}
