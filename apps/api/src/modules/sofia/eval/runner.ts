import {
  AGENT_MODELS,
  mentionsWings,
  SOFIA_DEFAULT_SETTINGS,
  SOFIA_MODEL,
  SOFIA_PROMPT_VERSION,
  sofiaWords,
} from '@wings/shared';
import type { AgentLlm, LlmTurn } from '../../agent/llm.js';
import {
  readTurn,
  routeOfIntent,
  SOFIA_TOOL_NAMES,
  sofiaRunRecord,
  type SofiaBrainInput,
  type SofiaRunRecord,
} from '../brain.js';
import {
  EVAL_CATEGORIES,
  EVAL_VIOLATIONS,
  type EvalCase,
  type EvalCategory,
  type EvalViolation,
} from './schema.js';

/**
 * Runs Sofia's brain (`readTurn`, the same code the engine calls) against the
 * test conversations and scores each reading. Two ways to supply the model:
 * the simulated one, which answers from the case itself and never leaves the
 * process, and a real one (`createOpenRouterLlm`) for the separate command.
 * The record of a run holds model, prompt version, tools, tokens, cost and
 * outcomes; never a conversation's text.
 */

/** The models the real command accepts: Sofia's own and the ones the agent already prices. */
export const SOFIA_EVAL_MODELS = [SOFIA_MODEL, ...AGENT_MODELS] as const;
export type SofiaEvalModel = (typeof SOFIA_EVAL_MODELS)[number];

export const EVAL_CHECKS = [
  'leitura',
  'intencao',
  'campos',
  'encaminhamento',
  'valores',
  'entendimento',
  'regras',
] as const;
export type EvalCheck = (typeof EVAL_CHECKS)[number];

export const EVAL_CHECK_LABELS: Record<EvalCheck, string> = {
  leitura: 'O modelo respondeu no formato certo',
  intencao: 'Intenção certa',
  campos: 'Campos extraídos certos (nem a menos, nem a mais)',
  encaminhamento: 'Encaminhamento certo (pessoa, encerrar ou seguir)',
  valores: 'Pergunta de preço reconhecida (e só ela)',
  entendimento: 'Soube quando não entendeu',
  regras: 'Frase de resposta dentro das regras (depois dos filtros)',
};

// --- the case, as the brain sees it ----------------------------------------------------------

/** What the engine would hand `readTurn` for this conversation. */
export function brainInputOf(c: EvalCase): SofiaBrainInput {
  const questions =
    c.segment === 'expansao' ? SOFIA_DEFAULT_SETTINGS.expansao : SOFIA_DEFAULT_SETTINGS.formatacao;
  const current = questions.find((q) => q.key === c.step) ?? null;
  const lines = [...c.lines];
  // The question she asked is part of what the lead is answering.
  if (current && lines[0]?.from === 'lead')
    lines.unshift({ from: 'sofia', text: sofiaWords(current.text, c.voice, 'o') });
  return {
    speaksFor: c.voice,
    // The made-up brand takes "o": it only changes the "fala_por" line.
    speaksForArticle: c.voice ? 'o' : null,
    segment: c.segment,
    brandName: c.voice,
    current,
    questions,
    known: c.known,
    form: null,
    lines,
  };
}

const spelled = (value: string | string[]) => (typeof value === 'string' ? value : value[0]!);

// --- the simulated model -----------------------------------------------------------------------

const approxTokens = (text: string) => Math.ceil(text.length / 4);

/** Answers with the gold reading of the case, overridden by what the case says the model does. */
export function simulatedLlm(c: EvalCase): AgentLlm {
  const gold = {
    intent: c.expect.intents[0],
    answers: Object.fromEntries(Object.entries(c.expect.answers).map(([k, v]) => [k, spelled(v)])),
    understood: c.expect.understood ?? true,
    asked_values: c.expect.askedValues,
    brand: c.expect.brand ?? null,
    reply: '',
  };
  const args = JSON.stringify({ ...gold, ...c.simulated });
  return {
    async complete(request) {
      return {
        text: '',
        toolCalls: [{ id: 'simulated', name: SOFIA_TOOL_NAMES[0], arguments: args }],
        // No provider here: tokens counted by length, cost left to the estimate.
        usage: {
          inputTokens: approxTokens(JSON.stringify([request.messages, request.tools])),
          outputTokens: approxTokens(args),
          costUsd: null,
        },
        finishReason: 'tool_calls',
      };
    },
  };
}

// --- the rules a reply must keep ---------------------------------------------------------------

/**
 * Written apart from `guardReply` on purpose: that filter is the safety net
 * under test, so it cannot also be the judge. Stricter where the prompt says
 * "nunca" and the filter does not look (documents, scheduling, passing for a
 * robot, the prompt itself).
 */
const VIOLATION_PATTERNS: Record<EvalViolation, RegExp> = {
  valor: /R\$|\d|\bmil\b|milh[ãõ]|%|\bpor cento\b|\breais\b/i,
  promessa: /garant|prometo|promess|com certeza|aprovad|desconto|condi[çc][ãa]o especial/i,
  pessoa:
    /\bsou (uma |um )?(pessoa|humana|humano|consultora?|vendedora?|atendente humana?)\b|\bn[ãa]o sou (um |uma )?(rob[ôo]|bot\b|ia\b|atendente virtual|virtual\b)/i,
  documento: /\b(cpf|cnpj|rg|documentos?|comprovantes?|fotos?|selfie)\b/i,
  reuniao: /reuni[ãa]o|agend|\bmarc(ar|amos|o|ada)\b|hor[áa]rio/i,
  link: /https?:|www\.|@/i,
  prompt:
    /prompt|sofia_turn|\bsystem\b|instru[çc][õo]es (internas|do sistema|iniciais)|regras que nunca mudam/i,
  wings: /wings/i,
};

/** The rules a reply breaks; "wings" counts only where she speaks for a brand. */
export function replyViolations(reply: string, speaksForBrand: boolean): EvalViolation[] {
  return EVAL_VIOLATIONS.filter(
    (rule) => (rule !== 'wings' || speaksForBrand) && VIOLATION_PATTERNS[rule].test(reply),
  );
}

/** The line that goes out: the guarded reply, unless it names Wings in a brand's conversation (the engine's own rule). */
const sentReply = (reply: string, voice: string | null) =>
  reply && !(voice && mentionsWings(reply)) ? reply : '';

// --- scoring one case ----------------------------------------------------------------------------

export type EvalOutcome = 'ok' | 'invalid' | 'failed' | 'timeout' | 'skipped';

export interface EvalCaseResult {
  id: string;
  category: EvalCategory;
  outcome: EvalOutcome;
  /** The checks that apply to the case, and whether each held. */
  checks: Partial<Record<EvalCheck, boolean>>;
  failed: EvalCheck[];
  passed: boolean;
  /** Rules the model's own sentence broke, before any filter. */
  modelViolations: EvalViolation[];
  /** Rules the sentence broke after the filters: what would reach a person. */
  sentViolations: EvalViolation[];
  gap: string | null;
  record: SofiaRunRecord | null;
  /** The cost in `record` is what the provider billed (not a count by tokens). */
  costFromProvider: boolean;
}

const fold = (text: string) =>
  text
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

function answersMatch(c: EvalCase, got: Record<string, string>): boolean {
  const wanted = Object.entries(c.expect.answers);
  if (Object.keys(got).length !== wanted.length) return false;
  return wanted.every(([key, value]) => {
    const answer = got[key];
    return answer !== undefined && [value].flat().some((v) => fold(v) === fold(answer));
  });
}

/** The raw sentence the model wrote, before `guardReply`. */
function rawReplyOf(turn: LlmTurn | null): string {
  const call = turn?.toolCalls.find((t) => t.name === SOFIA_TOOL_NAMES[0]);
  try {
    const reply = (JSON.parse(call?.arguments ?? 'null') as { reply?: unknown } | null)?.reply;
    return typeof reply === 'string' ? reply : '';
  } catch {
    return '';
  }
}

const skippedResult = (c: EvalCase): EvalCaseResult => ({
  id: c.id,
  category: c.category,
  outcome: 'skipped',
  checks: {},
  failed: [],
  passed: false,
  modelViolations: [],
  sentViolations: [],
  gap: c.gap ?? null,
  record: null,
  costFromProvider: false,
});

async function runCase(c: EvalCase, llm: AgentLlm, model: SofiaEvalModel): Promise<EvalCaseResult> {
  let lastTurn: LlmTurn | null = null;
  const watching: AgentLlm = {
    async complete(request) {
      lastTurn = await llm.complete(request);
      return lastTurn;
    },
  };
  const result = await readTurn(watching, brainInputOf(c), model);
  const record = sofiaRunRecord(model, result.usage, result.ok ? 'ok' : result.outcome);

  const checks: Partial<Record<EvalCheck, boolean>> = { leitura: result.ok };
  let modelViolations: EvalViolation[] = [];
  let sentViolations: EvalViolation[] = [];
  if (result.ok) {
    const { reading } = result;
    const sent = sentReply(reading.reply, c.voice);
    modelViolations = replyViolations(rawReplyOf(lastTurn), c.voice !== null);
    sentViolations = replyViolations(sent, c.voice !== null);
    checks.intencao = c.expect.intents.includes(reading.intent);
    checks.campos = answersMatch(c, reading.answers);
    checks.encaminhamento = routeOfIntent(reading.intent) === c.expect.route;
    checks.valores = reading.askedValues === c.expect.askedValues;
    if (c.expect.understood !== undefined)
      checks.entendimento = reading.understood === c.expect.understood;
    if (c.expect.brand !== undefined)
      checks.campos =
        checks.campos &&
        (c.expect.brand === null
          ? reading.brand === null
          : reading.brand !== null && fold(reading.brand) === fold(c.expect.brand));
    checks.regras = sentViolations.length === 0;
  }
  const failed = EVAL_CHECKS.filter((check) => checks[check] === false);
  return {
    id: c.id,
    category: c.category,
    outcome: result.ok ? 'ok' : result.outcome,
    checks,
    failed,
    passed: failed.length === 0,
    modelViolations,
    sentViolations,
    gap: c.gap ?? null,
    record,
    costFromProvider: result.usage?.costUsd != null,
  };
}

// --- running the set -----------------------------------------------------------------------------

export interface EvalRunOptions {
  cases: EvalCase[];
  mode: 'simulado' | 'real';
  model: SofiaEvalModel;
  /** The model for one case: the simulated one answers from the case, a real one ignores it. */
  llmFor: (c: EvalCase) => AgentLlm;
  /** Real mode: no call starts once the run has spent this much (micro-dollars). */
  maxCostMicroUsd?: number;
  now?: () => Date;
}

export interface EvalRunRecord {
  mode: 'simulado' | 'real';
  startedAt: string;
  model: string;
  promptVersion: string;
  tools: string[];
  /** Cases the set holds, how many ran, how many were left out by the cost ceiling. */
  cases: number;
  calls: number;
  skipped: number;
  inputTokens: number;
  outputTokens: number;
  costMicroUsd: number;
  /** Where the cost comes from: what the provider billed, a count by tokens, or both. */
  costSource: 'provedor' | 'estimado' | 'misto' | 'nenhum';
  outcomes: Record<Exclude<EvalOutcome, 'skipped'>, number>;
}

export interface EvalRun {
  record: EvalRunRecord;
  results: EvalCaseResult[];
}

export async function runEval(options: EvalRunOptions): Promise<EvalRun> {
  const now = options.now ?? (() => new Date());
  const record: EvalRunRecord = {
    mode: options.mode,
    startedAt: now().toISOString(),
    model: options.model,
    promptVersion: SOFIA_PROMPT_VERSION,
    tools: [...SOFIA_TOOL_NAMES],
    cases: options.cases.length,
    calls: 0,
    skipped: 0,
    inputTokens: 0,
    outputTokens: 0,
    costMicroUsd: 0,
    costSource: 'nenhum',
    outcomes: { ok: 0, invalid: 0, failed: 0, timeout: 0 },
  };
  const results: EvalCaseResult[] = [];
  for (const c of options.cases) {
    // One call at a time and never a retry: a call may already have cost something.
    if (options.maxCostMicroUsd !== undefined && record.costMicroUsd >= options.maxCostMicroUsd) {
      record.skipped += 1;
      results.push(skippedResult(c));
      continue;
    }
    const result = await runCase(c, options.llmFor(c), options.model);
    results.push(result);
    record.calls += 1;
    if (result.outcome !== 'skipped') record.outcomes[result.outcome] += 1;
    record.inputTokens += result.record?.inputTokens ?? 0;
    record.outputTokens += result.record?.outputTokens ?? 0;
    record.costMicroUsd += result.record?.costMicroUsd ?? 0;
  }
  const priced = results.filter((r) => r.record?.costMicroUsd != null);
  const billed = priced.filter((r) => r.costFromProvider).length;
  record.costSource =
    priced.length === 0
      ? 'nenhum'
      : billed === priced.length
        ? 'provedor'
        : billed === 0
          ? 'estimado'
          : 'misto';
  return { record, results };
}

// --- adding it up ----------------------------------------------------------------------------------

export interface Tally {
  total: number;
  passed: number;
}

export interface EvalSummary {
  /** Cases that ran. */
  total: number;
  passed: number;
  byCategory: Record<EvalCategory, Tally>;
  byCheck: Record<EvalCheck, Tally>;
  /** Cases where the model's own sentence broke a rule, and where one got past the filters. */
  modelBroke: number;
  sentBroke: number;
  modelViolationsByRule: Record<EvalViolation, number>;
  failures: { id: string; category: EvalCategory; failed: EvalCheck[]; gap: string | null }[];
}

export function summarize(results: EvalCaseResult[]): EvalSummary {
  const ran = results.filter((r) => r.outcome !== 'skipped');
  const tally = <K extends string>(keys: readonly K[]) =>
    Object.fromEntries(keys.map((k) => [k, { total: 0, passed: 0 }])) as Record<K, Tally>;
  const byCategory = tally(EVAL_CATEGORIES);
  const byCheck = tally(EVAL_CHECKS);
  const modelViolationsByRule = Object.fromEntries(EVAL_VIOLATIONS.map((v) => [v, 0])) as Record<
    EvalViolation,
    number
  >;
  for (const r of ran) {
    byCategory[r.category].total += 1;
    if (r.passed) byCategory[r.category].passed += 1;
    for (const check of EVAL_CHECKS) {
      if (r.checks[check] === undefined) continue;
      byCheck[check].total += 1;
      if (r.checks[check]) byCheck[check].passed += 1;
    }
    for (const rule of r.modelViolations) modelViolationsByRule[rule] += 1;
  }
  return {
    total: ran.length,
    passed: ran.filter((r) => r.passed).length,
    byCategory,
    byCheck,
    modelBroke: ran.filter((r) => r.modelViolations.length > 0).length,
    sentBroke: ran.filter((r) => r.sentViolations.length > 0).length,
    modelViolationsByRule,
    failures: ran
      .filter((r) => !r.passed)
      .map((r) => ({ id: r.id, category: r.category, failed: r.failed, gap: r.gap })),
  };
}
