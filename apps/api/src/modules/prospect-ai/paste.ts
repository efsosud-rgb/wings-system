import {
  BUY_SIGNAL_LABELS,
  commentOccurredAt,
  grantedScope,
  instagramExcerpt,
  maskCommentText,
  normalizeInstagram,
  normalizeInstagramPostUrl,
  OUTROS_REASON_PREFIX,
  parseInstagramPaste,
  placeOfComment,
  PROSPECT_OPEN_STATES,
  type Actor,
  type BuySignal,
  type InstagramPasteInput,
  type InstagramPasteReading,
  type InstagramProspectingSettings,
  type PasteCommentTag,
  type PasteConfirmResponse,
  type PastePreviewResponse,
} from '@wings/shared';
import { and, count, eq, gte, inArray, sql, type SQL } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import { createHash } from 'node:crypto';
import type { Database } from '../../db/client.js';
import { WINGS_TENANT_ID } from '../../db/schema/ads.js';
import {
  clients,
  employees,
  igPasteBatches,
  leads,
  prospectClassifications,
  prospectEvidence,
  prospectOpportunities,
} from '../../db/schema/index.js';
import { writeAudit } from '../../lib/audit.js';
import type { AgentLlm } from '../agent/llm.js';
import { optOutsAmong } from '../leads/contact-block.js';
import { leadVisibleTo } from '../leads/access.js';
import {
  classifyComments,
  estimatedCostMicroUsd,
  normalizeClassifierText,
  PROMPT_VERSION,
  startOfDaySaoPaulo,
  unclassified,
} from './classifier.js';

/**
 * Prospecção Instagram, parte 2 (docs/prospeccao/instagram.md §1.2, §2.4, §4): the preview reads
 * and crosses the paste with our base without writing or calling the AI; the confirmation keeps
 * the batch's counts and, per usable comment, the masked excerpt as evidence and an opportunity.
 * The pasted text itself is never written. Logs and audit carry ids and counts only.
 */

export type Refusal = { ok: false; status: number; error: string; message: string };
const refusal = (status: number, error: string, message: string): Refusal => ({
  ok: false,
  status,
  error,
  message,
});

export const isInstagramManager = (actor: Actor) =>
  grantedScope(actor, 'prospecting.instagram_paste') === 'all';

const DAY_MS = 86_400_000;
const BUYING_OR_DOUBT: BuySignal[] = ['quer_comprar', 'pediu_preco', 'duvida'];

/** The @ a stored Instagram field holds (`@x`, `x` or the profile link), in SQL. */
const igKey = (column: SQL | AnyPgColumn) =>
  sql<string>`lower(split_part(split_part(regexp_replace(regexp_replace(trim(coalesce(${column}, '')), '^(https?://)?(www\\.)?instagr(am\\.com|\\.am)/', '', 'i'), '^@+', ''), '/', 1), '?', 1))`;

interface Read {
  postUrl: string;
  postOwner: string | null;
  reading: InstagramPasteReading;
}

/** The paste read in memory, or why not (§4.5): 400 link, 413 size, 422 too many comments. */
export function readPaste(
  input: InstagramPasteInput,
  settings: InstagramProspectingSettings,
  wingsUsername: string | null,
): Read | Refusal {
  const postUrl = normalizeInstagramPostUrl(input.postUrl);
  if (!postUrl)
    return refusal(
      400,
      'post_invalido',
      'Informe o link de um post ou reel do Instagram (https://www.instagram.com/p/…).',
    );
  const typedOwner = input.postOwner ? normalizeInstagram(input.postOwner) : null;
  if (input.postOwner && !typedOwner)
    return refusal(400, 'dono_invalido', 'O @ do dono do post não é um @ válido.');
  const parsed = parseInstagramPaste(input.text, {
    postOwner: typedOwner,
    wingsUsername,
    maxChars: settings.paste.maxChars,
  });
  if (!parsed.ok)
    return refusal(
      413,
      'colagem_grande',
      `Cole no máximo ${settings.paste.maxChars.toLocaleString('pt-BR')} caracteres por vez.`,
    );
  const found = parsed.reading.comments.length;
  if (found > settings.paste.maxComments)
    return refusal(
      422,
      'colagem_muitos_comentarios',
      `Esta colagem tem ${found} comentários; o limite é ${settings.paste.maxComments}. Divida em partes.`,
    );
  return { postUrl, postOwner: parsed.reading.postOwner, reading: parsed.reading };
}

/**
 * Who among these @ we already know (§2.4), in order: "não contatar" (Instagram or every
 * channel), client, lead, open prospect. A seller never sees who holds another seller's prospect.
 */
export async function crossBase(
  db: Database,
  actor: Actor,
  usernames: string[],
): Promise<Map<string, PasteCommentTag>> {
  const tags = new Map<string, PasteCommentTag>();
  if (usernames.length === 0) return tags;
  const [optOuts, clientRows, leadRows, prospectRows] = await Promise.all([
    optOutsAmong(db, {
      placeIds: [],
      phones: [],
      instagramUsers: usernames,
      channels: ['instagram'],
    }),
    db
      .select({ username: igKey(sql`${clients.social}->>'instagram'`) })
      .from(clients)
      .where(inArray(igKey(sql`${clients.social}->>'instagram'`), usernames)),
    db
      .select({ username: igKey(leads.instagram), lead: leads, ownerName: employees.fullName })
      .from(leads)
      .leftJoin(employees, eq(employees.id, leads.ownerEmployeeId))
      .where(inArray(igKey(leads.instagram), usernames)),
    db
      .select({
        username: prospectEvidence.authorUsername,
        ownerId: prospectOpportunities.ownerEmployeeId,
        ownerName: employees.fullName,
      })
      .from(prospectOpportunities)
      .innerJoin(prospectEvidence, eq(prospectEvidence.id, prospectOpportunities.evidenceId))
      .leftJoin(employees, eq(employees.id, prospectOpportunities.ownerEmployeeId))
      .where(
        and(
          eq(prospectOpportunities.tenantId, WINGS_TENANT_ID),
          inArray(prospectOpportunities.state, PROSPECT_OPEN_STATES),
          inArray(prospectEvidence.authorUsername, usernames),
        ),
      ),
  ]);
  const manager = isInstagramManager(actor);
  for (const row of prospectRows)
    if (row.username)
      tags.set(row.username, {
        kind: 'prospect',
        ownerName: manager || row.ownerId === actor.employeeId ? row.ownerName : null,
      });
  for (const row of leadRows)
    tags.set(row.username, {
      kind: 'lead',
      ownerName: row.ownerName,
      // Shown to open (and attach the comment to) only when the seller reaches the lead.
      leadId: leadVisibleTo(actor, 'leads.write', row.lead) ? row.lead.id : null,
    });
  for (const row of clientRows) tags.set(row.username, { kind: 'cliente' });
  for (const username of usernames) {
    if (optOuts.has(`instagram_user:${username}`)) tags.set(username, { kind: 'nao_contatar' });
  }
  return tags;
}

const isKnown = (tag: PasteCommentTag | undefined) => Boolean(tag && tag.kind !== 'prospect');

export async function previewPaste(
  db: Database,
  actor: Actor,
  read: Read,
  deps: { aiEnabled: boolean; now: Date },
): Promise<PastePreviewResponse> {
  const { reading } = read;
  const tags = await crossBase(db, actor, [...new Set(reading.comments.map((c) => c.username))]);
  const counted = { naoContatar: 0, cliente: 0, lead: 0, prospect: 0 };
  const comments = reading.comments.map((c) => {
    const tag = tags.get(c.username) ?? null;
    if (tag) counted[tag.kind === 'nao_contatar' ? 'naoContatar' : tag.kind] += 1;
    // Another seller's prospect: the @ and the excerpt are not shown, only the label (§9).
    const hidden = tag?.kind === 'prospect' && tag.ownerName === null;
    return {
      username: hidden ? '—' : c.username,
      excerpt: hidden ? '' : instagramExcerpt(c.text),
      when: c.when,
      occurredAt: commentOccurredAt(c.when, deps.now).toISOString(),
      tag,
    };
  });
  const usable = reading.comments.filter((c) => !isKnown(tags.get(c.username)));
  return {
    postUrl: read.postUrl,
    postOwner: read.postOwner,
    format: reading.format,
    comments,
    usable: usable.length,
    linesTotal: reading.linesTotal,
    linesIgnored: reading.linesIgnored,
    ignored: reading.ignored,
    discarded: reading.discarded,
    unrecognized: reading.unrecognized,
    linesUnrecognized: reading.linesUnrecognized,
    alreadyKnown: counted,
    estimatedCostMicroUsd: deps.aiEnabled ? estimatedCostMicroUsd(usable.map((c) => c.text)) : null,
    aiEnabled: deps.aiEnabled,
  };
}

/** The same comment pasted twice has the same id: the post, the @ and the masked text. */
export const evidenceExternalId = (postUrl: string, username: string, text: string) =>
  createHash('sha256')
    .update(`${postUrl}\n${username}\n${normalizeClassifierText(maskCommentText(text))}`)
    .digest('hex');

/** Pastes this seller confirmed today (São Paulo day). */
export async function pastesToday(db: Database, employeeId: string, now: Date) {
  const [row] = await db
    .select({ n: count() })
    .from(igPasteBatches)
    .where(
      and(
        eq(igPasteBatches.createdBy, employeeId),
        gte(igPasteBatches.createdAt, startOfDaySaoPaulo(now)),
      ),
    );
  return row?.n ?? 0;
}

export interface ConfirmDeps {
  settings: InstagramProspectingSettings;
  llm: AgentLlm | null;
  aiEnabled: boolean;
  dailyUsd: number;
  now: Date;
}

/** The open opportunity of this @, if any (the one a new comment joins). */
async function openOpportunityOf(db: Pick<Database, 'select'>, username: string) {
  const [row] = await db
    .select({ id: prospectOpportunities.id })
    .from(prospectOpportunities)
    .innerJoin(prospectEvidence, eq(prospectEvidence.id, prospectOpportunities.evidenceId))
    .where(
      and(
        eq(prospectOpportunities.tenantId, WINGS_TENANT_ID),
        inArray(prospectOpportunities.state, PROSPECT_OPEN_STATES),
        eq(prospectEvidence.authorUsername, username),
      ),
    )
    .limit(1);
  return row?.id ?? null;
}

const emptyResult = (
  batchId: string | null,
  repeated: number,
  skippedKnown: number,
): PasteConfirmResponse => ({
  batchId,
  created: 0,
  joined: 0,
  repeated,
  skippedKnown,
  lists: {
    querComprar: 0,
    revisar: 0,
    outros: {
      quer_comprar: 0,
      pediu_preco: 0,
      duvida: 0,
      elogio: 0,
      reclamacao: 0,
      spam: 0,
      sem_sinal: 0,
    },
  },
});

/**
 * Confirms the paste (§1.2 step 4): a paste with no new comment (all known or repeated) writes
 * nothing and is not counted; otherwise the day's limit is counted and the batch written under one
 * lock per seller; then the rules and the AI; then, per comment and under a lock on its @, the
 * evidence and the opportunity (or the evidence joined to the @'s open opportunity).
 */
export async function confirmPaste(
  db: Database,
  actor: Actor,
  read: Read,
  deps: ConfirmDeps,
): Promise<PasteConfirmResponse | Refusal> {
  const { reading, postUrl, postOwner } = read;
  const tags = await crossBase(db, actor, [...new Set(reading.comments.map((c) => c.username))]);
  const known = reading.comments.filter((c) => isKnown(tags.get(c.username))).length;
  const usable = reading.comments
    .filter((c) => !isKnown(tags.get(c.username)))
    .map((c) => ({ ...c, externalId: evidenceExternalId(postUrl, c.username, c.text) }));
  const existing = new Set(
    usable.length === 0
      ? []
      : (
          await db
            .select({ id: prospectEvidence.externalId })
            .from(prospectEvidence)
            .where(
              and(
                eq(prospectEvidence.tenantId, WINGS_TENANT_ID),
                eq(prospectEvidence.source, 'instagram_colagem'),
                inArray(
                  prospectEvidence.externalId,
                  usable.map((c) => c.externalId),
                ),
              ),
            )
        ).map((row) => row.id),
  );
  const fresh = usable.filter((c) => !existing.has(c.externalId));
  // A paste without one new comment writes nothing and does not count toward the day's limit.
  if (fresh.length === 0) return emptyResult(null, usable.length, known);
  const batchId = await db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${`ig_paste:${actor.employeeId}`}))`,
    );
    const [today] = await tx
      .select({ n: count() })
      .from(igPasteBatches)
      .where(
        and(
          eq(igPasteBatches.createdBy, actor.employeeId),
          gte(igPasteBatches.createdAt, startOfDaySaoPaulo(deps.now)),
        ),
      );
    if ((today?.n ?? 0) >= deps.settings.paste.perSellerPerDay) return null;
    const [batch] = await tx
      .insert(igPasteBatches)
      .values({
        createdBy: actor.employeeId,
        postUrl,
        postOwnerUsername: postOwner,
        chars: reading.chars,
        linesTotal: reading.linesTotal,
        commentsFound: reading.comments.length,
        linesIgnored: reading.linesIgnored,
        linesUnrecognized: reading.linesUnrecognized,
        alreadyKnown: known,
        formatDetected: reading.format,
        createdAt: deps.now,
      })
      .returning({ id: igPasteBatches.id });
    return batch!.id;
  });
  if (!batchId)
    return refusal(
      429,
      'colagem_limite_dia',
      `Você já fez as ${deps.settings.paste.perSellerPerDay} colagens de hoje. Volte amanhã.`,
    );

  // Only who has no open prospect goes to the AI: a joined comment costs nothing.
  const toClassify = fresh.filter((c) => tags.get(c.username)?.kind !== 'prospect');
  const classified = await classifyComments(
    toClassify.map((c) => c.text),
    { db, llm: deps.llm, enabled: deps.aiEnabled, dailyUsd: deps.dailyUsd, now: deps.now },
  );
  const classOf = new Map(toClassify.map((c, i) => [c.externalId, classified[i]!]));

  const days = deps.settings.retention.instagramSemLeadDias;
  const result = emptyResult(batchId, usable.length - fresh.length, known);
  for (const comment of fresh) {
    const outcome = await db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext(${`ig_user:${comment.username}`}))`,
      );
      const evidence = {
        source: 'instagram_colagem',
        externalId: comment.externalId,
        url: postUrl,
        occurredAt: commentOccurredAt(comment.when, deps.now),
        occurredAtPrecision: 'aproximada',
        excerpt: instagramExcerpt(comment.text),
        authorUsername: comment.username,
        legalBasis: 'legitimate_interest',
        retentionUntil: new Date(deps.now.getTime() + days * DAY_MS),
        recordedBy: actor.employeeId,
        createdAt: deps.now,
      };
      // A "não me contate" written since crossBase (the AI can take seconds) keeps the @ out.
      const optedOut = await optOutsAmong(tx, {
        placeIds: [],
        phones: [],
        instagramUsers: [comment.username],
        channels: ['instagram'],
      });
      if (optedOut.size > 0) return 'blocked';
      const open = await openOpportunityOf(tx, comment.username);
      if (open) {
        const joined = await tx
          .insert(prospectEvidence)
          .values({ ...evidence, opportunityId: open })
          .onConflictDoNothing()
          .returning({ id: prospectEvidence.id });
        return joined.length > 0 ? 'joined' : 'repeated';
      }
      // Its @ had an open prospect when the AI ran, closed since: to "Revisar", unclassified.
      const classification = classOf.get(comment.externalId) ?? unclassified('sem_ia');
      const place = placeOfComment(classification, deps.settings.thresholds);
      const [ev] = await tx
        .insert(prospectEvidence)
        .values(evidence)
        .onConflictDoNothing()
        .returning({ id: prospectEvidence.id });
      if (!ev) return 'repeated';
      const outros =
        place.state !== 'rejeitada'
          ? null
          : classification.signal && !BUYING_OR_DOUBT.includes(classification.signal)
            ? `${OUTROS_REASON_PREFIX}${BUY_SIGNAL_LABELS[classification.signal].toLowerCase()}`
            : `${OUTROS_REASON_PREFIX}confiança baixa`;
      const [opportunity] = await tx
        .insert(prospectOpportunities)
        .values({
          evidenceId: ev.id,
          source: 'instagram_colagem',
          state: place.state,
          category: classification.category,
          intent: classification.intent,
          buySignal: classification.signal,
          confidence: classification.confidence,
          justification: classification.justification,
          needsReviewReason: place.reviewReason,
          ownerEmployeeId: actor.employeeId,
          pasteBatchId: batchId,
          decidedAt: outros ? deps.now : null,
          decisionReason: outros,
          createdAt: deps.now,
          updatedAt: deps.now,
        })
        .returning({ id: prospectOpportunities.id });
      await tx
        .update(prospectEvidence)
        .set({ opportunityId: opportunity!.id })
        .where(eq(prospectEvidence.id, ev.id));
      if (classification.method) {
        const [row] = await tx
          .insert(prospectClassifications)
          .values({
            opportunityId: opportunity!.id,
            method: classification.method,
            category: classification.category,
            intent: classification.intent,
            buySignal: classification.signal,
            confidence: classification.confidence,
            justification: classification.justification,
            model: classification.model,
            promptVersion: classification.method === 'ia_lote' ? PROMPT_VERSION : null,
            runId: classification.runId,
            createdAt: deps.now,
          })
          .returning({ id: prospectClassifications.id });
        await tx
          .update(prospectOpportunities)
          .set({ classificationId: row!.id })
          .where(eq(prospectOpportunities.id, opportunity!.id));
      }
      return { state: place.state, signal: classification.signal };
    });
    if (outcome === 'joined') result.joined += 1;
    else if (outcome === 'repeated') result.repeated += 1;
    else if (outcome === 'blocked') result.skippedKnown += 1;
    else {
      result.created += 1;
      if (outcome.state === 'nova') result.lists.querComprar += 1;
      else if (outcome.state === 'em_revisao') result.lists.revisar += 1;
      else result.lists.outros[(outcome.signal ?? 'sem_sinal') as BuySignal | 'sem_sinal'] += 1;
    }
  }
  await writeAudit(db, {
    actorEmployeeId: actor.employeeId,
    action: 'prospect_ai.instagram_paste_confirmed',
    entity: 'ig_paste_batch',
    entityId: batchId,
    metadata: {
      commentsFound: reading.comments.length,
      created: result.created,
      joined: result.joined,
      repeated: result.repeated,
      skippedKnown: result.skippedKnown,
      querComprar: result.lists.querComprar,
      revisar: result.lists.revisar,
      aiEnabled: deps.aiEnabled,
    },
  });
  return result;
}
