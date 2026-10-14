import {
  AGENDA_MAX_ATTENDEES,
  addDays,
  AGENDA_NOTICES,
  GOOGLE_EVENT_COLORS,
  agendaEventInputSchema,
  agendaEventPatchSchema,
  type AgendaCalendarKey,
  type AgendaEvent,
  type AgendaEventPatch,
  type AgendaOverview,
} from '@wings/shared';
import { useId, useRef, useState, type CSSProperties, type FormEvent } from 'react';
import { ApiError } from '../../api/client.js';
import { useCreateAgendaEvent, useUpdateAgendaEvent } from '../../api/agenda.js';
import { failureReason } from '../../lib/failure.js';
import { Icon } from '../Icon.js';
import { Alert } from '../ui.js';
import { calendarOf, exclusiveEndOf, lastDayOf } from './layout.js';
import { dayOf, instantAt, partsOf, timeLabel } from './time.js';
import { useDialog } from './useDialog.js';

/** What the form opens with: a new event's start and end, or the event being edited. */
export type EventFormTarget =
  | { kind: 'create'; start: number; end: number; allDay?: boolean }
  | { kind: 'edit'; event: AgendaEvent };

interface Values {
  title: string;
  allDay: boolean;
  startDate: string;
  startTime: string;
  /** All-day: the last day the event covers (inclusive); the payload adds a day, as Google. */
  endDate: string;
  endTime: string;
  calendar: AgendaCalendarKey;
  guests: string[];
  createMeet: boolean;
  location: string;
  description: string;
  colorId: string | null;
}

const EMAIL = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/;
const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;

const minutesOfTime = (time: string) => {
  const [hour, minute] = time.split(':').map(Number) as [number, number];
  return (hour || 0) * 60 + (minute || 0);
};
const dayDiff = (from: string, to: string) => {
  const a = partsOf(from);
  const b = partsOf(to);
  return Math.round(
    (Date.UTC(b.year, b.month - 1, b.day) - Date.UTC(a.year, a.month - 1, a.day)) / DAY_MS,
  );
};

function initialValues(target: EventFormTarget): Values {
  if (target.kind === 'create') {
    return {
      title: '',
      allDay: target.allDay ?? false,
      startDate: dayOf(target.start),
      startTime: timeLabel(target.start),
      endDate: dayOf(target.allDay ? target.start : target.end),
      endTime: timeLabel(target.end),
      calendar: 'mine',
      guests: [],
      createMeet: false,
      location: '',
      description: '',
      colorId: null,
    };
  }
  const { event } = target;
  const guests = event.attendees
    .filter((guest) => !(guest.self && guest.organizer))
    .map((guest) => guest.email);
  return {
    title: event.title,
    allDay: event.allDay,
    startDate: event.allDay ? event.start : dayOf(event.start),
    startTime: event.allDay ? '09:00' : timeLabel(event.start),
    endDate: event.allDay ? lastDayOf(event.end) : dayOf(event.end),
    endTime: event.allDay ? '10:00' : timeLabel(event.end),
    calendar: event.calendar,
    guests,
    createMeet: false,
    location: event.location ?? '',
    description: event.description ?? '',
    colorId: event.colorId,
  };
}

/** The start and end as the API takes them: instants, or days with Google's exclusive end. */
function timesOf(values: Values): { allDay: boolean; start: string; end: string } {
  if (values.allDay) {
    return { allDay: true, start: values.startDate, end: exclusiveEndOf(values.endDate) };
  }
  return {
    allDay: false,
    start: instantAt(values.startDate, minutesOfTime(values.startTime)).toISOString(),
    end: instantAt(values.endDate, minutesOfTime(values.endTime)).toISOString(),
  };
}

const sameList = (a: string[], b: string[]) =>
  a.length === b.length && [...a].sort().join('\n') === [...b].sort().join('\n');

const errorText = (error: unknown) =>
  error instanceof ApiError ? error.message : `Não foi possível salvar: ${failureReason(error)}.`;

/**
 * Create or edit an event, in São Paulo time whatever the browser's zone.
 * Moving the start keeps the duration; an all-day event is edited by its
 * first and last day. On an edit only what changed is sent, and the calendar
 * stays where it is (moving between calendars is not offered).
 */
export function EventForm({
  target,
  overview,
  onClose,
  returnFocus,
}: {
  target: EventFormTarget;
  overview: AgendaOverview;
  onClose: () => void;
  returnFocus?: HTMLElement | null;
}) {
  const initial = useRef(initialValues(target)).current;
  const [values, setValues] = useState<Values>(initial);
  const [guestDraft, setGuestDraft] = useState('');
  const [guestError, setGuestError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const create = useCreateAgendaEvent();
  const update = useUpdateAgendaEvent();
  const saving = create.isPending || update.isPending;
  const failure = create.error ?? update.error;

  const ref = useRef<HTMLDivElement>(null);
  const titleRef = useRef<HTMLInputElement>(null);
  const headingId = useId();
  const guestErrorId = useId();
  // While a save runs the dialog stays: closing it would hide the answer, a refusal included.
  const close = () => {
    if (!saving) onClose();
  };
  useDialog(ref, close, { initialFocus: titleRef, returnFocus });

  const editing = target.kind === 'edit' ? target.event : null;
  const wingsCalendar = calendarOf(overview.calendars, 'wings');
  const wingsWritable = overview.wings === 'writer' && Boolean(wingsCalendar?.canWrite);
  const set = <K extends keyof Values>(key: K, value: Values[K]) =>
    setValues((current) => ({ ...current, [key]: value }));

  /** A new start moves the end with it, keeping the duration. */
  const moveStart = (startDate: string, startTime: string) =>
    setValues((current) => {
      if (current.allDay) {
        const length = dayDiff(current.startDate, current.endDate);
        return { ...current, startDate, endDate: addDays(startDate, Math.max(0, length)) };
      }
      const before = timesOf(current);
      const duration = Math.max(0, Date.parse(before.end) - Date.parse(before.start));
      const start = instantAt(startDate, minutesOfTime(startTime)).getTime();
      const end = start + duration;
      return {
        ...current,
        startDate,
        startTime,
        endDate: dayOf(end),
        endTime: timeLabel(end),
      };
    });

  const addGuest = (raw: string): boolean => {
    const email = raw
      .trim()
      .replace(/[,;]+$/, '')
      .toLowerCase();
    if (!email) return true;
    if (!EMAIL.test(email)) {
      setGuestError(`E-mail inválido: ${email}`);
      return false;
    }
    if (values.guests.length >= AGENDA_MAX_ATTENDEES) {
      setGuestError(`No máximo ${AGENDA_MAX_ATTENDEES} convidados.`);
      return false;
    }
    setGuestError(null);
    setGuestDraft('');
    if (!values.guests.includes(email)) set('guests', [...values.guests, email]);
    return true;
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setFormError(null);
    // A typed address not yet turned into a chip still counts.
    let guests = values.guests;
    if (guestDraft.trim()) {
      if (!addGuest(guestDraft)) return;
      const email = guestDraft
        .trim()
        .replace(/[,;]+$/, '')
        .toLowerCase();
      if (!guests.includes(email)) guests = [...guests, email];
    }
    const times = timesOf(values);
    const fields = {
      title: values.title.trim(),
      ...times,
      location: values.location.trim() || null,
      description: values.description.trim() ? values.description : null,
      attendees: guests,
      createMeet: values.createMeet,
      colorId: values.colorId,
    };

    if (!editing) {
      const parsed = agendaEventInputSchema.safeParse({ calendar: values.calendar, ...fields });
      if (!parsed.success) {
        setFormError(parsed.error.issues[0]?.message ?? 'Verifique os campos.');
        return;
      }
      create.mutate(parsed.data, { onSuccess: onClose });
      return;
    }

    const patch: AgendaEventPatch = {};
    if (fields.title !== initial.title.trim()) patch.title = fields.title;
    const before = timesOf(initial);
    if (
      times.allDay !== before.allDay ||
      times.start !== before.start ||
      times.end !== before.end
    ) {
      Object.assign(patch, times);
    }
    if (fields.location !== (editing.location ?? null)) patch.location = fields.location;
    if (fields.description !== (editing.description ?? null)) {
      patch.description = fields.description;
    }
    if (!sameList(guests, initial.guests)) patch.attendees = guests;
    if (values.createMeet && !editing.meetUrl) patch.createMeet = true;
    if (fields.colorId !== editing.colorId) patch.colorId = fields.colorId;
    if (Object.keys(patch).length === 0) {
      onClose();
      return;
    }
    const parsed = agendaEventPatchSchema.safeParse(patch);
    if (!parsed.success) {
      setFormError(parsed.error.issues[0]?.message ?? 'Verifique os campos.');
      return;
    }
    update.mutate(
      { calendar: editing.calendar, id: editing.id, patch: parsed.data },
      { onSuccess: onClose },
    );
  };

  const calendarName = (key: AgendaCalendarKey) =>
    key === 'mine' ? 'Minha agenda' : 'Wings Company';

  return (
    <div
      className="crm-modal-backdrop agenda-backdrop"
      onMouseDown={(click) => {
        if (click.target === click.currentTarget && !saving) onClose();
      }}
    >
      <div
        ref={ref}
        className="crm-modal agenda-dialog agenda-form"
        role="dialog"
        aria-modal="true"
        aria-labelledby={headingId}
      >
        <div className="agenda-form-head">
          <h2 id={headingId}>{editing ? 'Editar evento' : 'Novo evento'}</h2>
          <button
            type="button"
            className="agenda-icon-btn"
            aria-label="Fechar"
            onClick={close}
            disabled={saving}
          >
            <Icon name="x" size={18} />
          </button>
        </div>
        <form className="agenda-form-body" onSubmit={submit} noValidate>
          <input
            ref={titleRef}
            className="agenda-form-title"
            placeholder="Adicionar título"
            aria-label="Título"
            value={values.title}
            maxLength={300}
            onChange={(change) => set('title', change.target.value)}
          />

          {editing?.recurring && (
            <p className="agenda-form-note">
              Evento recorrente: a alteração vale só para esta ocorrência
            </p>
          )}

          <label className="agenda-check">
            <input
              type="checkbox"
              checked={values.allDay}
              onChange={(change) => set('allDay', change.target.checked)}
            />
            Dia inteiro
          </label>

          <div className="agenda-form-times">
            <label className="agenda-form-field">
              <span>Início</span>
              <span className="agenda-form-pair">
                <input
                  type="date"
                  className="control"
                  aria-label="Data de início"
                  value={values.startDate}
                  onChange={(change) =>
                    change.target.value && moveStart(change.target.value, values.startTime)
                  }
                />
                {!values.allDay && (
                  <input
                    type="time"
                    step={900}
                    className="control"
                    aria-label="Hora de início"
                    value={values.startTime}
                    onChange={(change) =>
                      change.target.value && moveStart(values.startDate, change.target.value)
                    }
                  />
                )}
              </span>
            </label>
            <label className="agenda-form-field">
              <span>Fim</span>
              <span className="agenda-form-pair">
                <input
                  type="date"
                  className="control"
                  aria-label="Data de fim"
                  value={values.endDate}
                  onChange={(change) => change.target.value && set('endDate', change.target.value)}
                />
                {!values.allDay && (
                  <input
                    type="time"
                    step={900}
                    className="control"
                    aria-label="Hora de fim"
                    value={values.endTime}
                    onChange={(change) =>
                      change.target.value && set('endTime', change.target.value)
                    }
                  />
                )}
              </span>
            </label>
          </div>

          <label className="agenda-form-field">
            <span>Agenda</span>
            <select
              className="control"
              value={values.calendar}
              disabled={Boolean(editing)}
              onChange={(change) => set('calendar', change.target.value as AgendaCalendarKey)}
            >
              <option value="mine">{calendarName('mine')}</option>
              {(wingsWritable || editing?.calendar === 'wings') && (
                <option value="wings">{calendarName('wings')}</option>
              )}
            </select>
          </label>
          {!editing && overview.wings === 'reader' && (
            <p className="agenda-form-note">{AGENDA_NOTICES.wingsReadOnly}</p>
          )}
          {!editing && overview.wings === 'not_shared' && (
            <p className="agenda-form-note">{AGENDA_NOTICES.wingsNotShared}</p>
          )}

          <div className="agenda-form-field">
            <label htmlFor={`${headingId}-guest`}>Convidados</label>
            {values.guests.length > 0 && (
              <ul className="agenda-guest-chips">
                {values.guests.map((email) => (
                  <li key={email} className="agenda-guest-chip">
                    <span>{email}</span>
                    <button
                      type="button"
                      aria-label={`Remover ${email}`}
                      onClick={() =>
                        set(
                          'guests',
                          values.guests.filter((guest) => guest !== email),
                        )
                      }
                    >
                      <Icon name="x" size={14} />
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <input
              id={`${headingId}-guest`}
              type="email"
              className="control"
              placeholder="Adicionar convidados (e-mail)"
              value={guestDraft}
              aria-invalid={guestError ? true : undefined}
              aria-describedby={guestError ? guestErrorId : undefined}
              onChange={(change) => {
                const text = change.target.value;
                if (text.endsWith(',')) addGuest(text);
                else setGuestDraft(text);
              }}
              onKeyDown={(key) => {
                if (key.key === 'Enter') {
                  key.preventDefault();
                  addGuest(guestDraft);
                }
              }}
            />
            {guestError && (
              <span className="field-error" role="alert" id={guestErrorId}>
                {guestError}
              </span>
            )}
          </div>

          {!editing?.meetUrl && (
            <label className="agenda-check">
              <input
                type="checkbox"
                checked={values.createMeet}
                onChange={(change) => set('createMeet', change.target.checked)}
              />
              Adicionar videoconferência do Google Meet
            </label>
          )}

          <label className="agenda-form-field">
            <span>Local</span>
            <input
              className="control"
              placeholder="Adicionar local"
              value={values.location}
              maxLength={500}
              onChange={(change) => set('location', change.target.value)}
            />
          </label>

          <label className="agenda-form-field">
            <span>Descrição</span>
            <textarea
              className="control"
              rows={3}
              placeholder="Adicionar descrição"
              value={values.description}
              maxLength={8000}
              onChange={(change) => set('description', change.target.value)}
            />
          </label>

          <div className="agenda-form-field">
            <span id={`${headingId}-color`}>Cor</span>
            <div className="agenda-swatches" role="group" aria-labelledby={`${headingId}-color`}>
              <button
                type="button"
                className="agenda-swatch-btn is-calendar"
                style={
                  {
                    '--ev-bg': calendarOf(overview.calendars, values.calendar)?.backgroundColor,
                  } as CSSProperties
                }
                aria-pressed={values.colorId === null}
                aria-label="Cor da agenda"
                title="Cor da agenda"
                onClick={() => set('colorId', null)}
              />
              {Object.entries(GOOGLE_EVENT_COLORS).map(([id, color]) => {
                const shown = overview.eventColors[id] ?? color;
                return (
                  <button
                    key={id}
                    type="button"
                    className="agenda-swatch-btn"
                    style={{ '--ev-bg': shown.background } as CSSProperties}
                    aria-pressed={values.colorId === id}
                    aria-label={color.name}
                    title={color.name}
                    onClick={() => set('colorId', id)}
                  />
                );
              })}
            </div>
          </div>

          {formError && <Alert kind="error">{formError}</Alert>}
          {failure && <Alert kind="error">{errorText(failure)}</Alert>}

          <div className="agenda-dialog-actions">
            <button type="button" className="crm-btn" onClick={close} disabled={saving}>
              Cancelar
            </button>
            <button type="submit" className="crm-btn is-primary" disabled={saving}>
              {saving ? 'Salvando…' : 'Salvar'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

/** The default slot for "Criar": the next whole hour today, else 09:00 on the day on screen. */
export function defaultSlot(anchor: string, today: string, now: number): EventFormTarget {
  const start =
    anchor === today
      ? Math.ceil((now + 1) / (60 * MINUTE_MS)) * 60 * MINUTE_MS
      : instantAt(anchor, 9 * 60).getTime();
  return { kind: 'create', start, end: start + 60 * MINUTE_MS };
}
