import { LEAD_PIPELINE_LABELS, type LeadPipeline } from '@wings/shared';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { hasPermission, useSession } from '../../api/auth.js';
import { ApiError } from '../../api/client.js';
import { useCreateLead } from '../../api/leads.js';
import { useChatNumbers, useStartNumberChat, useWhatsAppTargets } from '../../api/whatsapp.js';
import { LoadFailure } from '../../components/LoadFailure.js';
import { Modal } from './CreateDealModal.js';
import { formatPhone } from './format.js';

/**
 * "Nova conversa": a deal or a contact of the CRM in the reader's scope, or a
 * number typed in, by the official number or by one of the reader's work
 * numbers (docs/whatsapp/central.md). A number with no deal becomes one by the
 * manual entry rule (`POST /leads`: a seller's own, otherwise the funnel's
 * rotation). By the official number the conversation opens on the deal, and
 * without a 24-hour window the first message has to be an approved template.
 * By a work number the number's chat with that phone opens; there only free
 * text goes, inside 24 h of the person's last message on that number.
 */

const digitsOf = (text: string) => text.replace(/\D/g, '');

export function WhatsAppNewConversation({
  onClose,
  initial = '',
}: {
  onClose: () => void;
  /** A phone or a name asked for from a contact or a company page. */
  initial?: string;
}) {
  const navigate = useNavigate();
  const session = useSession();
  const canCreate = hasPermission(session.data, 'leads.write');
  const [q, setQ] = useState(initial);
  const [by, setBy] = useState('');
  const numbers = (useChatNumbers().data?.numbers ?? []).filter((n) => n.connected);
  const start = useStartNumberChat();
  const targets = useWhatsAppTargets(q);
  const found = targets.data?.targets ?? [];
  const digits = digitsOf(q);
  const isNumber = /^[\d\s()+.-]+$/.test(q.trim()) && digits.length >= 10 && digits.length <= 13;
  const sameNumber = found.some((t) => digitsOf(t.phone).endsWith(digits.slice(-8)));

  const go = (target: { leadId: string; conversationId: string | null; phone: string }) => {
    if (by)
      return start.mutate(
        { numberId: by, leadId: target.leadId, phone: target.phone },
        {
          onSuccess: ({ conversationId }) => {
            onClose();
            navigate(`/crm-vendas/whatsapp/${conversationId}`);
          },
        },
      );
    onClose();
    navigate(
      target.conversationId
        ? `/crm-vendas/whatsapp/${target.conversationId}`
        : `/crm-vendas/negociacoes/${target.leadId}/whatsapp`,
    );
  };

  return (
    <Modal title="Nova conversa" onClose={onClose}>
      {numbers.length > 0 && (
        <label className="crm-field">
          <span>Enviar por</span>
          <select className="crm-select" value={by} onChange={(e) => setBy(e.target.value)}>
            <option value="">Número oficial</option>
            {numbers.map((n) => (
              <option key={n.id} value={n.id}>
                {n.label ?? (n.phone ? formatPhone(n.phone) : 'Número')}
                {n.ownerName ? ` (${n.ownerName})` : ''}
              </option>
            ))}
          </select>
        </label>
      )}
      {by ? (
        <p className="crm-wa-window is-closed">
          Por este número só vai mensagem livre, dentro de 24 h da última mensagem da pessoa para
          ele. Para falar primeiro com quem não escreveu, use o número oficial e um modelo aprovado.
        </p>
      ) : (
        <p className="crm-wa-window is-closed">
          Sem conversa com a pessoa nas últimas 24 h, a primeira mensagem tem de ser um modelo
          aprovado pela Meta: a conversa abre já na escolha do modelo. Quando a pessoa responder, dá
          para escrever livre por 24 h.
        </p>
      )}
      <label className="crm-field">
        <span>Negociação, contato ou número</span>
        <input
          className="crm-input"
          autoFocus
          type="search"
          placeholder="Nome, telefone ou contato"
          value={q}
          onChange={(event) => setQ(event.target.value)}
        />
      </label>
      {targets.isFetching && <p className="crm-muted">Buscando…</p>}
      {targets.isError && (
        <LoadFailure what="a busca" error={targets.error} onRetry={() => void targets.refetch()} />
      )}
      {start.isError && (
        <p className="crm-error" role="alert">
          {start.error instanceof ApiError
            ? start.error.message
            : 'Não foi possível abrir a conversa por este número.'}
        </p>
      )}
      {found.length > 0 && (
        <ul className="crm-wa-targets">
          {found.map((target) => (
            <li key={`${target.leadId}:${target.phone}`}>
              <button type="button" className="crm-wa-target" onClick={() => go(target)}>
                <b>{target.name ?? 'Sem nome'}</b>
                <span className="crm-sub">
                  {target.contactName ? `${target.contactName} · ` : ''}
                  {formatPhone(target.phone)}
                  {target.pipeline
                    ? ` · ${LEAD_PIPELINE_LABELS[target.pipeline as LeadPipeline] ?? target.pipeline}`
                    : ''}
                  {` · ${target.ownerName ?? 'Sem dono'}`}
                  {target.open ? '' : ' · fechada'}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {/* "Nothing found" and "no deal with this number" only after a search that answered. */}
      {q.trim().length >= 2 &&
        targets.isSuccess &&
        !targets.isFetching &&
        found.length === 0 &&
        !isNumber && <p className="crm-muted">Nada encontrado nas suas negociações.</p>}
      {isNumber && targets.isSuccess && !sameNumber && !targets.isFetching && targets.data.busy && (
        <p className="crm-muted">
          Esta pessoa já está em atendimento (com a Sofia ou com a equipe) e ainda não tem
          negociação. Peça à Diretoria para passar a conversa a você.
        </p>
      )}
      {isNumber &&
        targets.isSuccess &&
        !sameNumber &&
        !targets.isFetching &&
        !targets.data.busy && (
          <NewNumber
            phone={digits}
            canCreate={canCreate}
            onCreated={(leadId) => go({ leadId, conversationId: null, phone: digits })}
          />
        )}
    </Modal>
  );
}

/** A typed number with no deal: one is made for it (the Central's contact panel uses it too). */
export function NewNumber({
  phone,
  canCreate,
  onCreated,
}: {
  phone: string;
  canCreate: boolean;
  onCreated: (leadId: string) => void;
}) {
  const create = useCreateLead();
  const [name, setName] = useState('');
  const [pipeline, setPipeline] = useState<LeadPipeline>('formatacao');
  if (!canCreate)
    return (
      <p className="crm-muted">
        Nenhuma negociação com {formatPhone(phone)}. Para um número novo, alguém que cria
        negociações precisa cadastrá-lo antes.
      </p>
    );
  return (
    <form
      className="crm-wa-new-number"
      onSubmit={(event) => {
        event.preventDefault();
        if (name.trim().length < 2 || create.isPending) return;
        create.mutate(
          { name: name.trim(), phone, pipeline, legalBasis: 'legitimate_interest' },
          { onSuccess: (data) => onCreated(data.lead.id) },
        );
      }}
    >
      <p className="crm-sub">
        Nenhuma negociação com {formatPhone(phone)}. Crie uma para começar a conversa (pela regra do
        cadastro manual: a negociação fica com você, ou com o rodízio do funil).
      </p>
      <label className="crm-field">
        <span>Nome da pessoa</span>
        <input
          className="crm-input"
          value={name}
          maxLength={120}
          onChange={(event) => setName(event.target.value)}
        />
      </label>
      <label className="crm-field">
        <span>Funil</span>
        <select
          className="crm-input"
          value={pipeline}
          onChange={(event) => setPipeline(event.target.value as LeadPipeline)}
        >
          <option value="formatacao">{LEAD_PIPELINE_LABELS.formatacao}</option>
          <option value="expansao">{LEAD_PIPELINE_LABELS.expansao}</option>
        </select>
      </label>
      {create.error && (
        <p className="crm-error">
          {create.error instanceof ApiError
            ? create.error.message
            : 'Não foi possível criar a negociação.'}
        </p>
      )}
      <button
        type="submit"
        className="crm-btn is-primary"
        disabled={name.trim().length < 2 || create.isPending}
      >
        Criar negociação e abrir a conversa
      </button>
    </form>
  );
}
