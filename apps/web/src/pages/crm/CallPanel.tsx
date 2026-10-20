import { LEAD_CALL_OUTCOME_LABELS, LEAD_CALL_OUTCOMES, type LeadCallOutcome } from '@wings/shared';
import { useEffect, useState, type SyntheticEvent } from 'react';
import { createPortal } from 'react-dom';
import { ApiError } from '../../api/client.js';
import { useAddActivity } from '../../api/crm.js';
import { useWhatsAppSoon, WHATSAPP_SOON_TEXT } from '../../api/whatsapp.js';
import { Icon } from '../../components/Icon.js';
import { formatPhone, waMeUrl } from './format.js';
import { useWhatsAppCallCenter, WhatsAppCallSection } from './WhatsAppCalls.js';

/**
 * The call panel (Eric, 07/10/2026): "Ligar" opens this inside the system
 * instead of the browser's tel: link, whose "open the app?" prompt led
 * nowhere. Three things: call through WhatsApp (Calling API, `WhatsAppCalls.tsx`:
 * on once calling is on for the number and the person allows calls), copy the
 * number to dial from a phone, and register a call made outside the system (a
 * WhatsApp call registers itself). Drawn in a portal and stopping its events, so that a click in it
 * never reaches a kanban card underneath (which opens the deal).
 */

export const WHATSAPP_CALL_OFF =
  'Fica ativo quando a API oficial do WhatsApp estiver ligada no sistema.';

const errorText = (error: unknown, fallback: string) =>
  error instanceof ApiError ? error.message : fallback;

const stop = (event: SyntheticEvent) => event.stopPropagation();

export function CallPanel({
  leadId,
  name,
  phone,
  canWrite,
  onClose,
}: {
  leadId: string;
  name: string | null;
  phone: string | null;
  canWrite: boolean;
  onClose: () => void;
}) {
  const center = useWhatsAppCallCenter();
  const soon = useWhatsAppSoon();
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return createPortal(
    <div
      className="crm-modal-backdrop"
      onClick={stop}
      onKeyDown={stop}
      onMouseDown={(event) => {
        event.stopPropagation();
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="crm-modal crm-call" role="dialog" aria-modal="true" aria-label="Ligação">
        <h2>Ligação</h2>
        <div className="crm-call-who">
          <span className="crm-call-avatar" aria-hidden="true">
            <Icon name="phone" size={18} />
          </span>
          <div>
            <b>{name ?? 'Sem nome'}</b>
            <div className="crm-call-number">{phone ? formatPhone(phone) : 'Sem telefone'}</div>
          </div>
        </div>
        {soon ? (
          <>
            <button
              type="button"
              className="crm-btn is-primary"
              disabled
              title={WHATSAPP_SOON_TEXT}
            >
              <Icon name="message" size={15} /> Ligar pelo WhatsApp <small>em breve</small>
            </button>
            <p className="crm-sub">{WHATSAPP_SOON_TEXT}</p>
          </>
        ) : center ? (
          <WhatsAppCallSection
            center={center}
            leadId={leadId}
            name={name}
            phone={phone}
            onCalling={onClose}
          />
        ) : (
          <>
            <button type="button" className="crm-btn is-primary" disabled title={WHATSAPP_CALL_OFF}>
              <Icon name="message" size={15} /> Ligar pelo WhatsApp
            </button>
            <p className="crm-sub">{WHATSAPP_CALL_OFF}</p>
          </>
        )}
        {phone && (
          <div className="crm-call-ways">
            <a className="crm-btn" href={waMeUrl(phone)} target="_blank" rel="noopener noreferrer">
              Abrir no WhatsApp do vendedor
            </a>
            <CopyNumber phone={phone} />
          </div>
        )}
        {phone && (
          <p className="crm-sub">
            Para ligar pelo seu WhatsApp ou do seu telefone, abra a conversa ou copie o número, e
            registre a ligação aqui.
          </p>
        )}
        {canWrite && <RegisterCall leadId={leadId} />}
        <div className="crm-quick-row">
          <button type="button" className="crm-btn" onClick={onClose}>
            Fechar
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function CopyNumber({ phone }: { phone: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="crm-btn"
      onClick={() => {
        void navigator.clipboard
          ?.writeText(`+${phone}`)
          .then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          })
          .catch(() => undefined); // the browser refused: the number stays on screen to select
      }}
    >
      {copied ? 'Copiado' : 'Copiar número'}
    </button>
  );
}

function RegisterCall({ leadId }: { leadId: string }) {
  const activity = useAddActivity(leadId);
  const [form, setForm] = useState({
    outcome: 'answered' as LeadCallOutcome,
    minutes: '',
    note: '',
  });
  const [saved, setSaved] = useState(false);
  return (
    <form
      className="crm-record-form"
      aria-label="Registrar ligação"
      onSubmit={(event) => {
        event.preventDefault();
        setSaved(false);
        activity.mutate(
          {
            kind: 'call',
            outcome: form.outcome,
            durationSeconds: form.minutes ? Math.round(Number(form.minutes) * 60) : undefined,
            note: form.note || undefined,
          },
          {
            onSuccess: () => {
              setForm({ outcome: 'answered', minutes: '', note: '' });
              setSaved(true);
            },
          },
        );
      }}
    >
      <h3 className="crm-call-title">Registrar ligação</h3>
      <div className="crm-row">
        <select
          className="crm-select"
          aria-label="Resultado"
          value={form.outcome}
          onChange={(e) => setForm((c) => ({ ...c, outcome: e.target.value as LeadCallOutcome }))}
        >
          {LEAD_CALL_OUTCOMES.map((o) => (
            <option key={o} value={o}>
              {LEAD_CALL_OUTCOME_LABELS[o]}
            </option>
          ))}
        </select>
        <input
          className="crm-input"
          type="number"
          min={0}
          max={600}
          aria-label="Duração em minutos"
          placeholder="Duração (min)"
          value={form.minutes}
          onChange={(e) => setForm((c) => ({ ...c, minutes: e.target.value }))}
        />
      </div>
      <textarea
        className="crm-textarea"
        aria-label="Observação"
        placeholder="Observação"
        value={form.note}
        maxLength={2000}
        onChange={(e) => setForm((c) => ({ ...c, note: e.target.value }))}
      />
      <div className="crm-quick-row">
        {saved && <span className="crm-sub">Ligação registrada na negociação.</span>}
        <button type="submit" className="crm-btn is-primary" disabled={activity.isPending}>
          Registrar ligação
        </button>
      </div>
      {activity.error && (
        <p className="crm-error">{errorText(activity.error, 'Não foi possível registrar.')}</p>
      )}
    </form>
  );
}
