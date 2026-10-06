import {
  DEFAULT_AGENT_MODEL,
  LEAD_CALL_OUTCOME_LABELS,
  LEAD_PIPELINE_LABELS,
  type AgentModel,
  type LeadAiSummary,
} from '@wings/shared';
import { eq } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import { leadEvents, leads } from '../../db/schema/index.js';
import { LlmError, type AgentLlm } from '../agent/llm.js';
import { scrubSensitive } from '../agent/scrub.js';
import type { LoadedLead } from './service.js';

/**
 * The deal's AI summary (ficha do cliente, Etapa 4). The model reads ONLY the
 * timeline (stages, notes, calls, meetings, tasks, system events) and the
 * form answers: never the person's name, phone, e-mail, CPF or any document.
 * Every line still goes through the scrubber, and bare digit runs are taken
 * out too (an unformatted phone or CPF typed into a note). The answer is
 * stored on the lead with the date; "Faça uma pergunta" reads the same text
 * and stores nothing.
 *
 * Model: Anthropic Claude via OpenRouter, asked with `data_collection: deny`
 * so OpenRouter routes only to providers that neither store nor train on the
 * prompt (docs/crm/ficha-do-cliente.md).
 */

export const SUMMARY_MODEL: AgentModel = DEFAULT_AGENT_MODEL;
const MAX_LINES = 120;
const MAX_CHARS = 12_000;

/** Questions of a form that would carry a contact or a document: never sent. */
const CONTACT_QUESTION = /telefone|celular|whats|e-?mail|cpf|cnpj|\brg\b|documento|endere[cç]o|cep\b/i;

/** The scrubber plus what it leaves alone on purpose elsewhere: bare digit runs. */
export const scrubForModel = (text: string) =>
  scrubSensitive(text)
    .replace(/\b\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}\b/g, '[documento removido]')
    .replace(/\b\d{8,14}\b/g, '[número removido]');

const when = (iso: string) =>
  new Date(iso).toLocaleString('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });

const EVENT_TEXT: Record<string, string> = {
  'lead.received.rd_station': 'chegou pela landing page',
  'lead.received.whatsapp': 'chegou pelo WhatsApp',
  'lead.received.meta_lead_ads': 'chegou pelo Meta Lead Ads',
  'lead.received.tiktok_lead_ads': 'chegou pelo TikTok Lead Ads',
  'lead.received.google_lead_form': 'chegou pelo formulário do Google Ads',
  'lead.received.site_form': 'chegou pelo formulário do site',
  'lead.created_manually': 'negociação criada à mão',
  'lead.imported.rd_crm': 'trazida do RD CRM',
  'lead.imported.csv': 'importada de planilha',
  'lead.email_sent': 'e-mail enviado ao lead',
  'lead.owner_changed': 'dono alterado',
  'lead.value_changed': 'valor alterado',
  'lead.expected_close_changed': 'previsão de fechamento alterada',
  'lead.brand_changed': 'marca de interesse alterada',
  'lead.file_added': 'arquivo adicionado',
};

/** What goes to the model, and how much of the record it came from. */
export function summaryInputOf(data: LoadedLead): { text: string; events: number; answers: number } {
  const { lead } = data;
  const lines: { at: string; text: string }[] = [];
  for (const item of data.history)
    lines.push({
      at: item.at,
      text:
        item.won === true
          ? 'marcada como venda'
          : item.won === false
            ? `marcada como perda${item.lostReason ? ` (${item.lostReason})` : ''}`
            : `etapa: ${item.fromStage ?? '—'} → ${item.toStage ?? '—'}`,
    });
  for (const note of data.notes) lines.push({ at: note.at, text: `anotação do vendedor: ${note.body}` });
  for (const activity of data.activities)
    lines.push({
      at: activity.at,
      text:
        activity.kind === 'call'
          ? `ligação${activity.outcome ? ` (${LEAD_CALL_OUTCOME_LABELS[activity.outcome]})` : ''}${activity.durationSeconds ? `, ${Math.round(activity.durationSeconds / 60)} min` : ''}${activity.note ? `: ${activity.note}` : ''}`
          : `reunião${activity.participants ? ` com ${activity.participants}` : ''}${activity.note ? `: ${activity.note}` : ''}`,
    });
  for (const task of data.tasks) {
    lines.push({ at: task.createdAt, text: `tarefa criada: ${task.title} (para ${when(task.dueAt)})` });
    if (task.doneAt) lines.push({ at: task.doneAt, text: `tarefa concluída: ${task.title}` });
  }
  for (const event of data.events) {
    const text = EVENT_TEXT[event.kind];
    if (text) lines.push({ at: event.at, text });
  }
  lines.sort((a, b) => a.at.localeCompare(b.at));
  const kept = lines.slice(-MAX_LINES);

  const answers = Object.entries(lead.formAnswers ?? {}).filter(
    ([question, value]) =>
      !CONTACT_QUESTION.test(question) && value !== null && String(value).trim() !== '',
  );

  const parts = [
    `Funil: ${lead.pipeline ? LEAD_PIPELINE_LABELS[lead.pipeline] : 'não definido'}. Etapa atual: ${lead.work.stage ?? 'não definida'}. Situação: ${lead.work.won === true ? 'venda' : lead.work.won === false ? 'perda' : 'em aberto'}.`,
    '',
    'LINHA DO TEMPO (mais antiga primeiro):',
    ...(kept.length === 0 ? ['(nada registrado)'] : kept.map((line) => `- ${when(line.at)} — ${line.text}`)),
    '',
    'RESPOSTAS DO FORMULÁRIO:',
    ...(answers.length === 0
      ? ['(nenhuma)']
      : answers.map(([question, value]) => `- ${question}: ${String(value)}`)),
  ];
  if (lead.firstMessage) parts.push('', `PRIMEIRA MENSAGEM: ${lead.firstMessage}`);
  const text = scrubForModel(parts.join('\n')).slice(0, MAX_CHARS);
  return { text, events: kept.length, answers: answers.length };
}

const SYSTEM = [
  'Você é o assistente de vendas da Wings Company. Lê o registro de uma negociação e responde em português do Brasil, em texto corrido, sem títulos nem listas.',
  'Regras: use SOMENTE o que está no registro. Nunca invente nome, número, data, intenção ou acordo. Se algo não consta, diga "não consta no registro".',
  'Nunca escreva telefone, e-mail, CPF, CNPJ ou outro documento, mesmo que apareça no registro.',
].join('\n');

const SUMMARY_ASK =
  'Resuma a negociação em 3 a 6 frases curtas, nesta ordem: situação atual e etapa; o que a pessoa procura e seu perfil (das respostas do formulário); os últimos contatos e o que foi dito; o próximo passo combinado ou pendente. Se o registro estiver quase vazio, diga isso em uma frase.';

export class SummaryError extends Error {
  constructor(
    readonly code: 'ai_unavailable' | 'ai_failed',
    message: string,
  ) {
    super(message);
    this.name = 'SummaryError';
  }
}

async function ask(llm: AgentLlm, text: string, request: string, maxOutputTokens: number) {
  try {
    const turn = await llm.complete({
      model: SUMMARY_MODEL,
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: `${request}\n\nREGISTRO:\n${text}` },
      ],
      tools: [],
      maxOutputTokens,
      noDataCollection: true,
    });
    const answer = turn.text.trim();
    if (!answer) throw new SummaryError('ai_failed', 'empty answer');
    return { answer: scrubForModel(answer), costUsd: turn.usage.costUsd };
  } catch (error) {
    if (error instanceof SummaryError) throw error;
    throw new SummaryError(
      'ai_failed',
      error instanceof LlmError ? error.code : 'provider failure',
    );
  }
}

/** Makes the summary, stores it on the lead with the date and writes one event (model and cost only). */
export async function generateSummary(
  db: Database,
  llm: AgentLlm | null,
  data: LoadedLead,
  actorEmployeeId: string,
  now = new Date(),
): Promise<LeadAiSummary> {
  if (!llm) throw new SummaryError('ai_unavailable', 'no model configured');
  const input = summaryInputOf(data);
  const { answer, costUsd } = await ask(llm, input.text, SUMMARY_ASK, 600);
  const summary: LeadAiSummary = {
    text: answer,
    generatedAt: now.toISOString(),
    model: SUMMARY_MODEL,
    basedOn: { events: input.events, answers: input.answers },
  };
  await db.transaction(async (tx) => {
    await tx.update(leads).set({ aiSummary: summary, updatedAt: now }).where(eq(leads.id, data.lead.id));
    await tx.insert(leadEvents).values({
      leadId: data.lead.id,
      kind: 'lead.summary_generated',
      actorEmployeeId,
      at: now,
      detail: { model: SUMMARY_MODEL, costUsd, events: input.events, answers: input.answers },
    });
  });
  return summary;
}

/** Answers one question of the seller from the same text; nothing is stored. */
export async function answerQuestion(
  llm: AgentLlm | null,
  data: LoadedLead,
  question: string,
): Promise<{ answer: string; model: AgentModel }> {
  if (!llm) throw new SummaryError('ai_unavailable', 'no model configured');
  const input = summaryInputOf(data);
  const { answer } = await ask(
    llm,
    input.text,
    `Responda à pergunta do vendedor em até 4 frases, só com o que está no registro.\nPERGUNTA: ${scrubForModel(question)}`,
    400,
  );
  return { answer, model: SUMMARY_MODEL };
}
