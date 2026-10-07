import {
  nextBusinessInstant,
  SOFIA_BRAND_BUTTONS,
  SOFIA_BUTTONS,
  SOFIA_CLOSE_LABELS,
  SOFIA_HANDOFF_LABELS,
  SOFIA_LOST_REASONS,
  SOFIA_MODEL,
  SOFIA_OBJECTIVE_BUTTONS,
  SOFIA_PROMPT_VERSION,
  WA_MEDIA_KINDS,
  WA_WINDOW_HOURS,
  type SofiaCloseReason,
  type SofiaHandoffReason,
  type SofiaQuestion,
  type SofiaSegment,
  type SofiaSettings,
  type WaMessageKind,
} from '@wings/shared';
import { and, asc, desc, eq, gte, inArray, isNull, lt, lte, or, sql } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import {
  clients,
  crmNotifications,
  leads,
  sofiaAiRuns,
  waContacts,
  waConversations,
  waMessages,
} from '../../db/schema/index.js';
import { writeAudit } from '../../lib/audit.js';
import type { AgentLlm, LlmUsage } from '../agent/llm.js';
import { managersAndBoard } from '../leads/crm-alerts.js';
import { changeLead } from '../leads/crm.js';
import {
  buttonsPayload,
  listPayload,
  textPayload,
  type OutgoingPayload,
  type WhatsAppConfig,
} from '../whatsapp/graph.js';
import { adoptUnmatched } from '../whatsapp/intake.js';
import { deliverWhatsApp, type Contact } from '../whatsapp/outbox.js';
import { isOptOut } from '../whatsapp/webhook-parse.js';
import { readTurn, type SofiaIntent, type SofiaReading, type SofiaTurnLine } from './brain.js';
import { sofiaHandOver } from './deal.js';
import { loadSofiaSettings } from './settings.js';
import { factsOf, type ConversationRow, type SofiaFacts } from './state.js';

/**
 * Sofia's turn (docs/whatsapp/sofia.md). The person wrote and a few quiet
 * seconds passed: one server takes the turn (a claim on the row), reads the
 * new messages, understands them — buttons, lists and the name step without
 * the AI, free text with one AI call under SOFIA_DAILY_USD — and answers with
 * one message: the next question, the handover to the seller, or the handover
 * to a person. The state is saved before the message goes, and the message
 * goes once and is never retried, so a crash never answers twice.
 */

export interface SofiaDeps {
  db: Database;
  llm: AgentLlm | null;
  fetchImpl: typeof fetch;
  config: WhatsAppConfig | null;
  /** SOFIA_DAILY_USD. */
  dailyUsd: number;
  now: () => Date;
  log: (facts: Record<string, unknown>) => void;
}

/** A claim older than this was cut short by a restart. */
const STALE_CLAIM_MS = 2 * 60_000;
/** The most one AI call may cost, reserved before it is made (a turn costs well under a cent). */
export const SOFIA_RESERVE_MICRO_USD = 10_000;
/** Lines of the conversation the AI reads. */
const CONTEXT_LINES = 12;

const HUMAN_INTENTS: Partial<Record<SofiaIntent, SofiaHandoffReason>> = {
  cliente_atual: 'cliente_atual',
  fornecedor: 'fornecedor',
  emprego: 'emprego',
  reclamacao: 'reclamacao',
  quer_pessoa: 'quer_pessoa',
};

const SEGMENT_OF: Partial<Record<SofiaIntent, Exclude<SofiaSegment, 'outro'>>> = {
  formatacao: 'formatacao',
  consultoria: 'formatacao',
  expansao: 'expansao',
};

const YES =
  /^\s*(sim|isso|isso mesmo|exato|correto|certo|é sim|e sim|é essa|essa mesma|positivo)\b/i;
const NO = /^\s*(n[aã]o|nao é|outra)\b/i;
const NOTHING = /^\s*(n[aã]o( tenho| tem| possuo| temos)?|nenhum|ainda n[aã]o|sem)\s*[.!]?\s*$/i;

/** A name as people write it ("Meu nome é Ana Paula"), or null when it does not look like one. */
export function nameFrom(text: string): string | null {
  const cleaned = text
    .trim()
    .replace(/^(oi|ol[áa]|bom dia|boa tarde|boa noite)[\s,!.]*/i, '')
    .replace(/^(meu nome [ée]|me chamo|eu sou|sou|aqui [ée])\s+(o\s+|a\s+)?/i, '')
    .replace(/[\s.!,]+$/, '')
    .trim();
  if (!cleaned || cleaned.length > 60) return null;
  if (!/^[\p{L}][\p{L}' .-]*$/u.test(cleaned)) return null;
  if (cleaned.split(/\s+/).length > 6) return null;
  return cleaned;
}

/** Mon–Fri 9h–18h in São Paulo (the CRM's working hours, to the minute). */
const inHours = (now: Date) => nextBusinessInstant(now).getTime() <= now.getTime();

type Step =
  | { kind: 'objective' }
  | { kind: 'other' }
  | { kind: 'brand_confirm'; brandName: string }
  | { kind: 'brand' }
  | { kind: 'question'; question: SofiaQuestion }
  | { kind: 'done' };

function questionsOf(settings: SofiaSettings, segment: SofiaSegment | null) {
  return segment === 'expansao' ? settings.expansao : settings.formatacao;
}

/** Runs every turn that is due; returns how many ran. */
export async function runDueSofiaTurns(deps: SofiaDeps, limit = 10): Promise<number> {
  const now = deps.now();
  const due = await deps.db
    .select({ id: waConversations.id })
    .from(waConversations)
    .where(
      and(
        eq(waConversations.attendance, 'sofia'),
        lte(waConversations.sofiaDueAt, now),
        or(
          isNull(waConversations.sofiaClaimedAt),
          lt(waConversations.sofiaClaimedAt, new Date(now.getTime() - STALE_CLAIM_MS)),
        ),
      ),
    )
    .orderBy(asc(waConversations.sofiaDueAt))
    .limit(limit);
  let ran = 0;
  for (const row of due) {
    try {
      if (await runSofiaTurn(deps, row.id)) ran++;
    } catch (error) {
      const code =
        error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
          ? `db_${error.code}`
          : 'error';
      deps.log({ job: 'sofia', conversation: row.id, error: code });
      // Tried again in a minute (the state was not saved, nothing was sent).
      await deps.db
        .update(waConversations)
        .set({ sofiaClaimedAt: null, sofiaDueAt: new Date(deps.now().getTime() + 60_000) })
        .where(eq(waConversations.id, row.id));
    }
  }
  return ran;
}

/** One turn of one conversation; false when there was nothing to do or another server has it. */
export async function runSofiaTurn(deps: SofiaDeps, conversationId: string): Promise<boolean> {
  const { db } = deps;
  const now = deps.now();
  const [claimed] = await db
    .update(waConversations)
    .set({ sofiaClaimedAt: now })
    .where(
      and(
        eq(waConversations.id, conversationId),
        eq(waConversations.attendance, 'sofia'),
        lte(waConversations.sofiaDueAt, now),
        or(
          isNull(waConversations.sofiaClaimedAt),
          lt(waConversations.sofiaClaimedAt, new Date(now.getTime() - STALE_CLAIM_MS)),
        ),
      ),
    )
    .returning();
  if (!claimed) return false;
  const turn = new Turn(deps, claimed, now);
  await turn.run();
  return true;
}

interface Outgoing {
  shown: string;
  payload: OutgoingPayload;
  kind: WaMessageKind;
  content: Record<string, unknown>;
}

class Turn {
  private facts: SofiaFacts;
  private segment: SofiaSegment | null;
  private brandClientId: string | null;
  private misses: number;
  private settings!: SofiaSettings;
  private contact!: Contact;
  private newIds: string[] = [];
  private parts: string[] = [];

  constructor(
    private readonly deps: SofiaDeps,
    private conversation: ConversationRow,
    private readonly now: Date,
  ) {
    this.facts = factsOf(conversation);
    this.segment = (conversation.segment as SofiaSegment | null) ?? null;
    this.brandClientId = conversation.brandClientId;
    this.misses = conversation.sofiaMisses;
  }

  private get db() {
    return this.deps.db;
  }

  async run() {
    const { db } = this;
    this.settings = await loadSofiaSettings(db);
    const contact = await db.query.waContacts.findFirst({
      where: eq(waContacts.id, this.conversation.contactId),
    });
    if (!contact) return this.release();
    this.contact = contact;

    const fresh = await db
      .select()
      .from(waMessages)
      .where(
        and(
          eq(waMessages.conversationId, this.conversation.id),
          eq(waMessages.direction, 'in'),
          // Compared in the database: its timestamps have microseconds, a JS Date has not.
          sql`${waMessages.createdAt} > coalesce((select c.sofia_read_until from wa_conversations c where c.id = ${this.conversation.id}), '-infinity'::timestamptz)`,
        ),
      )
      .orderBy(asc(waMessages.createdAt))
      .limit(30);
    this.newIds = fresh.map((m) => m.id);
    if (fresh.length === 0) return this.release();

    if (!this.settings.enabled) return this.toHuman('sofia_desligada', false);
    const windowOpen =
      contact.lastInboundAt !== null &&
      contact.lastInboundAt.getTime() + WA_WINDOW_HOURS * 3_600_000 > this.now.getTime();
    if (!windowOpen || !this.deps.config) return this.toHuman('ia_indisponivel', false);

    // SAIR / PARAR: a fixed rule, no AI, no conversation.
    if (fresh.some((m) => isOptOut(m.text))) return this.close('nao_contatar', true);

    // --- what the person said ---------------------------------------------------------
    let progress = false;
    for (const message of fresh) {
      const id = (message.content as { interactive?: { id?: string | null } }).interactive?.id;
      if (id && this.applyButton(id)) progress = true;
    }
    const ours = (m: (typeof fresh)[number]) =>
      ((m.content as { interactive?: { id?: string | null } }).interactive?.id ?? '').startsWith(
        'sofia:',
      );
    // Typed text, a template's quick reply, or a tap on a button that is not Sofia's.
    const texts = fresh
      .filter(
        (m) =>
          (m.kind === 'text' || m.kind === 'button' || (m.kind === 'interactive' && !ours(m))) &&
          m.text?.trim(),
      )
      .map((m) => m.text!.trim());
    const mediaOnly =
      texts.length === 0 &&
      !progress &&
      fresh.some((m) => WA_MEDIA_KINDS.includes(m.kind as WaMessageKind));

    let reading: SofiaReading | null = null;
    let missed = false;
    if (texts.length > 0) {
      const text = texts.join('\n');
      if (this.readWithoutAi(text)) progress = true;
      else {
        const read = await this.readWithAi();
        if (read === 'ceiling') return this.aiDown('teto_diario');
        if (read === null) return this.aiDown('ia_indisponivel');
        reading = read;
        const human = HUMAN_INTENTS[reading.intent];
        if (human) return this.toHuman(human, true);
        if (reading.intent === 'nao_contatar') return this.close('nao_contatar', true);
        if (reading.intent === 'spam') return this.close('spam', false);
        if (reading.intent === 'numero_errado') return this.close('numero_errado', false);
        if (await this.applyReading(reading)) progress = true;
        if (this.facts.step === 'other' && this.segment === 'outro')
          return this.toHuman('outro_assunto', true);
        if (!progress && !reading.understood) missed = true;
        if (!progress && reading.understood && !reading.reply && !reading.askedValues)
          missed = true;
      }
    } else if (mediaOnly) {
      if (this.facts.mediaAsked) return this.toHuman('midia', true);
      this.facts.mediaAsked = true;
      this.parts.push(this.settings.texts.media);
    } else if (!progress) {
      // A reaction, a location, a contact card: nothing to answer yet.
      return this.release();
    }

    // Before her first words nothing was asked, so nothing was misunderstood.
    if (!this.facts.greeted) missed = false;
    if (missed) {
      this.misses += 1;
      if (this.misses >= 2) return this.toHuman('nao_entendeu', true);
      this.parts.push(this.settings.texts.notUnderstood);
    } else if (progress) this.misses = 0;

    // --- what comes next -------------------------------------------------------------
    if (!this.facts.greeted) this.parts.unshift(this.settings.texts.greeting);
    this.facts.greeted = true;
    if (reading?.reply && !missed) this.parts.push(reading.reply);
    if (reading?.askedValues) this.parts.push(this.settings.texts.values);

    const step = await this.nextStep();
    if (step.kind === 'done') return this.handOver();
    const outgoing = this.ask(step);
    await this.save({});
    await this.send(outgoing);
  }

  // --- reading ---------------------------------------------------------------------------

  /** A tap on one of Sofia's buttons or list rows. */
  private applyButton(id: string): boolean {
    if (id === SOFIA_BUTTONS.formatacao || id === SOFIA_BUTTONS.expansao) {
      this.segment = id === SOFIA_BUTTONS.formatacao ? 'formatacao' : 'expansao';
      return true;
    }
    if (id === SOFIA_BUTTONS.outro) {
      this.segment = 'outro';
      return true;
    }
    if (id === SOFIA_BUTTONS.brandYes) {
      this.facts.brandConfirmed = true;
      return true;
    }
    if (id === SOFIA_BUTTONS.brandOther) {
      this.brandClientId = null;
      this.facts.brandConfirmed = false;
      this.facts.brandText = null;
      this.facts.step = 'brand';
      return true;
    }
    const row = /^sofia:q:([a-z][a-z0-9_]*):(\d+)$/.exec(id);
    if (row) {
      const question = questionsOf(this.settings, this.segment).find((q) => q.key === row[1]);
      const option = question?.options[Number(row[2])];
      if (question && option) {
        this.facts.answers[question.key] = option;
        return true;
      }
    }
    return false;
  }

  /** The name step, a yes/no to the brand and "não tenho": read by rule, never by the AI. */
  private readWithoutAi(text: string): boolean {
    const step = this.facts.step;
    if (step === 'brand_confirm') {
      if (YES.test(text)) {
        this.facts.brandConfirmed = true;
        return true;
      }
      if (NO.test(text) && text.length < 30) {
        this.brandClientId = null;
        this.facts.brandConfirmed = false;
        this.facts.step = 'brand';
        return true;
      }
      return false;
    }
    const question = questionsOf(this.settings, this.segment).find((q) => q.key === step);
    if (!question) return false;
    if (question.kind === 'name') {
      const name = nameFrom(text);
      if (!name) return false;
      this.facts.answers[question.key] = name;
      return true;
    }
    if (question.optional && NOTHING.test(text)) {
      this.facts.answers[question.key] = 'Não tem';
      return true;
    }
    return false;
  }

  /** One AI call under the daily ceiling; 'ceiling' when it would pass it, null when it failed. */
  private async readWithAi(): Promise<SofiaReading | 'ceiling' | null> {
    const { llm } = this.deps;
    if (!llm) return null;
    const runId = await this.reserve();
    if (!runId) return 'ceiling';
    const questions = questionsOf(this.settings, this.segment);
    const name = questions.find((q) => q.kind === 'name');
    const known = { ...this.facts.answers };
    if (name) delete known[name.key];
    const result = await readTurn(llm, {
      segment: this.segment,
      brandName: await this.brandName(),
      current: questions.find((q) => q.key === this.facts.step) ?? null,
      questions,
      known,
      lines: await this.context(name ? this.facts.answers[name.key] : undefined),
    });
    await this.settle(runId, result.usage, result.ok ? 'ok' : result.outcome);
    return result.ok ? result.reading : null;
  }

  /** The last lines of the conversation, with the person's name taken out. */
  private async context(name: string | undefined): Promise<SofiaTurnLine[]> {
    const rows = await this.db
      .select({ direction: waMessages.direction, text: waMessages.text })
      .from(waMessages)
      .where(eq(waMessages.conversationId, this.conversation.id))
      .orderBy(desc(waMessages.createdAt))
      .limit(CONTEXT_LINES);
    const names = [name, this.contact.profileName]
      .filter((n): n is string => Boolean(n && n.trim().length >= 2))
      .map((n) => new RegExp(n.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'));
    return rows
      .reverse()
      .filter((r) => r.text)
      .map((r) => ({
        from: r.direction === 'in' ? ('lead' as const) : ('sofia' as const),
        text: names.reduce((t, re) => t.replace(re, '[nome]'), r.text!),
      }));
  }

  private async applyReading(reading: SofiaReading): Promise<boolean> {
    let progress = false;
    const segment = SEGMENT_OF[reading.intent];
    if (segment && (this.segment === null || this.segment === 'outro')) {
      this.segment = segment;
      progress = true;
    }
    const questions = questionsOf(this.settings, this.segment);
    for (const [key, answer] of Object.entries(reading.answers)) {
      if (!questions.some((q) => q.key === key)) continue;
      if (this.facts.answers[key] !== answer) progress = true;
      this.facts.answers[key] = answer;
    }
    if (this.segment === 'expansao' && reading.brand) {
      if (!this.brandClientId || this.facts.step === 'brand') {
        const match = await this.matchBrand(reading.brand);
        if (match) {
          this.brandClientId = match;
          this.facts.brandConfirmed = true;
        } else this.facts.brandText = reading.brand;
        progress = true;
      }
    }
    return progress;
  }

  /** A client of ours whose name the person wrote (accents and case aside). */
  private async matchBrand(text: string): Promise<string | null> {
    const fold = (s: string) =>
      s
        .normalize('NFD')
        .replace(/\p{Diacritic}/gu, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .trim();
    const wanted = fold(text);
    if (wanted.length < 3) return null;
    const rows = await this.db
      .select({ id: clients.id, name: clients.name })
      .from(clients)
      .where(eq(clients.active, true));
    const hit =
      rows.find((c) => fold(c.name) === wanted) ??
      rows.find((c) => fold(c.name).includes(wanted) || wanted.includes(fold(c.name)));
    return hit && fold(hit.name).length >= 3 ? hit.id : null;
  }

  private async brandName(): Promise<string | null> {
    if (!this.brandClientId) return null;
    const row = await this.db.query.clients.findFirst({
      where: eq(clients.id, this.brandClientId),
      columns: { name: true },
    });
    return row?.name ?? null;
  }

  // --- the next step ------------------------------------------------------------------------

  private async nextStep(): Promise<Step> {
    if (this.segment === null) return { kind: 'objective' };
    if (this.segment === 'outro') return { kind: 'other' };
    if (this.segment === 'expansao') {
      if (this.brandClientId && !this.facts.brandConfirmed) {
        const brandName = await this.brandName();
        if (brandName) return { kind: 'brand_confirm', brandName };
        this.brandClientId = null;
      }
      if (!this.brandClientId && !this.facts.brandText) return { kind: 'brand' };
    }
    const question = questionsOf(this.settings, this.segment).find(
      (q) => this.facts.answers[q.key] === undefined,
    );
    return question ? { kind: 'question', question } : { kind: 'done' };
  }

  private ask(step: Exclude<Step, { kind: 'done' }>): Outgoing {
    const texts = this.settings.texts;
    const body = (last: string) => [...this.parts, last].join('\n\n');
    if (step.kind === 'objective') {
      this.facts.step = 'objective';
      return this.buttons(body(texts.objective), SOFIA_OBJECTIVE_BUTTONS);
    }
    if (step.kind === 'other') {
      this.facts.step = 'other';
      this.facts.askedOther = true;
      return this.text(body(texts.otherSubject));
    }
    if (step.kind === 'brand_confirm') {
      this.facts.step = 'brand_confirm';
      return this.buttons(
        body(texts.brandConfirm.replaceAll('{marca}', step.brandName)),
        SOFIA_BRAND_BUTTONS,
      );
    }
    if (step.kind === 'brand') {
      this.facts.step = 'brand';
      return this.text(body(texts.brandQuestion));
    }
    const { question } = step;
    this.facts.step = question.key;
    if (question.kind === 'choice') {
      const shown = body(question.text);
      const rows = question.options.map((title, i) => ({
        id: `sofia:q:${question.key}:${i}`,
        title,
      }));
      return {
        shown: `${shown}\n\n${question.options.map((o) => `• ${o}`).join('\n')}`,
        payload: listPayload(shown, 'Ver opções', rows),
        kind: 'interactive',
        content: { sofia: { step: question.key }, list: rows },
      };
    }
    return this.text(body(question.text));
  }

  private text(shown: string): Outgoing {
    return {
      shown,
      payload: textPayload(shown),
      kind: 'text',
      content: { sofia: { step: this.facts.step } },
    };
  }

  private buttons(shown: string, buttons: readonly { id: string; title: string }[]): Outgoing {
    return {
      shown: `${shown}\n\n${buttons.map((b) => `[${b.title}]`).join(' ')}`,
      payload: buttonsPayload(shown, buttons),
      kind: 'interactive',
      content: { sofia: { step: this.facts.step }, buttons },
    };
  }

  // --- endings ------------------------------------------------------------------------------

  private withHours(text: string) {
    return inHours(this.now) ? text : `${text}\n\n${this.settings.texts.outOfHours}`;
  }

  /** Her first words always say who she is, even when they are a handover. */
  private introduced(text: string) {
    if (this.facts.greeted) return text;
    this.facts.greeted = true;
    return `${this.settings.texts.greeting}\n\n${text}`;
  }

  /** The questions are done: the deal is made and given to its seller. */
  private async handOver() {
    const segment = this.segment === 'expansao' ? 'expansao' : 'formatacao';
    const deal = await sofiaHandOver(this.db, {
      conversation: this.conversation,
      contact: this.contact,
      facts: this.facts,
      segment,
      brandClientId: this.brandClientId,
      settings: this.settings,
      now: this.now,
    });
    if (this.conversation.leadId !== deal.leadId)
      await adoptUnmatched(this.db, this.contact.id, deal.leadId);
    // Adoption may have merged this conversation into the deal's own one.
    const [target] = await this.db
      .select()
      .from(waConversations)
      .where(
        and(
          eq(waConversations.contactId, this.contact.id),
          eq(waConversations.leadId, deal.leadId),
        ),
      )
      .limit(1);
    if (target) this.conversation = target;
    this.facts.step = null;
    await this.save({ attendance: 'waiting_seller', reason: null });
    await writeAudit(this.db, {
      action: 'sofia.handed_over',
      entity: 'lead',
      entityId: deal.leadId,
      metadata: { conversationId: this.conversation.id, segment, created: deal.created },
    });
    const words = [...this.parts, this.withHours(this.settings.texts.handoffSeller)].join('\n\n');
    await this.send(this.text(words), deal.leadId);
  }

  /** A person of the team takes over: no deal is made. */
  private async toHuman(reason: SofiaHandoffReason, say: boolean) {
    const text = say ? this.introduced(this.withHours(this.settings.texts.handoffHuman)) : null;
    await this.save({ attendance: 'waiting_human', reason });
    await this.notifyTeam(reason);
    if (text) await this.send(this.text(text));
  }

  private async aiDown(reason: 'ia_indisponivel' | 'teto_diario') {
    const text = this.introduced(this.withHours(this.settings.texts.aiDown));
    await this.save({ attendance: 'waiting_human', reason });
    await this.notifyTeam(reason);
    await this.send(this.text(text));
  }

  /**
   * The only cases Sofia ends alone (Eric, 04/10): the person asked not to be
   * contacted, spam, wrong number. An open deal of the conversation with no
   * owner is lost with that reason; one with an owner is never touched.
   */
  private async close(reason: Exclude<SofiaCloseReason, 'encerrada'>, confirm: boolean) {
    if (reason === 'nao_contatar')
      await this.db
        .update(waContacts)
        .set({ optOutAt: this.now, updatedAt: this.now })
        .where(and(eq(waContacts.id, this.contact.id), isNull(waContacts.optOutAt)));
    if (this.conversation.leadId) {
      const [lead] = await this.db
        .select({ owner: leads.ownerEmployeeId, won: leads.won })
        .from(leads)
        .where(eq(leads.id, this.conversation.leadId));
      if (lead && lead.owner === null && lead.won === null)
        await changeLead(this.db, {
          leadId: this.conversation.leadId,
          won: false,
          lostReason: SOFIA_LOST_REASONS[reason],
          source: 'sofia',
          actorEmployeeId: null,
        });
    }
    await this.save({ attendance: 'closed', reason });
    await writeAudit(this.db, {
      action: 'sofia.closed',
      entity: 'wa_conversation',
      entityId: this.conversation.id,
      metadata: { reason, label: SOFIA_CLOSE_LABELS[reason] },
    });
    if (confirm) await this.send(this.text(this.settings.texts.optOut));
  }

  private async notifyTeam(reason: SofiaHandoffReason) {
    try {
      const people = await managersAndBoard(this.db);
      if (people.length === 0) return;
      await this.db
        .insert(crmNotifications)
        .values(
          people.map((person) => ({
            recipientEmployeeId: person,
            leadId: this.conversation.leadId,
            kind: 'sofia_handoff',
            message: `Uma conversa do WhatsApp espera um atendente (${SOFIA_HANDOFF_LABELS[reason]}). Veja em Sofia (SDR IA).`,
            dedupeKey: `sofia_handoff:${this.conversation.id}:${this.now.toISOString()}:${person}`,
          })),
        )
        .onConflictDoNothing();
    } catch {
      // The conversation is already waiting on the screen; the notice is a courtesy.
    }
  }

  // --- saving and sending ----------------------------------------------------------------

  /**
   * Saves the turn: what Sofia knows, where she is, and that the messages read
   * were answered (by their own timestamps, to the microsecond). A message the
   * person sent while this turn ran pushed `sofia_due_at` forward: that wake-up
   * is kept.
   */
  private async save(change: { attendance?: string; reason?: string | null }) {
    const ids = this.newIds;
    const dueAtClaim = this.conversation.sofiaDueAt;
    await this.db
      .update(waConversations)
      .set({
        sofiaFacts: this.facts,
        segment: this.segment,
        brandClientId: this.brandClientId,
        sofiaMisses: this.misses,
        sofiaClaimedAt: null,
        ...(ids.length > 0
          ? {
              sofiaReadUntil: sql`greatest(${waConversations.sofiaReadUntil}, (select max(${waMessages.createdAt}) from ${waMessages} where ${inArray(waMessages.id, ids)}))`,
            }
          : {}),
        sofiaDueAt:
          change.attendance && change.attendance !== 'sofia'
            ? null
            : dueAtClaim
              ? sql`case when ${waConversations.sofiaDueAt} > ${dueAtClaim.toISOString()}::timestamptz then ${waConversations.sofiaDueAt} else null end`
              : null,
        ...(change.attendance
          ? {
              attendance: change.attendance,
              reason: change.reason ?? null,
              stateChangedAt: this.now,
            }
          : {}),
      })
      .where(eq(waConversations.id, this.conversation.id));
  }

  /** Nothing to answer: the messages count as read, the turn ends. */
  private async release() {
    await this.save({});
  }

  private async send(outgoing: Outgoing, leadId?: string) {
    const { config } = this.deps;
    if (!config) return;
    const delivered = await deliverWhatsApp(this.db, this.deps.fetchImpl, config, {
      contact: this.contact,
      conversationId: this.conversation.id,
      leadId: leadId ?? this.conversation.leadId,
      author: 'sofia',
      employeeId: null,
      kind: outgoing.kind,
      shown: outgoing.shown,
      content: outgoing.content,
      payload: outgoing.payload,
      at: this.deps.now(),
    });
    await writeAudit(this.db, {
      action: 'whatsapp.message_sent',
      entity: (leadId ?? this.conversation.leadId) ? 'lead' : 'wa_conversation',
      entityId: leadId ?? this.conversation.leadId ?? this.conversation.id,
      metadata: {
        messageId: delivered.row.id,
        author: 'sofia',
        kind: outgoing.kind,
        outcome: delivered.outcome,
        ...(delivered.errorCode === null ? {} : { errorCode: delivered.errorCode }),
      },
    });
  }

  // --- the AI ceiling -----------------------------------------------------------------------

  /**
   * Reserves one call under SOFIA_DAILY_USD (UTC day), or null when it would
   * pass it. Checked and written under one lock; every call counts, at its
   * real cost once known and at its reservation until then or if it failed.
   */
  private async reserve(): Promise<string | null> {
    const day = new Date(
      Date.UTC(this.now.getUTCFullYear(), this.now.getUTCMonth(), this.now.getUTCDate()),
    );
    const ceiling = Math.round(this.deps.dailyUsd * 1e6);
    const reserve = Math.min(SOFIA_RESERVE_MICRO_USD, ceiling);
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext('sofia_ai_ceiling'))`);
      const [row] = await tx
        .select({
          total: sql<
            string | null
          >`sum(coalesce(${sofiaAiRuns.costMicroUsd}, ${sofiaAiRuns.reservedMicroUsd}))`,
        })
        .from(sofiaAiRuns)
        .where(gte(sofiaAiRuns.startedAt, day));
      if (Number(row?.total ?? 0) + reserve > ceiling) return null;
      const [run] = await tx
        .insert(sofiaAiRuns)
        .values({
          conversationId: this.conversation.id,
          startedAt: this.now,
          model: SOFIA_MODEL,
          promptVersion: SOFIA_PROMPT_VERSION,
          reservedMicroUsd: reserve,
        })
        .returning({ id: sofiaAiRuns.id });
      return run!.id;
    });
  }

  private async settle(runId: string, usage: LlmUsage | null, outcome: string) {
    // The provider's own cost when it says; otherwise a generous estimate from
    // the tokens; with neither (the call threw), the reservation stands.
    const cost =
      usage?.costUsd !== null && usage?.costUsd !== undefined
        ? Math.round(usage.costUsd * 1e6)
        : usage
          ? Math.ceil(usage.inputTokens * 0.3 + usage.outputTokens * 1.5)
          : null;
    await this.db
      .update(sofiaAiRuns)
      .set({ costMicroUsd: cost, outcome, finishedAt: this.deps.now() })
      .where(eq(sofiaAiRuns.id, runId));
  }
}

/** Today's AI spend of Sofia (UTC day), in dollars. */
export async function sofiaSpentToday(db: Database, now: Date): Promise<number> {
  const day = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const [row] = await db
    .select({
      total: sql<
        string | null
      >`sum(coalesce(${sofiaAiRuns.costMicroUsd}, ${sofiaAiRuns.reservedMicroUsd}))`,
    })
    .from(sofiaAiRuns)
    .where(gte(sofiaAiRuns.startedAt, day));
  return Number(row?.total ?? 0) / 1e6;
}

/** The loop: every few seconds, the turns that are due. */
export function startSofia(deps: SofiaDeps & { tickMs?: number }) {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await runDueSofiaTurns(deps);
    } catch {
      deps.log({ job: 'sofia', error: 'tick_failed' });
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void tick(), deps.tickMs ?? 2_000);
  timer.unref?.();
  return {
    tick,
    stop: () => clearInterval(timer),
  };
}
