import {
  CONTACT_CHANNEL_LABELS,
  CONTACT_CHANNELS,
  CONTACT_OPT_OUT_ORIGIN_LABELS,
  type ContactChannel,
  type ContactOptOutEntry,
} from '@wings/shared';
import { useState } from 'react';
import { ApiError } from '../../api/client.js';
import {
  useContactOptOuts,
  useRecordContactOptOut,
  useRevokeContactOptOut,
} from '../../api/contact-opt-outs.js';
import { Icon } from '../../components/Icon.js';
import { LoadFailure } from '../../components/LoadFailure.js';
import { formatDate } from './format.js';

const errorText = (error: unknown, fallback: string) =>
  error instanceof ApiError ? error.message : fallback;

/** "Não me contate: WhatsApp, desde 29/10/2026 (pediu para sair pelo WhatsApp)". */
export const optOutLine = (entry: ContactOptOutEntry) =>
  `${CONTACT_CHANNEL_LABELS[entry.channel]}, desde ${formatDate(entry.since)} (${
    CONTACT_OPT_OUT_ORIGIN_LABELS[entry.origin]
  })${entry.reason ? `: ${entry.reason}` : ''}`;

/**
 * The deal's "Não me contate" (docs/crm/nao-me-contate.md): the badge with every active one, the
 * button that records one (`leads.write`), and the revoke (managers and the board only). Both ask
 * for confirmation on the strip itself, with the reason; the API checks everything again.
 */
export function ContactOptOutStrip({
  leadId,
  canWrite,
  canRevoke,
}: {
  leadId: string;
  canWrite: boolean;
  canRevoke: boolean;
}) {
  const optOuts = useContactOptOuts(leadId);
  const record = useRecordContactOptOut(leadId);
  const revoke = useRevokeContactOptOut(leadId);
  const [form, setForm] = useState<
    | { kind: 'record'; channels: ContactChannel[] }
    | { kind: 'revoke'; channel: ContactChannel }
    | null
  >(null);
  const [reason, setReason] = useState('');

  if (optOuts.isError && !optOuts.data)
    return (
      <LoadFailure
        what="o não me contate"
        error={optOuts.error}
        onRetry={() => void optOuts.refetch()}
      />
    );
  if (!optOuts.data) return null;
  const { entries } = optOuts.data;
  if (entries.length === 0 && !canWrite) return null;
  // Only the register's own rows are revoked here; a SAIR or a prospect change elsewhere.
  const revocable = [...new Set(entries.filter((e) => e.id).map((e) => e.channel))];
  const close = () => {
    setForm(null);
    setReason('');
  };
  const pending = record.isPending || revoke.isPending;
  const toggle = (channel: ContactChannel) =>
    form?.kind === 'record' &&
    setForm({
      kind: 'record',
      channels: form.channels.includes(channel)
        ? form.channels.filter((c) => c !== channel)
        : [...form.channels, channel],
    });

  return (
    <section
      className={entries.length ? 'crm-strip is-late' : 'crm-strip'}
      aria-label="Não me contate"
    >
      <Icon name="alert" size={16} />
      <div>
        {entries.length > 0 ? (
          <>
            <b>Não me contate</b>
            <ul className="crm-sub" style={{ margin: 0, paddingLeft: '1.1em' }}>
              {entries.map((entry) => (
                <li key={`${entry.channel}:${entry.origin}`}>{optOutLine(entry)}</li>
              ))}
            </ul>
            <div className="crm-sub">
              Nenhum modelo, pedido de ligação, ligação ou e-mail sai por esses canais. Se a pessoa
              escrever, um vendedor responde; a Sofia não.
            </div>
          </>
        ) : (
          <span className="crm-sub">A pessoa pediu para não ser contatada? Registre aqui.</span>
        )}

        {form?.kind === 'record' && (
          <form
            className="crm-record-form"
            aria-label="Registrar não me contate"
            onSubmit={(event) => {
              event.preventDefault();
              record.mutate({ channels: form.channels, reason }, { onSuccess: close });
            }}
          >
            <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
              <legend className="crm-sub">Por quais canais?</legend>
              {CONTACT_CHANNELS.map((channel) => (
                <label key={channel} style={{ marginRight: 12 }}>
                  <input
                    type="checkbox"
                    checked={form.channels.includes(channel)}
                    onChange={() => toggle(channel)}
                  />{' '}
                  {CONTACT_CHANNEL_LABELS[channel]}
                </label>
              ))}
            </fieldset>
            <ReasonField
              value={reason}
              onChange={setReason}
              label="Motivo (o que a pessoa disse)"
            />
            <p className="crm-sub">
              Confirme: a Wings deixa de iniciar contato por{' '}
              {form.channels.length
                ? form.channels.map((c) => CONTACT_CHANNEL_LABELS[c]).join(', ')
                : '—'}
              . Só a gerência ou a diretoria revogam.
            </p>
            <div className="crm-quick-row">
              <button
                type="submit"
                className="crm-btn is-primary is-small"
                disabled={pending || form.channels.length === 0 || reason.trim().length < 3}
              >
                Confirmar não me contate
              </button>
              <button type="button" className="crm-btn is-small" onClick={close}>
                Cancelar
              </button>
            </div>
            {record.isError && (
              <p className="crm-error">{errorText(record.error, 'Não foi possível registrar.')}</p>
            )}
          </form>
        )}

        {form?.kind === 'revoke' && (
          <form
            className="crm-record-form"
            aria-label="Revogar não me contate"
            onSubmit={(event) => {
              event.preventDefault();
              revoke.mutate({ channel: form.channel, reason }, { onSuccess: close });
            }}
          >
            <ReasonField value={reason} onChange={setReason} label="Motivo da revogação" />
            <p className="crm-sub">
              Confirme: a Wings volta a poder iniciar contato por{' '}
              {CONTACT_CHANNEL_LABELS[form.channel]}. Fica no histórico e na auditoria.
            </p>
            <div className="crm-quick-row">
              <button
                type="submit"
                className="crm-btn is-primary is-small"
                disabled={pending || reason.trim().length < 3}
              >
                Confirmar revogação
              </button>
              <button type="button" className="crm-btn is-small" onClick={close}>
                Cancelar
              </button>
            </div>
            {revoke.isError && (
              <p className="crm-error">{errorText(revoke.error, 'Não foi possível revogar.')}</p>
            )}
          </form>
        )}
      </div>
      {!form && (
        <div className="crm-quick-row">
          {canWrite && (
            <button
              type="button"
              className="crm-btn is-small"
              onClick={() => setForm({ kind: 'record', channels: ['all'] })}
            >
              Não me contate
            </button>
          )}
          {canRevoke &&
            revocable.map((channel) => (
              <button
                key={channel}
                type="button"
                className="crm-btn is-small is-quiet"
                onClick={() => setForm({ kind: 'revoke', channel })}
              >
                Revogar ({CONTACT_CHANNEL_LABELS[channel]})
              </button>
            ))}
        </div>
      )}
    </section>
  );
}

function ReasonField({
  value,
  onChange,
  label,
}: {
  value: string;
  onChange: (value: string) => void;
  label: string;
}) {
  return (
    <label className="crm-sub" style={{ display: 'block', marginTop: 8 }}>
      {label}
      <textarea
        className="crm-input"
        rows={2}
        maxLength={500}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        style={{ display: 'block', width: '100%' }}
      />
    </label>
  );
}
