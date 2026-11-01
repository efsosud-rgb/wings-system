import {
  DIRECT_WINDOW_HOURS,
  instagramExcerpt,
  placeOfComment,
  PROSPECT_OPEN_STATES,
  repliesAlone,
  type InstagramProspectingSettings,
} from '@wings/shared';
import { and, asc, eq, inArray, isNotNull, lt, lte, sql } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import { WINGS_TENANT_ID } from '../../db/schema/ads.js';
import {
  clients,
  igPeople,
  igWebhookEvents,
  leads,
  prospectClassifications,
  prospectEvidence,
  prospectOpportunities,
} from '../../db/schema/index.js';
import { writeAudit } from '../../lib/audit.js';
import type { AgentLlm } from '../agent/llm.js';
import { contactBlock, recordContactOptOut } from '../leads/contact-block.js';
import { classifyComments, PROMPT_VERSION } from '../prospect-ai/classifier.js';
import { igKey } from '../prospect-ai/paste.js';
import { loadInstagramSettings } from '../prospect-ai/settings.js';
import { isOptOut } from '../whatsapp/webhook-parse.js';
import { mediaPermalink, type InstagramMessagingConfig } from './graph.js';
import { commentOnLead, leadFromDirect } from './lead.js';
import {
  contactsInText,
  parseInstagramComment,
  parseInstagramMessage,
  type IgWebhookEvent,
  type InstagramComment,
} from './payload.js';
import { requestPrivateReply, retryPrivateReplies } from './private-reply.js';

/**
 * The 60-second loop of parte 1 (docs/prospeccao/instagram.md §1.4, §5; spec PA §3.1, §3.2): the
 * webhook only stored the events; here a comment is classified and opens an opportunity (or joins
 * the person's open one, or goes on her lead's timeline), and a Direct message moves the 24-hour
 * window, records a PARAR or makes the lead. A buying comment above the threshold gets the private
 * reply alone only in `automatico`. Logs carry kinds, codes and counts, never text, @ or IGSID.
 */

export const INSTAGRAM_INTAKE_JOB = 'instagram-intake';
const MAX_ATTEMPTS = 8;
const BACKOFF_MINUTES = [1, 5, 15, 60, 180, 360, 720, 1440];
const BATCH = 50;
const DAY_MS = 86_400_000;
/** The raw event (it holds the text) is emptied after this; the row (the key) stays. */
export const IG_PAYLOAD_RETENTION_DAYS = 30;
const PART_ONE_SOURCES = ['instagram_comment', 'instagram_ad_comment'];

export interface InstagramIntakeDeps {
  db: Database;
  fetch: typeof fetch;
  /** Wings' account id: its own comments and messages are never a person's. */
  accountId: string | null;
  /** Reads the permalink of Wings' post; null without the token. */
  messagingToken: string | null;
  replyConfig: InstagramMessagingConfig | null;
  llm: AgentLlm | null;
  aiEnabled: boolean;
  dailyUsd: number;
  now?: () => Date;
  log: (facts: Record<string, unknown>) => void;
}

/** Stores the events of one POST; a repeat (same key) is dropped. Returns how many are new. */
export async function enqueueInstagramEvents(
  db: Database,
  events: IgWebhookEvent[],
): Promise<number> {
  if (events.length === 0) return 0;
  const rows = await db
    .insert(igWebhookEvents)
    .values(
      events.map((event) => ({
        eventKey: event.eventKey,
        kind: event.kind,
        igAccountId: event.igAccountId,
        occurredAt: event.occurredAt,
        payload: event.payload,
      })),
    )
    .onConflictDoNothing()
    .returning({ id: igWebhookEvents.id });
  return rows.length;
}

type Outcome = { status: 'done' | 'ignored' | 'failed'; code?: string; opportunityId?: string };

/** The person by IGSID: created, or the @ (a label) and last seen brought up to date. */
async function personOf(db: Database, igsid: string, username: string | null, at: Date) {
  const [person] = await db
    .insert(igPeople)
    .values({ igsid, username, firstSeenAt: at, lastSeenAt: at, createdAt: at, updatedAt: at })
    .onConflictDoUpdate({
      target: [igPeople.tenantId, igPeople.igsid],
      set: {
        username: username ? username : sql`${igPeople.username}`,
        lastSeenAt: at,
        updatedAt: at,
      },
    })
    .returning();
  return person!;
}

const openOfPerson = (personId: string, states = PROSPECT_OPEN_STATES) =>
  and(
    eq(prospectOpportunities.tenantId, WINGS_TENANT_ID),
    eq(prospectOpportunities.igPersonId, personId),
    inArray(prospectOpportunities.source, PART_ONE_SOURCES),
    inArray(prospectOpportunities.state, states),
  );

async function isClient(db: Database, username: string | null) {
  if (!username) return false;
  const [row] = await db
    .select({ id: clients.id })
    .from(clients)
    .where(eq(igKey(sql`${clients.social}->>'instagram'`), username))
    .limit(1);
  return Boolean(row);
}

async function processComment(
  deps: InstagramIntakeDeps,
  settings: InstagramProspectingSettings,
  event: typeof igWebhookEvents.$inferSelect,
  now: Date,
): Promise<Outcome> {
  const comment = parseInstagramComment(event.payload);
  if (!comment) return { status: 'failed', code: 'payload_invalido' };
  // Wings' own comments (its replies included) never start anything.
  if (comment.fromId === event.igAccountId || comment.fromId === deps.accountId)
    return { status: 'ignored', code: 'conta_wings' };
  const { db } = deps;
  const at = event.occurredAt ?? event.receivedAt;
  const source = comment.adId ? 'instagram_ad_comment' : 'instagram_comment';
  const [seen] = await db
    .select({ id: prospectEvidence.id })
    .from(prospectEvidence)
    .where(
      and(eq(prospectEvidence.source, source), eq(prospectEvidence.externalId, comment.commentId)),
    );
  if (seen) return { status: 'done', code: 'repetido' };
  // "Não contatar" or a client: nothing is kept about the person (§2.4).
  const blocked = await contactBlock(db, 'instagram', {
    instagramUser: comment.fromUsername,
    instagramIgsid: comment.fromId,
  });
  if (blocked.blocked) return { status: 'done', code: 'nao_contatar' };
  if (await isClient(db, comment.fromUsername)) return { status: 'done', code: 'cliente' };

  const person = await personOf(db, comment.fromId, comment.fromUsername, now);
  if (person.leadId) {
    const lead = await db.query.leads.findFirst({ where: eq(leads.id, person.leadId) });
    if (lead) {
      await commentOnLead(db, lead, { ...comment, at });
      return { status: 'done', code: 'ja_e_lead' };
    }
  }
  const evidence = await evidenceOf(deps, settings, comment, source, at);
  // A second comment of someone already in the queue joins her opportunity: no AI, no new row.
  const joined = await db.transaction(async (tx) => joinOpen(tx, person.id, evidence));
  if (joined) return { status: 'done', code: 'juntado', opportunityId: joined };

  const [classified] = await classifyComments([comment.text], {
    db,
    llm: deps.llm,
    enabled: deps.aiEnabled,
    dailyUsd: deps.dailyUsd,
    now,
  });
  const place = placeOfComment(classified!, settings.thresholds);
  // Praise, complaint, spam and low confidence: nothing is created (minimization, §1.4 step 2).
  if (place.state === 'rejeitada') return { status: 'done', code: 'outros' };
  const opportunityId = await db.transaction(async (tx) => {
    const open = await joinOpen(tx, person.id, evidence);
    if (open) return open;
    const [ev] = await tx
      .insert(prospectEvidence)
      .values(evidence)
      .onConflictDoNothing()
      .returning({ id: prospectEvidence.id });
    if (!ev) return null;
    const c = classified!;
    const [opportunity] = await tx
      .insert(prospectOpportunities)
      .values({
        evidenceId: ev.id,
        source,
        state: place.state,
        category: c.category,
        intent: c.intent,
        buySignal: c.signal,
        confidence: c.confidence,
        justification: c.justification,
        needsReviewReason: place.reviewReason,
        respondBy: new Date(at.getTime() + 7 * DAY_MS),
        igPersonId: person.id,
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: prospectOpportunities.id });
    await tx
      .update(prospectEvidence)
      .set({ opportunityId: opportunity!.id })
      .where(eq(prospectEvidence.id, ev.id));
    if (c.method) {
      // One comment per call here: the model's method is `ia`, not the paste's batch.
      const method = c.method === 'ia_lote' ? 'ia' : c.method;
      const [row] = await tx
        .insert(prospectClassifications)
        .values({
          opportunityId: opportunity!.id,
          method,
          category: c.category,
          intent: c.intent,
          buySignal: c.signal,
          confidence: c.confidence,
          justification: c.justification,
          model: c.model,
          promptVersion: method === 'ia' ? PROMPT_VERSION : null,
          runId: c.runId,
          createdAt: now,
        })
        .returning({ id: prospectClassifications.id });
      await tx
        .update(prospectOpportunities)
        .set({ classificationId: row!.id })
        .where(eq(prospectOpportunities.id, opportunity!.id));
    }
    return opportunity!.id;
  });
  if (!opportunityId) return { status: 'done', code: 'repetido' };
  if (
    place.state === 'nova' &&
    repliesAlone(settings.privateReply, classified!.signal, classified!.confidence)
  )
    await requestPrivateReply(
      { db, fetch: deps.fetch, config: deps.replyConfig, settings, now },
      opportunityId,
      'automatico',
      null,
    );
  return { status: 'done', code: place.state, opportunityId };
}

type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];

/**
 * Under a lock on the person: her open opportunity of parte 1, with this evidence joined to it;
 * null when she has none (the caller, in the same transaction, opens one).
 */
async function joinOpen(
  tx: Tx,
  personId: string,
  evidence: Awaited<ReturnType<typeof evidenceOf>>,
) {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`ig_person:${personId}`}))`);
  const [open] = await tx
    .select({ id: prospectOpportunities.id })
    .from(prospectOpportunities)
    .where(openOfPerson(personId))
    .limit(1);
  if (!open) return null;
  await tx
    .insert(prospectEvidence)
    .values({ ...evidence, opportunityId: open.id })
    .onConflictDoNothing();
  return open.id;
}

/** The evidence row of a comment on Wings' media: masked excerpt, ids, 30 days unless a lead. */
async function evidenceOf(
  deps: InstagramIntakeDeps,
  settings: InstagramProspectingSettings,
  comment: InstagramComment,
  source: string,
  at: Date,
) {
  // The permalink of Wings' own post, read once per post when another comment already has it.
  let url: string | null = null;
  if (comment.mediaId) {
    const [known] = await deps.db
      .select({ url: prospectEvidence.url })
      .from(prospectEvidence)
      .where(and(eq(prospectEvidence.mediaId, comment.mediaId), isNotNull(prospectEvidence.url)))
      .limit(1);
    url =
      known?.url ??
      (deps.messagingToken
        ? await mediaPermalink(deps.fetch, deps.messagingToken, comment.mediaId)
        : null);
  }
  return {
    source,
    externalId: comment.commentId,
    url,
    occurredAt: at,
    occurredAtPrecision: 'exata',
    excerpt: instagramExcerpt(comment.text),
    authorIgsid: comment.fromId,
    authorUsername: comment.fromUsername,
    mediaId: comment.mediaId,
    adId: comment.adId,
    legalBasis: 'legitimate_interest',
    retentionUntil: new Date(at.getTime() + settings.retention.instagramSemLeadDias * DAY_MS),
  };
}

async function processMessage(
  deps: InstagramIntakeDeps,
  event: typeof igWebhookEvents.$inferSelect,
  now: Date,
): Promise<Outcome> {
  const message = parseInstagramMessage(event.payload);
  if (!message) return { status: 'failed', code: 'payload_invalido' };
  const { db } = deps;
  const at = message.at ?? event.occurredAt ?? event.receivedAt;
  if (message.isEcho) {
    // Wings answered her in the Direct: the first human answer of her open opportunity.
    const [person] = await db
      .select({ id: igPeople.id })
      .from(igPeople)
      .where(eq(igPeople.igsid, message.recipientId));
    if (person)
      await db
        .update(prospectOpportunities)
        .set({ respondedAt: at, updatedAt: now })
        .where(and(openOfPerson(person.id), sql`${prospectOpportunities.respondedAt} is null`));
    return { status: 'done', code: 'eco' };
  }
  if (message.senderId === event.igAccountId || message.senderId === deps.accountId)
    return { status: 'ignored', code: 'conta_wings' };
  const [known] = await db
    .select()
    .from(igPeople)
    .where(and(eq(igPeople.tenantId, WINGS_TENANT_ID), eq(igPeople.igsid, message.senderId)));
  // Someone who never commented on Wings' media: the Direct-first flow is not parte 1, nothing kept.
  if (!known) return { status: 'done', code: 'sem_comentario' };
  await db
    .update(igPeople)
    .set({ lastInboundAt: at, lastSeenAt: now, updatedAt: now })
    .where(eq(igPeople.id, known.id));

  if (isOptOut(message.text)) {
    await recordContactOptOut(db, {
      instagramIgsid: known.igsid,
      instagramUser: known.username,
      leadId: known.leadId,
      channels: ['instagram'],
      origin: 'instagram',
      reason: 'Pediu para parar pelo Direct do Instagram.',
      createdBy: null,
    });
    const closed = await db
      .update(prospectOpportunities)
      .set({
        state: 'rejeitada',
        decidedAt: now,
        decidedBy: null,
        decisionReason: 'Pediu para parar pelo Direct',
        updatedAt: now,
      })
      .where(openOfPerson(known.id, [...PROSPECT_OPEN_STATES, 'prazo_vencido']))
      .returning({ id: prospectOpportunities.id });
    await writeAudit(db, {
      action: 'prospect_ai.instagram_stop_by_direct',
      entity: 'ig_person',
      entityId: known.id,
      metadata: { closed: closed.length },
    });
    return { status: 'done', code: 'parar' };
  }

  // Meta's 24 hours from her last message: the deadline becomes min(deadline, message + 24 h);
  // an expired one comes back to "Revisar" with the new deadline (spec PA §3.2 step 7).
  const windowEnd = new Date(at.getTime() + DIRECT_WINDOW_HOURS * 3_600_000);
  await db
    .update(prospectOpportunities)
    .set({
      respondBy: sql`least(${prospectOpportunities.respondBy}, ${windowEnd.toISOString()}::timestamptz)`,
      updatedAt: now,
    })
    .where(openOfPerson(known.id));
  await db
    .update(prospectOpportunities)
    .set({ state: 'em_revisao', respondBy: windowEnd, updatedAt: now })
    .where(openOfPerson(known.id, ['prazo_vencido']));
  const [opportunity] = await db
    .select({ row: prospectOpportunities, opening: prospectEvidence })
    .from(prospectOpportunities)
    .innerJoin(prospectEvidence, eq(prospectEvidence.id, prospectOpportunities.evidenceId))
    .where(openOfPerson(known.id))
    .limit(1);
  if (!opportunity || !message.text) return { status: 'done', code: 'janela' };
  await db
    .insert(prospectEvidence)
    .values({
      source: 'instagram_dm',
      externalId: message.mid,
      occurredAt: at,
      excerpt: instagramExcerpt(message.text),
      authorIgsid: known.igsid,
      authorUsername: known.username,
      legalBasis: 'pre_contract',
      retentionUntil: opportunity.opening.retentionUntil,
      opportunityId: opportunity.row.id,
      createdAt: now,
    })
    .onConflictDoNothing();
  const { phone, email } = contactsInText(message.text);
  if (!phone && !email) return { status: 'done', code: 'direct' };
  const lead = await leadFromDirect(db, {
    opportunity: opportunity.row,
    opening: opportunity.opening,
    personId: known.id,
    username: known.username,
    igsid: known.igsid,
    phone,
    email,
    at: now,
  });
  return {
    status: 'done',
    code: 'leadId' in lead ? 'lead' : lead.skipped,
    opportunityId: opportunity.row.id,
  };
}

const backoffMs = (attempt: number) =>
  (BACKOFF_MINUTES[Math.min(attempt, BACKOFF_MINUTES.length) - 1] ?? 1440) * 60_000;

/** One pass: up to 50 due events, each claimed by compare-and-set so two passes never share one. */
export async function processInstagramEvents(
  deps: InstagramIntakeDeps,
): Promise<{ processed: number; done: number; failed: number; retried: number }> {
  const now = deps.now?.() ?? new Date();
  const result = { processed: 0, done: 0, failed: 0, retried: 0 };
  const rows = await deps.db
    .select()
    .from(igWebhookEvents)
    .where(
      and(
        eq(igWebhookEvents.status, 'pending'),
        lte(igWebhookEvents.nextAttemptAt, new Date(now.getTime() + 1)),
      ),
    )
    .orderBy(asc(igWebhookEvents.receivedAt))
    .limit(BATCH);
  const settings = await loadInstagramSettings(deps.db);
  for (const row of rows) {
    const [claimed] = await deps.db
      .update(igWebhookEvents)
      .set({ attempts: row.attempts + 1, nextAttemptAt: new Date(now.getTime() + 10 * 60_000) })
      .where(and(eq(igWebhookEvents.id, row.id), eq(igWebhookEvents.attempts, row.attempts)))
      .returning();
    if (!claimed) continue;
    result.processed += 1;
    try {
      const outcome =
        claimed.kind === 'comment'
          ? await processComment(deps, settings, claimed, now)
          : claimed.kind === 'message' || claimed.kind === 'echo'
            ? await processMessage(deps, claimed, now)
            : ({ status: 'ignored', code: 'tipo' } as Outcome);
      await deps.db
        .update(igWebhookEvents)
        .set({
          status: outcome.status,
          lastError: outcome.status === 'failed' ? (outcome.code ?? null) : null,
          processedAt: now,
          opportunityId: outcome.opportunityId ?? null,
        })
        .where(eq(igWebhookEvents.id, claimed.id));
      if (outcome.status === 'failed') result.failed += 1;
      else result.done += 1;
    } catch (error) {
      const last = claimed.attempts >= MAX_ATTEMPTS;
      await deps.db
        .update(igWebhookEvents)
        .set({
          status: last ? 'failed' : 'pending',
          lastError: error instanceof Error ? error.name.slice(0, 60) : 'erro',
          nextAttemptAt: new Date(now.getTime() + backoffMs(claimed.attempts)),
        })
        .where(eq(igWebhookEvents.id, claimed.id));
      if (last) result.failed += 1;
      else result.retried += 1;
    }
  }
  return result;
}

/** Empties the raw events past the retention; the key stays so Meta's repeat is still a no-op. */
export async function purgeInstagramPayloads(
  db: Pick<Database, 'update'>,
  now = new Date(),
): Promise<number> {
  const rows = await db
    .update(igWebhookEvents)
    .set({ payload: null })
    .where(
      and(
        isNotNull(igWebhookEvents.payload),
        lt(
          igWebhookEvents.receivedAt,
          new Date(now.getTime() - IG_PAYLOAD_RETENTION_DAYS * DAY_MS),
        ),
      ),
    )
    .returning({ id: igWebhookEvents.id });
  return rows.length;
}

/**
 * The loop: a tick every minute (events due, replies Meta asked to wait for), plus `kick()` right
 * after the webhook stores. One pass at a time. Never started by
 * `buildApp`, so no test starts it.
 */
export function startInstagramIntake(deps: InstagramIntakeDeps & { tickMs?: number }) {
  let running: Promise<unknown> | null = null;
  // The raw events are emptied by the hourly housekeeping (prospect-ai/housekeeping.ts).
  const pass = async () => {
    const now = deps.now?.() ?? new Date();
    const result = await processInstagramEvents(deps);
    const settings = await loadInstagramSettings(deps.db);
    const resent = await retryPrivateReplies({
      db: deps.db,
      fetch: deps.fetch,
      config: deps.replyConfig,
      settings,
      now,
    });
    if (result.processed > 0 || resent > 0)
      deps.log({ job: INSTAGRAM_INTAKE_JOB, ...result, repliesRetried: resent });
  };
  const runOnce = () => {
    running ??= pass()
      .catch((error: unknown) =>
        deps.log({
          job: INSTAGRAM_INTAKE_JOB,
          error: error instanceof Error ? error.name : 'unknown',
        }),
      )
      .finally(() => {
        running = null;
      });
    return running;
  };
  const timer = setInterval(() => void runOnce(), deps.tickMs ?? 60_000);
  timer.unref();
  return { kick: () => void runOnce(), runOnce, stop: () => clearInterval(timer) };
}
