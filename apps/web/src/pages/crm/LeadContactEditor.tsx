import {
  checkLeadContactUpdate,
  LEAD_CONTACT_FIELD_LABELS,
  type Lead,
  type LeadContactField,
  type LeadContactUpdateInput,
} from '@wings/shared';
import { useState } from 'react';
import { ApiError } from '../../api/client.js';
import { useLeadContactChanges, useUpdateLeadContact } from '../../api/lead-contact.js';
import { LoadFailure } from '../../components/LoadFailure.js';
import { formatDateTime, formatPhone } from './format.js';

const INPUT_FIELDS: { field: LeadContactField; placeholder: string; type?: string }[] = [
  { field: 'name', placeholder: 'Nome do contato' },
  { field: 'phone', placeholder: '(11) 91234-5678', type: 'tel' },
  { field: 'email', placeholder: 'nome@empresa.com.br', type: 'email' },
  { field: 'instagram', placeholder: '@perfil' },
  { field: 'website', placeholder: 'empresa.com.br' },
];

type Form = Record<LeadContactField, string>;

const formOf = (lead: Lead): Form => ({
  name: lead.name ?? '',
  phone: lead.phone ? formatPhone(lead.phone) : '',
  email: lead.email ?? '',
  instagram: lead.fields.instagram ?? '',
  website: lead.fields.website ?? '',
});

/** A history value as shown: a phone with its mask, "—" for none. */
const shown = (field: LeadContactField, value: string | null) =>
  !value ? '—' : field === 'phone' ? formatPhone(value) : value;

/**
 * "Editar dados" on the Contatos card (t089): name, phone, e-mail, Instagram and site of the deal's
 * person, in the form the ficha already uses. Only what changed is sent; the shared validator runs
 * here and again in the API, which also decides who may.
 */
export function LeadContactEditor({ lead }: { lead: Lead }) {
  const update = useUpdateLeadContact(lead.id);
  const [open, setOpen] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [form, setForm] = useState<Form>(() => formOf(lead));
  const [problem, setProblem] = useState<{
    field: LeadContactField | null;
    message: string;
  } | null>(null);
  const history = useLeadContactChanges(lead.id, showHistory);

  const submit = () => {
    const start = formOf(lead);
    const input: LeadContactUpdateInput = {};
    for (const { field } of INPUT_FIELDS)
      if (form[field].trim() !== start[field].trim()) input[field] = form[field];
    const checked = checkLeadContactUpdate(input);
    if (!checked.ok) {
      setProblem({ field: checked.field, message: checked.message });
      return;
    }
    setProblem(null);
    update.mutate(input, { onSuccess: () => setOpen(false) });
  };

  const apiProblem =
    update.error instanceof ApiError
      ? {
          field: (update.error.body as { field?: LeadContactField }).field ?? null,
          message: update.error.message,
        }
      : update.error
        ? { field: null, message: 'Não foi possível salvar.' }
        : null;
  const shownProblem = problem ?? apiProblem;

  return (
    <>
      <span className="crm-quick-row">
        {!open && (
          <button
            type="button"
            className="crm-btn is-small is-quiet"
            onClick={() => {
              setForm(formOf(lead));
              setProblem(null);
              update.reset();
              setOpen(true);
            }}
          >
            Editar dados
          </button>
        )}
        <button
          type="button"
          className="crm-btn is-small is-quiet"
          aria-expanded={showHistory}
          onClick={() => setShowHistory((value) => !value)}
        >
          Histórico dos dados
        </button>
      </span>
      {open && (
        <form
          className="crm-record-form"
          aria-label="Editar dados de contato"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          {INPUT_FIELDS.map(({ field, placeholder, type }) => (
            <label key={field} className="crm-stack" style={{ gap: 2 }}>
              <span className="crm-sub">{LEAD_CONTACT_FIELD_LABELS[field]}</span>
              <input
                className="crm-input"
                type={type === 'email' ? 'text' : type}
                inputMode={type === 'email' ? 'email' : undefined}
                placeholder={placeholder}
                value={form[field]}
                aria-invalid={shownProblem?.field === field}
                onChange={(event) =>
                  setForm((current) => ({ ...current, [field]: event.target.value }))
                }
              />
            </label>
          ))}
          {shownProblem && (
            <span className="crm-error" role="alert">
              {shownProblem.message}
            </span>
          )}
          <small className="crm-sub">
            O número novo passa a ser o do WhatsApp e das ligações. A mudança fica no histórico.
          </small>
          <div className="crm-quick-row">
            <button
              type="button"
              className="crm-btn is-small is-quiet"
              onClick={() => setOpen(false)}
            >
              Cancelar
            </button>
            <button
              type="submit"
              className="crm-btn is-small is-primary"
              disabled={update.isPending}
            >
              Salvar
            </button>
          </div>
        </form>
      )}
      {showHistory && (
        <div className="crm-stack" style={{ gap: 4 }} aria-label="Histórico dos dados de contato">
          {history.isPending && <span className="crm-sub">Carregando…</span>}
          {history.isError && <LoadFailure what="o histórico dos dados" error={history.error} />}
          {history.data && history.data.changes.length === 0 && (
            <span className="crm-sub">Nenhum dado de contato foi alterado.</span>
          )}
          {history.data?.changes.map((change) => (
            <div key={change.id} className="crm-sub">
              {formatDateTime(change.at)} · {change.actorName ?? 'Sistema'} alterou{' '}
              {LEAD_CONTACT_FIELD_LABELS[change.field].toLowerCase()}: era{' '}
              <b>{shown(change.field, change.from)}</b>, ficou{' '}
              <b>{shown(change.field, change.to)}</b>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
