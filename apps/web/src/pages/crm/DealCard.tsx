import { initialsOf, sourceBadgeOf, type BoardCard } from '@wings/shared';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ago, dueLabel, formatPhone, isPast, money } from './format.js';
import { Icon } from '../../components/Icon.js';

/**
 * A compact card: name, company, contact, value, the owner's initials, time
 * in the stage, the next task (red when late), the source badge and the
 * brand. Hovering shows the quick actions; nothing else moves.
 */
export function DealCard({
  card,
  canWrite,
  dragging,
  onDragStart,
  onDragEnd,
  onWon,
  onLost,
  onTask,
}: {
  card: BoardCard;
  canWrite: boolean;
  dragging: boolean;
  onDragStart: () => void;
  onDragEnd: () => void;
  onWon: () => void;
  onLost: (reason: string) => void;
  onTask: () => void;
}) {
  const [losing, setLosing] = useState(false);
  const [reason, setReason] = useState('');
  const badge = sourceBadgeOf(card.source);
  const stale = isPast(card.stageChangedAt, Date.now() - 7 * 86_400_000);
  const late = card.nextTask ? isPast(card.nextTask.dueAt) : false;
  const contact = card.contactName && card.contactName !== card.name ? card.contactName : null;
  return (
    <article
      className={`crm-card${dragging ? ' is-dragging' : ''}`}
      draggable={canWrite}
      tabIndex={0}
      onDragStart={(event) => {
        event.dataTransfer.setData('text/plain', card.id);
        event.dataTransfer.effectAllowed = 'move';
        onDragStart();
      }}
      onDragEnd={onDragEnd}
    >
      <Link className="crm-card-name" to={`/crm-vendas/negociacoes/${card.id}`}>
        {card.name ?? 'Sem nome'}
      </Link>
      {(card.companyName || contact) && (
        <div className="crm-card-sub">
          {card.companyName ?? ''}
          {card.companyName && contact ? ' · ' : ''}
          {contact ?? ''}
        </div>
      )}
      <div className="crm-card-row">
        <span className="crm-card-value">{money(card.valueCents)}</span>
        <span className={`crm-clock${stale ? ' is-stale' : ''}`} title="Tempo na etapa">
          {ago(card.stageChangedAt ?? card.createdAt)}
        </span>
      </div>
      {card.nextTask && (
        <div className={`crm-card-task${late ? ' is-late' : ''}`}>
          <Icon name={late ? 'alert' : 'clock'} size={12} />
          {card.nextTask.title} · {dueLabel(card.nextTask.dueAt)}
        </div>
      )}
      <div className="crm-card-meta">
        <span
          className={`crm-avatar${card.ownerName ? '' : ' is-empty'}`}
          title={card.ownerName ?? 'Sem dono'}
        >
          {initialsOf(card.ownerName)}
        </span>
        <span className={`crm-badge tone-${badge.tone}`}>{badge.label}</span>
        {card.brand && <span className="crm-badge is-brand">{card.brand}</span>}
      </div>
      {canWrite && !losing && (
        <div className="crm-card-actions">
          {card.phone && (
            <a className="crm-btn" href={`tel:+${card.phone}`} title={formatPhone(card.phone)}>
              Ligar
            </a>
          )}
          {card.email && (
            <a className="crm-btn" href={`mailto:${card.email}`}>
              E-mail
            </a>
          )}
          <button type="button" className="crm-btn" onClick={onTask}>
            Tarefa
          </button>
          <button type="button" className="crm-btn is-success" onClick={onWon}>
            Ganho
          </button>
          <button type="button" className="crm-btn is-danger" onClick={() => setLosing(true)}>
            Perda
          </button>
        </div>
      )}
      {losing && (
        <form
          className="crm-card-lost"
          onSubmit={(event) => {
            event.preventDefault();
            onLost(reason);
            setLosing(false);
            setReason('');
          }}
        >
          <input
            className="crm-input"
            placeholder="Motivo da perda"
            value={reason}
            maxLength={200}
            autoFocus
            onChange={(event) => setReason(event.target.value)}
          />
          <div className="crm-quick-row">
            <button
              type="button"
              className="crm-btn is-small is-quiet"
              onClick={() => setLosing(false)}
            >
              Cancelar
            </button>
            <button
              type="submit"
              className="crm-btn is-small is-danger"
              disabled={reason.trim().length < 2}
            >
              Confirmar perda
            </button>
          </div>
        </form>
      )}
    </article>
  );
}
