import {
  initialsOf,
  LEAD_ENTERED_SOURCE_LABELS,
  sourceBadgeOf,
  type BoardCard,
} from '@wings/shared';
import { type KeyboardEvent, type MouseEvent, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ago, dueLabel, formatEnteredShort, formatPhone, isPast, money } from './format.js';
import { Icon } from '../../components/Icon.js';
import { CallPanel } from './CallPanel.js';

/** What a click inside the card keeps for itself: links, buttons and the lost-reason form. */
const OWN_CONTROLS = 'a, button, input, select, textarea, form, label';

/**
 * A compact card: name, company, contact, value, the owner's initials, time
 * in the stage, the next task (red when late), the source badge and the
 * brand. Hovering shows the quick actions; nothing else moves. The whole
 * card opens the deal — by click or Enter — except its own links and
 * buttons, and never right after a drag.
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
  const navigate = useNavigate();
  const [losing, setLosing] = useState(false);
  const [reason, setReason] = useState('');
  const [calling, setCalling] = useState(false);
  // A drop ends with no click, but a drag cancelled over the card does: swallow that one.
  const dragged = useRef(false);
  const badge = sourceBadgeOf(card.source);
  const stale = isPast(card.stageChangedAt, Date.now() - 7 * 86_400_000);
  const late = card.nextTask ? isPast(card.nextTask.dueAt) : false;
  const contact = card.contactName && card.contactName !== card.name ? card.contactName : null;
  const href = `/crm-vendas/negociacoes/${card.id}`;
  const open = (event: MouseEvent<HTMLElement>) => {
    if (dragged.current) {
      dragged.current = false;
      return;
    }
    if ((event.target as HTMLElement).closest(OWN_CONTROLS)) return;
    if (window.getSelection()?.toString()) return; // the person was selecting text
    navigate(href);
  };
  const openByKey = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== 'Enter' || event.target !== event.currentTarget) return;
    event.preventDefault();
    navigate(href);
  };
  return (
    <article
      className={`crm-card${dragging ? ' is-dragging' : ''}`}
      draggable={canWrite}
      tabIndex={0}
      aria-label={card.name ?? 'Sem nome'}
      onClick={open}
      onKeyDown={openByKey}
      onDragStart={(event) => {
        event.dataTransfer.setData('text/plain', card.id);
        event.dataTransfer.effectAllowed = 'move';
        dragged.current = true;
        onDragStart();
      }}
      onDragEnd={() => {
        // Let a click born of the same gesture see the flag, then forget it.
        setTimeout(() => (dragged.current = false), 0);
        onDragEnd();
      }}
    >
      <Link className="crm-card-name" to={href} tabIndex={-1}>
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
      <div
        className="crm-sub"
        title={
          card.enteredAtSource === 'received'
            ? 'A fonte não trouxe a data: hora em que o sistema recebeu o lead'
            : `Data da fonte: ${LEAD_ENTERED_SOURCE_LABELS[card.enteredAtSource]}`
        }
      >
        Entrou {formatEnteredShort(card.enteredAt)}
        {card.enteredAtSource === 'received' ? ' *' : ''}
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
            <button
              type="button"
              className="crm-btn"
              title={formatPhone(card.phone)}
              onClick={() => setCalling(true)}
            >
              Ligar
            </button>
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
      {calling && (
        <CallPanel
          leadId={card.id}
          name={card.name}
          phone={card.phone}
          canWrite={canWrite}
          onClose={() => setCalling(false)}
        />
      )}
    </article>
  );
}
