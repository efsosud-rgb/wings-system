import { readFile, writeFile } from 'node:fs/promises';
import { SOFIA_MODEL } from '@wings/shared';
import { loadDotEnv } from '../db/load-env.js';
import { createOpenRouterLlm } from '../modules/agent/llm.js';
import { EVAL_CASES } from '../modules/sofia/eval/cases.js';
import { formatReport } from '../modules/sofia/eval/report.js';
import { parseEvalCases, type EvalCase } from '../modules/sofia/eval/schema.js';
import {
  runEval,
  simulatedLlm,
  SOFIA_EVAL_MODELS,
  summarize,
  type EvalRun,
  type SofiaEvalModel,
} from '../modules/sofia/eval/runner.js';

/**
 * Evaluation of Sofia's brain (docs/whatsapp/sofia-avaliacao.md):
 *
 *   pnpm --filter @wings/api sofia:avaliar [--casos <arquivo.json>] [--saida <arquivo.json>]
 *       Simulated model: no call leaves the process, nothing is spent.
 *   pnpm --filter @wings/api sofia:avaliar:real --modelo <id> [--confirmado] [--teto-usd 0.5] [...]
 *       A real model through OpenRouter: spends credits. Without --confirmado it only says
 *       what it would do. Each case is one call, sent once and never retried.
 *
 * `--casos` adds the conversations of a file (the same shape as `eval/cases.ts`, with the
 * personal data already taken out: a file that still has any is refused) to the built-in set.
 * `--saida` writes the run's record and results as JSON: ids, check names, tokens and cost.
 */

const arg = (name: string) => {
  const at = process.argv.indexOf(name);
  return at > 0 ? (process.argv[at + 1] ?? null) : null;
};
const has = (name: string) => process.argv.includes(name);

/** The set to run: the built-in one, plus the file's. */
async function casesToRun(): Promise<EvalCase[]> {
  const file = arg('--casos');
  if (!file) return EVAL_CASES;
  const extra = parseEvalCases(JSON.parse(await readFile(file, 'utf8')));
  const taken = new Set(EVAL_CASES.map((c) => c.id));
  const clash = extra.filter((c) => taken.has(c.id));
  if (clash.length > 0) throw new Error(`Ids que já existem: ${clash.map((c) => c.id).join(', ')}`);
  return [...EVAL_CASES, ...extra];
}

async function finish(run: EvalRun) {
  console.warn(formatReport(run));
  const out = arg('--saida');
  if (out)
    await writeFile(
      out,
      JSON.stringify(
        { record: run.record, summary: summarize(run.results), results: run.results },
        null,
        2,
      ),
    );
}

async function simulated() {
  const cases = await casesToRun();
  const run = await runEval({
    cases,
    mode: 'simulado',
    model: SOFIA_MODEL,
    llmFor: simulatedLlm,
  });
  await finish(run);
  // A failure that is not a known gap means the code and the cases disagree.
  if (run.results.some((r) => !r.passed && r.gap === null)) process.exitCode = 1;
}

async function real() {
  const model = arg('--modelo') as SofiaEvalModel | null;
  if (!model || !SOFIA_EVAL_MODELS.includes(model)) {
    console.error(
      `uso: sofia:avaliar:real --modelo <${SOFIA_EVAL_MODELS.join(' | ')}> --confirmado`,
    );
    process.exitCode = 2;
    return;
  }
  const ceilingUsd = Number(arg('--teto-usd') ?? '0.5');
  if (!(ceilingUsd > 0 && ceilingUsd <= 5)) {
    console.error('--teto-usd: um valor entre 0 e 5 (dólares).');
    process.exitCode = 2;
    return;
  }
  const cases = await casesToRun();
  if (!has('--confirmado')) {
    console.warn(
      `Rodaria ${cases.length} chamadas ao modelo ${model} pelo OpenRouter, com teto de US$ ${ceilingUsd}. ` +
        'Isso gasta crédito. Nada foi chamado: repita com --confirmado para rodar.',
    );
    process.exitCode = 2;
    return;
  }
  loadDotEnv();
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    console.error('OPENROUTER_API_KEY não está definida neste ambiente.');
    process.exitCode = 2;
    return;
  }
  const llm = createOpenRouterLlm({ apiKey });
  await finish(
    await runEval({
      cases,
      mode: 'real',
      model,
      llmFor: () => llm,
      maxCostMicroUsd: Math.round(ceilingUsd * 1e6),
    }),
  );
}

async function main() {
  const mode = process.argv[2];
  if (mode === 'simulado') return simulated();
  if (mode === 'real') return real();
  console.error('uso: sofia-eval.js simulado | real --modelo <id> --confirmado');
  process.exitCode = 2;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'erro');
  process.exitCode = 1;
});
