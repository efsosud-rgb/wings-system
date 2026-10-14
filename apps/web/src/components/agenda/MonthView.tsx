import type { AgendaEvent, AgendaOverview } from '@wings/shared';
import type { MouseEvent } from 'react';
import { ariaLabelOf, colorStyle, titleOf } from './format.js';
import { calendarOf, colorsOf, eventKey, eventsOfDay, inAllDayLane } from './layout.js';
import { dayLabel, partsOf, timeLabel, WEEKDAY_SHORT } from './time.js';

/** Chips a cell shows before "+N mais" (all of them when they fit in one more). */
const CHIPS_PER_DAY = 3;

/**
 * The month view: whole weeks from Sunday, each day with its first events and
 * "+N mais"; a click on the day number or on "+N mais" opens that day, a click
 * on the empty cell creates an event that day.
 */
export function MonthView({
  days,
  month,
  events,
  overview,
  today,
  onOpen,
  onDay,
  onSlot,
}: {
  days: string[];
  /** The month on show (1-12): days of other months are muted. */
  month: number;
  events: AgendaEvent[];
  overview: AgendaOverview;
  today: string;
  onOpen: (event: AgendaEvent, element: HTMLElement) => void;
  onDay: (day: string) => void;
  onSlot: (day: string) => void;
}) {
  const nameOf = (event: AgendaEvent) =>
    calendarOf(overview.calendars, event.calendar)?.name ?? 'Wings Company';
  const weeks = Array.from({ length: days.length / 7 }, (_, week) =>
    days.slice(week * 7, week * 7 + 7),
  );

  return (
    <div className="agenda-month" style={{ gridTemplateRows: `auto repeat(${weeks.length}, 1fr)` }}>
      <div className="agenda-month-row is-head">
        {WEEKDAY_SHORT.map((weekday) => (
          <span key={weekday} className="agenda-month-weekday">
            {weekday}
          </span>
        ))}
      </div>
      {weeks.map((week) => (
        <div key={week[0]} className="agenda-month-row">
          {week.map((day) => {
            const list = eventsOfDay(events, day);
            const shown = list.length > CHIPS_PER_DAY + 1 ? list.slice(0, CHIPS_PER_DAY) : list;
            const more = list.length - shown.length;
            const classes = ['agenda-month-cell'];
            if (partsOf(day).month !== month) classes.push('is-outside');
            if (day === today) classes.push('is-today');
            return (
              <div
                key={day}
                className={classes.join(' ')}
                data-day={day}
                onClick={(click: MouseEvent<HTMLDivElement>) => {
                  if (click.target === click.currentTarget) onSlot(day);
                }}
              >
                <button
                  type="button"
                  className="agenda-month-num"
                  aria-label={dayLabel(day)}
                  aria-current={day === today ? 'date' : undefined}
                  onClick={() => onDay(day)}
                >
                  {partsOf(day).day}
                </button>
                {shown.map((event) => {
                  const lane = inAllDayLane(event);
                  return (
                    <button
                      key={eventKey(event)}
                      type="button"
                      className={`agenda-ev agenda-chip${lane ? ' is-bar' : ''}${event.tentative ? ' is-tentative' : ''}`}
                      style={colorStyle(colorsOf(event, overview))}
                      aria-label={ariaLabelOf(event, nameOf(event))}
                      onClick={(click) => onOpen(event, click.currentTarget)}
                    >
                      {!lane && <span className="agenda-dot" aria-hidden="true" />}
                      <span className="agenda-chip-text">
                        {lane ? '' : `${timeLabel(event.start)} `}
                        {titleOf(event)}
                      </span>
                    </button>
                  );
                })}
                {more > 0 && (
                  <button type="button" className="agenda-more" onClick={() => onDay(day)}>
                    +{more} mais
                  </button>
                )}
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}
