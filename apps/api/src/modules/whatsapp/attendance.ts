import {
  can,
  isSectorSlug,
  ROLE_KEYS,
  ROLE_PERMISSIONS,
  SOFIA_CLOSE_LABELS,
  SOFIA_HANDOFF_LABELS,
  WA_ASSIGNMENT_MODES,
  WA_REPLYING_SECONDS,
  type Actor,
  type LeadPipeline,
  type SectorSlug,
  type SofiaCloseReason,
  type SofiaFact,
  type SofiaHandoffReason,
  type WaAssignmentMode,
  type WaAttendanceView,
  type WaConversationEventKind,
} from '@wings/shared';
import { and, asc, desc, eq, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import type { PgUpdateSetSource } from 'drizzle-orm/pg-core';
import { alias } from 'drizzle-orm/pg-core';
import type { Database } from '../../db/client.js';
import { WINGS_TENANT_ID } from '../../db/schema/ads.js';
import {
  crmNotifications,
  employees,
  leads,
  roles,
  waConversationEvents,
  waConversations,
  waNumbers,
  whatsappSettings,
} from '../../db/schema/index.js';
import { leadOwnerFilter } from '../leads/access.js';
import { nextInRotation, type Executor } from '../leads/crm.js';
import { givenBack } from '../sofia/state.js';
import { notifyInboxChanged } from './inbox-signal.js';

/**
 * Who answers a WhatsApp conversation (docs/whatsapp/central.md, "Atendimento"; Eric, 26/10). The
 * holder is the one assigned, else the deal's owner (official number) or the number's owner (a
 * work number); with neither, the conversation waits in its queue. Only the holder writes: anyone
 * else who sees it takes it first, and the one who had it is told. Every change of hands moves the
 * row's `version` and leaves a line in `wa_conversation_events`; an action made on an older version
 * is refused, and Sofia's turn compares it too, so she never answers a conversation a person took
 * while she thought. Authorization stays here, in the API; the screen only hides buttons.
 */

export type AttendanceErrorCode =
  | 'conversation_changed'
  | 'not_holder'
  | 'person_invalid'
  | 'has_owner'
  | 'closed'
  | 'not_closed'
  | 'sofia_off'
  | 'not_official'
  | 'not_allowed';

export class AttendanceError extends Error {
  constructor(
    readonly code: AttendanceErrorCode,
    /** Who holds it, for "está com Fulano". */
    readonly holderName: string | null = null,
  ) {
    super(code);
  }
}

type ConversationRow = typeof waConversations.$inferSelect;

interface Hands {
  row: ConversationRow;
  holderId: string | null;
  /** Who holds it with nobody assigned: the deal's owner, or the number's. */
  naturalId: string | null;
  leadPipeline: string | null;
}

/** The conversation and its holder; `lock` holds the row until the transaction ends. */
async function handsOf(db: Executor, conversationId: string, lock = false): Promise<Hands | null> {
  const query = db
    .select({
      row: waConversations,
      leadOwner: leads.ownerEmployeeId,
      leadPipeline: leads.pipeline,
      numberOwner: waNumbers.ownerEmployeeId,
    })
    .from(waConversations)
    .leftJoin(leads, eq(leads.id, waConversations.leadId))
    .leftJoin(waNumbers, eq(waNumbers.id, waConversations.numberId))
    .where(eq(waConversations.id, conversationId));
  const [found] = lock ? await query.for('update', { of: waConversations }) : await query;
  if (!found) return null;
  const naturalId = found.row.numberId ? found.numberOwner : found.leadOwner;
  return {
    row: found.row,
    holderId: found.row.assigneeEmployeeId ?? naturalId,
    naturalId,
    leadPipeline: found.leadPipeline,
  };
}

const nameOf = async (db: Executor, id: string | null) => {
  if (!id) return null;
  const [row] = await db
    .select({ name: employees.fullName })
    .from(employees)
    .where(eq(employees.id, id));
  return row?.name ?? null;
};

interface Change {
  conversationId: string;
  /** The version the actor saw; null when the system moves it (the row is locked or compared). */
  version: number | null;
  actorId: string | null;
  kind: WaConversationEventKind;
  set: PgUpdateSetSource<typeof waConversations>;
  from?: string | null;
  to?: string | null;
  queue?: string | null;
  reason?: string | null;
  at: Date;
  /** The same holder, only a wait ending: the version moves, the history has nothing to add. */
  quiet?: boolean;
}

/** One change of hands: compared on the version, moved by one, written to the history. */
export async function changeHands(db: Executor, change: Change): Promise<boolean> {
  const [moved] = await db
    .update(waConversations)
    .set({
      ...change.set,
      version: sql`${waConversations.version} + 1`,
      stateChangedAt: change.at,
    })
    .where(
      and(
        eq(waConversations.id, change.conversationId),
        change.version === null ? undefined : eq(waConversations.version, change.version),
      ),
    )
    .returning({ id: waConversations.id });
  if (!moved) return false;
  if (!change.quiet) await recordEvent(db, change);
  return true;
}

export async function recordEvent(
  db: Executor,
  event: Pick<
    Change,
    'conversationId' | 'kind' | 'actorId' | 'from' | 'to' | 'queue' | 'reason' | 'at'
  >,
) {
  await db.insert(waConversationEvents).values({
    conversationId: event.conversationId,
    kind: event.kind,
    actorEmployeeId: event.actorId,
    fromEmployeeId: event.from ?? null,
    toEmployeeId: event.to ?? null,
    queue: event.queue ?? null,
    reason: event.reason ?? null,
    createdAt: event.at,
  });
}

/** A notice in the panel (CRM Vendas → Avisos): names our people, never the person's data. */
async function tell(
  db: Database,
  people: (string | null)[],
  notice: { leadId: string | null; message: string; key: string },
) {
  const to = [...new Set(people.filter((p): p is string => Boolean(p)))];
  if (to.length === 0) return;
  try {
    await db
      .insert(crmNotifications)
      .values(
        to.map((person) => ({
          recipientEmployeeId: person,
          leadId: notice.leadId,
          kind: 'whatsapp_assigned',
          message: notice.message,
          dedupeKey: `whatsapp_assigned:${notice.key}:${person}`,
        })),
      )
      .onConflictDoNothing();
  } catch {
    // The change is already made and in the history; the notice is a courtesy.
  }
}

const isFull = (actor: Actor) => leadOwnerFilter(actor, 'leads.whatsapp') === undefined;
const WHATSAPP_ROLES = ROLE_KEYS.filter((key) => ROLE_PERMISSIONS[key]['leads.whatsapp']);

/** Who a conversation may go to: active people whose level talks on the system's WhatsApp. */
export async function attendants(db: Executor) {
  return db
    .select({ id: employees.id, name: employees.fullName })
    .from(employees)
    .innerJoin(roles, eq(roles.id, employees.roleId))
    .where(and(eq(employees.status, 'active'), inArray(roles.key, WHATSAPP_ROLES)))
    .orderBy(asc(employees.fullName));
}

const PERSON_TAKES = ['sofia', 'waiting_seller', 'waiting_human'];

export interface ActionInput {
  conversationId: string;
  /** The version the screen saw; null compares nothing (an older screen without it). */
  version: number | null;
  actor: Actor;
  at: Date;
}

async function inTransaction<T>(db: Database, run: (tx: Executor) => Promise<T>) {
  const result = await db.transaction(run);
  notifyInboxChanged();
  return result;
}

/** Locks the row and checks the version the screen saw. */
async function current(tx: Executor, input: ActionInput) {
  const hands = await handsOf(tx, input.conversationId, true);
  if (!hands) throw new AttendanceError('not_allowed');
  if (input.version !== null && hands.row.version !== input.version)
    throw new AttendanceError('conversation_changed', await nameOf(tx, hands.holderId));
  return hands;
}

/** "Assumir": the reader holds it now; Sofia stops, and whoever had it hears. */
export async function takeOver(db: Database, input: ActionInput) {
  const me = input.actor.employeeId;
  const hands = await inTransaction(db, async (tx) => {
    const hands = await current(tx, input);
    if (hands.row.attendance === 'closed') throw new AttendanceError('closed');
    if (hands.holderId === me && hands.row.attendance === 'with_person') return hands;
    await changeHands(tx, {
      conversationId: hands.row.id,
      version: hands.row.version,
      actorId: me,
      kind: 'taken',
      set: {
        assigneeEmployeeId: me,
        attendance: 'with_person',
        reason: null,
        sofiaDueAt: null,
      },
      from: hands.holderId,
      to: me,
      at: input.at,
    });
    return hands;
  });
  if (hands.holderId && hands.holderId !== me)
    await tell(db, [hands.holderId], {
      leadId: hands.row.leadId,
      message: `${(await nameOf(db, me)) ?? 'Outra pessoa'} assumiu uma conversa do WhatsApp que estava com você.`,
      key: `${hands.row.id}:${input.at.toISOString()}`,
    });
}

/** The holder (or a full-scope reader) passes it to someone else, who hears at once. */
export async function transfer(db: Database, input: ActionInput & { to: string }) {
  const me = input.actor.employeeId;
  if (!(await attendants(db)).some((person) => person.id === input.to))
    throw new AttendanceError('person_invalid');
  const hands = await inTransaction(db, async (tx) => {
    const hands = await current(tx, input);
    if (hands.holderId !== me && !isFull(input.actor))
      throw new AttendanceError('not_holder', await nameOf(tx, hands.holderId));
    await changeHands(tx, {
      conversationId: hands.row.id,
      version: hands.row.version,
      actorId: me,
      kind: 'transferred',
      set: {
        assigneeEmployeeId: input.to,
        // Waiting for the new person's first word; a resolved one stays resolved.
        ...(hands.row.attendance === 'closed'
          ? {}
          : { attendance: 'waiting_seller', sofiaDueAt: null }),
      },
      from: hands.holderId,
      to: input.to,
      at: input.at,
    });
    return hands;
  });
  const by = (await nameOf(db, me)) ?? 'Uma pessoa';
  const key = `${hands.row.id}:${input.at.toISOString()}`;
  if (input.to !== me)
    await tell(db, [input.to], {
      leadId: hands.row.leadId,
      message: `${by} passou uma conversa do WhatsApp para você. Ela está em CRM Vendas › WhatsApp, na aba Minhas.`,
      key,
    });
  if (hands.holderId && hands.holderId !== me && hands.holderId !== input.to)
    await tell(db, [hands.holderId], {
      leadId: hands.row.leadId,
      message: `${by} passou para outra pessoa uma conversa do WhatsApp que estava com você.`,
      key,
    });
}

/** Back to a department's queue, nobody holding it: only a conversation with no deal or number owner. */
export async function sendToQueue(db: Database, input: ActionInput & { queue: SectorSlug }) {
  const me = input.actor.employeeId;
  await inTransaction(db, async (tx) => {
    const hands = await current(tx, input);
    if (hands.holderId !== me && !isFull(input.actor))
      throw new AttendanceError('not_holder', await nameOf(tx, hands.holderId));
    // The deal's owner (or the number's) would hold it again at once: a person is chosen instead.
    if (hands.naturalId) throw new AttendanceError('has_owner', await nameOf(tx, hands.naturalId));
    await changeHands(tx, {
      conversationId: hands.row.id,
      version: hands.row.version,
      actorId: me,
      kind: 'queued',
      set: {
        assigneeEmployeeId: null,
        queue: input.queue,
        ...(hands.row.attendance === 'closed'
          ? {}
          : { attendance: 'waiting_human', reason: null, sofiaDueAt: null }),
      },
      from: hands.holderId,
      queue: input.queue,
      at: input.at,
    });
  });
}

/** "Resolver": closed, kept with its holder; the person's next message opens it again. */
export async function resolve(db: Database, input: ActionInput) {
  const me = input.actor.employeeId;
  await inTransaction(db, async (tx) => {
    const hands = await current(tx, input);
    if (hands.row.attendance === 'closed') throw new AttendanceError('closed');
    if (hands.holderId !== me && !isFull(input.actor))
      throw new AttendanceError('not_holder', await nameOf(tx, hands.holderId));
    await changeHands(tx, {
      conversationId: hands.row.id,
      version: hands.row.version,
      actorId: me,
      kind: 'resolved',
      set: { attendance: 'closed', reason: 'encerrada', sofiaDueAt: null },
      at: input.at,
    });
  });
}

/** "Reabrir": back with its holder, or waiting in its queue when nobody holds it. */
export async function reopen(db: Database, input: ActionInput) {
  await inTransaction(db, async (tx) => {
    const hands = await current(tx, input);
    if (hands.row.attendance !== 'closed') throw new AttendanceError('not_closed');
    await changeHands(tx, {
      conversationId: hands.row.id,
      version: hands.row.version,
      actorId: input.actor.employeeId,
      kind: 'reopened',
      set: { attendance: hands.holderId ? 'with_person' : 'waiting_human', reason: null },
      at: input.at,
    });
  });
}

/**
 * Sofia in one conversation of the official number. Pause: she stops now and never takes it again
 * until someone turns her on (she is not reopened by the person's next message). Resume: needs
 * `sofia.read` and Sofia switched on; she answers the person's next message, never the ones a
 * person already had.
 */
export async function switchSofia(
  db: Database,
  input: ActionInput & { action: 'pause' | 'resume'; sofiaOn: boolean },
) {
  await inTransaction(db, async (tx) => {
    const hands = await current(tx, input);
    if (hands.row.numberId) throw new AttendanceError('not_official');
    if (input.action === 'pause') {
      await changeHands(tx, {
        conversationId: hands.row.id,
        version: hands.row.version,
        actorId: input.actor.employeeId,
        kind: 'sofia_paused',
        set: {
          sofiaPaused: true,
          ...(hands.row.attendance === 'sofia'
            ? { attendance: 'waiting_human', reason: 'sofia_pausada', sofiaDueAt: null }
            : {}),
        },
        reason: 'sofia_pausada',
        at: input.at,
      });
      return;
    }
    if (!can(input.actor, 'sofia.read').allowed) throw new AttendanceError('not_allowed');
    if (!input.sofiaOn) throw new AttendanceError('sofia_off');
    await changeHands(tx, {
      conversationId: hands.row.id,
      version: hands.row.version,
      actorId: input.actor.employeeId,
      kind: 'sofia_resumed',
      set: givenBack(hands.row.id),
      at: input.at,
    });
  });
}

/**
 * A person is about to write in the conversation: it must be theirs. Nobody holding it, it becomes
 * theirs; Sofia or a wait stops (one change of hands, recorded). Someone else holding it refuses,
 * with that person's name: they take it first ("Assumir"). Done before the message goes, so Sofia
 * never answers alongside.
 */
export async function holdForSend(
  db: Database,
  conversationId: string,
  actorId: string,
  at: Date,
): Promise<{ ok: true } | { ok: false; holderName: string | null }> {
  return inTransaction(db, async (tx) => {
    const hands = await handsOf(tx, conversationId, true);
    if (!hands) return { ok: true } as const;
    if (hands.holderId && hands.holderId !== actorId)
      return { ok: false, holderName: await nameOf(tx, hands.holderId) } as const;
    const { row } = hands;
    const stopsWait = PERSON_TAKES.includes(row.attendance) || row.attendance === 'closed';
    if (!hands.holderId || stopsWait)
      await changeHands(tx, {
        conversationId: row.id,
        version: row.version,
        actorId,
        kind: row.attendance === 'sofia' ? 'sofia_suspended' : 'taken',
        quiet: Boolean(hands.holderId) && row.attendance !== 'sofia',
        set: {
          ...(hands.holderId ? {} : { assigneeEmployeeId: actorId }),
          ...(stopsWait ? { attendance: 'with_person', reason: null, sofiaDueAt: null } : {}),
        },
        from: hands.holderId,
        to: actorId,
        at,
      });
    // The one typing just wrote: no "está respondendo" left behind.
    await tx
      .update(waConversations)
      .set({ replyingEmployeeId: null, replyingUntil: null })
      .where(and(eq(waConversations.id, row.id), eq(waConversations.replyingEmployeeId, actorId)));
    return { ok: true } as const;
  });
}

/** Read only, before the work of a send: who else holds the conversation, when someone does. */
export async function heldByOther(
  db: Database,
  conversationId: string,
  actorId: string,
): Promise<{ holderName: string | null } | null> {
  const hands = await handsOf(db, conversationId);
  if (!hands?.holderId || hands.holderId === actorId) return null;
  return { holderName: await nameOf(db, hands.holderId) };
}

/** "Está respondendo": the reader types here for the next seconds. Null, or who already is. */
export async function startReplying(
  db: Database,
  conversationId: string,
  actorId: string,
  at: Date,
): Promise<string | null> {
  const [mine] = await db
    .update(waConversations)
    .set({
      replyingEmployeeId: actorId,
      replyingUntil: new Date(at.getTime() + WA_REPLYING_SECONDS * 1000),
    })
    .where(
      and(
        eq(waConversations.id, conversationId),
        or(
          isNull(waConversations.replyingEmployeeId),
          eq(waConversations.replyingEmployeeId, actorId),
          lt(waConversations.replyingUntil, at),
        ),
      ),
    )
    .returning({ id: waConversations.id });
  if (mine) return null;
  const [other] = await db
    .select({ id: waConversations.replyingEmployeeId })
    .from(waConversations)
    .where(eq(waConversations.id, conversationId));
  return nameOf(db, other?.id ?? null);
}

export async function assignmentModeOf(db: Executor): Promise<WaAssignmentMode> {
  const [row] = await db
    .select({ mode: whatsappSettings.assignmentMode })
    .from(whatsappSettings)
    .where(eq(whatsappSettings.tenantId, WINGS_TENANT_ID));
  return (WA_ASSIGNMENT_MODES as readonly string[]).includes(row?.mode ?? '')
    ? (row!.mode as WaAssignmentMode)
    : 'manual';
}

export async function setAssignmentMode(db: Database, mode: WaAssignmentMode, employeeId: string) {
  await db
    .insert(whatsappSettings)
    .values({ tenantId: WINGS_TENANT_ID, assignmentMode: mode, updatedBy: employeeId })
    .onConflictDoUpdate({
      target: whatsappSettings.tenantId,
      set: { assignmentMode: mode, updatedBy: employeeId, updatedAt: new Date() },
    });
}

const PIPELINE_OF_SEGMENT: Record<string, LeadPipeline> = {
  expansao: 'expansao',
  formatacao: 'formatacao',
};

/**
 * A conversation that waits for a person and that nobody holds: with the rotation on, the funnel's
 * next person (the deal's funnel, else what Sofia found out) takes it and hears. Off, or with no
 * funnel known, it waits in its queue. Returns who got it.
 */
export async function distribute(
  db: Database,
  conversationId: string,
  at: Date,
): Promise<string | null> {
  if ((await assignmentModeOf(db)) !== 'rodizio') return null;
  const picked = await db.transaction(async (tx) => {
    const hands = await handsOf(tx, conversationId, true);
    if (!hands || hands.holderId) return null;
    if (!['waiting_human', 'waiting_seller'].includes(hands.row.attendance)) return null;
    const pipeline =
      (hands.leadPipeline as LeadPipeline | null) ??
      PIPELINE_OF_SEGMENT[hands.row.segment ?? ''] ??
      null;
    if (!pipeline) return null;
    const person = await nextInRotation(tx, pipeline, at);
    if (!person) return null;
    await changeHands(tx, {
      conversationId,
      version: null,
      actorId: null,
      kind: 'distributed',
      set: { assigneeEmployeeId: person, attendance: 'waiting_seller' },
      to: person,
      at,
    });
    return { person, leadId: hands.row.leadId };
  });
  if (!picked) return null;
  notifyInboxChanged();
  await tell(db, [picked.person], {
    leadId: picked.leadId,
    message:
      'O rodízio passou uma conversa do WhatsApp para você. Ela está em CRM Vendas › WhatsApp, na aba Minhas.',
    key: `${conversationId}:${at.toISOString()}`,
  });
  return picked.person;
}

const OTHER_REASONS: Record<string, string> = { mensagem_da_pessoa: 'A pessoa escreveu de novo' };

const reasonLabel = (reason: string | null) =>
  reason
    ? (SOFIA_HANDOFF_LABELS[reason as SofiaHandoffReason] ??
      SOFIA_CLOSE_LABELS[reason as SofiaCloseReason] ??
      OTHER_REASONS[reason] ??
      null)
    : null;

/** The Central's panel: who holds it, what each reader may do, the history and Sofia's context. */
export async function attendanceView(
  db: Database,
  input: { conversationId: string; actor: Actor; at: Date; sofiaOn: boolean },
  sofiaFacts: (row: ConversationRow) => SofiaFact[],
): Promise<WaAttendanceView | null> {
  const hands = await handsOf(db, input.conversationId);
  if (!hands) return null;
  const { row } = hands;
  const me = input.actor.employeeId;
  const full = isFull(input.actor);
  const holds = hands.holderId === me;
  const closed = row.attendance === 'closed';
  const official = row.numberId === null;
  const replying =
    row.replyingEmployeeId && row.replyingEmployeeId !== me && row.replyingUntil
      ? row.replyingUntil > input.at
        ? await nameOf(db, row.replyingEmployeeId)
        : null
      : null;
  const facts = official ? sofiaFacts(row) : [];
  const from = alias(employees, 'from_person');
  const to = alias(employees, 'to_person');
  const by = alias(employees, 'by_person');
  const events = await db
    .select({
      id: waConversationEvents.id,
      kind: waConversationEvents.kind,
      fromName: from.fullName,
      toName: to.fullName,
      queue: waConversationEvents.queue,
      reason: waConversationEvents.reason,
      actorName: by.fullName,
      at: waConversationEvents.createdAt,
    })
    .from(waConversationEvents)
    .leftJoin(from, eq(from.id, waConversationEvents.fromEmployeeId))
    .leftJoin(to, eq(to.id, waConversationEvents.toEmployeeId))
    .leftJoin(by, eq(by.id, waConversationEvents.actorEmployeeId))
    .where(eq(waConversationEvents.conversationId, row.id))
    .orderBy(desc(waConversationEvents.createdAt))
    .limit(50);
  const canTransfer = holds || full;
  return {
    attendance: {
      conversationId: row.id,
      version: row.version,
      holderId: hands.holderId,
      holderName: await nameOf(db, hands.holderId),
      assigned: row.assigneeEmployeeId !== null,
      queue: row.queue && isSectorSlug(row.queue) ? row.queue : null,
      replyingName: replying,
      sofiaPaused: row.sofiaPaused,
      sofia:
        official && (facts.length > 0 || row.reason)
          ? { reason: reasonLabel(row.reason), facts }
          : null,
      can: {
        take: !closed && !(holds && row.attendance === 'with_person'),
        transfer: canTransfer,
        resolve: !closed && canTransfer,
        reopen: closed,
        pauseSofia: official && input.sofiaOn && !row.sofiaPaused,
        resumeSofia:
          official &&
          input.sofiaOn &&
          row.attendance !== 'sofia' &&
          can(input.actor, 'sofia.read').allowed,
      },
    },
    events: events.map((event) => ({
      id: event.id,
      kind: event.kind as WaConversationEventKind,
      fromName: event.fromName,
      toName: event.toName,
      queue: event.queue && isSectorSlug(event.queue) ? event.queue : null,
      reason: reasonLabel(event.reason),
      actorName: event.actorName,
      at: event.at.toISOString(),
    })),
    people: canTransfer ? await attendants(db) : [],
  };
}

const STATUS: Record<AttendanceErrorCode, number> = {
  conversation_changed: 409,
  not_holder: 409,
  person_invalid: 400,
  has_owner: 409,
  closed: 409,
  not_closed: 409,
  sofia_off: 409,
  not_official: 409,
  not_allowed: 403,
};

/** The answer for a refused action, in the words the screen shows. */
export function attendanceRefusal(error: AttendanceError) {
  const who = error.holderName ?? 'outra pessoa';
  const messages: Record<AttendanceErrorCode, string> = {
    conversation_changed: `A conversa mudou de mãos agora (está com ${who}). Veja de novo antes de agir.`,
    not_holder: `Esta conversa está com ${who}. Assuma a conversa antes (${who} recebe um aviso).`,
    person_invalid: 'Escolha uma pessoa ativa que atende pelo WhatsApp.',
    has_owner: `Esta conversa é de ${who} (dono da negociação ou do número): passe para uma pessoa em vez da fila.`,
    closed: 'A conversa está resolvida: reabra antes.',
    not_closed: 'A conversa já está aberta.',
    sofia_off: 'A Sofia está desligada. Ligue-a na configuração antes.',
    not_official: 'A Sofia só atende no número oficial.',
    not_allowed: 'Você não pode fazer isso nesta conversa.',
  };
  return {
    status: STATUS[error.code],
    body: { error: error.code, message: messages[error.code] },
  };
}
