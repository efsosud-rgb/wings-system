import {
  commentOccurredAt,
  DO_NOT_CONTACT_REASON,
  instagramExcerpt,
  listOfState,
  normalizeInstagram,
  normalizeInstagramPostUrl,
  OUTROS_REASON_PREFIX,
  pipelineOfCategory,
  PROSPECT_OPEN_STATES,
  ROLE_PERMISSIONS,
  WINGS_CLIENT_ID,
  type Actor,
  type BuySignal,
  type InstagramAttachInput,
  type InstagramLeadInput,
  type InstagramPasteBatch,
  type InstagramProspect,
  type InstagramProspectingSettings,
  type IgPrivateReplyStatus,
  type ProspectOpportunityState,
  type ProspectReviewReason,
} from '@wings/shared';
import { and, asc, desc, eq, inArray, isNull, sql, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { Database } from '../../db/client.js';
import { WINGS_TENANT_ID } from '../../db/schema/ads.js';
import {
  employees,
  igPasteBatches,
  igPeople,
  igPrivateReplies,
  leadEvents,
  prospectEvidence,
  prospectOpportunities,
  roles,
} from '../../db/schema/index.js';
import { writeAudit } from '../../lib/audit.js';
import { leadInScope } from '../leads/access.js';
import { contactBlock, recordContactOptOut } from '../leads/contact-block.js';
import { addNote } from '../leads/crm.js';
import { ForeignLeadError, upsertLead } from '../leads/service.js';
import { dayOf, mergeProspectConsent, type ProspectConsent } from '../prospecting/service.js';
import { isInstagramManager, type Refusal } from './paste.js';

/**
 * The prospects of parte 2 (docs/prospeccao/instagram.md §1.2 step 5, §1.5): a seller sees and
 * works her own, a manager every one. A prospect out of reach answers 404. Every change is a
 * conditional update on the state, audited by id and code (never the @ or the excerpt).
 */

const DAY_MS = 86_400_000;
const refusal = (status: number, error: string, message: string): Refusal => ({
  ok: false,
  status,
  error,
  message,
});
const CHANGED = refusal(
  409,
  'prospect_mudou',
  'Este prospect mudou enquanto você olhava. Recarregue.',
);

const opening = alias(prospectEvidence, 'opening');
const owner = alias(employees, 'owner');

const prospectQuery = (db: Database) =>
  db
    .select({
      row: prospectOpportunities,
      evidence: opening,
      postOwner: igPasteBatches.postOwnerUsername,
      ownerName: owner.fullName,
      reply: {
        status: igPrivateReplies.status,
        sentAt: igPrivateReplies.sentAt,
        trigger: igPrivateReplies.trigger,
      },
      comments: sql<number>`(select count(*)::int from ${prospectEvidence} where ${prospectEvidence.opportunityId} = ${prospectOpportunities.id})`,
      purgeAt: sql<Date | null>`(select max(${prospectEvidence.retentionUntil}) from ${prospectEvidence} where ${prospectEvidence.opportunityId} = ${prospectOpportunities.id})`,
    })
    .from(prospectOpportunities)
    .innerJoin(opening, eq(opening.id, prospectOpportunities.evidenceId))
    .leftJoin(igPasteBatches, eq(igPasteBatches.id, prospectOpportunities.pasteBatchId))
    .leftJoin(owner, eq(owner.id, prospectOpportunities.ownerEmployeeId))
    // Parte 1: the one private reply of the opening comment (unique by comment).
    .leftJoin(
      igPrivateReplies,
      and(
        eq(igPrivateReplies.opportunityId, prospectOpportunities.id),
        eq(igPrivateReplies.commentId, opening.externalId),
      ),
    );

type Found = Awaited<ReturnType<ReturnType<typeof prospectQuery>['where']>>[number];

function toView(found: Found, actor: Actor): InstagramProspect {
  const { row, evidence } = found;
  const state = row.state as ProspectOpportunityState;
  return {
    id: row.id,
    batchId: row.pasteBatchId,
    state,
    list: listOfState(state),
    username: evidence.authorUsername ?? '—',
    excerpt: evidence.excerpt,
    occurredAt: evidence.occurredAt.toISOString(),
    occurredAtPrecision: evidence.occurredAtPrecision as 'exata' | 'aproximada',
    postUrl: evidence.url,
    postOwner: found.postOwner,
    signal: row.buySignal as BuySignal | null,
    confidence: row.confidence,
    justification: row.justification,
    category: row.category,
    reviewReason: row.needsReviewReason as ProspectReviewReason | null,
    decisionReason: row.decisionReason,
    ownerEmployeeId: row.ownerEmployeeId,
    ownerName: found.ownerName,
    mine: row.ownerEmployeeId === actor.employeeId,
    approachedAt: row.respondedAt?.toISOString() ?? null,
    leadId: row.leadId,
    moreComments: Math.max(0, Number(found.comments) - 1),
    purgeAt: row.leadId || !found.purgeAt ? null : new Date(found.purgeAt).toISOString(),
    createdAt: row.createdAt.toISOString(),
    part: row.source === 'instagram_colagem' ? 2 : 1,
    respondBy: row.respondBy?.toISOString() ?? null,
    onAd: evidence.adId !== null,
    privateReply: found.reply?.status
      ? {
          status: found.reply.status as IgPrivateReplyStatus,
          sentAt: found.reply.sentAt?.toISOString() ?? null,
          alone: found.reply.trigger === 'automatico',
        }
      : null,
  };
}

/** Parte 2 (pasted) and parte 1 (comments on Wings' posts and ads): the same actions. */
const INSTAGRAM_SOURCES = ['instagram_colagem', 'instagram_comment', 'instagram_ad_comment'];
const ofTenant = and(
  eq(prospectOpportunities.tenantId, WINGS_TENANT_ID),
  inArray(prospectOpportunities.source, INSTAGRAM_SOURCES),
)!;

export async function listInstagramProspects(
  db: Database,
  actor: Actor,
  filter: { batch?: string; state?: ProspectOpportunityState; owner?: string; parte?: '1' | '2' },
): Promise<InstagramProspect[]> {
  const conditions: SQL[] = [
    ofTenant,
    filter.parte === '1'
      ? inArray(prospectOpportunities.source, ['instagram_comment', 'instagram_ad_comment'])
      : eq(prospectOpportunities.source, 'instagram_colagem'),
  ];
  const ownerId = isInstagramManager(actor) ? filter.owner : actor.employeeId;
  if (ownerId) conditions.push(eq(prospectOpportunities.ownerEmployeeId, ownerId));
  if (filter.batch) conditions.push(eq(prospectOpportunities.pasteBatchId, filter.batch));
  if (filter.state) conditions.push(eq(prospectOpportunities.state, filter.state));
  // shortcut: the newest 500 only, no paging; add paging when a team holds more.
  const rows = await prospectQuery(db)
    .where(and(...conditions))
    .orderBy(desc(prospectOpportunities.updatedAt))
    .limit(500);
  return rows.map((found) => toView(found, actor));
}

/** The seller's pastes, or every one for a manager. Counts and the post link only. */
export async function listPasteBatches(db: Database, actor: Actor): Promise<InstagramPasteBatch[]> {
  const creator = alias(employees, 'creator');
  const rows = await db
    .select({
      batch: igPasteBatches,
      name: creator.fullName,
      prospects: sql<number>`(select count(*)::int from ${prospectOpportunities} where ${prospectOpportunities.pasteBatchId} = ${igPasteBatches.id})`,
    })
    .from(igPasteBatches)
    .leftJoin(creator, eq(creator.id, igPasteBatches.createdBy))
    .where(
      and(
        eq(igPasteBatches.tenantId, WINGS_TENANT_ID),
        isInstagramManager(actor) ? undefined : eq(igPasteBatches.createdBy, actor.employeeId),
      ),
    )
    .orderBy(desc(igPasteBatches.createdAt))
    .limit(200);
  return rows.map(({ batch, name, prospects }) => ({
    id: batch.id,
    createdBy: batch.createdBy,
    createdByName: name,
    postUrl: batch.postUrl,
    postOwner: batch.postOwnerUsername,
    commentsFound: batch.commentsFound,
    linesIgnored: batch.linesIgnored,
    linesUnrecognized: batch.linesUnrecognized,
    alreadyKnown: batch.alreadyKnown,
    formatDetected: batch.formatDetected,
    createdAt: batch.createdAt.toISOString(),
    prospects: Number(prospects),
  }));
}

/** The prospect when the caller may touch it (its owner, or a manager); null answers 404. */
export async function instagramProspectInReach(db: Database, actor: Actor, id: string) {
  const [found] = await prospectQuery(db).where(and(ofTenant, eq(prospectOpportunities.id, id)));
  if (!found) return null;
  return isInstagramManager(actor) || found.row.ownerEmployeeId === actor.employeeId ? found : null;
}
export type InstagramFound = NonNullable<Awaited<ReturnType<typeof instagramProspectInReach>>>;

type Change = Partial<typeof prospectOpportunities.$inferInsert>;

/** Closes every open prospect of this @ (whoever holds it) as "Não contatar"; returns how many. */
async function closeOpenOf(db: Database, actor: Actor, username: string, now: Date) {
  const closed = await db
    .update(prospectOpportunities)
    .set({
      state: 'rejeitada',
      decidedAt: now,
      decidedBy: actor.employeeId,
      decisionReason: DO_NOT_CONTACT_REASON,
      updatedAt: now,
    })
    .where(
      and(
        ofTenant,
        inArray(prospectOpportunities.state, PROSPECT_OPEN_STATES),
        inArray(
          prospectOpportunities.evidenceId,
          db
            .select({ id: prospectEvidence.id })
            .from(prospectEvidence)
            .where(eq(prospectEvidence.authorUsername, username)),
        ),
      ),
    )
    .returning({ id: prospectOpportunities.id });
  return closed.length;
}

/**
 * "Não me contate" at the moment of the action (lições 3 e 4), not only at the paste: a prospect
 * closed by it, or an @ in the register now (Instagram or every channel), refuses "Copiar
 * mensagem", "Abordei", reopening and transfer; a register found now closes the @'s open prospects.
 */
export async function instagramOptOut(
  db: Database,
  actor: Actor,
  found: InstagramFound,
  now: Date,
): Promise<Refusal | null> {
  const blocked = (reason: string | null) =>
    refusal(409, 'contact_blocked', reason ?? 'Pediu para não ser contatado.');
  if (found.row.decisionReason === DO_NOT_CONTACT_REASON) return blocked(null);
  const username = found.evidence.authorUsername;
  const block = await contactBlock(db, 'instagram', {
    instagramUser: username,
    instagramIgsid: found.evidence.authorIgsid,
    leadId: found.row.leadId,
  });
  if (!block.blocked) return null;
  if (username) {
    const closed = await closeOpenOf(db, actor, username, now);
    await writeAudit(db, {
      actorEmployeeId: actor.employeeId,
      action: 'prospect_ai.instagram_closed_by_opt_out',
      entity: 'prospect_opportunity',
      entityId: found.row.id,
      metadata: { closed },
    });
  }
  return blocked(block.reason);
}

/** One conditional update: only from these states (and not while a lead is being created). */
async function move(
  db: Database,
  actor: Actor,
  found: InstagramFound,
  from: ProspectOpportunityState[],
  set: Change,
  action: string,
  now: Date,
  metadata: Record<string, unknown> = {},
): Promise<{ ok: true; prospect: InstagramProspect } | Refusal> {
  const [updated] = await db
    .update(prospectOpportunities)
    .set({ ...set, updatedAt: now })
    .where(
      and(
        eq(prospectOpportunities.id, found.row.id),
        inArray(prospectOpportunities.state, from),
        // decided_at on an open state marks a "Criar lead" in progress.
        found.row.state === 'rejeitada' ? undefined : isNull(prospectOpportunities.decidedAt),
      ),
    )
    .returning({ id: prospectOpportunities.id });
  if (!updated) return CHANGED;
  await writeAudit(db, {
    actorEmployeeId: actor.employeeId,
    action,
    entity: 'prospect_opportunity',
    entityId: found.row.id,
    metadata: { from: found.row.state, to: set.state ?? found.row.state, ...metadata },
  });
  const [fresh] = await prospectQuery(db).where(eq(prospectOpportunities.id, found.row.id));
  return { ok: true, prospect: toView(fresh!, actor) };
}

/** The 30 days (§8.4) start again: creation, "Abordei" and a transfer. */
async function restartRetention(db: Database, id: string, days: number, now: Date) {
  await db
    .update(prospectEvidence)
    .set({ retentionUntil: new Date(now.getTime() + days * DAY_MS) })
    .where(eq(prospectEvidence.opportunityId, id));
}

export async function markApproached(
  db: Database,
  actor: Actor,
  found: InstagramFound,
  settings: InstagramProspectingSettings,
  now: Date,
) {
  const blocked = await instagramOptOut(db, actor, found, now);
  if (blocked) return blocked;
  const result = await move(
    db,
    actor,
    found,
    ['nova', 'em_revisao'],
    { state: 'abordada', respondedAt: now, needsReviewReason: null },
    'prospect_ai.instagram_approached',
    now,
  );
  if (result.ok)
    await restartRetention(db, found.row.id, settings.retention.instagramSemLeadDias, now);
  return result;
}

/**
 * To "Quer comprar": a comment in "Revisar" or in "Outros" (the seller's own), and a discarded
 * one only by a manager ("reabre descartado", §1.6). Never one closed by "não me contate".
 */
export async function promote(db: Database, actor: Actor, found: InstagramFound, now: Date) {
  const blocked = await instagramOptOut(db, actor, found, now);
  if (blocked) return blocked;
  const { row } = found;
  const outros =
    row.state === 'rejeitada' &&
    !row.decidedBy &&
    row.decisionReason?.startsWith(OUTROS_REASON_PREFIX);
  if (row.state === 'rejeitada' && !outros && !isInstagramManager(actor))
    return refusal(403, 'forbidden', 'Só a gerência reabre um prospect descartado.');
  const from: ProspectOpportunityState[] =
    row.state === 'rejeitada' ? ['rejeitada'] : ['em_revisao'];
  return move(
    db,
    actor,
    found,
    from,
    {
      state: 'nova',
      needsReviewReason: null,
      decidedAt: null,
      decidedBy: null,
      decisionReason: null,
    },
    'prospect_ai.instagram_promoted',
    now,
  );
}

export async function discard(
  db: Database,
  actor: Actor,
  found: InstagramFound,
  reason: string,
  now: Date,
) {
  return move(
    db,
    actor,
    found,
    PROSPECT_OPEN_STATES,
    { state: 'rejeitada', decidedAt: now, decidedBy: actor.employeeId, decisionReason: reason },
    'prospect_ai.instagram_discarded',
    now,
  );
}

/**
 * "Não contatar" (§8.3): the one register by the @, channel Instagram, origin prospecção; every
 * open prospect of that @ (whoever holds it) is closed. The register is never purged.
 */
export async function doNotContact(
  db: Database,
  actor: Actor,
  found: InstagramFound,
  reason: string | null,
  now: Date,
) {
  const username = found.evidence.authorUsername;
  if (!username) return CHANGED;
  await recordContactOptOut(db, {
    instagramUser: username,
    instagramIgsid: found.evidence.authorIgsid,
    channels: ['instagram'],
    origin: 'prospeccao',
    reason: reason || 'Pediu para não ser contatado (Prospecção Instagram).',
    createdBy: actor.employeeId,
  });
  const closed = await closeOpenOf(db, actor, username, now);
  await writeAudit(db, {
    actorEmployeeId: actor.employeeId,
    action: 'prospect_ai.instagram_do_not_contact',
    entity: 'prospect_opportunity',
    entityId: found.row.id,
    metadata: { closed },
  });
  const [fresh] = await prospectQuery(db).where(eq(prospectOpportunities.id, found.row.id));
  return { ok: true as const, prospect: toView(fresh!, actor) };
}

/** The levels that paste and create leads: who may receive a prospect. */
const INSTAGRAM_ROLE_KEYS = Object.entries(ROLE_PERMISSIONS)
  .filter(([, p]) => p['prospecting.instagram_paste'] && p['leads.write'])
  .map(([role]) => role);

export async function instagramOwners(db: Database) {
  return db
    .select({ id: employees.id, name: employees.fullName })
    .from(employees)
    .innerJoin(roles, eq(roles.id, employees.roleId))
    .where(and(eq(employees.status, 'active'), inArray(roles.key, INSTAGRAM_ROLE_KEYS)))
    .orderBy(asc(employees.fullName));
}

export async function transfer(
  db: Database,
  actor: Actor,
  found: InstagramFound,
  ownerEmployeeId: string,
  settings: InstagramProspectingSettings,
  now: Date,
) {
  if (!isInstagramManager(actor))
    return refusal(403, 'forbidden', 'Só a gerência transfere um prospect.');
  if (!(await instagramOwners(db)).some((o) => o.id === ownerEmployeeId))
    return refusal(400, 'invalid', 'Essa pessoa não trabalha a Prospecção Instagram.');
  const blocked = await instagramOptOut(db, actor, found, now);
  if (blocked) return blocked;
  const result = await move(
    db,
    actor,
    found,
    PROSPECT_OPEN_STATES,
    { ownerEmployeeId },
    'prospect_ai.instagram_transferred',
    now,
    { ownerEmployeeId },
  );
  if (result.ok)
    await restartRetention(db, found.row.id, settings.retention.instagramSemLeadDias, now);
  return result;
}

/**
 * "Criar lead" (§1.2): what the person passed in the Direct, typed by the seller. Every key is
 * checked against "não me contate" first, and a refusal writes nothing. The lead is born in the
 * category's funnel (or the one chosen), owned by the prospect's owner, origin instagram_colagem;
 * WhatsApp only when the person asked for it.
 */
export async function createLead(
  db: Database,
  actor: Actor,
  found: InstagramFound,
  input: InstagramLeadInput,
  now: Date,
): Promise<{ ok: true; leadId: string; created: boolean } | Refusal> {
  const { row, evidence } = found;
  if (!PROSPECT_OPEN_STATES.includes(row.state as ProspectOpportunityState))
    return refusal(409, 'prospect_fechado', 'Este prospect não está mais aberto.');
  const pipeline = input.pipeline ?? pipelineOfCategory(row.category);
  if (!pipeline) return refusal(400, 'invalid', 'Escolha o funil do lead.');
  const block = await contactBlock(db, ['instagram', 'phone', 'email', 'whatsapp'], {
    instagramUser: evidence.authorUsername,
    instagramIgsid: evidence.authorIgsid,
    phone: input.phone || null,
    email: input.email || null,
  });
  if (block.blocked)
    return refusal(409, 'contact_blocked', block.reason ?? 'Pediu para não ser contatado.');
  // Claimed first: two clicks create one lead; given back if the lead fails.
  const [claimed] = await db
    .update(prospectOpportunities)
    .set({ decidedAt: now, decidedBy: actor.employeeId, updatedAt: now })
    .where(
      and(
        eq(prospectOpportunities.id, row.id),
        inArray(prospectOpportunities.state, PROSPECT_OPEN_STATES),
        isNull(prospectOpportunities.decidedAt),
      ),
    )
    .returning({ id: prospectOpportunities.id });
  if (!claimed) return CHANGED;
  const ownerId = row.ownerEmployeeId ?? actor.employeeId;
  const optIn = input.whatsappOptIn;
  // Parte 1: a comment on Wings' post or ad (§5.6: an ad's lead is born `instagram_ad`).
  const partOne = row.source !== 'instagram_colagem';
  const consent: ProspectConsent = {
    legalBasis: optIn ? 'consent' : 'legitimate_interest',
    consentedAt: optIn ? now : null,
    consentSource: 'prospeccao',
    consentText: `${optIn ? 'Pediu' : 'Não pediu'} contato por WhatsApp na conversa pelo Direct (${dayOf(now)}). ${
      partOne
        ? `Comentário num ${evidence.adId ? 'anúncio' : 'post'} da Wings no Instagram, recebido em ${dayOf(row.createdAt)}.`
        : `Comentário público em post do Instagram${found.postOwner ? ` de @${found.postOwner}` : ''}, colado em ${dayOf(row.createdAt)}.`
    }`,
  };
  try {
    const result = await upsertLead(db, {
      source: !partOne ? 'instagram_colagem' : evidence.adId ? 'instagram_ad' : 'instagram_comment',
      externalId: partOne ? evidence.externalId : row.id,
      attribution:
        partOne && evidence.adId ? { adPlatform: 'meta', adExternalId: evidence.adId } : null,
      channel: 'instagram',
      name: input.contactName,
      phone: input.phone || null,
      email: input.email || null,
      clientId: WINGS_CLIENT_ID,
      clientMapped: true,
      pipeline,
      ownerEmployeeId: ownerId,
      company: input.companyName ? { name: input.companyName } : null,
      fields: evidence.authorUsername ? { instagram: evidence.authorUsername } : null,
      firstMessage: evidence.excerpt,
      ...consent,
      mergeOnlyIfOwnedBy: ownerId,
      distribute: false,
      skipResearch: true,
      event: {
        kind: 'lead.created_from_instagram',
        actorEmployeeId: actor.employeeId,
        detail: { opportunityId: row.id },
      },
    });
    const leadId = result.lead.id;
    if (!result.created) await mergeProspectConsent(db, actor, result.lead, consent, optIn);
    if (input.notes)
      await addNote(db, { leadId, body: input.notes, authorEmployeeId: actor.employeeId });
    await db
      .update(prospectOpportunities)
      .set({ state: 'aprovada', leadId, needsReviewReason: null, updatedAt: now })
      .where(eq(prospectOpportunities.id, row.id));
    // Parte 1: the person (IGSID) is now this lead's, so her next comment goes on its timeline.
    if (row.igPersonId)
      await db
        .update(igPeople)
        .set({ leadId, updatedAt: now })
        .where(eq(igPeople.id, row.igPersonId));
    // A lead follows the lead's own retention: the evidence is no longer purged at 30 days.
    await db
      .update(prospectEvidence)
      .set({ retentionUntil: null })
      .where(eq(prospectEvidence.opportunityId, row.id));
    await writeAudit(db, {
      actorEmployeeId: actor.employeeId,
      action: 'prospect_ai.instagram_lead_created',
      entity: 'prospect_opportunity',
      entityId: row.id,
      metadata: { leadId, created: result.created, pipeline, whatsappOptIn: optIn },
    });
    return { ok: true, leadId, created: result.created };
  } catch (error) {
    await db
      .update(prospectOpportunities)
      .set({ decidedAt: null, decidedBy: null, updatedAt: now })
      .where(eq(prospectOpportunities.id, row.id));
    if (error instanceof ForeignLeadError)
      return refusal(409, 'duplicate', 'Já existe uma negociação com este telefone ou e-mail.');
    throw error;
  }
}

/**
 * "Anexar o comentário ao lead" (§2.4): the person is already a lead the seller reaches; the
 * masked comment goes on the lead's timeline, nothing else is created.
 */
export async function attachToLead(
  db: Database,
  actor: Actor,
  input: InstagramAttachInput,
  now: Date,
): Promise<{ ok: true } | Refusal> {
  const lead = await leadInScope(db, actor, input.leadId, 'leads.write');
  const username = normalizeInstagram(input.username);
  const postUrl = normalizeInstagramPostUrl(input.postUrl);
  if (!lead) return refusal(404, 'not_found', 'Lead não encontrado.');
  if (!postUrl || !username || (lead.instagram && normalizeInstagram(lead.instagram)) !== username)
    return refusal(409, 'outro_instagram', 'O @ do comentário não é o Instagram deste lead.');
  await db.insert(leadEvents).values({
    leadId: lead.id,
    at: now,
    kind: 'prospect.instagram_comment_seen',
    actorEmployeeId: actor.employeeId,
    detail: {
      postUrl,
      excerpt: instagramExcerpt(input.text),
      occurredAt: commentOccurredAt(input.when ?? null, now).toISOString(),
      occurredAtPrecision: 'aproximada',
    },
  });
  await writeAudit(db, {
    actorEmployeeId: actor.employeeId,
    action: 'prospect_ai.instagram_comment_attached',
    entity: 'lead',
    entityId: lead.id,
  });
  return { ok: true };
}

/**
 * "A pessoa pediu contato por WhatsApp" on the lead a comment of parte 1 became from the Direct
 * (§5.5): the machine never infers consent; only who read the conversation marks it. The WhatsApp
 * send still asks the one "não me contate" register first.
 */
export async function markWhatsAppAsked(
  db: Database,
  actor: Actor,
  found: InstagramFound,
  now: Date,
): Promise<{ ok: true } | Refusal> {
  if (found.row.source === 'instagram_colagem' || !found.row.leadId)
    return refusal(409, 'sem_lead', 'Este prospect ainda não virou lead.');
  const lead = await leadInScope(db, actor, found.row.leadId, 'leads.write');
  if (!lead) return refusal(404, 'not_found', 'Lead não encontrado.');
  await mergeProspectConsent(
    db,
    actor,
    lead,
    {
      legalBasis: 'consent',
      consentedAt: now,
      consentSource: 'prospeccao',
      consentText: `Pediu contato por WhatsApp na conversa pelo Direct do Instagram (${dayOf(now)}), marcado por quem leu a conversa.`,
    },
    true,
  );
  await writeAudit(db, {
    actorEmployeeId: actor.employeeId,
    action: 'prospect_ai.instagram_whatsapp_asked',
    entity: 'prospect_opportunity',
    entityId: found.row.id,
    metadata: { leadId: lead.id },
  });
  return { ok: true };
}
