import type { AgendaEvent, AgendaOverview } from '@wings/shared';
import { ariaLabelOf, colorStyle, timeRangeOf, titleOf } from './format.js';
import { calendarOf, colorsOf, eventKey, eventsOfDay } from './layout.js';
import { listDayLabel } from './time.js';
import { Icon } from '../Icon.js';

/**
 * The Agenda (list) view and the search results: the days that have events,
 * in order, each row with its colour, its time and its title. Days without
 * events are left out; `empty` is said only after a read that succeeded (the
 * page shows "—" and the reason when the read failed).
 */
export function ListView({
  days,
  events,
  overview,
  today,
  empty,
  onOpen,
  onDay,
}: {
  days: string[];
  events: AgendaEvent[];
  overview: AgendaOverview;
  today: string;
  empty: string;
  onOpen: (event: AgendaEvent, element: HTMLElement) => void;
  onDay: (day: string) => void;
}) {
  const groups = days
    .map((day) => ({ day, list: eventsOfDay(events, day) }))
    .filter((group) => group.list.length > 0);
  const nameOf = (event: AgendaEvent) =>
    calendarOf(overview.calendars, event.calendar)?.name ?? 'Wings Company';

  if (groups.length === 0) {
    return <p className="agenda-list-empty">{empty}</p>;
  }

  return (
    <ol className="agenda-list">
      {groups.map(({ day, list }) => (
        <li key={day} className={`agenda-list-day${day === today ? ' is-today' : ''}`}>
          <button type="button" className="agenda-list-date" onClick={() => onDay(day)}>
            {listDayLabel(day)}
          </button>
          <ul className="agenda-list-events">
            {list.map((event) => (
              <li key={eventKey(event)}>
                <button
                  type="button"
                  className={`agenda-list-row${event.tentative ? ' is-tentative' : ''}`}
                  style={colorStyle(colorsOf(event, overview))}
                  aria-label={ariaLabelOf(event, nameOf(event))}
                  onClick={(click) => onOpen(event, click.currentTarget)}
                >
                  <span className="agenda-dot" aria-hidden="true" />
                  <span className="agenda-list-time">
                    {event.allDay ? 'Dia inteiro' : timeRangeOf(event)}
                  </span>
                  <span className="agenda-list-title">{titleOf(event)}</span>
                  {event.meetUrl && (
                    <Icon name="video" size={16} className="agenda-list-meet" title="Google Meet" />
                  )}
                </button>
              </li>
            ))}
          </ul>
        </li>
      ))}
    </ol>
  );
}
