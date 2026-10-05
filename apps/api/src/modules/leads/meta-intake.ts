import { normalizeBrazilianPhone, normalizeEmail, type LeadPipeline } from '@wings/shared';
import { and, asc, eq, isNotNull, lt, lte, sql } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import { leadEvents, leadSourceRules, leads, metaLeadgenEvents } from '../../db/schema/index.js';
import { writeAudit } from '../../lib/audit.js';
import { RdCrm, type CrmMap, type NewDeal } from '../expansion/rd.js';
import { shapeOf } from '../media/kairogen-adapter.js';
import {
  fetchFormLeads,
  fetchMetaLead,
  MetaLeadFetchError,
  type MetaLeadDetails,
  type MetaLeadgenEvent,
} from './meta-leads.js';
import { entryStageOf } from './crm.js';
import { classifyUnruledForm, noticeUnclassifiedForm } from './meta-form-routing.js';
import { POLL_EVERY_MS, pollMetaLeadsLocked } from './meta-poll.js';
import { resolveMetaSource, upsertLead } from './service.js';

/**
 * Meta Lead Ads → Funil → RD CRM (docs/leads/meta-lead-ads.md).
 *
 * The webhook stores each `leadgen` change (`enqueueMetaLeadgenEvents`) and
 * answers 200 at once; `processMetaLeadgenEvents` then, for each pending row:
 *
 *  1. reads the form's answers from the Graph API (`leads_retrieval`);
 *  2. finds the rule for the form (else the campaign) → client, brand, funnel;
 *  3. creates the lead, or merges it into the one with the same phone or
 *     e-mail (`upsertLead`), with the whole origin: campaign, ad set, ad,
 *     form and platform;
 *  4. makes the copy in RD CRM: Formatação → "Sem contato", Expansão →
 *     "Novo Contato", unless the contact already has an open deal there.
 *
 * A re-sent webhook is a no-op (unique `leadgen_id`). A Graph read that
 * fails is retried with a growing delay; a lead with no phone and no e-mail
 * is not created (nothing to dedupe by, nothing a seller could call). The RD
 * write is made once: if it fails after the call was sent, the row is marked
 * `unknown` for a person to check, never retried. Logs carry ids, codes and
 * shapes only.
 */

export const META_LEADGEN_JOB = 'meta-leadgen-intake';
/** The raw webhook payload is kept this long (requisito LGPD: no máximo 90 dias). */
export const META_PAYLOAD_RETENTION_DAYS = 90;
const MAX_ATTEMPTS = 8;
/** Minutes until the next try, by attempt number (1-based). */
const BACKOFF_MINUTES = [1, 5, 15, 60, 180, 360, 720, 1440];
const BATCH = 50;
/** Rows one pass may take (a historical sync can queue hundreds). */
const MAX_PER_PASS = 1000;

const RD_TARGETS: Record<LeadPipeline, { pipeline: string; stage: string }> = {
  expansao: { pipeline: 'Expansão', stage: 'Novo Contato' },
  formatacao: { pipeline: 'Formatação', stage: 'Sem contato' },
  consultoria: { pipeline: 'Consultoria', stage: 'Novo contato' },
};
/** RD CRM "Origem" names tried for a Lead Ads deal, first that exists wins; none invented. */
const RD_SOURCE_CANDIDATES = ['Meta Lead Ads', 'Facebook Lead Ads', 'Lead Ads', 'Facebook Ads'];

export interface MetaIntakeDeps {
  db: Database;
  /** Token that reads leads (`leads_retrieval`); none → events wait. */
  accessToken: string | null;
  /** RD CRM token; none → no copy in RD (`rd_outcome = disabled`). */
  rdCrmToken: string | null;
  /** RD CRM user who owns the Expansão deals (not a secret); null leaves them unassigned. */
  expansionOwnerId: string | null;
  /** Off switch for the RD copy (META_LEADS_RD_COPY_ENABLED=false). */
  rdCopyEnabled: boolean;
  graphFetch?: typeof fetch;
  rdFetch?: typeof fetch;
  log: (facts: Record<string, unknown>) => void;
  now?: () => Date;
}

/** Stores the events of one webhook body; a leadgen id seen before is ignored. Returns how many are new. */
export async function enqueueMetaLeadgenEvents(
  db: Database,
  events: readonly MetaLeadgenEvent[],
): Promise<number> {
  let queued = 0;
  for (const event of events) {
    const [row] = await db
      .insert(metaLeadgenEvents)
      .values({
        leadgenId: event.leadgenId,
        formId: event.formId,
        pageId: event.pageId,
        adId: event.adId,
        adgroupId: event.adgroupId,
        createdTime: event.createdTime,
        payload: event.raw ?? null,
      })
      .onConflictDoNothing()
      .returning({ id: metaLeadgenEvents.id });
    if (row) queued += 1;
  }
  return queued;
}

export interface MetaIntakeRunResult {
  processed: number;
  done: number;
  retried: number;
  failed: number;
  rdCreated: number;
}

type EventRow = typeof metaLeadgenEvents.$inferSelect;

/** One pass over the pending events whose time has come. Safe to call from several places; a row is taken once. */
export async function processMetaLeadgenEvents(deps: MetaIntakeDeps): Promise<MetaIntakeRunResult> {
  const now = deps.now?.() ?? new Date();
  const result: MetaIntakeRunResult = {
    processed: 0,
    done: 0,
    retried: 0,
    failed: 0,
    rdCreated: 0,
  };
  let rdMap: CrmMap | null | undefined;
  const crm =
    deps.rdCopyEnabled && deps.rdCrmToken ? new RdCrm(deps.rdCrmToken, deps.rdFetch) : null;
  let rows: EventRow[];
  do {
    rows = await deps.db
      .select()
      .from(metaLeadgenEvents)
      .where(
        and(eq(metaLeadgenEvents.status, 'pending'), lte(metaLeadgenEvents.nextAttemptAt, now)),
      )
      .orderBy(asc(metaLeadgenEvents.receivedAt))
      .limit(BATCH);
    for (const row of rows) {
      // Claim the row: two loops (webhook kick + scheduler) never take the same one.
      const [claimed] = await deps.db
        .update(metaLeadgenEvents)
        .set({ attempts: row.attempts + 1, nextAttemptAt: new Date(now.getTime() + 10 * 60_000) })
        .where(and(eq(metaLeadgenEvents.id, row.id), eq(metaLeadgenEvents.attempts, row.attempts)))
        .returning();
      if (!claimed) continue;
      result.processed += 1;
      try {
        if (rdMap === undefined && crm) {
          try {
            rdMap = await crm.map();
          } catch {
            rdMap = null;
          }
        }
        const outcome = await processOne(deps, claimed, crm, rdMap ?? null, now);
        if (outcome === 'done') result.done += 1;
        if (outcome === 'rd_retry') result.retried += 1;
        if (outcome === 'rd_created') {
          result.done += 1;
          result.rdCreated += 1;
        }
      } catch (error) {
        const code =
          error instanceof MetaLeadFetchError
            ? `graph_${error.status}`
            : error instanceof IntakeRefusal
              ? error.code
              : 'error';
        const permanent =
          error instanceof IntakeRefusal
            ? error.permanent
            : error instanceof MetaLeadFetchError && error.status !== 429 && error.status < 500;
        const exhausted = claimed.attempts >= MAX_ATTEMPTS;
        await deps.db
          .update(metaLeadgenEvents)
          .set({
            lastError: code,
            ...(permanent || exhausted
              ? { status: 'failed', processedAt: now }
              : { nextAttemptAt: new Date(now.getTime() + backoffMs(claimed.attempts)) }),
          })
          .where(eq(metaLeadgenEvents.id, claimed.id));
        if (permanent || exhausted) result.failed += 1;
        else result.retried += 1;
        deps.log({
          job: META_LEADGEN_JOB,
          eventId: claimed.id,
          attempt: claimed.attempts,
          error: code,
          permanent: permanent || exhausted,
        });
      }
    }
  } while (rows.length === BATCH && result.processed < MAX_PER_PASS);
  return result;
}

export interface MetaSyncResult {
  forms: number;
  /** Lead ids the Graph API listed for the forms in the window. */
  listed: number;
  /** New to the queue (not seen by webhook or an earlier sync). */
  queued: number;
  alreadyKnown: number;
  /** Forms whose listing failed (code per form id). */
  failed: Record<string, string>;
  truncated: number;
}

/**
 * "Buscar leads da Meta": for every active `meta_form` rule, lists the form's
 * leads of the last `days` days (Meta keeps 90) and queues the ones the
 * queue has not seen (`leadgen_id` unique). Each then goes through the same
 * path as a webhook event: Graph read, dedupe by phone and e-mail, the lead,
 * the RD copy. Totals only; nothing about a person is read here.
 */
export async function syncMetaFormLeads(
  deps: MetaIntakeDeps & { days?: number },
): Promise<MetaSyncResult> {
  const result: MetaSyncResult = {
    forms: 0,
    listed: 0,
    queued: 0,
    alreadyKnown: 0,
    failed: {},
    truncated: 0,
  };
  if (!deps.accessToken) throw new IntakeRefusal('no_token', false);
  const now = deps.now?.() ?? new Date();
  const since = new Date(now.getTime() - (deps.days ?? META_PAYLOAD_RETENTION_DAYS) * 86_400_000);
  const rules = await deps.db
    .select({ pattern: leadSourceRules.pattern })
    .from(leadSourceRules)
    .where(and(eq(leadSourceRules.kind, 'meta_form'), eq(leadSourceRules.active, true)));
  for (const rule of rules) {
    result.forms += 1;
    try {
      const page = await fetchFormLeads(rule.pattern, {
        accessToken: deps.accessToken,
        since,
        fetchImpl: deps.graphFetch,
      });
      result.listed += page.leads.length;
      if (page.truncated) result.truncated += 1;
      const queued = await enqueueMetaLeadgenEvents(
        deps.db,
        page.leads.map((lead) => ({
          leadgenId: lead.leadgenId,
          formId: rule.pattern,
          pageId: null,
          adId: lead.adId,
          adgroupId: lead.adsetId,
          createdTime: lead.createdTime,
          raw: {
            source: 'sync',
            id: lead.leadgenId,
            form_id: rule.pattern,
            ad_id: lead.adId,
            adset_id: lead.adsetId,
            campaign_id: lead.campaignId,
          },
        })),
      );
      result.queued += queued;
      result.alreadyKnown += page.leads.length - queued;
    } catch (error) {
      result.failed[rule.pattern] =
        error instanceof MetaLeadFetchError ? `graph_${error.status}` : 'graph_unreachable';
    }
  }
  deps.log({ job: META_LEADGEN_JOB, msg: 'meta form sync', ...result });
  return result;
}

export interface MetaQueueStatus {
  pending: number;
  failed: number;
  done: number;
  /** Done events whose RD copy did not happen (no_pipeline, unknown, failed, stage_missing, disabled). */
  rdMissing: number;
  lastReceivedAt: string | null;
  lastProcessedAt: string | null;
}

export async function metaQueueStatus(db: Database): Promise<MetaQueueStatus> {
  const [row] = await db
    .select({
      pending: sql<number>`(count(*) filter (where ${metaLeadgenEvents.status} = 'pending'))::int`,
      failed: sql<number>`(count(*) filter (where ${metaLeadgenEvents.status} = 'failed'))::int`,
      done: sql<number>`(count(*) filter (where ${metaLeadgenEvents.status} = 'done'))::int`,
      rdMissing: sql<number>`(count(*) filter (where ${metaLeadgenEvents.status} = 'done' and ${metaLeadgenEvents.rdDealId} is null and ${metaLeadgenEvents.rdOutcome} not in ('existing_deal')))::int`,
      lastReceivedAt: sql<string | null>`max(${metaLeadgenEvents.receivedAt})`,
      lastProcessedAt: sql<string | null>`max(${metaLeadgenEvents.processedAt})`,
    })
    .from(metaLeadgenEvents);
  return {
    pending: row?.pending ?? 0,
    failed: row?.failed ?? 0,
    done: row?.done ?? 0,
    rdMissing: row?.rdMissing ?? 0,
    lastReceivedAt: row?.lastReceivedAt ? new Date(row.lastReceivedAt).toISOString() : null,
    lastProcessedAt: row?.lastProcessedAt ? new Date(row.lastProcessedAt).toISOString() : null,
  };
}

const backoffMs = (attempt: number) =>
  (BACKOFF_MINUTES[Math.min(attempt, BACKOFF_MINUTES.length) - 1] ?? 1440) * 60_000;

/** A refusal decided here (not by a remote service); `permanent` ones are not retried. */
class IntakeRefusal extends Error {
  constructor(
    readonly code: string,
    readonly permanent: boolean,
  ) {
    super(code);
    this.name = 'IntakeRefusal';
  }
}

async function processOne(
  deps: MetaIntakeDeps,
  row: EventRow,
  crm: RdCrm | null,
  rdMap: CrmMap | null,
  now: Date,
): Promise<'done' | 'rd_created' | 'rd_retry'> {
  // Step 1 — the lead in the Wings System (skipped on a retry that already made it).
  let leadId = row.leadId;
  let origin: OriginFacts | null = null;
  if (!leadId) {
    if (!deps.accessToken) throw new IntakeRefusal('no_token', false);
    const answer = await fetchMetaLead(row.leadgenId, {
      accessToken: deps.accessToken,
      fetchImpl: deps.graphFetch,
    });
    const details = answer.details;
    deps.log({ job: META_LEADGEN_JOB, msg: 'meta lead fetched', shape: shapeOf(answer.raw) });

    const phone = normalizeBrazilianPhone(details.phone);
    const email = normalizeEmail(details.email);
    if (!phone && !email) throw new IntakeRefusal('no_contact_data', true);

    const formId = details.formId ?? row.formId;
    const campaignId = details.campaignId ?? null;
    let client = await resolveMetaSource(deps.db, { formId, campaignId });
    // No rule for the form or the campaign: the form's own name says the funnel; if it does
    // not, Formatação, and Diretoria gets one notice about the form.
    let guessed = false;
    if (!client.ruleId) {
      const guess = await classifyUnruledForm(deps.db, formId);
      client = {
        clientId: guess.clientId ?? client.clientId,
        mapped: guess.clientId !== null,
        ruleId: null,
        pipeline: guess.pipeline,
        brand: guess.brand,
      };
      guessed = guess.guessed;
    }
    // The entry stage of the segment's funnel exists before the lead lands in it (names are RD's).
    if (client.pipeline) await ensureEntryStage(deps.db, client.pipeline);
    const upserted = await upsertLead(deps.db, {
      source: 'meta_lead_ads',
      name: details.name,
      email,
      phone,
      clientId: client.clientId,
      clientMapped: client.mapped,
      pipeline: client.pipeline,
      brand: client.brand,
      channel: 'meta_lead_ads',
      campaignId,
      campaignName: details.campaignName,
      formId,
      externalId: row.leadgenId,
      city: details.city,
      formAnswers: Object.keys(details.answers).length > 0 ? details.answers : null,
      legalBasis: 'consent',
      consentedAt: details.createdTime ?? row.createdTime ?? now,
      consentSource: `meta_lead_ads:form:${formId ?? 'desconhecido'}`,
      consentText:
        'Formulário de cadastro do Meta Lead Ads, com a política de privacidade do formulário.',
      attribution: {
        adPlatform: 'meta',
        adCampaignExternalId: campaignId,
        adSetExternalId: details.adsetId,
        adExternalId: details.adId ?? row.adId,
        utmSource: details.platform ? `meta:${details.platform}` : null,
      },
      event: {
        kind: 'lead.received.meta_lead_ads',
        detail: {
          ruleId: client.ruleId,
          formId,
          campaignId,
          adsetId: details.adsetId,
          adId: details.adId ?? row.adId,
          platform: details.platform,
          organic: details.organic,
          answers: Object.keys(details.answers).length,
          leadgenEventId: row.id,
        },
      },
    });
    await writeAudit(deps.db, {
      action: upserted.created ? 'lead.received' : 'lead.merged',
      entity: 'lead',
      entityId: upserted.lead.id,
      metadata: {
        source: 'meta_lead_ads',
        clientMapped: client.mapped,
        pipeline: client.pipeline,
        leadgenEventId: row.id,
        assignedTo: upserted.assignedTo ?? null,
      },
    });
    leadId = upserted.lead.id;
    if (guessed && upserted.created) {
      await deps.db.insert(leadEvents).values({
        leadId,
        kind: 'lead.pipeline_guessed',
        detail: { formId, pipeline: client.pipeline, reason: 'form_without_rule' },
      });
      await noticeUnclassifiedForm(deps.db, formId);
    }
    origin = originFactsOf(details);
    // In the Wings System now, whatever RD says next.
    await deps.db
      .update(metaLeadgenEvents)
      .set({ leadId, leadCreated: upserted.created, lastError: null })
      .where(eq(metaLeadgenEvents.id, row.id));
    deps.log({
      job: META_LEADGEN_JOB,
      eventId: row.id,
      leadId,
      created: upserted.created,
      pipeline: client.pipeline,
      mapped: client.mapped,
    });
  }

  // Step 2 — the copy in RD CRM, never in the way of step 1.
  const lead = await deps.db.query.leads.findFirst({ where: eq(leads.id, leadId) });
  if (!lead) throw new IntakeRefusal('lead_missing', true);
  const rd = await copyToRd(deps, {
    crm,
    rdMap,
    leadId: lead.id,
    rdDealId: lead.rdDealId,
    pipeline: (lead.pipeline as LeadPipeline | null) ?? null,
    brand: lead.brand,
    person: { name: lead.name, email: lead.email, phone: lead.phone },
    origin: origin ?? originFactsOfLead(lead),
  });
  const retryRd = rd.outcome === 'failed' && row.attempts < MAX_ATTEMPTS;
  await deps.db
    .update(metaLeadgenEvents)
    .set(
      retryRd
        ? {
            lastError: 'rd_failed',
            rdOutcome: 'failed',
            nextAttemptAt: new Date(now.getTime() + backoffMs(row.attempts)),
          }
        : {
            status: 'done',
            processedAt: now,
            lastError: rd.outcome === 'failed' ? 'rd_failed' : null,
            rdDealId: rd.dealId,
            rdOutcome: rd.outcome,
          },
    )
    .where(eq(metaLeadgenEvents.id, row.id));
  deps.log({ job: META_LEADGEN_JOB, eventId: row.id, leadId, rd: rd.outcome, retryRd });
  if (retryRd) return 'rd_retry';
  return rd.outcome === 'created' ? 'rd_created' : 'done';
}

/** What the RD deal's OBS says about where the lead came from: ids and ad names, never the person. */
interface OriginFacts {
  platform: string | null;
  formId: string | null;
  campaignId: string | null;
  campaignName: string | null;
  adsetId: string | null;
  adsetName: string | null;
  adId: string | null;
  adName: string | null;
  organic: boolean;
}

const originFactsOf = (details: MetaLeadDetails): OriginFacts => ({
  platform: details.platform,
  formId: details.formId,
  campaignId: details.campaignId,
  campaignName: details.campaignName,
  adsetId: details.adsetId,
  adsetName: details.adsetName,
  adId: details.adId,
  adName: details.adName,
  organic: details.organic,
});

/** On a retry the Graph answer is gone; the lead's own columns say the same, by id. */
const originFactsOfLead = (lead: typeof leads.$inferSelect): OriginFacts => ({
  platform: lead.utmSource?.startsWith('meta:') ? lead.utmSource.slice(5) : null,
  formId: lead.formId,
  campaignId: lead.adCampaignExternalId,
  campaignName: lead.campaignName,
  adsetId: lead.adSetExternalId,
  adsetName: null,
  adId: lead.adExternalId,
  adName: null,
  organic: false,
});

/** The first stage of each funnel, as RD CRM names them; made once, then the manager owns the list. */
export async function ensureEntryStage(db: Database, pipeline: LeadPipeline): Promise<void> {
  await entryStageOf(db, pipeline);
}

type RdOutcome =
  | 'created'
  | 'existing_deal'
  | 'no_pipeline'
  | 'no_contact_data'
  | 'disabled'
  | 'stage_missing'
  | 'unknown'
  | 'failed';

/**
 * The copy in RD CRM during the transition (Eric, 05/10): the deal goes to
 * the funnel of the lead's segment, in its entry stage. A lead that already
 * has a deal, or whose contact has an open one in RD, gets no second deal.
 * One POST, never retried: an answer lost on the way leaves `unknown`.
 */
async function copyToRd(
  deps: MetaIntakeDeps,
  input: {
    crm: RdCrm | null;
    rdMap: CrmMap | null;
    leadId: string;
    rdDealId: string | null;
    pipeline: LeadPipeline | null;
    brand: string | null;
    person: { name: string | null; email: string | null; phone: string | null };
    origin: OriginFacts;
  },
): Promise<{ outcome: RdOutcome; dealId: string | null }> {
  if (input.rdDealId) return { outcome: 'existing_deal', dealId: input.rdDealId };
  if (!input.crm) return { outcome: 'disabled', dealId: null };
  if (!input.pipeline) return { outcome: 'no_pipeline', dealId: null };
  if (!input.rdMap) return { outcome: 'failed', dealId: null };
  if (!input.person.email && !input.person.phone)
    return { outcome: 'no_contact_data', dealId: null };

  let contact: Awaited<ReturnType<RdCrm['findContact']>>;
  try {
    contact = await input.crm.findContact(input.person.email, input.person.phone);
  } catch {
    return { outcome: 'failed', dealId: null };
  }
  const open = contact?.deals.find((deal) => deal.win === null);
  if (open) {
    await recordDeal(deps.db, input.leadId, open.id, input.pipeline, 'rd.deal_linked');
    return { outcome: 'existing_deal', dealId: open.id };
  }

  const deal = dealFor(input, input.rdMap, deps.expansionOwnerId);
  if (!deal) return { outcome: 'stage_missing', dealId: null };
  let dealId: string;
  try {
    dealId = await input.crm.createDeal(deal);
  } catch {
    // The POST may have gone through: nobody retries it (a duplicate in RD is worse).
    return { outcome: 'unknown', dealId: null };
  }
  await recordDeal(deps.db, input.leadId, dealId, input.pipeline, 'rd.deal_created');
  return { outcome: 'created', dealId };
}

function dealFor(
  input: {
    pipeline: LeadPipeline | null;
    brand: string | null;
    person: { name: string | null; email: string | null; phone: string | null };
    origin: OriginFacts;
  },
  map: CrmMap,
  expansionOwnerId: string | null,
): NewDeal | null {
  if (!input.pipeline) return null;
  const target = RD_TARGETS[input.pipeline];
  const stageId = map.pipelines.get(target.pipeline)?.stages.get(target.stage);
  if (!stageId) return null;
  const name = input.person.name ?? input.person.email ?? 'Lead';
  const customFields: { id: string; value: string }[] = [];
  const brandField = map.customFields.get('Nome da Marca');
  if (input.brand && brandField) customFields.push({ id: brandField, value: input.brand });
  const obsField = map.customFields.get('OBS');
  if (obsField) customFields.push({ id: obsField, value: describeOrigin(input.origin) });
  const sourceName = RD_SOURCE_CANDIDATES.find((candidate) => map.sources.has(candidate));
  const campaignId = input.origin.campaignName
    ? (map.campaigns.get(input.origin.campaignName) ?? null)
    : null;
  return {
    name: input.brand ? `${name} - ${input.brand}` : name,
    stageId,
    contact: { name, email: input.person.email, phone: input.person.phone },
    sourceId: sourceName ? (map.sources.get(sourceName) ?? null) : null,
    campaignId,
    // Same rule as the Expansão intake: Fernando (EXPANSION_OWNER_RD_USER_ID) owns Expansão deals; Formatação's stay unassigned.
    ownerId: input.pipeline === 'expansao' ? expansionOwnerId : null,
    customFields,
  };
}

/** The OBS field of the RD deal: where the lead came from, ids and names of the ad, never the person. */
export function describeOrigin(details: OriginFacts): string {
  const parts = [
    'Meta Lead Ads',
    details.platform && `plataforma=${details.platform}`,
    details.formId && `formulário=${details.formId}`,
    details.campaignName && `campanha=${details.campaignName}`,
    details.campaignId && `campanha_id=${details.campaignId}`,
    details.adsetName
      ? `conjunto=${details.adsetName}`
      : details.adsetId && `conjunto_id=${details.adsetId}`,
    details.adName ? `anúncio=${details.adName}` : details.adId && `anúncio_id=${details.adId}`,
    details.organic && 'orgânico',
  ].filter(Boolean);
  return parts.join(' · ').slice(0, 1000);
}

async function recordDeal(
  db: Database,
  leadId: string,
  dealId: string,
  pipeline: LeadPipeline,
  kind: 'rd.deal_created' | 'rd.deal_linked',
): Promise<void> {
  await db
    .update(leads)
    .set({ rdDealId: dealId, rdPipeline: RD_TARGETS[pipeline].pipeline, updatedAt: new Date() })
    .where(and(eq(leads.id, leadId), sql`${leads.rdDealId} is null`));
  await db.insert(leadEvents).values({
    leadId,
    kind,
    detail: { rdDealId: dealId, pipeline, via: 'meta_lead_ads' },
  });
}

/** Drops the raw payload of events older than the retention; the row (ids) stays so a re-send is still a no-op. */
export async function purgeMetaLeadgenPayloads(
  db: Database,
  now = new Date(),
): Promise<{ purged: number }> {
  const cutoff = new Date(now.getTime() - META_PAYLOAD_RETENTION_DAYS * 86_400_000);
  const rows = await db
    .update(metaLeadgenEvents)
    .set({ payload: null })
    .where(and(isNotNull(metaLeadgenEvents.payload), lt(metaLeadgenEvents.receivedAt, cutoff)))
    .returning({ id: metaLeadgenEvents.id });
  return { purged: rows.length };
}

/**
 * The loop: a tick every `tickMs` (retries and payload purge), plus `kick()`
 * right after a webhook so a new lead is in the Funil within seconds. One
 * pass at a time per process. Never started by `buildApp`.
 */
export function startMetaLeadgenIntake(
  deps: MetaIntakeDeps & {
    tickMs?: number;
    /** Reading the forms with just the key, every `everyMs` (5 min); on whenever there is a key. */
    poll?: { enabled: boolean; everyMs?: number; extraPageIds?: string[] };
  },
): {
  kick: () => void;
  runOnce: () => Promise<MetaIntakeRunResult>;
  stop: () => void;
} {
  let running: Promise<MetaIntakeRunResult> | null = null;
  const runOnce = () => {
    if (running) return running;
    running = processMetaLeadgenEvents(deps)
      .catch((error: unknown) => {
        deps.log({
          job: META_LEADGEN_JOB,
          error: error instanceof Error ? error.message.slice(0, 200) : 'unknown',
        });
        return { processed: 0, done: 0, retried: 0, failed: 0, rdCreated: 0 };
      })
      .finally(() => {
        running = null;
      });
    return running;
  };
  let purgedOn = '';
  let lastPollAt = 0;
  let polling = false;
  const pollIfDue = async () => {
    if (!deps.poll?.enabled || !deps.accessToken || polling) return;
    const clock = (deps.now?.() ?? new Date()).getTime();
    if (lastPollAt !== 0 && clock - lastPollAt < (deps.poll.everyMs ?? POLL_EVERY_MS)) return;
    polling = true;
    lastPollAt = clock;
    try {
      await pollMetaLeadsLocked({ ...deps, extraPageIds: deps.poll.extraPageIds });
    } catch (error) {
      deps.log({
        job: META_LEADGEN_JOB,
        msg: 'meta poll failed',
        error: error instanceof Error ? error.message.slice(0, 120) : 'unknown',
      });
    } finally {
      polling = false;
    }
  };
  const tick = async () => {
    await pollIfDue();
    const result = await runOnce();
    if (result.processed > 0) deps.log({ job: META_LEADGEN_JOB, ...result });
    const today = (deps.now?.() ?? new Date()).toISOString().slice(0, 10);
    if (purgedOn !== today) {
      purgedOn = today;
      const { purged } = await purgeMetaLeadgenPayloads(deps.db, deps.now?.());
      if (purged > 0) deps.log({ job: META_LEADGEN_JOB, purgedPayloads: purged });
    }
  };
  const timer = setInterval(() => void tick(), deps.tickMs ?? 60_000);
  timer.unref();
  return {
    kick: () => void runOnce(),
    runOnce,
    stop: () => clearInterval(timer),
  };
}
