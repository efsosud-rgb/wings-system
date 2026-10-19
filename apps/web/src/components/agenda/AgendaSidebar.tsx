import {
  AGENDA_NOTICES,
  type AgendaCalendar,
  type AgendaCalendarKey,
  type AgendaOverview,
} from '@wings/shared';
import type { CSSProperties } from 'react';
import { Icon } from '../Icon.js';
import { calendarOf } from './layout.js';
import { MiniCalendar } from './MiniCalendar.js';

/**
 * The left column: "Criar", the small month, and the two calendars with a
 * checkbox each in the calendar's colour. Unticking a calendar hides its
 * events at once (nothing is read again).
 */
export function AgendaSidebar({
  overview,
  hidden,
  onToggle,
  onCreate,
  anchor,
  today,
  period,
  onPick,
}: {
  overview: AgendaOverview;
  hidden: ReadonlySet<AgendaCalendarKey>;
  onToggle: (key: AgendaCalendarKey) => void;
  /** Absent without `calendar.write`: the sellers schedule from the deal. */
  onCreate?: () => void;
  anchor: string;
  today: string;
  period: { start: string; end: string };
  onPick: (day: string) => void;
}) {
  const mine = calendarOf(overview.calendars, 'mine');
  const wings = calendarOf(overview.calendars, 'wings');

  return (
    <aside className="agenda-side" aria-label="Agendas">
      {onCreate && (
        <button type="button" className="agenda-create" onClick={onCreate}>
          <Icon name="plus" size={22} />
          <span>Criar</span>
        </button>
      )}
      <MiniCalendar anchor={anchor} today={today} period={period} onPick={onPick} />

      <section className="agenda-cals" aria-labelledby="agenda-cals-mine">
        <h2 id="agenda-cals-mine" className="agenda-cals-title">
          Minhas agendas
        </h2>
        {mine && <CalendarToggle calendar={mine} hidden={hidden} onToggle={onToggle} />}
      </section>

      {(overview.wings === 'writer' ||
        overview.wings === 'reader' ||
        overview.wings === 'not_shared') && (
        <section className="agenda-cals" aria-labelledby="agenda-cals-others">
          <h2 id="agenda-cals-others" className="agenda-cals-title">
            Outras agendas
          </h2>
          {wings && (
            <CalendarToggle
              calendar={wings}
              hidden={hidden}
              onToggle={onToggle}
              note={overview.wings === 'reader' ? 'só leitura' : undefined}
            />
          )}
          {overview.wings === 'not_shared' && (
            <p className="agenda-cals-notice">{AGENDA_NOTICES.wingsNotShared}</p>
          )}
        </section>
      )}
    </aside>
  );
}

function CalendarToggle({
  calendar,
  hidden,
  onToggle,
  note,
}: {
  calendar: AgendaCalendar;
  hidden: ReadonlySet<AgendaCalendarKey>;
  onToggle: (key: AgendaCalendarKey) => void;
  note?: string;
}) {
  return (
    <label className="agenda-cal">
      <input
        type="checkbox"
        checked={!hidden.has(calendar.key)}
        onChange={() => onToggle(calendar.key)}
        style={{ '--cal-bg': calendar.backgroundColor } as CSSProperties}
      />
      <span className="agenda-cal-name">{calendar.name}</span>
      {note && <span className="agenda-cal-note">{note}</span>}
    </label>
  );
}
