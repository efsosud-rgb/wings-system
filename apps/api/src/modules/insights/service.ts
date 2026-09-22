import {
  AGENT_TOOL_LABEL,
  estimateAgentCostMicroUsd,
  type AgentConsultation,
  type AgentModel,
  type InsightRun,
  type InsightRunKind,
  type InsightRunTrigger,
  type InsightsUsageToday,
} from '@wings/shared';
import { and, desc, eq, gte, lt, sql } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import { employees, insightRuns } from '../../db/schema/index.js';
import { LlmError, type AgentLlm, type LlmMessage } from '../agent/llm.js';
import { scrubSensitive } from '../agent/scrub.js';
import {
  INSIGHTS_SYSTEM_PROMPT,
  NUDGE_TURN,
  SUGGESTIONS_SYSTEM_PROMPT,
  insightsUserTurn,
} from './prompt.js';
import {
  INSIGHTS_TOOL_DEFINITIONS,
  SUGGESTIONS_TOOL_DEFINITIONS,
  dataEnvelope,
  isInsightTool,
  runInsightTool,
  type InsightToolContext,
} from './tools.js';

/**
 * One run of the generator: the model reads our tables through the tools and
 * registers cards, with every tool call, token and cent on the record. The
 * same loop as the agent's turn, without a conversation: one system prompt,
 * one user line, up to MAX_TOOL_ROUNDS rounds, and a run row that says what
 * happened, whether it went well or not. Never a fake card.
 */

const MAX_TOOL_ROUNDS = 10;
const MAX_OUTPUT_TOKENS = 8000;
/** A `running` row older than this belongs to a process that died. */
const STALE_RUN_MS = 15 * 60_000;

export interface InsightsDeps {
  db: Database;
  llm: AgentLlm;
  model: AgentModel;
  dailyLimitUsd: number;
  now?: () => Date;
  /** Numbers and enum values only. Never anybody's words. */
  log?: (facts: Record<string, unknown>) => void;
}

export type RunRefusal = { ok: false; code: 'daily_limit' | 'already_running' | 'already_ran' };
export type RunStarted = { ok: true; runId: string };

const toMicro = (usd: number) => Math.round(usd * 1_000_000);

/** Midnight of today in São Paulo, as an instant. The ceiling resets there. */
export function startOfDay(now: Date): Date {
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(now);
  return new Date(`${day}T00:00:00-03:00`);
}

/** The company's spend on insights today, scheduled and on-demand alike. */
export async function insightsUsageToday(
  db: Database,
  dailyLimitUsd: number,
  now = new Date(),
): Promise<InsightsUsageToday> {
  const [row] = await db
    .select({ total: sql<string>`coalesce(sum(${insightRuns.costMicroUsd}), 0)` })
    .from(insightRuns)
    .where(gte(insightRuns.startedAt, startOfDay(now)));
  const spentMicroUsd = Number(row?.total ?? 0);
  const limitMicroUsd = toMicro(dailyLimitUsd);
  return { spentMicroUsd, limitMicroUsd, exhausted: spentMicroUsd >= limitMicroUsd };
}

/** A run row as the screen sees it. */
export async function runOf(db: Database, id: string): Promise<InsightRun | null> {
  const [row] = await db
    .select({ run: insightRuns, requestedByName: employees.fullName })
    .from(insightRuns)
    .leftJoin(employees, eq(employees.id, insightRuns.requestedBy))
    .where(eq(insightRuns.id, id));
  return row ? toRun(row.run, row.requestedByName) : null;
}

export function toRun(
  row: typeof insightRuns.$inferSelect,
  requestedByName: string | null,
): InsightRun {
  return {
    id: row.id,
    kind: row.kind,
    trigger: row.trigger,
    status: row.status,
    startedAt: row.startedAt.toISOString(),
    finishedAt: row.finishedAt?.toISOString() ?? null,
    requestedByName: row.requestedBy ? requestedByName : null,
    model: (row.model as AgentModel | null) ?? null,
    costMicroUsd: row.costMicroUsd,
    produced: row.produced,
    consulted: (row.consulted as AgentConsultation[]) ?? [],
    error: row.error,
  };
}

/** Newest run of a kind, whatever its status. */
export async function latestRun(db: Database, kind: InsightRunKind): Promise<InsightRun | null> {
  const [row] = await db
    .select({ run: insightRuns, requestedByName: employees.fullName })
    .from(insightRuns)
    .leftJoin(employees, eq(employees.id, insightRuns.requestedBy))
    .where(eq(insightRuns.kind, kind))
    .orderBy(desc(insightRuns.startedAt))
    .limit(1);
  return row ? toRun(row.run, row.requestedByName) : null;
}

/** A run of the kind still going, after retiring rows left behind by a dead process. */
export async function runningRun(
  db: Database,
  kind: InsightRunKind,
  now = new Date(),
): Promise<InsightRun | null> {
  await db
    .update(insightRuns)
    .set({ status: 'failed', error: 'stale', finishedAt: now })
    .where(
      and(
        eq(insightRuns.kind, kind),
        eq(insightRuns.status, 'running'),
        lt(insightRuns.startedAt, new Date(now.getTime() - STALE_RUN_MS)),
      ),
    );
  const [row] = await db
    .select({ run: insightRuns, requestedByName: employees.fullName })
    .from(insightRuns)
    .leftJoin(employees, eq(employees.id, insightRuns.requestedBy))
    .where(and(eq(insightRuns.kind, kind), eq(insightRuns.status, 'running')))
    .orderBy(desc(insightRuns.startedAt))
    .limit(1);
  return row ? toRun(row.run, row.requestedByName) : null;
}

/**
 * Opens a run, or says why not. Separate from the loop so a route can answer
 * 202 with the row and let the model work in the background.
 */
export async function openRun(
  deps: InsightsDeps,
  input: {
    kind: InsightRunKind;
    trigger: InsightRunTrigger;
    requestedBy: string | null;
    weekKey?: string;
  },
): Promise<RunStarted | RunRefusal> {
  const now = deps.now?.() ?? new Date();
  const usage = await insightsUsageToday(deps.db, deps.dailyLimitUsd, now);
  if (usage.exhausted) return { ok: false, code: 'daily_limit' };
  if (await runningRun(deps.db, input.kind, now)) return { ok: false, code: 'already_running' };

  const [row] = await deps.db
    .insert(insightRuns)
    .values({
      kind: input.kind,
      trigger: input.trigger,
      weekKey: input.weekKey ?? null,
      requestedBy: input.requestedBy,
      startedAt: now,
      model: deps.model,
    })
    // Two replicas on a Monday morning: the unique index lets one in.
    .onConflictDoNothing()
    .returning({ id: insightRuns.id });
  if (!row) return { ok: false, code: 'already_ran' };
  return { ok: true, runId: row.id };
}

interface ToolCallRecord {
  name: string;
  arguments: string;
  result: unknown;
  consultation: AgentConsultation | null;
  stored: number;
}

/** The model loop for an open run. Writes the outcome to the row; never throws for what the model did. */
export async function executeRun(
  deps: InsightsDeps,
  runId: string,
  kind: InsightRunKind,
): Promise<void> {
  const { db } = deps;
  const now = deps.now?.() ?? new Date();
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(now);
  const [run] = await db.select().from(insightRuns).where(eq(insightRuns.id, runId));
  if (!run) return;

  const writeTool = kind === 'insights' ? 'registrar_insights' : 'registrar_sugestoes';
  const tools = kind === 'insights' ? INSIGHTS_TOOL_DEFINITIONS : SUGGESTIONS_TOOL_DEFINITIONS;
  const messages: LlmMessage[] = [
    {
      role: 'system',
      content: kind === 'insights' ? INSIGHTS_SYSTEM_PROMPT : SUGGESTIONS_SYSTEM_PROMPT,
    },
    { role: 'user', content: insightsUserTurn(kind, today) },
  ];
  const toolContext: InsightToolContext = { db, now, requestedBy: run.requestedBy, runId };

  const records: ToolCallRecord[] = [];
  const rounds: {
    finishReason: string | null;
    inputTokens: number;
    outputTokens: number;
    toolCalls: number;
  }[] = [];
  let inputTokens = 0;
  let outputTokens = 0;
  let costMicroUsd = 0;
  let costFromProvider = true;
  let produced = 0;
  let error: string | null = null;
  let nudged = false;
  const limitMicroUsd = toMicro(deps.dailyLimitUsd);
  const before = await insightsUsageToday(db, deps.dailyLimitUsd, now);

  try {
    for (let round = 0; round <= MAX_TOOL_ROUNDS; round += 1) {
      const lastRound = round === MAX_TOOL_ROUNDS;
      const turn = await deps.llm.complete({
        model: deps.model,
        messages,
        tools: lastRound ? [] : tools,
        maxOutputTokens: MAX_OUTPUT_TOKENS,
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
        // Stopped without registering anything: asked once more, plainly.
        if (produced === 0 && !nudged && !lastRound) {
          nudged = true;
          messages.push({ role: 'assistant', content: turn.text });
          messages.push({ role: 'user', content: NUDGE_TURN });
          continue;
        }
        break;
      }

      messages.push({ role: 'assistant', content: turn.text, toolCalls: turn.toolCalls });
      for (const call of turn.toolCalls) {
        if (isInsightTool(call.name)) {
          const label = AGENT_TOOL_LABEL[call.name as keyof typeof AGENT_TOOL_LABEL];
          deps.log?.({ msg: 'insights tool', runId, tool: call.name, label });
        }
        const outcome = await runInsightTool(toolContext, call, writeTool, { cut });
        produced += outcome.stored;
        records.push({
          name: call.name.slice(0, 80),
          arguments: scrubSensitive(call.arguments).slice(0, 8000),
          result: outcome.result,
          consultation: outcome.consultation,
          stored: outcome.stored,
        });
        messages.push({ role: 'tool', toolCallId: call.id, content: dataEnvelope(outcome.result) });
      }

      // Checked between rounds too: a long chain of tool calls cannot run past the ceiling.
      if (before.spentMicroUsd + costMicroUsd >= limitMicroUsd) {
        error = produced === 0 ? 'daily_limit' : null;
        break;
      }
    }
  } catch (caught) {
    if (!(caught instanceof LlmError)) {
      error = 'internal_error';
      deps.log?.({
        msg: 'insights run',
        runId,
        kind,
        error: caught instanceof Error ? caught.name : 'unknown',
      });
    } else {
      error = caught.code;
    }
  }
  if (error === null && produced === 0) error = 'no_cards';

  await db
    .update(insightRuns)
    .set({
      status: error === null ? 'done' : 'failed',
      finishedAt: deps.now?.() ?? new Date(),
      inputTokens,
      outputTokens,
      costMicroUsd,
      costSource: rounds.length === 0 ? null : costFromProvider ? 'provider' : 'estimate',
      consulted: records.flatMap((record) => (record.consultation ? [record.consultation] : [])),
      toolCalls: records,
      diagnostics: { rounds, nudged },
      produced,
      error,
    })
    .where(eq(insightRuns.id, runId));

  deps.log?.({
    msg: 'insights run',
    runId,
    kind,
    trigger: run.trigger,
    model: deps.model,
    rounds,
    tools: records.map((record) => record.name),
    produced,
    error,
    costMicroUsd,
  });
}

/** Opens a run and executes it to the end. What the scheduler calls. */
export async function runInsights(
  deps: InsightsDeps,
  input: {
    kind: InsightRunKind;
    trigger: InsightRunTrigger;
    requestedBy: string | null;
    weekKey?: string;
  },
): Promise<RunStarted | RunRefusal> {
  const opened = await openRun(deps, input);
  if (!opened.ok) return opened;
  await executeRun(deps, opened.runId, input.kind);
  return opened;
}
