import { MEETING_MAX_ATTENDEES, meetingUpdateSchema, type MeetingUpdateInput } from '@wings/shared';
import { useId, useRef, useState, type FormEvent } from 'react';
import { useChangeCrmMeeting } from '../../api/agenda.js';
import { ApiError } from '../../api/client.js';
import { useMeeting } from '../../api/crm.js';
import { toLocalInput } from '../../pages/crm/format.js';
import { Icon } from '../Icon.js';
import { Alert } from '../ui.js';
import { useDialog } from './useDialog.js';

const EMAIL = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/;

/**
 * "Editar" on the card of a deal's meeting: title, time and guests, sent through the meeting's own
 * route so Google and the deal follow (Eric, 04/11). It reads the meeting first: the Agenda's
 * event does not carry a pasted-link meeting's guests. Only what changed is sent.
 */
export function CrmMeetingEditor({
  meetingId,
  onClose,
  returnFocus,
}: {
  meetingId: string;
  onClose: () => void;
  returnFocus?: HTMLElement | null;
}) {
  const meeting = useMeeting(meetingId);
  const change = useChangeCrmMeeting();
  const ref = useRef<HTMLDivElement>(null);
  const titleRef = useRef<HTMLInputElement>(null);
  const headingId = useId();
  const saving = change.isPending;
  // While a save runs the dialog stays open: closing it would hide the answer, a refusal included.
  const close = () => {
    if (!saving) onClose();
  };
  useDialog(ref, close, { initialFocus: titleRef, returnFocus });

  return (
    <div
      className="crm-modal-backdrop agenda-backdrop"
      onMouseDown={(click) => {
        if (click.target === click.currentTarget) close();
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
          <h2 id={headingId}>Editar reunião</h2>
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
        {meeting.isLoading && <p className="agenda-form-note">Carregando a reunião…</p>}
        {meeting.isError && (
          <Alert kind="error">
            {meeting.error instanceof ApiError
              ? meeting.error.message
              : 'Não foi possível ler a reunião.'}
          </Alert>
        )}
        {meeting.data && (
          <EditorForm
            key={meeting.data.id}
            meeting={meeting.data}
            titleRef={titleRef}
            change={change}
            onClose={close}
            saving={saving}
          />
        )}
      </div>
    </div>
  );
}

type Loaded = NonNullable<ReturnType<typeof useMeeting>['data']>;

function EditorForm({
  meeting,
  titleRef,
  change,
  onClose,
  saving,
}: {
  meeting: Loaded;
  titleRef: React.RefObject<HTMLInputElement | null>;
  change: ReturnType<typeof useChangeCrmMeeting>;
  onClose: () => void;
  saving: boolean;
}) {
  const initial = useRef({
    title: meeting.title,
    startsAt: toLocalInput(new Date(meeting.startsAt)),
    endsAt: toLocalInput(new Date(meeting.endsAt)),
    guests: meeting.attendees.map((guest) => guest.email.toLowerCase()),
  }).current;
  const [title, setTitle] = useState(initial.title);
  const [startsAt, setStartsAt] = useState(initial.startsAt);
  const [endsAt, setEndsAt] = useState(initial.endsAt);
  const [guests, setGuests] = useState(initial.guests);
  const [guestDraft, setGuestDraft] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [googleRefused, setGoogleRefused] = useState(false);
  const guestsId = useId();

  /** Turns the typed address into a chip; false (with the reason shown) when it cannot. */
  const addGuest = (raw: string, into: string[]): string[] | null => {
    const email = raw
      .trim()
      .replace(/[,;]+$/, '')
      .toLowerCase();
    if (!email) return into;
    if (!EMAIL.test(email)) {
      setProblem(`E-mail inválido: ${email}`);
      return null;
    }
    if (into.length >= MEETING_MAX_ATTENDEES && !into.includes(email)) {
      setProblem(`No máximo ${MEETING_MAX_ATTENDEES} convidados.`);
      return null;
    }
    setProblem(null);
    setGuestDraft('');
    return into.includes(email) ? into : [...into, email];
  };

  const submit = (skipGoogle: boolean) => {
    const list = addGuest(guestDraft, guests);
    if (!list) return;
    setGuests(list);
    const sameGuests =
      list.length === initial.guests.length && list.every((g) => initial.guests.includes(g));
    const patch: MeetingUpdateInput = {
      ...(title.trim() !== initial.title ? { title: title.trim() } : {}),
      ...(startsAt !== initial.startsAt ? { startsAt: new Date(startsAt).toISOString() } : {}),
      ...(endsAt !== initial.endsAt ? { endsAt: new Date(endsAt).toISOString() } : {}),
      ...(sameGuests ? {} : { attendees: list.map((email) => ({ email })) }),
    };
    if (Object.keys(patch).length === 0) {
      onClose();
      return;
    }
    // Both ends go together, so the window is checked as a whole.
    const parsed = meetingUpdateSchema.safeParse({
      ...patch,
      startsAt: new Date(startsAt).toISOString(),
      endsAt: new Date(endsAt).toISOString(),
      ...(skipGoogle ? { skipGoogle: true } : {}),
    });
    if (!parsed.success) {
      setProblem(parsed.error.issues[0]?.message ?? 'Confira o título e as datas');
      return;
    }
    setProblem(null);
    change.mutate(
      { meetingId: meeting.id, patch: { ...patch, ...(skipGoogle ? { skipGoogle: true } : {}) } },
      {
        onSuccess: onClose,
        onError: (error) => {
          setProblem(error instanceof ApiError ? error.message : 'Não foi possível salvar.');
          setGoogleRefused(error instanceof ApiError && error.status === 502);
        },
      },
    );
  };

  return (
    <form
      className="agenda-form-body"
      noValidate
      onSubmit={(event: FormEvent) => {
        event.preventDefault();
        submit(false);
      }}
    >
      <input
        ref={titleRef}
        className="agenda-form-title"
        aria-label="Título"
        value={title}
        maxLength={160}
        onChange={(change) => setTitle(change.target.value)}
      />
      <div className="agenda-form-times">
        <label className="agenda-form-field">
          <span>Início</span>
          <input
            type="datetime-local"
            className="control"
            value={startsAt}
            onChange={(change) => setStartsAt(change.target.value)}
          />
        </label>
        <label className="agenda-form-field">
          <span>Fim</span>
          <input
            type="datetime-local"
            className="control"
            value={endsAt}
            onChange={(change) => setEndsAt(change.target.value)}
          />
        </label>
      </div>
      <div className="agenda-form-field">
        <label htmlFor={guestsId}>Convidados</label>
        {guests.length > 0 && (
          <ul className="agenda-guest-chips">
            {guests.map((email) => (
              <li key={email} className="agenda-guest-chip">
                <span>{email}</span>
                <button
                  type="button"
                  aria-label={`Remover ${email}`}
                  onClick={() => setGuests(guests.filter((guest) => guest !== email))}
                >
                  <Icon name="x" size={14} />
                </button>
              </li>
            ))}
          </ul>
        )}
        <input
          id={guestsId}
          type="email"
          className="control"
          placeholder="Adicionar convidados (e-mail)"
          value={guestDraft}
          onChange={(change) => {
            const text = change.target.value;
            if (text.endsWith(',')) {
              const next = addGuest(text, guests);
              if (next) setGuests(next);
            } else setGuestDraft(text);
          }}
          onKeyDown={(key) => {
            if (key.key === 'Enter') {
              key.preventDefault();
              const next = addGuest(guestDraft, guests);
              if (next) setGuests(next);
            }
          }}
        />
      </div>
      {meeting.googleEventId && (
        <p className="agenda-form-note">
          A mudança vai para o Google Agenda e os convidados são avisados.
        </p>
      )}
      {problem && <Alert kind="error">{problem}</Alert>}
      <div className="agenda-dialog-actions">
        <button type="button" className="crm-btn" onClick={onClose} disabled={saving}>
          Cancelar
        </button>
        {googleRefused && (
          <button type="button" className="crm-btn" disabled={saving} onClick={() => submit(true)}>
            Mudar só no sistema
          </button>
        )}
        <button type="submit" className="crm-btn is-primary" disabled={saving}>
          {saving ? 'Salvando…' : 'Salvar'}
        </button>
      </div>
    </form>
  );
}
