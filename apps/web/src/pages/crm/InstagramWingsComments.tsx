import {
  BUY_SIGNAL_LABELS,
  IG_PRIVATE_REPLY_STATUS_LABELS,
  PROSPECT_REVIEW_REASON_LABELS,
  PROSPECT_STATE_LABELS,
  type InstagramProspect,
} from '@wings/shared';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import {
  useInstagramOwners,
  usePrivateReply,
  useProspectAction,
  useWingsComments,
  type InstagramAction,
} from '../../api/prospect-ai.js';
import { LoadFailure } from '../../components/LoadFailure.js';
import { actionFailure, LeadModal } from './InstagramProspectList.js';
import { formatDateTime } from './format.js';

/**
 * Prospecção → Instagram → Comentários da Wings (docs/prospeccao/instagram.md §1.4, §5): the
 * buying comments on Wings' posts and ads, with the deadline. The one private reply leaves only by
 * the button (or alone, if Eric turned it on), with the fixed text; the conversation goes on in
 * the Instagram app, within 24 hours of her last message. The API decides everything.
 */

const OPEN = ['nova', 'em_revisao', 'abordada'];

export function WingsComments({
  canManage,
  canWrite,
  webhookEnabled,
  replyEnabled,
}: {
  canManage: boolean;
  canWrite: boolean;
  webhookEnabled: boolean;
  replyEnabled: boolean;
}) {
  const list = useWingsComments(true);
  const owners = useInstagramOwners(canManage && canWrite);
  return (
    <div className="crm-stack">
      {!webhookEnabled && (
        <p className="load-failure" role="status">
          <span className="load-failure-dash" aria-hidden="true">
            —
          </span>
          <span>
            Comentários da Wings desligados: o webhook do Instagram espera a revisão do app pela
            Meta. Quem liga é o Eric.
          </span>
        </p>
      )}
      {webhookEnabled && !replyEnabled && (
        <p className="crm-sub">
          Resposta privada desligada: os comentários chegam, mas nada é enviado.
        </p>
      )}
      {list.isError ? (
        <LoadFailure
          what="os comentários da Wings"
          error={list.error}
          onRetry={() => void list.refetch()}
        />
      ) : !list.data ? (
        <p className="muted">Carregando…</p>
      ) : list.data.prospects.length === 0 ? (
        <p className="muted">Nenhum comentário de compra por enquanto.</p>
      ) : (
        list.data.prospects.map((p) => (
          <WingsCommentCard
            key={p.id}
            prospect={p}
            canManage={canManage}
            canWrite={canWrite}
            owners={owners.data?.owners ?? []}
          />
        ))
      )}
    </div>
  );
}

function WingsCommentCard({
  prospect: p,
  canManage,
  canWrite,
  owners,
}: {
  prospect: InstagramProspect;
  canManage: boolean;
  canWrite: boolean;
  owners: { id: string; name: string }[];
}) {
  const act = useProspectAction();
  const reply = usePrivateReply();
  const [leadOpen, setLeadOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const open = OPEN.includes(p.state);
  const run = (action: InstagramAction, body?: unknown) => act.mutate({ id: p.id, action, body });
  const deadlinePassed = p.respondBy !== null && new Date(p.respondBy) < new Date();
  const failure = act.error ?? reply.error;

  return (
    <article className="crm-panel crm-stack">
      <p>
        <strong>@{p.username}</strong> · {PROSPECT_STATE_LABELS[p.state]} ·{' '}
        {p.signal ? BUY_SIGNAL_LABELS[p.signal] : '—'}
        {p.confidence !== null && ` (${p.confidence}%)`} · {p.onAd ? 'anúncio' : 'post'}
        {canManage && ` · ${p.ownerName ?? 'sem dono'}`}
      </p>
      <blockquote>{p.excerpt ?? '—'}</blockquote>
      <p className="crm-sub">
        Comentário de {formatDateTime(p.occurredAt)}
        {p.postUrl && (
          <>
            {' '}
            no{' '}
            <a href={p.postUrl} target="_blank" rel="noopener noreferrer">
              {p.onAd ? 'anúncio' : 'post'}
            </a>
          </>
        )}
        {p.moreComments > 0 && ` · mais ${p.moreComments} mensagem(ns)`}
        {p.justification && ` · por: "${p.justification}"`}
        {p.reviewReason && ` · ${PROSPECT_REVIEW_REASON_LABELS[p.reviewReason]}`}
        {p.decisionReason && ` · ${p.decisionReason}`}
        {open && p.respondBy && ` · responder até ${formatDateTime(p.respondBy)}`}
      </p>
      <p className="crm-sub">
        {p.privateReply
          ? `${IG_PRIVATE_REPLY_STATUS_LABELS[p.privateReply.status]}${p.privateReply.alone ? ' (sozinha)' : ''}${p.privateReply.sentAt ? ` em ${formatDateTime(p.privateReply.sentAt)}` : ''}`
          : 'Resposta privada: não enviada'}
      </p>
      {p.leadId && <Link to={`/crm-vendas/negociacoes/${p.leadId}`}>Abrir negociação</Link>}
      {canWrite && (
        <div className="crm-quick-row">
          <a
            className="crm-btn is-small"
            href={`https://www.instagram.com/${p.username}/`}
            target="_blank"
            rel="noopener noreferrer"
          >
            Abrir no Instagram
          </a>
          {p.state === 'nova' && !p.privateReply && !deadlinePassed && (
            <button
              type="button"
              className="crm-btn is-small is-primary"
              onClick={() => setConfirming(true)}
            >
              Enviar resposta privada
            </button>
          )}
          {open && (
            <>
              <button type="button" className="crm-btn is-small" onClick={() => setLeadOpen(true)}>
                Criar lead
              </button>
              <button
                type="button"
                className="crm-btn is-small is-quiet"
                onClick={() => run('do-not-contact', { reason: '' })}
              >
                Não contatar
              </button>
            </>
          )}
          {p.state === 'aprovada' && p.leadId && (
            <button
              type="button"
              className="crm-btn is-small"
              onClick={() => run('whatsapp-asked')}
            >
              A pessoa pediu contato por WhatsApp
            </button>
          )}
          {canManage && open && owners.length > 0 && (
            <select
              className="crm-select"
              aria-label="Transferir para"
              value=""
              onChange={(e) =>
                e.target.value && run('transfer', { ownerEmployeeId: e.target.value })
              }
            >
              <option value="">Transferir para…</option>
              {owners
                .filter((o) => o.id !== p.ownerEmployeeId)
                .map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.name}
                  </option>
                ))}
            </select>
          )}
        </div>
      )}
      {confirming && (
        <div className="crm-quick-row" role="group" aria-label="Confirmar resposta privada">
          <span className="crm-sub">
            Sai uma mensagem só, com o texto aprovado, até{' '}
            {p.respondBy ? formatDateTime(p.respondBy) : '—'}. Não dá para desfazer.
          </span>
          <button
            type="button"
            className="crm-btn is-small is-primary"
            disabled={reply.isPending}
            onClick={() => {
              setConfirming(false);
              reply.mutate(p.id);
            }}
          >
            Confirmar envio
          </button>
          <button
            type="button"
            className="crm-btn is-small is-quiet"
            onClick={() => setConfirming(false)}
          >
            Cancelar
          </button>
        </div>
      )}
      {failure && (
        <p className="crm-error" role="alert">
          {actionFailure(failure)}
        </p>
      )}
      {leadOpen && <LeadModal prospect={p} onClose={() => setLeadOpen(false)} />}
    </article>
  );
}
