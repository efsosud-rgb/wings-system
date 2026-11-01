import {
  PRIVATE_REPLIES_PER_HOUR,
  PRIVATE_REPLY_SAME_PERSON_DAYS,
  privateReplyDeadline,
  privateReplyText,
  type IgPrivateReplyBlock,
  type IgPrivateReplyStatus,
  type InstagramProspectingSettings,
} from '@wings/shared';
import { and, eq, inArray, lte, sql } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import type { Database } from '../../db/client.js';
import { WINGS_TENANT_ID } from '../../db/schema/ads.js';
import {
  igPeople,
  igPrivateReplies,
  prospectEvidence,
  prospectOpportunities,
} from '../../db/schema/index.js';
import { writeAudit } from '../../lib/audit.js';
import { contactBlock } from '../leads/contact-block.js';
import { sendPrivateReply, type InstagramMessagingConfig } from './graph.js';

/**
 * The one private reply to a comment on Wings' posts and ads (docs/prospeccao/instagram.md §5.3,
 * spec PA §3.1 steps 6 and 7). The gates, in order: switch and mode on, the policy's link, under 7
 * days (one hour of margin), "não me contate" by every key of the person, one reply per person
 * every 7 days, 600 an hour. The first gate that fails ends it: no row, no call (lição 4). The two
 * limits are counted and the row written under one lock (lição 5); the unique comment id makes a
 * second click or loop a no-op. Then one call; a reply that may have arrived is never sent again.
 */

const LOCK_KEY = 'ig_private_reply';
const DAY_MS = 86_400_000;
/** Minutes before trying again after Meta said "wait", by attempt (1-based). */
const RETRY_MINUTES = [5, 15, 60, 180, 360];
/** Counted as possibly delivered: they hold the person's 7 days and the hour's budget. */
const COUNTED: IgPrivateReplyStatus[] = ['sending', 'sent', 'unknown'];

export interface PrivateReplyDeps {
  db: Database;
  fetch: typeof fetch;
  /** Null: INSTAGRAM_AUTO_REPLY_ENABLED off or the token or account missing. */
  config: InstagramMessagingConfig | null;
  settings: InstagramProspectingSettings;
  now: Date;
}

export type PrivateReplyResult =
  | { ok: true; status: IgPrivateReplyStatus }
  | { ok: false; block: IgPrivateReplyBlock | 'ja_tratado' | 'fora_da_fila' };

/** The comment behind an opportunity of parte 1: its id, date, ad and person. */
async function commentOf(db: Database, opportunityId: string) {
  const [row] = await db
    .select({
      state: prospectOpportunities.state,
      leadId: prospectOpportunities.leadId,
      igPersonId: prospectOpportunities.igPersonId,
      commentId: prospectEvidence.externalId,
      occurredAt: prospectEvidence.occurredAt,
      adId: prospectEvidence.adId,
      igsid: prospectEvidence.authorIgsid,
      username: prospectEvidence.authorUsername,
    })
    .from(prospectOpportunities)
    .innerJoin(prospectEvidence, eq(prospectEvidence.id, prospectOpportunities.evidenceId))
    .where(
      and(
        eq(prospectOpportunities.id, opportunityId),
        eq(prospectOpportunities.tenantId, WINGS_TENANT_ID),
        inArray(prospectOpportunities.source, ['instagram_comment', 'instagram_ad_comment']),
      ),
    );
  return row ?? null;
}

type Comment = NonNullable<Awaited<ReturnType<typeof commentOf>>>;
type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];

/** 600 replies (possibly delivered) in the last hour: the next one waits. Under the lock. */
async function hourIsFull(tx: Tx, now: Date): Promise<boolean> {
  const [hour] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(igPrivateReplies)
    .where(
      and(
        eq(igPrivateReplies.tenantId, WINGS_TENANT_ID),
        inArray(igPrivateReplies.status, COUNTED),
        sql`coalesce(${igPrivateReplies.sentAt}, ${igPrivateReplies.createdAt}) > ${new Date(now.getTime() - 60 * 60_000).toISOString()}::timestamptz`,
      ),
    );
  return (hour?.n ?? 0) >= PRIVATE_REPLIES_PER_HOUR;
}

/** The gates that need no lock, in the spec's order: the first refusal, or the text to send. */
async function openGate(
  deps: PrivateReplyDeps,
  comment: Comment,
): Promise<{ block: IgPrivateReplyBlock } | { text: string }> {
  if (!deps.config || deps.settings.privateReply.modo === 'desligado')
    return { block: 'desligado' };
  const text = privateReplyText(
    deps.settings.privateReply,
    deps.settings.messages.linkPolitica,
    comment.adId !== null,
  );
  if (!text) return { block: 'sem_texto' };
  if (deps.now >= privateReplyDeadline(comment.occurredAt)) return { block: 'prazo_meta' };
  const blocked = await contactBlock(deps.db, 'instagram', {
    instagramUser: comment.username,
    instagramIgsid: comment.igsid,
    leadId: comment.leadId,
  });
  if (blocked.blocked) return { block: 'nao_contatar' };
  return { text };
}

/** Takes the comment's one reply under the lock, after the person's and the hour's limits. */
async function claim(
  deps: PrivateReplyDeps,
  comment: Comment,
  opportunityId: string,
  trigger: 'clique' | 'automatico',
  requestedBy: string | null,
  text: string,
): Promise<{ id: string } | { block: IgPrivateReplyBlock | 'ja_tratado' }> {
  return deps.db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${LOCK_KEY}))`);
    const [done] = await tx
      .select({ id: igPrivateReplies.id })
      .from(igPrivateReplies)
      .where(
        and(
          eq(igPrivateReplies.tenantId, WINGS_TENANT_ID),
          eq(igPrivateReplies.commentId, comment.commentId),
        ),
      );
    if (done) return { block: 'ja_tratado' as const };
    const sinceDay = new Date(deps.now.getTime() - PRIVATE_REPLY_SAME_PERSON_DAYS * DAY_MS);
    const counted = and(
      eq(igPrivateReplies.tenantId, WINGS_TENANT_ID),
      inArray(igPrivateReplies.status, COUNTED),
    );
    const when = sql`coalesce(${igPrivateReplies.sentAt}, ${igPrivateReplies.createdAt})`;
    if (comment.igPersonId) {
      const [person] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(igPrivateReplies)
        .where(
          and(
            counted,
            eq(igPrivateReplies.igPersonId, comment.igPersonId),
            sql`${when} > ${sinceDay.toISOString()}::timestamptz`,
          ),
        );
      if ((person?.n ?? 0) > 0) return { block: 'limite_pessoa' as const };
    }
    if (await hourIsFull(tx, deps.now)) return { block: 'limite_hora' as const };
    const [row] = await tx
      .insert(igPrivateReplies)
      .values({
        commentId: comment.commentId,
        opportunityId,
        igPersonId: comment.igPersonId,
        trigger,
        requestedBy,
        messageSha256: createHash('sha256').update(text).digest('hex'),
        status: 'sending',
        attempts: 1,
        commentCreatedAt: comment.occurredAt,
        createdAt: deps.now,
      })
      .onConflictDoNothing()
      .returning({ id: igPrivateReplies.id });
    return row ? { id: row.id } : { block: 'ja_tratado' as const };
  });
}

/** The one call, and what Meta's answer makes of the row. */
async function deliver(
  deps: PrivateReplyDeps,
  replyId: string,
  comment: Comment,
  text: string,
  attempts: number,
): Promise<IgPrivateReplyStatus> {
  const outcome = await sendPrivateReply(deps.fetch, deps.config!, comment.commentId, text);
  if (outcome.kind === 'sent') {
    await deps.db
      .update(igPrivateReplies)
      .set({ status: 'sent', sentAt: deps.now, graphMessageId: outcome.messageId })
      .where(eq(igPrivateReplies.id, replyId));
    if (comment.igPersonId)
      await deps.db
        .update(igPeople)
        .set({ lastAutoReplyAt: deps.now, updatedAt: deps.now })
        .where(eq(igPeople.id, comment.igPersonId));
    return 'sent';
  }
  const retryAt = new Date(
    deps.now.getTime() + (RETRY_MINUTES[attempts - 1] ?? Number.POSITIVE_INFINITY) * 60_000,
  );
  // Meta said "wait" and it still fits the 7 days: tried again later; otherwise it ends here.
  const status: IgPrivateReplyStatus =
    outcome.kind === 'rate_limited'
      ? retryAt < privateReplyDeadline(comment.occurredAt)
        ? 'rate_limited'
        : 'failed'
      : outcome.kind;
  await deps.db
    .update(igPrivateReplies)
    .set({
      status,
      lastError: outcome.code,
      nextAttemptAt: status === 'rate_limited' ? retryAt : null,
    })
    .where(eq(igPrivateReplies.id, replyId));
  return status;
}

/**
 * Sends the private reply of one opportunity, by a click (`requestedBy`) or alone. Only an open
 * opportunity in "Quer comprar" (`nova`) of a comment on Wings' media; the caller checks who may
 * click. Returns the status, or the gate that refused it.
 */
export async function requestPrivateReply(
  deps: PrivateReplyDeps,
  opportunityId: string,
  trigger: 'clique' | 'automatico',
  requestedBy: string | null,
): Promise<PrivateReplyResult> {
  const comment = await commentOf(deps.db, opportunityId);
  if (!comment || comment.state !== 'nova') return { ok: false, block: 'fora_da_fila' };
  const gate = await openGate(deps, comment);
  const audit = (metadata: Record<string, unknown>) =>
    writeAudit(deps.db, {
      actorEmployeeId: requestedBy,
      action: 'prospect_ai.instagram_private_reply',
      entity: 'prospect_opportunity',
      entityId: opportunityId,
      metadata: { trigger, ...metadata },
    });
  if ('block' in gate) {
    await audit({ refused: gate.block });
    return { ok: false, block: gate.block };
  }
  const claimed = await claim(deps, comment, opportunityId, trigger, requestedBy, gate.text);
  if ('block' in claimed) {
    await audit({ refused: claimed.block });
    return { ok: false, block: claimed.block };
  }
  const status = await deliver(deps, claimed.id, comment, gate.text, 1);
  await audit({ status });
  return { ok: true, status };
}

/**
 * The replies Meta asked to wait for, due now: the gates again (the switch, the 7 days and "não me
 * contate" may have changed), then the one call. Claimed by compare-and-set on the status.
 */
export async function retryPrivateReplies(deps: PrivateReplyDeps): Promise<number> {
  const due = await deps.db
    .select({ id: igPrivateReplies.id, opportunityId: igPrivateReplies.opportunityId })
    .from(igPrivateReplies)
    .where(
      and(
        eq(igPrivateReplies.status, 'rate_limited'),
        lte(igPrivateReplies.nextAttemptAt, deps.now),
      ),
    )
    .limit(20);
  let sent = 0;
  for (const row of due) {
    const found = row.opportunityId ? await commentOf(deps.db, row.opportunityId) : null;
    const comment = found?.state === 'nova' ? found : null;
    const gate = comment ? await openGate(deps, comment) : { block: 'fora_da_fila' as const };
    if ('block' in gate) {
      await deps.db
        .update(igPrivateReplies)
        .set({ status: 'failed', lastError: gate.block, nextAttemptAt: null })
        .where(and(eq(igPrivateReplies.id, row.id), eq(igPrivateReplies.status, 'rate_limited')));
      continue;
    }
    // The hour's 600 again, counted and claimed under the same lock as a new reply (lição 5); a
    // full hour leaves it waiting for the next pass (the 7 days are checked again there).
    const claimed = await deps.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${LOCK_KEY}))`);
      if (await hourIsFull(tx, deps.now)) return null;
      const [taken] = await tx
        .update(igPrivateReplies)
        .set({ status: 'sending', attempts: sql`${igPrivateReplies.attempts} + 1` })
        .where(and(eq(igPrivateReplies.id, row.id), eq(igPrivateReplies.status, 'rate_limited')))
        .returning({ attempts: igPrivateReplies.attempts });
      return taken ?? null;
    });
    if (!claimed) continue;
    if ((await deliver(deps, row.id, comment!, gate.text, claimed.attempts)) === 'sent') sent += 1;
  }
  return sent;
}
