import { normalizeBrazilianPhone, normalizeEmail, type LeadPipeline } from '@wings/shared';
import { and, asc, desc, eq, isNotNull, lt, lte, sql } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import {
  adAds,
  adCampaigns,
  crmDistributionMembers,
  employees,
  leadEvents,
  leadSourceRules,
  leads,
  metaLeadForms,
  metaLeadgenEvents,
} from '../../db/schema/index.js';
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
import { ensureFirstContactTask, entryStageOf } from './crm.js';
import { classifyUnruledForm, noticeUnclassifiedForm } from './meta-form-routing.js';
import { POLL_EVERY_MS, pollMetaLeadsLocked } from './meta-poll.js';
import { announceBackfill, announceLeadArrival, type BackfillTally } from './crm-alerts.js';
import { resolveMetaSource, upsertLead, answersPhone, isWorkableLead } from './service.js';

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
/** Same for a TikTok Lead Ads deal. */
export const RD_TIKTOK_SOURCE_CANDIDATES = ['TikTok Lead Ads', 'TikTok Ads', 'TikTok'];

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
  const backfill: BackfillTally = new Map();
  const crm =
    deps.rdCopyEnabled && deps.rdCrmToken ? new RdCrm(deps.rdCrmToken, deps.rdFetch) : null;
  let rows: EventRow[];
  do {
    rows = await deps.db
      .select()
      .from(metaLeadgenEvents)
      .where(
        and(
          eq(metaLeadgenEvents.status, 'pending'),
          // The column keeps microseconds and a JS date stops at the millisecond: an event written
          // in this very millisecond (the webhook's kick) is due too, not "in the future".
          lte(metaLeadgenEvents.nextAttemptAt, new Date(now.getTime() + 1)),
        ),
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
        const outcome = await processOne(deps, claimed, crm, rdMap ?? null, now, backfill);
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
  await announceBackfill(deps.db, backfill, now);
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

/** How a failed event reads on the screen: a warning needs a person to look, an error is the system's. */
export type MetaFailureSeverity = 'warning' | 'error';

export interface MetaFailureReason {
  code: string;
  label: string;
  severity: MetaFailureSeverity;
}

/**
 * The plain-Portuguese reason for a `last_error` code. A lead that arrived with
 * no phone and no e-mail is a warning (nothing broke: the form had nothing to
 * call); every other code is an error. Codes only: no text about the person.
 */
export function metaFailureReason(code: string | null): MetaFailureReason {
  const error = (label: string): MetaFailureReason => ({
    code: code ?? 'unknown',
    label,
    severity: 'error',
  });
  if (code === 'no_contact_data')
    return { code, label: 'Sem telefone nem e-mail', severity: 'warning' };
  if (code === null) return error('Sem motivo registrado');
  if (code === 'no_token') return error('Falta a chave de leitura da Meta');
  if (code === 'graph_unreachable') return error('Não foi possível falar com a Meta');
  if (code === 'lead_missing') return error('O lead criado não foi encontrado');
  if (code === 'error') return error('Erro inesperado ao processar');
  const graph = /^graph_(\d{3})$/.exec(code);
  if (graph) {
    const status = Number(graph[1]);
    if (status === 401 || status === 403)
      return error(`A Meta recusou a chave de leitura (erro ${status})`);
    if (status === 404) return error('A Meta não encontrou esse lead (erro 404)');
    return error(`Erro da Meta (erro ${status})`);
  }
  return error(`Motivo desconhecido (${code})`);
}

export interface MetaFailedEvent {
  leadgenId: string;
  /** When Meta says the form was sent; when it did not say, when the event reached us. */
  leadAt: string;
  formId: string | null;
  formName: string | null;
  adId: string | null;
  /** From the ad mirror; null when the Meta sent no ad or the ad is not mirrored. */
  campaignName: string | null;
  attempts: number;
  reason: MetaFailureReason;
}

export interface MetaFailedEvents {
  /** Every event with status `failed`, whatever the list below shows. */
  total: number;
  items: MetaFailedEvent[];
}

export const META_FAILED_EVENTS_LIMIT = 50;

/**
 * The events that gave up, newest lead first (Eric, 13/10): when, form,
 * campaign and why. Ids, names of our own forms and campaigns and a code: never
 * the person, who was never stored for these.
 */
export async function listFailedMetaEvents(
  db: Database,
  limit = META_FAILED_EVENTS_LIMIT,
): Promise<MetaFailedEvents> {
  const leadAt = sql<Date>`coalesce(${metaLeadgenEvents.createdTime}, ${metaLeadgenEvents.receivedAt})`;
  const [rows, [count]] = await Promise.all([
    db
      .select({
        leadgenId: metaLeadgenEvents.leadgenId,
        leadAt,
        formId: metaLeadgenEvents.formId,
        formName: metaLeadForms.name,
        adId: metaLeadgenEvents.adId,
        campaignName: sql<
          string | null
        >`(select ${adCampaigns.name} from ${adAds} join ${adCampaigns} on ${adCampaigns.id} = ${adAds.campaignId} where ${adAds.externalId} = ${metaLeadgenEvents.adId} limit 1)`,
        attempts: metaLeadgenEvents.attempts,
        lastError: metaLeadgenEvents.lastError,
      })
      .from(metaLeadgenEvents)
      .leftJoin(metaLeadForms, eq(metaLeadForms.formId, metaLeadgenEvents.formId))
      .where(eq(metaLeadgenEvents.status, 'failed'))
      .orderBy(desc(leadAt), asc(metaLeadgenEvents.leadgenId))
      .limit(limit),
    db
      .select({ total: sql<number>`count(*)::int` })
      .from(metaLeadgenEvents)
      .where(eq(metaLeadgenEvents.status, 'failed')),
  ]);
  return {
    total: count?.total ?? 0,
    items: rows.map((row) => ({
      leadgenId: row.leadgenId,
      leadAt: new Date(row.leadAt).toISOString(),
      formId: row.formId,
      formName: row.formName,
      adId: row.adId,
      campaignName: row.campaignName,
      attempts: row.attempts,
      reason: metaFailureReason(row.lastError),
    })),
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
  backfill: BackfillTally,
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

    const phone = normalizeBrazilianPhone(details.phone ?? answersPhone(details.answers));
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
      // A person whose lead is closed, or has neither owner nor stage, gets a
      // deal of their own (Eric, 09/10): a form lead always reaches a seller.
      reopenClosed: true,
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
      originCreatedAt: details.createdTime ?? row.createdTime ?? null,
      enteredAt: details.createdTime ?? row.createdTime ?? null,
      enteredAtSource: 'meta_created_time',
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
        ...(upserted.reopenedFromLeadId ? { reopenedFrom: upserted.reopenedFromLeadId } : {}),
      },
    });
    leadId = upserted.lead.id;
    if (upserted.created && upserted.stale)
      backfill.set(
        upserted.assignedTo ?? null,
        (backfill.get(upserted.assignedTo ?? null) ?? 0) + 1,
      );
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
export interface OriginFacts {
  /** What the OBS says first; Meta Lead Ads when absent. */
  label?: string;
  /** RD CRM "Origem" names to try, in order; Meta's list when absent. */
  sourceCandidates?: readonly string[];
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

export type RdOutcome =
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
export async function copyToRd(
  deps: Pick<MetaIntakeDeps, 'db' | 'expansionOwnerId'>,
  input: {
    crm: RdCrm | null;
    rdMap: CrmMap | null;
    leadId: string;
    rdDealId: string | null;
    pipeline: LeadPipeline | null;
    brand: string | null;
    person: { name: string | null; email: string | null; phone: string | null };
    origin: OriginFacts;
    /** The `via` the timeline records; Meta's when absent. */
    via?: string;
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
    await recordDeal(deps.db, input.leadId, open.id, input.pipeline, 'rd.deal_linked', input.via);
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
  await recordDeal(deps.db, input.leadId, dealId, input.pipeline, 'rd.deal_created', input.via);
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
  const sourceName = (input.origin.sourceCandidates ?? RD_SOURCE_CANDIDATES).find((candidate) =>
    map.sources.has(candidate),
  );
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
    details.label ?? 'Meta Lead Ads',
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
  via = 'meta_lead_ads',
): Promise<void> {
  await db
    .update(leads)
    .set({ rdDealId: dealId, rdPipeline: RD_TARGETS[pipeline].pipeline, updatedAt: new Date() })
    .where(and(eq(leads.id, leadId), sql`${leads.rdDealId} is null`));
  await db.insert(leadEvents).values({
    leadId,
    kind,
    detail: { rdDealId: dealId, pipeline, via },
  });
}

// --- reprocessing one event ---------------------------------------------------

/** What `reprocessMetaLeadgenEvent` found and did: ids, statuses and first names only. */
export interface MetaReprocessReport {
  mode: 'estado' | 'simular' | 'aplicar';
  event: {
    id: string;
    leadgenId: string;
    status: string;
    leadId: string | null;
    leadCreated: boolean;
    rdOutcome: string | null;
    rdDealId: string | null;
    createdTime: string | null;
  };
  /** The lead the event is tied to today, if any. */
  attachedTo: {
    id: string;
    source: string;
    pipeline: string | null;
    stage: string | null;
    owner: string | null;
    closed: boolean;
    workable: boolean;
    rdDealId: string | null;
  } | null;
  /** Why nothing can be done, when so. */
  refusal: string | null;
  /** What a run would do (simular) or did (aplicar). */
  plan: {
    opensNewLead: boolean;
    pipeline: string | null;
    entryStage: string | null;
    nextInRotation: string | null;
    rd: 'would_create' | 'would_link_open_deal' | 'disabled' | 'no_pipeline' | 'unknown';
    openRdDealId: string | null;
  } | null;
  /** aplicar only. */
  result: {
    newLeadId: string | null;
    owner: string | null;
    stage: string | null;
    task: boolean;
    rdOutcome: string | null;
    rdDealId: string | null;
  } | null;
}

/**
 * Runs one processed event again under today's rules (`reopenClosed`), for a
 * form lead that was only attached to a closed or unworked lead and so never
 * reached a seller. `estado` reads; `simular` also reads the Graph API, the
 * rotation and RD (no write anywhere); `aplicar` clears the event's outcome
 * and processes it like a new arrival, then gives the new lead its
 * first-contact task and arrival notice however old the form is. Only an
 * event that is `done` and did not create its lead is accepted.
 */
export async function reprocessMetaLeadgenEvent(
  deps: MetaIntakeDeps,
  leadgenId: string,
  mode: MetaReprocessReport['mode'],
): Promise<MetaReprocessReport> {
  const now = deps.now?.() ?? new Date();
  const row = await deps.db.query.metaLeadgenEvents.findFirst({
    where: eq(metaLeadgenEvents.leadgenId, leadgenId),
  });
  if (!row) throw new IntakeRefusal('event_missing', true);
  const attached = row.leadId
    ? await deps.db.query.leads.findFirst({ where: eq(leads.id, row.leadId) })
    : undefined;
  const ownerName = async (id: string | null) =>
    id
      ? ((
          await deps.db.query.employees.findFirst({
            where: eq(employees.id, id),
            columns: { fullName: true },
          })
        )?.fullName.split(' ')[0] ?? null)
      : null;
  const report: MetaReprocessReport = {
    mode,
    event: {
      id: row.id,
      leadgenId: row.leadgenId,
      status: row.status,
      leadId: row.leadId,
      leadCreated: row.leadCreated === true,
      rdOutcome: row.rdOutcome,
      rdDealId: row.rdDealId,
      createdTime: row.createdTime?.toISOString() ?? null,
    },
    attachedTo: attached
      ? {
          id: attached.id,
          source: attached.source,
          pipeline: attached.pipeline,
          stage: attached.stage,
          owner: await ownerName(attached.ownerEmployeeId),
          closed: attached.won !== null || attached.closedAt !== null,
          workable: isWorkableLead(attached),
          rdDealId: attached.rdDealId,
        }
      : null,
    refusal: null,
    plan: null,
    result: null,
  };
  if (row.status !== 'done') report.refusal = `evento ${row.status}, não done`;
  else if (row.leadCreated) report.refusal = 'o evento criou o próprio lead: nada a reabrir';
  else if (!attached) report.refusal = 'o evento não está ligado a lead nenhum';
  else if (isWorkableLead(attached))
    report.refusal = 'o lead ligado está aberto e com dono ou etapa: fica anexado';
  if (mode === 'estado' || report.refusal || !attached) return report;

  // simular: the same reads the queue would make, and nothing written.
  if (!deps.accessToken) throw new IntakeRefusal('no_token', false);
  const answer = await fetchMetaLead(row.leadgenId, {
    accessToken: deps.accessToken,
    fetchImpl: deps.graphFetch,
  });
  const details = answer.details;
  const phone = normalizeBrazilianPhone(details.phone ?? answersPhone(details.answers));
  const email = normalizeEmail(details.email);
  if (!phone && !email) throw new IntakeRefusal('no_contact_data', true);
  const formId = details.formId ?? row.formId;
  let client = await resolveMetaSource(deps.db, { formId, campaignId: details.campaignId ?? null });
  if (!client.ruleId) {
    const guess = await classifyUnruledForm(deps.db, formId);
    client = { ...client, pipeline: guess.pipeline, brand: guess.brand };
  }
  const pipeline = client.pipeline;
  const [next] = pipeline
    ? await deps.db
        .select({ employeeId: crmDistributionMembers.employeeId })
        .from(crmDistributionMembers)
        .innerJoin(employees, eq(employees.id, crmDistributionMembers.employeeId))
        .where(
          and(
            eq(crmDistributionMembers.pipeline, pipeline),
            eq(crmDistributionMembers.active, true),
            eq(employees.status, 'active'),
          ),
        )
        .orderBy(
          sql`${crmDistributionMembers.lastAssignedAt} asc nulls first`,
          asc(crmDistributionMembers.updatedAt),
        )
        .limit(1)
    : [];
  const crm =
    deps.rdCopyEnabled && deps.rdCrmToken ? new RdCrm(deps.rdCrmToken, deps.rdFetch) : null;
  let rd: NonNullable<MetaReprocessReport['plan']>['rd'];
  let openRdDealId: string | null = null;
  if (!crm) rd = 'disabled';
  else if (!pipeline) rd = 'no_pipeline';
  else {
    try {
      const contact = await crm.findContact(email, phone);
      const open = contact?.deals.find((deal) => deal.win === null);
      openRdDealId = open?.id ?? null;
      rd = open ? 'would_link_open_deal' : 'would_create';
    } catch {
      rd = 'unknown';
    }
  }
  report.plan = {
    opensNewLead: true,
    pipeline,
    entryStage: pipeline ? RD_TARGETS[pipeline].stage : null,
    nextInRotation: await ownerName(next?.employeeId ?? null),
    rd,
    openRdDealId,
  };
  if (mode === 'simular') return report;

  // aplicar: the event forgets its outcome and goes through the queue's own path.
  const [cleared] = await deps.db
    .update(metaLeadgenEvents)
    .set({
      leadId: null,
      leadCreated: false,
      rdDealId: null,
      rdOutcome: null,
      lastError: null,
      processedAt: null,
      attempts: row.attempts + 1,
    })
    .where(and(eq(metaLeadgenEvents.id, row.id), eq(metaLeadgenEvents.leadId, attached.id)))
    .returning();
  if (!cleared) throw new IntakeRefusal('event_changed', true);
  let rdMap: CrmMap | null = null;
  if (crm) {
    try {
      rdMap = await crm.map();
    } catch {
      rdMap = null;
    }
  }
  const backfill: BackfillTally = new Map();
  try {
    await processOne(deps, cleared, crm, rdMap, now, backfill);
  } catch (error) {
    // Nothing was made: the event is tied back to the lead it had.
    await deps.db
      .update(metaLeadgenEvents)
      .set({
        leadId: attached.id,
        leadCreated: false,
        rdDealId: row.rdDealId,
        rdOutcome: row.rdOutcome,
        processedAt: row.processedAt,
        lastError: 'reprocess_failed',
      })
      .where(and(eq(metaLeadgenEvents.id, row.id), sql`${metaLeadgenEvents.leadId} is null`));
    throw error;
  }
  const after = await deps.db.query.metaLeadgenEvents.findFirst({
    where: eq(metaLeadgenEvents.id, row.id),
  });
  const lead = after?.leadId
    ? await deps.db.query.leads.findFirst({ where: eq(leads.id, after.leadId) })
    : undefined;
  // The form is old, so the queue made no task and no notice: the seller gets both now.
  let task = false;
  if (lead && after?.leadCreated && lead.ownerEmployeeId) {
    await ensureFirstContactTask(deps.db, lead, null, now, { force: true });
    await announceLeadArrival(deps.db, lead);
    task = true;
  }
  await writeAudit(deps.db, {
    action: 'lead.meta_reprocessed',
    entity: 'lead',
    entityId: lead?.id ?? row.leadId ?? row.id,
    metadata: {
      leadgenEventId: row.id,
      previousLeadId: row.leadId,
      newLeadId: after?.leadCreated ? (after.leadId ?? null) : null,
      rdOutcome: after?.rdOutcome ?? null,
    },
  });
  report.result = {
    newLeadId: after?.leadCreated ? (after.leadId ?? null) : null,
    owner: await ownerName(lead?.ownerEmployeeId ?? null),
    stage: lead?.stage ?? null,
    task,
    rdOutcome: after?.rdOutcome ?? null,
    rdDealId: after?.rdDealId ?? null,
  };
  return report;
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
