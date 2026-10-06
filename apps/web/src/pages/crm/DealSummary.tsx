import type { Lead } from '@wings/shared';
import { useState } from 'react';
import { ApiError } from '../../api/client.js';
import { useAskDeal, useGenerateSummary } from '../../api/crm.js';
import { formatDateTime } from './format.js';

/**
 * The AI summary at the top of the deal (ficha do cliente, Etapa 4): made on
 * request from the timeline and the form answers only, shown with the date
 * it was made; "Faça uma pergunta" answers from the same record and keeps
 * nothing. Without a model configured, the panel shows "—" and says why.
 */

const reasonOf = (error: unknown) =>
  error instanceof ApiError ? error.message : 'A IA não respondeu agora. Tente de novo em instantes.';

export function DealSummary({ lead, canWrite }: { lead: Lead; canWrite: boolean }) {
  const generate = useGenerateSummary(lead.id);
  const ask = useAskDeal(lead.id);
  const [question, setQuestion] = useState('');
  const [asking, setAsking] = useState(false);
  const summary = lead.aiSummary;
  const basedOn = summary
    ? `${summary.basedOn.events} ${summary.basedOn.events === 1 ? 'registro' : 'registros'} e ${summary.basedOn.answers} ${summary.basedOn.answers === 1 ? 'resposta' : 'respostas'}`
    : null;
  return (
    <section className="crm-panel crm-summary" aria-label="Resumo da IA">
      <h2>
        Resumo da IA
        {canWrite && (
          <button
            type="button"
            className="crm-btn is-small"
            disabled={generate.isPending}
            onClick={() => generate.mutate()}
          >
            {generate.isPending ? 'Gerando…' : summary ? 'Atualizar' : 'Gerar resumo'}
          </button>
        )}
      </h2>
      {summary ? (
        <>
          <p className="crm-summary-text">{summary.text}</p>
          <p className="crm-sub">
            Gerado em {formatDateTime(summary.generatedAt)} · com base em {basedOn} · só do que está
            nesta negociação
          </p>
        </>
      ) : (
        <p className="crm-summary-text is-empty">
          —{' '}
          <span className="crm-sub">
            {generate.error ? reasonOf(generate.error) : 'Ainda não gerado.'}
          </span>
        </p>
      )}
      {summary && generate.error && <p className="crm-error">{reasonOf(generate.error)}</p>}
      {!asking ? (
        <button type="button" className="crm-link-btn" onClick={() => setAsking(true)}>
          Faça uma pergunta
        </button>
      ) : (
        <form
          className="crm-summary-ask"
          onSubmit={(event) => {
            event.preventDefault();
            if (question.trim().length >= 3) ask.mutate(question.trim());
          }}
        >
          <input
            className="crm-input"
            aria-label="Pergunta sobre a negociação"
            placeholder="Ex.: ela já tem ponto comercial?"
            value={question}
            maxLength={500}
            autoFocus
            onChange={(e) => setQuestion(e.target.value)}
          />
          <button
            type="submit"
            className="crm-btn is-small is-primary"
            disabled={ask.isPending || question.trim().length < 3}
          >
            {ask.isPending ? 'Perguntando…' : 'Perguntar'}
          </button>
          {ask.data && (
            <p className="crm-summary-answer" role="status">
              {ask.data.answer}
            </p>
          )}
          {ask.error && <p className="crm-error">{reasonOf(ask.error)}</p>}
        </form>
      )}
    </section>
  );
}
