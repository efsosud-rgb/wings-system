import {
  PROSPECT_APPROACH_CHANNEL_LABELS,
  PROSPECT_APPROACH_CHANNELS,
  type ProspectApproachChannel,
} from '@wings/shared';
import { useState, type FormEvent } from 'react';
import { useProspectApproach } from '../../api/prospecting.js';
import { googleFailure } from './GooglePlacePanel.js';

/**
 * Sugerir abordagem (docs/crm/prospeccao.md): the AI drafts the first contact from what the seller
 * types here and what the company's own site showed, never from Google. It is a draft marked as
 * the AI's: nothing is sent, and WhatsApp is not an option (no opt-in before the first contact).
 */
export function ApproachPanel({ prospectId }: { prospectId: string }) {
  const approach = useProspectApproach();
  const [channel, setChannel] = useState<ProspectApproachChannel>('ligacao');
  const [segment, setSegment] = useState('');
  const [context, setContext] = useState('');
  const [copied, setCopied] = useState<'idle' | 'done' | 'failed'>('idle');
  const draft = approach.data;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setCopied('idle');
    approach.mutate({ id: prospectId, channel, segment, context });
  };
  const copy = () => {
    if (!draft) return;
    const text = [draft.opening, ...draft.points.map((p) => `- ${p}`), draft.nextStep].join('\n');
    navigator.clipboard.writeText(text).then(
      () => setCopied('done'),
      () => setCopied('failed'),
    );
  };

  return (
    <div className="crm-panel" role="region" aria-label="Sugestão de abordagem">
      <form className="crm-form-grid" onSubmit={submit}>
        <label className="crm-field">
          <span>Canal</span>
          <select
            className="crm-select"
            value={channel}
            onChange={(event) => setChannel(event.target.value as ProspectApproachChannel)}
          >
            {PROSPECT_APPROACH_CHANNELS.map((item) => (
              <option key={item} value={item}>
                {PROSPECT_APPROACH_CHANNEL_LABELS[item]}
              </option>
            ))}
          </select>
        </label>
        <label className="crm-field">
          <span>Segmento</span>
          <input
            className="crm-input"
            value={segment}
            maxLength={80}
            placeholder="padaria"
            onChange={(event) => setSegment(event.target.value)}
          />
        </label>
        <label className="crm-field is-wide">
          <span>O que você sabe da empresa (sem dados pessoais)</span>
          <textarea
            className="crm-input"
            rows={2}
            maxLength={500}
            value={context}
            onChange={(event) => setContext(event.target.value)}
          />
        </label>
        <div className="crm-form-actions is-wide">
          <span className="crm-sub">
            Vai para a IA só o que está aqui. Nada é enviado à empresa.
          </span>
          <button type="submit" className="crm-btn is-primary" disabled={approach.isPending}>
            {approach.isPending ? 'Pensando…' : 'Sugerir'}
          </button>
        </div>
      </form>
      {approach.isError && (
        <p className="crm-error" role="alert">
          — {googleFailure(approach.error)}
        </p>
      )}
      {draft && (
        <div>
          <p className="crm-sub">Sugestão da IA — revise antes de usar.</p>
          <p>{draft.opening}</p>
          <ul>
            {draft.points.map((point) => (
              <li key={point}>{point}</li>
            ))}
          </ul>
          <p>
            <b>Próximo passo:</b> {draft.nextStep}
          </p>
          <button type="button" className="crm-btn is-small" onClick={copy}>
            Copiar
          </button>
          {copied === 'done' && <span className="crm-sub"> Copiado.</span>}
          {copied === 'failed' && (
            <span className="crm-error"> — O navegador não deixou copiar.</span>
          )}
        </div>
      )}
    </div>
  );
}
