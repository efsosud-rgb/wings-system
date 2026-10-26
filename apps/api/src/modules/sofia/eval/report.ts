import {
  EVAL_CATEGORY_LABELS,
  EVAL_CATEGORIES,
  EVAL_VIOLATIONS,
  type EvalViolation,
} from './schema.js';
import { EVAL_CHECK_LABELS, EVAL_CHECKS, summarize, type EvalRun, type Tally } from './runner.js';

/** The rules, as the report names them. */
const VIOLATION_LABELS: Record<EvalViolation, string> = {
  valor: 'valor ou número',
  promessa: 'promessa ou desconto',
  pessoa: 'dizer que é pessoa ou não é robô',
  documento: 'pedir CPF, documento ou foto',
  reuniao: 'marcar reunião',
  link: 'link ou e-mail',
  wings: 'citar a Wings numa conversa de marca',
  prompt: 'revelar o prompt',
};

const percent = (tally: Tally) =>
  tally.total === 0 ? '—' : `${((tally.passed / tally.total) * 100).toFixed(1).replace('.', ',')}%`;

const line = (label: string, tally: Tally) =>
  `  ${label.padEnd(58)} ${`${tally.passed}/${tally.total}`.padStart(7)}  ${percent(tally).padStart(6)}`;

const dollars = (micro: number) => `US$ ${(micro / 1e6).toFixed(4).replace('.', ',')}`;

const COST_SOURCE = {
  provedor: 'cobrado pelo provedor',
  estimado: 'estimado pelos tokens',
  misto: 'parte do provedor, parte estimado',
  nenhum: '—',
} as const;

/**
 * The report Eric reads: hits by category and by check, what the model's own
 * sentences broke and what got past the filters, the run's record, the
 * failures by id. Ids and check names only: never a conversation's text.
 */
export function formatReport(run: EvalRun): string {
  const { record } = run;
  const summary = summarize(run.results);
  const out: string[] = [];
  out.push(
    record.mode === 'simulado'
      ? 'AVALIAÇÃO DA SOFIA — SIMULADA (modelo simulado, nenhuma chamada real)'
      : 'AVALIAÇÃO DA SOFIA — MODELO REAL',
  );
  out.push(
    `Modelo: ${record.model} · prompt ${record.promptVersion} · ferramentas: ${record.tools.join(', ')}`,
  );
  out.push(
    `Casos: ${summary.total} · acertos: ${summary.passed}/${summary.total} (${percent({ total: summary.total, passed: summary.passed })})` +
      (record.skipped > 0 ? ` · NÃO EXECUTADOS (teto de custo): ${record.skipped}` : ''),
  );
  out.push('', 'Acertos por categoria (o caso só conta se todas as verificações dele passam)');
  for (const category of EVAL_CATEGORIES)
    out.push(line(EVAL_CATEGORY_LABELS[category], summary.byCategory[category]));
  out.push('', 'Acertos por verificação');
  for (const check of EVAL_CHECKS) out.push(line(EVAL_CHECK_LABELS[check], summary.byCheck[check]));

  out.push('', 'Frases do modelo contra as regras comerciais');
  out.push(
    `  O modelo escreveu uma frase que quebra uma regra em ${summary.modelBroke} caso(s); ` +
      `depois dos filtros do sistema, ${summary.sentBroke} chegaria(m) à pessoa.`,
  );
  const byRule = EVAL_VIOLATIONS.filter((rule) => summary.modelViolationsByRule[rule] > 0).map(
    (rule) => `${VIOLATION_LABELS[rule]}: ${summary.modelViolationsByRule[rule]}`,
  );
  if (byRule.length > 0) out.push(`  Pelo tipo de regra: ${byRule.join(' · ')}`);

  out.push('', 'Registro da execução (sem conteúdo de conversa)');
  out.push(
    `  Chamadas: ${record.calls} · resultados: ${record.outcomes.ok} ok, ${record.outcomes.invalid} fora do formato, ` +
      `${record.outcomes.failed} falha, ${record.outcomes.timeout} demora`,
  );
  out.push(
    `  Tokens: ${record.inputTokens} de entrada, ${record.outputTokens} de saída · custo: ${dollars(record.costMicroUsd)} (${COST_SOURCE[record.costSource]})`,
  );

  const real = summary.failures.filter((f) => f.gap === null);
  const gaps = summary.failures.filter((f) => f.gap !== null);
  if (real.length > 0) {
    out.push('', 'Casos que falharam (id · categoria · verificações)');
    for (const f of real)
      out.push(`  ${f.id} · ${EVAL_CATEGORY_LABELS[f.category]} · ${f.failed.join(', ')}`);
  }
  if (gaps.length > 0) {
    out.push('', 'Lacunas conhecidas (o sistema ainda não cobre; falham de propósito)');
    for (const f of gaps) out.push(`  ${f.id} · ${f.gap}`);
  }
  return out.join('\n');
}
