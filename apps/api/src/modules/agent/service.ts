import {
  AGENT_TOOL_LABEL,
  WINGS_CLIENT_ID,
  agentCampaignProposalSchema,
  agentChangeProposalSchema,
  agentGenerationProposalSchema,
  estimateAgentCostMicroUsd,
  storedTimelineEditSchema,
  type AgentChatMessage,
  type AgentConsultation,
  type AgentModel,
  type AgentProposalCard,
  type AgentStreamEvent,
  type AgentUsageToday,
  type MediaProviderId,
  type StudioTimelineSnapshot,
} from '@wings/shared';
import { and, asc, desc, eq, gte, inArray, sql } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import type { StudioDeps } from '../media/studio.js';
import {
  adApprovalRequests,
  agentConversations,
  agentMessages,
  agentProposals,
  clients,
  mediaGenerations,
} from '../../db/schema/index.js';
import { LlmError, type AgentLlm, type LlmMessage, type LlmToolCall } from './llm.js';
import { TRAFFIC_AGENT, type AgentProfile } from './profile.js';
import { scrubSensitive } from './scrub.js';
import { changeCard, dataEnvelope, pendingFor, type ToolContext } from './tools.js';

/**
 * One turn of the conversation: the person's message in, the agent's reply out,
 * with every tool call, token and cent on the record.
 */

/** Tool rounds per reply. Past this the model is asked to answer with what it has. */
const MAX_TOOL_ROUNDS = 6;
/** Earlier messages replayed to the model. Older ones stay in the history on screen. */
const HISTORY_MESSAGES = 16;
/**
 * Output cap per call to the model. It covers the visible text, the arguments
 * of every tool call and, on models that think, the thinking too. At 2 000 the
 * first real proposal on staging was cut mid-sentence, before `propor_campanha`
 * was ever called; a complete proposal alone is well over a thousand tokens.
 */
const MAX_OUTPUT_TOKENS = 8000;

export const DAILY_LIMIT_NOTICE =
  'Você atingiu o limite diário de uso do agente. Ele volta a responder amanhã.';
export const CUT_NOTICE = 'A resposta ficou longa demais e foi cortada antes do fim.';
const ABORTED_NOTICE = 'Resposta interrompida.';
const PROVIDER_NOTICE =
  'O serviço do modelo não respondeu agora. Tente de novo em instantes. Nada foi alterado.';

export interface AgentDeps {
  db: Database;
  llm: AgentLlm;
  model: AgentModel;
  dailyLimitUsd: number;
  now?: () => Date;
  /** Numbers and enum values about a finished turn. Never anybody's words. */
  log?: (facts: Record<string, unknown>) => void;
  /** Which agent is answering. The traffic agent when absent. */
  profile?: AgentProfile;
  /** What the editing agent's tools need to read Kairogen. */
  studio?: StudioDeps;
}

/** Asking again can help with anything except the daily ceiling. */
export function isRetryable(notice: string | null): boolean {
  return notice !== null && notice !== DAILY_LIMIT_NOTICE;
}

/**
 * What the person reads when a proposal never became a card. The model is told
 * the reasons and usually corrects itself; when it does not, staying silent
 * would leave a reply that promises a card that is not there.
 */
export function refusedProposalText(reasons: string[]): string {
  const list = reasons.slice(0, 6).map((reason) => `- ${reason}`);
  return [
    'A proposta não virou cartão: a validação do sistema recusou.',
    ...list,
    'Peça de novo ou me diga o que ajustar, e eu refaço.',
  ].join('\n');
}

const toMicro = (usd: number) => Math.round(usd * 1_000_000);

/** Midnight of today in São Paulo, as an instant. The ceiling resets there. */
function startOfDay(now: Date): Date {
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(now);
  // São Paulo has been UTC-3 all year since 2019.
  return new Date(`${day}T00:00:00-03:00`);
}

export async function usageToday(
  db: Database,
  employeeId: string,
  dailyLimitUsd: number,
  now = new Date(),
): Promise<AgentUsageToday> {
  const [row] = await db
    .select({ total: sql<string>`coalesce(sum(${agentMessages.costMicroUsd}), 0)` })
    .from(agentMessages)
    .where(
      and(eq(agentMessages.employeeId, employeeId), gte(agentMessages.createdAt, startOfDay(now))),
    );
  const spentMicroUsd = Number(row?.total ?? 0);
  const limitMicroUsd = toMicro(dailyLimitUsd);
  return { spentMicroUsd, limitMicroUsd, exhausted: spentMicroUsd >= limitMicroUsd };
}

/** The stored tool-call log of one assistant message. */
interface ToolCallRecord {
  name: string;
  arguments: string;
  result: unknown;
  consultation: AgentConsultation | null;
  proposalId: string | null;
}

async function proposalCards(
  db: Database,
  messageIds: string[],
): Promise<Map<string, AgentProposalCard[]>> {
  const cards = new Map<string, AgentProposalCard[]>();
  if (messageIds.length === 0) return cards;
  const rows = await db
    .select({
      id: agentProposals.id,
      messageId: agentProposals.messageId,
      kind: agentProposals.kind,
      payload: agentProposals.payload,
      status: agentProposals.status,
      createdAt: agentProposals.createdAt,
      approvalId: adApprovalRequests.id,
    })
    .from(agentProposals)
    .leftJoin(
      adApprovalRequests,
      eq(adApprovalRequests.changeRequestId, agentProposals.changeRequestId),
    )
    .where(inArray(agentProposals.messageId, messageIds))
    .orderBy(asc(agentProposals.createdAt));

  for (const row of rows) {
    if (!row.messageId) continue;
    const card = await cardOf(db, row);
    if (!card) continue;
    cards.set(row.messageId, [...(cards.get(row.messageId) ?? []), card]);
  }
  return cards;
}

/** A stored proposal as the screen shows it. Re-validated: a row is data too. */
export async function cardOf(
  db: Database,
  row: {
    id: string;
    kind: 'campaign' | 'change' | 'generation' | 'timeline_edit';
    payload: unknown;
    status: AgentProposalCard['status'];
    createdAt: Date;
    approvalId: string | null;
  },
): Promise<AgentProposalCard | null> {
  if (row.kind === 'campaign') {
    const payload = agentCampaignProposalSchema.safeParse(row.payload);
    if (!payload.success) return null;
    return {
      kind: 'campaign',
      id: row.id,
      status: row.status,
      createdAt: row.createdAt.toISOString(),
      approvalId: row.approvalId,
      payload: payload.data,
      pending: pendingFor(payload.data),
    };
  }
  if (row.kind === 'timeline_edit') {
    const payload = storedTimelineEditSchema.safeParse(row.payload);
    if (!payload.success) return null;
    return {
      kind: 'timeline_edit',
      id: row.id,
      status: row.status,
      createdAt: row.createdAt.toISOString(),
      approvalId: null,
      payload: payload.data,
    };
  }
  if (row.kind === 'generation') {
    // Cards from before clients existed were all for Wings Company; from before
    // there were other providers, all on Kairogen.
    const payload = agentGenerationProposalSchema.safeParse({
      clientId: WINGS_CLIENT_ID,
      provider: 'kairogen',
      ...(row.payload as object),
    });
    if (!payload.success) return null;
    const client = await db.query.clients.findFirst({
      where: eq(clients.id, payload.data.clientId),
    });
    // The estimate made for this card, and what became of it after a click.
    const [made] = await db
      .select()
      .from(mediaGenerations)
      .where(eq(mediaGenerations.proposalId, row.id))
      .orderBy(desc(mediaGenerations.createdAt))
      .limit(1);
    return {
      kind: 'generation',
      id: row.id,
      status: row.status,
      createdAt: row.createdAt.toISOString(),
      approvalId: null,
      payload: payload.data,
      clientName: client?.name ?? null,
      // An estimate past its time is no price at all: the card offers "Estimar de novo".
      estimate:
        made?.status === 'estimated' && made.estimateExpiresAt > new Date()
          ? {
              id: made.id,
              credits: made.creditsEstimated,
              brlCents: made.brlCentsEstimated,
              providerId: made.provider as MediaProviderId,
              expiresAt: made.estimateExpiresAt.toISOString(),
            }
          : null,
      generationId: made && made.status !== 'estimated' ? made.id : null,
    };
  }
  const payload = agentChangeProposalSchema.safeParse(row.payload);
  if (!payload.success) return null;
  return changeCard(db, row, payload.data);
}

export async function conversationMessages(
  db: Database,
  conversationId: string,
): Promise<AgentChatMessage[]> {
  const rows = await db
    .select()
    .from(agentMessages)
    .where(eq(agentMessages.conversationId, conversationId))
    .orderBy(asc(agentMessages.createdAt));
  const cards = await proposalCards(
    db,
    rows.filter((row) => row.role === 'assistant').map((row) => row.id),
  );
  return rows.map((row) => ({
    id: row.id,
    role: row.role,
    content: row.content,
    createdAt: row.createdAt.toISOString(),
    consulted: ((row.toolCalls as ToolCallRecord[]) ?? []).flatMap((call) =>
      call.consultation ? [call.consultation] : [],
    ),
    proposals: cards.get(row.id) ?? [],
    notice: row.notice,
    retryable: row.role === 'assistant' && isRetryable(row.notice),
  }));
}

function titleOf(message: string): string {
  const words = message.replace(/\s+/g, ' ').trim();
  return words.length > 60 ? `${words.slice(0, 57)}…` : words;
}

export type TurnRefusal = { ok: false; code: 'not_found'; message: string };

export async function runAgentTurn(
  deps: AgentDeps,
  input: {
    employeeId: string;
    conversationId?: string;
    message: string;
    context?: {
      tab: 'paid' | 'owned' | 'media';
      draft?: Record<string, unknown>;
      timeline?: StudioTimelineSnapshot;
    };
    /** "Tentar de novo": answer the last message again rather than store a copy. */
    retry?: boolean;
    signal?: AbortSignal;
  },
  emit: (event: AgentStreamEvent) => void,
): Promise<{ ok: true } | TurnRefusal> {
  const { db } = deps;
  const profile = deps.profile ?? TRAFFIC_AGENT;
  const now = deps.now?.() ?? new Date();
  // What the person typed is stored and sent without tokens, phones or CPFs.
  const message = scrubSensitive(input.message);

  let conversation = input.conversationId
    ? await db.query.agentConversations.findFirst({
        where: and(
          eq(agentConversations.id, input.conversationId),
          // Somebody else's conversation does not exist, as far as you can tell;
          // nor does one held with another agent.
          eq(agentConversations.employeeId, input.employeeId),
          eq(agentConversations.scope, profile.scope),
        ),
      })
    : undefined;
  if (input.conversationId && !conversation) {
    return { ok: false, code: 'not_found', message: 'Conversa não encontrada.' };
  }
  if (!conversation) {
    [conversation] = await db
      .insert(agentConversations)
      .values({ employeeId: input.employeeId, scope: profile.scope, title: titleOf(message) })
      .returning();
    if (!conversation) throw new Error('failed to open conversation');
  }

  const history = await db
    .select({ id: agentMessages.id, role: agentMessages.role, content: agentMessages.content })
    .from(agentMessages)
    .where(eq(agentMessages.conversationId, conversation.id))
    .orderBy(desc(agentMessages.createdAt))
    .limit(HISTORY_MESSAGES);

  // Asking again: the question is already in the conversation, followed by the
  // reply that went wrong. It is answered again, not stored twice, and the model
  // is not shown the failed attempt.
  const asked = input.retry ? history.findIndex((row) => row.role === 'user') : -1;
  const repeated = asked !== -1 && history[asked]?.content === message ? history[asked] : null;
  if (repeated) history.splice(0, asked + 1);

  const [userRow] = repeated
    ? [{ id: repeated.id }]
    : await db
        .insert(agentMessages)
        .values({
          conversationId: conversation.id,
          employeeId: input.employeeId,
          role: 'user',
          content: message,
          createdAt: now,
        })
        .returning({ id: agentMessages.id });
  if (!userRow) throw new Error('failed to record message');

  emit({
    type: 'conversation',
    conversationId: conversation.id,
    title: conversation.title,
    userMessageId: userRow.id,
  });

  const records: ToolCallRecord[] = [];
  const proposals: AgentProposalCard[] = [];
  let text = '';
  let notice: string | null = null;
  let inputTokens = 0;
  let outputTokens = 0;
  let costMicroUsd = 0;
  let costFromProvider = true;
  let called = false;
  const rounds: {
    finishReason: string | null;
    inputTokens: number;
    outputTokens: number;
    toolCalls: number;
  }[] = [];
  /** Proposal tools whose last attempt was refused, with the reasons given. */
  const refused = new Map<string, string[]>();

  const before = await usageToday(db, input.employeeId, deps.dailyLimitUsd, now);
  const spentSoFar = () => before.spentMicroUsd + costMicroUsd;

  if (before.exhausted) {
    // The ceiling is reached: the agent says so and stops. No model is called.
    notice = DAILY_LIMIT_NOTICE;
  } else {
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(now);
    const messages: LlmMessage[] = [
      { role: 'system', content: profile.systemPrompt },
      ...history
        .reverse()
        .filter((row) => row.content.trim() !== '')
        .map((row): LlmMessage => ({ role: row.role, content: row.content })),
      {
        role: 'user',
        content: `${profile.contextLine({ today, tab: input.context?.tab ?? null })}\n\n${message}`,
      },
    ];
    const toolContext: ToolContext = {
      db,
      employeeId: input.employeeId,
      conversationId: conversation.id,
      now,
      builderDraft: input.context?.draft,
      timeline: input.context?.timeline,
      studio: deps.studio,
    };

    try {
      for (let round = 0; round <= MAX_TOOL_ROUNDS; round += 1) {
        const lastRound = round === MAX_TOOL_ROUNDS;
        called = true;
        const turn = await deps.llm.complete({
          model: deps.model,
          messages,
          // On the last round there is nothing left to call: answer with what you have.
          tools: lastRound ? [] : profile.tools,
          maxOutputTokens: MAX_OUTPUT_TOKENS,
          signal: input.signal,
          onText: (delta) => {
            text += delta;
            emit({ type: 'delta', text: delta });
          },
        });

        rounds.push({
          finishReason: turn.finishReason,
          inputTokens: turn.usage.inputTokens,
          outputTokens: turn.usage.outputTokens,
          toolCalls: turn.toolCalls.length,
        });
        inputTokens += turn.usage.inputTokens;
        outputTokens += turn.usage.outputTokens;
        if (turn.usage.costUsd === null) {
          costFromProvider = false;
          costMicroUsd += estimateAgentCostMicroUsd(
            deps.model,
            turn.usage.inputTokens,
            turn.usage.outputTokens,
          );
        } else {
          costMicroUsd += toMicro(turn.usage.costUsd);
        }

        const cut = turn.finishReason === 'length';
        if (turn.toolCalls.length === 0 || lastRound) {
          // Cut in the middle of the text: say so, rather than end on half a sentence.
          if (cut) notice = CUT_NOTICE;
          break;
        }

        messages.push({ role: 'assistant', content: turn.text, toolCalls: turn.toolCalls });
        for (const call of turn.toolCalls) {
          messages.push({
            role: 'tool',
            toolCallId: call.id,
            content: dataEnvelope(await runTool(toolContext, call, cut)),
          });
        }

        // Checked between rounds too: a long chain of tool calls cannot run past the ceiling.
        if (spentSoFar() >= before.limitMicroUsd) {
          notice = DAILY_LIMIT_NOTICE;
          break;
        }
        if (text !== '' && !text.endsWith('\n')) {
          text += '\n\n';
          emit({ type: 'delta', text: '\n\n' });
        }
      }
    } catch (error) {
      if (!(error instanceof LlmError)) throw error;
      notice = error.code === 'aborted' ? ABORTED_NOTICE : PROVIDER_NOTICE;
    }

    // A proposal that was refused and never redone must not pass in silence.
    if (refused.size > 0) {
      const said = refusedProposalText([...refused.values()].flat());
      const separator = text.trim() === '' ? '' : '\n\n';
      text += `${separator}${said}`;
      emit({ type: 'delta', text: `${separator}${said}` });
    }
  }

  async function runTool(
    toolContext: ToolContext,
    call: LlmToolCall,
    cut: boolean,
  ): Promise<unknown> {
    if (profile.isTool(call.name)) {
      emit({ type: 'consulting', tool: call.name, label: AGENT_TOOL_LABEL[call.name] });
    }
    const outcome = await profile.run(toolContext, call, proposals.length, { cut });
    if (outcome.consultation) emit({ type: 'consulted', consultation: outcome.consultation });
    if (outcome.proposal) {
      proposals.push(outcome.proposal);
      refused.delete(call.name);
      emit({ type: 'proposal', proposal: outcome.proposal });
    } else if (outcome.refusal) {
      refused.set(call.name, outcome.refusal);
    }
    records.push({
      name: call.name.slice(0, 80),
      arguments: scrubSensitive(call.arguments).slice(0, 8000),
      result: outcome.result,
      consultation: outcome.consultation,
      proposalId: outcome.proposal?.id ?? null,
    });
    return outcome.result;
  }

  const content = text.trim() === '' && notice ? notice : text.trim();
  const [assistantRow] = await db
    .insert(agentMessages)
    .values({
      conversationId: conversation.id,
      employeeId: input.employeeId,
      role: 'assistant',
      content,
      toolCalls: records,
      notice,
      diagnostics: { rounds, proposals: proposals.length, refusedProposals: refused.size },
      model: called ? deps.model : null,
      inputTokens,
      outputTokens,
      costMicroUsd,
      costSource: called ? (costFromProvider ? 'provider' : 'estimate') : null,
      // After the person's message even when the clock is fixed, as in tests.
      createdAt: new Date(now.getTime() + 1),
    })
    .returning({ id: agentMessages.id, createdAt: agentMessages.createdAt });
  if (!assistantRow) throw new Error('failed to record reply');

  if (proposals.length > 0) {
    await db
      .update(agentProposals)
      .set({ messageId: assistantRow.id })
      .where(
        inArray(
          agentProposals.id,
          proposals.map((proposal) => proposal.id),
        ),
      );
  }
  await db
    .update(agentConversations)
    .set({ updatedAt: now })
    .where(eq(agentConversations.id, conversation.id));

  emit({
    type: 'done',
    message: {
      id: assistantRow.id,
      role: 'assistant',
      content,
      createdAt: assistantRow.createdAt.toISOString(),
      consulted: records.flatMap((record) => (record.consultation ? [record.consultation] : [])),
      proposals,
      notice,
      retryable: isRetryable(notice),
    },
    usage: await usageToday(db, input.employeeId, deps.dailyLimitUsd, now),
  });
  deps.log?.({
    msg: 'agent turn',
    model: called ? deps.model : null,
    rounds,
    tools: records.map((record) => record.name),
    proposals: proposals.length,
    refusedProposals: refused.size,
    cut: notice === CUT_NOTICE,
    stopped: notice === null ? null : notice === DAILY_LIMIT_NOTICE ? 'daily_limit' : 'interrupted',
    costMicroUsd,
  });
  return { ok: true };
}
