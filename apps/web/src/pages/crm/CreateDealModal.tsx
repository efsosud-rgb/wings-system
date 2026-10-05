import {
  LEAD_CHANNEL_LABELS,
  LEAD_CHANNELS,
  LEAD_PIPELINE_LABELS,
  LEAD_PIPELINES,
  LEAD_TASK_KIND_LABELS,
  LEAD_TASK_KINDS,
  type LeadChannel,
  type LeadPipeline,
  type LeadTaskKind,
} from '@wings/shared';
import { useEffect, useState } from 'react';
import { hasPermission, useSession } from '../../api/auth.js';
import { ApiError } from '../../api/client.js';
import { useBrands } from '../../api/crm.js';
import { useCreateLead, useCreateTask, useSellers, useStages } from '../../api/leads.js';
import { parseMoney, toLocalInput } from './format.js';

const errorText = (error: unknown, fallback: string) =>
  error instanceof ApiError ? error.message : fallback;

function Modal({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div
      className="crm-modal-backdrop"
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <div className="crm-modal" role="dialog" aria-modal="true" aria-label={title}>
        <h2>{title}</h2>
        {children}
      </div>
    </div>
  );
}

/**
 * "Criar negociação": name, company, contact, phone, e-mail, funnel, stage,
 * owner (the rotation by default), value and source. One request; the API
 * finds the person again by phone or e-mail instead of making a twin.
 */
export function CreateDealModal({
  pipeline,
  onClose,
  onCreated,
}: {
  pipeline: LeadPipeline;
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const session = useSession();
  const canAssign = hasPermission(session.data, 'leads.assign');
  const create = useCreateLead();
  const sellers = useSellers();
  const brands = useBrands();
  const [form, setForm] = useState({
    name: '',
    companyName: '',
    phone: '',
    email: '',
    pipeline,
    stageId: '',
    ownerEmployeeId: canAssign ? '' : 'me',
    value: '',
    channel: '' as LeadChannel | '',
    clientId: '',
  });
  const stages = useStages(form.pipeline);
  const set = (key: keyof typeof form) => (event: { target: { value: string } }) =>
    setForm((current) => ({
      ...current,
      [key]: event.target.value,
      ...(key === 'pipeline' ? { stageId: '' } : {}),
    }));
  const valueCents = parseMoney(form.value);
  const valid =
    form.name.trim().length >= 2 &&
    (form.phone.trim() || form.email.trim()) &&
    valueCents !== undefined;

  return (
    <Modal title="Criar negociação" onClose={onClose}>
      <form
        className="crm-stack"
        onSubmit={(event) => {
          event.preventDefault();
          create.mutate(
            {
              name: form.name,
              companyName: form.companyName || undefined,
              phone: form.phone || undefined,
              email: form.email || undefined,
              pipeline: form.pipeline,
              stageId: form.stageId || undefined,
              ownerEmployeeId: (form.ownerEmployeeId || undefined) as 'me' | string | undefined,
              valueCents: valueCents ?? null,
              channel: form.channel || undefined,
              clientId: form.clientId || undefined,
              legalBasis: 'legitimate_interest',
            },
            { onSuccess: (answer) => onCreated(answer.lead.id) },
          );
        }}
      >
        <div className="crm-form-grid">
          <label className="crm-field is-wide">
            <span>Nome da negociação (a pessoa)</span>
            <input
              className="crm-input"
              value={form.name}
              onChange={set('name')}
              maxLength={120}
              autoFocus
              required
            />
          </label>
          <label className="crm-field">
            <span>Empresa</span>
            <input
              className="crm-input"
              value={form.companyName}
              onChange={set('companyName')}
              maxLength={120}
            />
          </label>
          <label className="crm-field">
            <span>Telefone (WhatsApp)</span>
            <input
              className="crm-input"
              value={form.phone}
              onChange={set('phone')}
              inputMode="tel"
              placeholder="(21) 99999-0000"
            />
          </label>
          <label className="crm-field">
            <span>E-mail</span>
            <input className="crm-input" type="email" value={form.email} onChange={set('email')} />
          </label>
          <label className="crm-field">
            <span>Valor estimado</span>
            <input
              className="crm-input"
              value={form.value}
              onChange={set('value')}
              inputMode="decimal"
              placeholder="R$ 0,00"
            />
          </label>
          <label className="crm-field">
            <span>Funil</span>
            <select className="crm-select" value={form.pipeline} onChange={set('pipeline')}>
              {LEAD_PIPELINES.map((item) => (
                <option key={item} value={item}>
                  {LEAD_PIPELINE_LABELS[item]}
                </option>
              ))}
            </select>
          </label>
          <label className="crm-field">
            <span>Etapa</span>
            <select className="crm-select" value={form.stageId} onChange={set('stageId')}>
              <option value="">Primeira etapa</option>
              {(stages.data?.stages ?? [])
                .filter((stage) => stage.active)
                .map((stage) => (
                  <option key={stage.id} value={stage.id}>
                    {stage.name}
                  </option>
                ))}
            </select>
          </label>
          <label className="crm-field">
            <span>Dono</span>
            <select
              className="crm-select"
              value={form.ownerEmployeeId}
              onChange={set('ownerEmployeeId')}
              disabled={!canAssign}
            >
              {canAssign && <option value="">Pelo rodízio do funil</option>}
              <option value="me">Eu</option>
              {canAssign &&
                (sellers.data?.sellers ?? [])
                  .filter((seller) => seller.active && seller.id !== session.data?.employeeId)
                  .map((seller) => (
                    <option key={seller.id} value={seller.id}>
                      {seller.name}
                    </option>
                  ))}
            </select>
          </label>
          {form.pipeline === 'expansao' && (
            <label className="crm-field">
              <span>Marca de interesse</span>
              <select className="crm-select" value={form.clientId} onChange={set('clientId')}>
                <option value="">Ainda não sei</option>
                {(brands.data?.brands ?? []).map((brand) => (
                  <option key={brand.clientId} value={brand.clientId}>
                    {brand.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label className="crm-field">
            <span>Origem</span>
            <select className="crm-select" value={form.channel} onChange={set('channel')}>
              <option value="">Não informada</option>
              {LEAD_CHANNELS.map((channel) => (
                <option key={channel} value={channel}>
                  {LEAD_CHANNEL_LABELS[channel]}
                </option>
              ))}
            </select>
          </label>
        </div>
        {!form.phone && !form.email && form.name && (
          <p className="crm-muted">
            Informe um telefone ou um e-mail para encontrar a pessoa de novo.
          </p>
        )}
        {valueCents === undefined && (
          <p className="crm-error">Valor inválido: use números, como 25.000,00.</p>
        )}
        {create.error && (
          <p className="crm-error">
            {errorText(create.error, 'Não foi possível criar a negociação.')}
          </p>
        )}
        <div className="crm-form-actions">
          <button type="button" className="crm-btn is-quiet" onClick={onClose}>
            Cancelar
          </button>
          <button
            type="submit"
            className="crm-btn is-primary"
            disabled={!valid || create.isPending}
          >
            {create.isPending ? 'Criando…' : 'Criar negociação'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

/** "Criar tarefa" from a card or a page: kind, what, when; the assignee is the deal's owner. */
export function CreateTaskModal({
  leadId,
  leadName,
  onClose,
}: {
  leadId: string;
  leadName: string | null;
  onClose: () => void;
}) {
  const create = useCreateTask(leadId);
  const [form, setForm] = useState({
    kind: 'follow_up' as LeadTaskKind,
    title: '',
    dueAt: toLocalInput(new Date(Date.now() + 86_400_000)),
  });
  return (
    <Modal title={`Tarefa · ${leadName ?? 'negociação'}`} onClose={onClose}>
      <form
        className="crm-stack"
        onSubmit={(event) => {
          event.preventDefault();
          create.mutate(
            { kind: form.kind, title: form.title, dueAt: new Date(form.dueAt).toISOString() },
            { onSuccess: onClose },
          );
        }}
      >
        <div className="crm-form-grid">
          <label className="crm-field">
            <span>Tipo</span>
            <select
              className="crm-select"
              value={form.kind}
              onChange={(e) => setForm((c) => ({ ...c, kind: e.target.value as LeadTaskKind }))}
            >
              {LEAD_TASK_KINDS.filter((kind) => kind !== 'first_contact').map((kind) => (
                <option key={kind} value={kind}>
                  {LEAD_TASK_KIND_LABELS[kind]}
                </option>
              ))}
            </select>
          </label>
          <label className="crm-field">
            <span>Quando</span>
            <input
              className="crm-input"
              type="datetime-local"
              value={form.dueAt}
              onChange={(e) => setForm((c) => ({ ...c, dueAt: e.target.value }))}
            />
          </label>
          <label className="crm-field is-wide">
            <span>O que fazer</span>
            <input
              className="crm-input"
              value={form.title}
              maxLength={160}
              autoFocus
              onChange={(e) => setForm((c) => ({ ...c, title: e.target.value }))}
            />
          </label>
        </div>
        {create.error && (
          <p className="crm-error">{errorText(create.error, 'Não foi possível criar a tarefa.')}</p>
        )}
        <div className="crm-form-actions">
          <button type="button" className="crm-btn is-quiet" onClick={onClose}>
            Cancelar
          </button>
          <button
            type="submit"
            className="crm-btn is-primary"
            disabled={form.title.trim().length < 2 || create.isPending}
          >
            Criar tarefa
          </button>
        </div>
      </form>
    </Modal>
  );
}

export { Modal };
