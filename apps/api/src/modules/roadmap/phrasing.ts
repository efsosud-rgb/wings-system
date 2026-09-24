import type { RoadmapComputed } from '@wings/shared';
import type { AgentLlm } from '../agent/llm.js';

/**
 * Turns already-computed numbers into a handful of short PT-BR sentences.
 * The model only phrases: it is given the numbers as data and told to reuse
 * them exactly, never to invent one. Without OpenRouter, or if the call
 * fails for any reason, the plain template below carries the numbers on its
 * own — the report is never blocked on the language model being down.
 */

const formatPercent = (value: number | null) => (value === null ? 'sem dados' : `${value}%`);
const formatWeeks = (value: number | null) =>
  value === null ? 'indeterminado' : value === 0 ? '0 semanas' : `${value} semana(s)`;

function templateMessage(computed: RoadmapComputed, linkUrl: string | null): string {
  const lines: string[] = [];
  lines.push(`Roadmap Wings System — ${computed.reportDate}`);
  lines.push(`Progresso total: ${formatPercent(computed.weightedTotalPercent)}`);
  for (const module of computed.modules) {
    lines.push(`- ${module.label}: ${formatPercent(module.percent)}`);
  }
  lines.push(
    computed.forecast
      ? `Previsão: otimista ${formatWeeks(computed.forecast.optimisticWeeks)}, provável ${formatWeeks(computed.forecast.provavelWeeks)}, pessimista ${formatWeeks(computed.forecast.pessimisticWeeks)}`
      : 'Previsão: indeterminada (velocidade insuficiente ainda)',
  );
  if (computed.scopeChangePercent !== null) {
    const direction = computed.scopeChangePercent >= 0 ? 'aumentou' : 'diminuiu';
    lines.push(`Escopo ${direction} ${Math.abs(computed.scopeChangePercent)}% na semana`);
  }
  if (linkUrl) lines.push(linkUrl);
  return lines.join('\n');
}

const SYSTEM_PROMPT = `Você escreve, em português do Brasil, um relatório curto de progresso de um roadmap de software para os sócios da empresa.

Regras rígidas:
- Use APENAS os números que receber em JSON. Nunca invente, arredonde de outra forma ou estime um número que não esteja lá.
- Uma frase por módulo, citando seu label e sua porcentagem exatamente como veio.
- Cite a previsão (otimista/provável/pessimista) exatamente como veio; se for nula, diga que está indeterminada.
- Se vier "scopeChangePercent", cite o aumento ou diminuição de escopo na semana.
- Nada de floreio, nada de recomendações, nada além do que os números dizem.
- Se vier um link, inclua-o na última linha, sozinho.
- Responda só com o texto do relatório, sem markdown, sem aspas.`;

export interface ComposeReportMessageInput {
  llm: AgentLlm | null;
  computed: RoadmapComputed;
  /** The previous run's numbers, so the model can say what advanced. Optional. */
  previous?: RoadmapComputed | null;
  /** The preview link (17:30 draft) or null for the final CEO message. */
  linkUrl?: string | null;
}

export async function composeReportMessage(input: ComposeReportMessageInput): Promise<string> {
  const linkUrl = input.linkUrl ?? null;
  const template = templateMessage(input.computed, linkUrl);
  if (!input.llm) return template;

  try {
    const turn = await input.llm.complete({
      model: 'anthropic/claude-haiku-4.5',
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        {
          role: 'user',
          content: JSON.stringify({
            computed: input.computed,
            previous: input.previous ?? null,
            linkUrl,
          }),
        },
      ],
      tools: [],
      maxOutputTokens: 700,
    });
    const text = turn.text.trim();
    return text.length > 0 ? text : template;
  } catch {
    // Never block the report on the language model being down.
    return template;
  }
}
