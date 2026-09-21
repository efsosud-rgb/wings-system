import {
  AGENT_TOOL_LABEL,
  agentCampaignProposalSchema,
  agentChangeProposalSchema,
  estimateAgentCostMicroUsd,
  type AgentChatMessage,
  type AgentConsultation,
  type AgentModel,
  type AgentProposalCard,
  type AgentStreamEvent,
  type AgentUsageToday,
} from '@wings/shared';
import { and, asc, desc, eq, gte, inArray, sql } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import {
  adApprovalRequests,
  agentConversations,
  agentMessages,
  agentProposals,
} from '../../db/schema/index.js';
import { LlmError, type AgentLlm, type LlmMessage, type LlmToolCall } from './llm.js';
import { AGENT_SYSTEM_PROMPT, contextLine } from './prompt.js';
import { scrubSensitive } from './scrub.js';
import {
  AGENT_TOOL_DEFINITIONS,
  changeCard,
  dataEnvelope,
  isAgentTool,
  runAgentTool,
  type ToolContext,
} from './tools.js';

/**
 * One turn of the conversation: the person's message in, the agent's reply out,
 * with every tool call, token and cent on the record.
 */

/** Tool rounds per reply. Past this the model is asked to answer with what it has. */
const MAX_TOOL_ROUNDS = 6;
/** Earlier messages replayed to the model. Older ones stay in the history on screen. */
const HISTORY_MESSAGES = 16;
const MAX_OUTPUT_TOKENS = 2000;

export const DAILY_LIMIT_NOTICE =
  'Você atingiu o limite diário de uso do agente. Ele volta a responder amanhã.';
const PROVIDER_NOTICE =
  'O serviço do modelo não respondeu agora. Tente de novo em instantes. Nada foi alterado.';

export interface AgentDeps {
  db: Database;
  llm: AgentLlm;
  model: AgentModel;
  dailyLimitUsd: number;
  now?: () => Date;
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
    kind: 'campaign' | 'change';
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
    context?: { tab: 'paid' | 'owned'; draft?: Record<string, unknown> };
    signal?: AbortSignal;
  },
  emit: (event: AgentStreamEvent) => void,
): Promise<{ ok: true } | TurnRefusal> {
  const { db } = deps;
  const now = deps.now?.() ?? new Date();
  // What the person typed is stored and sent without tokens, phones or CPFs.
  const message = scrubSensitive(input.message);

  let conversation = input.conversationId
    ? await db.query.agentConversations.findFirst({
        where: and(
          eq(agentConversations.id, input.conversationId),
          // Somebody else's conversation does not exist, as far as you can tell.
          eq(agentConversations.employeeId, input.employeeId),
        ),
      })
    : undefined;
  if (input.conversationId && !conversation) {
    return { ok: false, code: 'not_found', message: 'Conversa não encontrada.' };
  }
  if (!conversation) {
    [conversation] = await db
      .insert(agentConversations)
      .values({ employeeId: input.employeeId, title: titleOf(message) })
      .returning();
    if (!conversation) throw new Error('failed to open conversation');
  }

  const history = await db
    .select({ role: agentMessages.role, content: agentMessages.content })
    .from(agentMessages)
    .where(eq(agentMessages.conversationId, conversation.id))
    .orderBy(desc(agentMessages.createdAt))
    .limit(HISTORY_MESSAGES);

  const [userRow] = await db
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

  const before = await usageToday(db, input.employeeId, deps.dailyLimitUsd, now);
  const spentSoFar = () => before.spentMicroUsd + costMicroUsd;

  if (before.exhausted) {
    // The ceiling is reached: the agent says so and stops. No model is called.
    notice = DAILY_LIMIT_NOTICE;
  } else {
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(now);
    const messages: LlmMessage[] = [
      { role: 'system', content: AGENT_SYSTEM_PROMPT },
      ...history
        .reverse()
        .filter((row) => row.content.trim() !== '')
        .map((row): LlmMessage => ({ role: row.role, content: row.content })),
      {
        role: 'user',
        content: `${contextLine({ today, tab: input.context?.tab ?? null })}\n\n${message}`,
      },
    ];
    const toolContext: ToolContext = {
      db,
      employeeId: input.employeeId,
      conversationId: conversation.id,
      now,
      builderDraft: input.context?.draft,
    };

    try {
      for (let round = 0; round <= MAX_TOOL_ROUNDS; round += 1) {
        const lastRound = round === MAX_TOOL_ROUNDS;
        called = true;
        const turn = await deps.llm.complete({
          model: deps.model,
          messages,
          // On the last round there is nothing left to call: answer with what you have.
          tools: lastRound ? [] : AGENT_TOOL_DEFINITIONS,
          maxOutputTokens: MAX_OUTPUT_TOKENS,
          signal: input.signal,
          onText: (delta) => {
            text += delta;
            emit({ type: 'delta', text: delta });
          },
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

        if (turn.toolCalls.length === 0 || lastRound) break;

        messages.push({ role: 'assistant', content: turn.text, toolCalls: turn.toolCalls });
        for (const call of turn.toolCalls) {
          messages.push({
            role: 'tool',
            toolCallId: call.id,
            content: dataEnvelope(await runTool(toolContext, call)),
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
      notice = error.code === 'aborted' ? 'Resposta interrompida.' : PROVIDER_NOTICE;
    }
  }

  async function runTool(toolContext: ToolContext, call: LlmToolCall): Promise<unknown> {
    if (isAgentTool(call.name)) {
      emit({ type: 'consulting', tool: call.name, label: AGENT_TOOL_LABEL[call.name] });
    }
    const outcome = await runAgentTool(toolContext, call, proposals.length);
    if (outcome.consultation) emit({ type: 'consulted', consultation: outcome.consultation });
    if (outcome.proposal) {
      proposals.push(outcome.proposal);
      emit({ type: 'proposal', proposal: outcome.proposal });
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
    },
    usage: await usageToday(db, input.employeeId, deps.dailyLimitUsd, now),
  });
  return { ok: true };
}
