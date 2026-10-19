import {
  AGENDA_NOTICES,
  AGENDA_RESPONSE_LABELS,
  agendaDealPath,
  type AgendaEvent,
  type AgendaOverview,
} from '@wings/shared';
import { useId, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { Link } from 'react-router-dom';
import { openMeetBeside } from '../../lib/meet.js';
import { Icon } from '../Icon.js';
import { colorStyle, httpsOnly, linkify, titleOf, whenOf } from './format.js';
import { calendarOf, colorsOf } from './layout.js';
import { useDialog } from './useDialog.js';

const CARD_WIDTH = 400;
const GAP = 8;
/** Below this width the card is a centered dialog instead of a card beside the event. */
const NARROW_PX = 700;

/**
 * An event's details, as the Google Agenda shows them: a card beside the
 * event on a wide screen, a centered dialog on a phone. Edit and delete only
 * when the person may (`canEdit`); a CRM meeting points to its deal instead. `readOnly`: the
 * person has no `calendar.write` (the sellers) and schedules from the deal.
 */
export function EventDetails({
  event,
  overview,
  anchor,
  onClose,
  onEdit,
  onDelete,
  readOnly = false,
}: {
  event: AgendaEvent;
  overview: AgendaOverview;
  /** The event button that opened the card: it sits beside it, and focus goes back to it. */
  anchor: HTMLElement | null;
  onClose: () => void;
  onEdit: () => void;
  onDelete: () => void;
  readOnly?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const [place, setPlace] = useState<CSSProperties | null>(null);
  useDialog(ref, onClose, { returnFocus: anchor });

  useLayoutEffect(() => {
    if (!anchor || window.innerWidth < NARROW_PX) {
      setPlace(null);
      return;
    }
    const box = anchor.getBoundingClientRect();
    const height = ref.current?.offsetHeight ?? 0;
    const roomRight = window.innerWidth - box.right - GAP;
    const left =
      roomRight >= CARD_WIDTH
        ? box.right + GAP
        : Math.max(
            GAP,
            Math.min(box.left - CARD_WIDTH - GAP, window.innerWidth - CARD_WIDTH - GAP),
          );
    const top = Math.max(GAP, Math.min(box.top, window.innerHeight - height - GAP));
    setPlace({ left, top });
  }, [anchor]);

  const calendar = calendarOf(overview.calendars, event.calendar);
  const colors = colorsOf(event, overview);
  const meetUrl = httpsOnly(event.meetUrl);
  const googleUrl = httpsOnly(event.htmlLink);
  const calendarColors = calendar
    ? { background: calendar.backgroundColor, foreground: calendar.foregroundColor }
    : null;

  return (
    <div
      className={`agenda-details-layer${place ? ' is-anchored' : ' is-centered'}`}
      onMouseDown={(click) => {
        if (click.target === click.currentTarget) onClose();
      }}
    >
      <div
        ref={ref}
        className="agenda-details agenda-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        style={place ?? undefined}
      >
        <div className="agenda-details-tools">
          {event.canEdit && (
            <>
              <button
                type="button"
                className="agenda-icon-btn"
                aria-label="Editar evento"
                title="Editar"
                onClick={onEdit}
              >
                <Icon name="edit" size={18} />
              </button>
              <button
                type="button"
                className="agenda-icon-btn"
                aria-label="Excluir evento"
                title="Excluir"
                onClick={onDelete}
              >
                <Icon name="trash" size={18} />
              </button>
            </>
          )}
          <button type="button" className="agenda-icon-btn" aria-label="Fechar" onClick={onClose}>
            <Icon name="x" size={18} />
          </button>
        </div>

        <div className="agenda-details-row">
          <span className="agenda-swatch" style={colorStyle(colors)} aria-hidden="true" />
          <div>
            <h2 id={titleId} className="agenda-details-title">
              {titleOf(event)}
            </h2>
            <p className="agenda-details-when">{whenOf(event)}</p>
            {event.recurring && (
              <p className="agenda-details-note">
                Evento recorrente: editar ou excluir vale só para esta ocorrência
              </p>
            )}
            {event.tentative && <p className="agenda-details-note">Provisório</p>}
          </div>
        </div>

        {event.crm && (
          <div className="agenda-details-crm">
            <span className="agenda-crm-chip">Reunião do CRM</span>
            <p>{AGENDA_NOTICES.crmMeeting}</p>
            {event.crm.leadId && (
              <Link className="crm-btn is-small" to={agendaDealPath(event.crm.leadId)}>
                Abrir negociação
              </Link>
            )}
          </div>
        )}

        {meetUrl && (
          <div className="agenda-details-row">
            <Icon name="video" size={18} className="agenda-details-icon" />
            <button
              type="button"
              className="crm-btn is-primary"
              title="Abre o Meet numa janela ao lado da Agenda"
              onClick={() => openMeetBeside(meetUrl)}
            >
              Participar com o Google Meet
            </button>
          </div>
        )}

        {event.location && (
          <div className="agenda-details-row">
            <Icon name="globe" size={18} className="agenda-details-icon" />
            <p className="agenda-details-text">{event.location}</p>
          </div>
        )}

        {event.description && (
          <div className="agenda-details-row">
            <Icon name="file-text" size={18} className="agenda-details-icon" />
            <p className="agenda-details-text agenda-details-description">
              {linkify(event.description).map((part, index) =>
                part.href ? (
                  <a key={index} href={part.href} target="_blank" rel="noopener noreferrer">
                    {part.text}
                  </a>
                ) : (
                  <span key={index}>{part.text}</span>
                ),
              )}
            </p>
          </div>
        )}

        {event.attendees.length > 0 && (
          <div className="agenda-details-row">
            <Icon name="users" size={18} className="agenda-details-icon" />
            <div className="agenda-details-guests">
              <p className="agenda-details-strong">
                {event.attendees.length === 1
                  ? '1 convidado'
                  : `${event.attendees.length} convidados`}
              </p>
              <ul>
                {event.attendees.map((guest) => (
                  <li key={guest.email}>
                    <span className="agenda-guest-name">{guest.name ?? guest.email}</span>
                    {guest.organizer && <span className="agenda-guest-tag">Organizador</span>}
                    <span className={`agenda-response is-${guest.response}`}>
                      {AGENDA_RESPONSE_LABELS[guest.response]}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        )}

        <div className="agenda-details-row">
          <Icon name="calendar" size={18} className="agenda-details-icon" />
          <p className="agenda-details-text">
            <span className="agenda-dot" style={colorStyle(calendarColors)} aria-hidden="true" />{' '}
            {calendar?.name ?? 'Wings Company'}
          </p>
        </div>

        {!event.canEdit && !event.crm && (
          <p className="agenda-details-note">
            {readOnly
              ? AGENDA_NOTICES.readOnly
              : event.calendar === 'wings' && overview.wings === 'reader'
                ? AGENDA_NOTICES.wingsReadOnly
                : AGENDA_NOTICES.notEditable}
          </p>
        )}

        {googleUrl && (
          <a
            className="agenda-details-google"
            href={googleUrl}
            target="_blank"
            rel="noopener noreferrer"
          >
            Abrir no Google Agenda <Icon name="external" size={14} />
          </a>
        )}
      </div>
    </div>
  );
}
