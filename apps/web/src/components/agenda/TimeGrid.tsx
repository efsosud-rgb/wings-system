import { weekdayOf, type AgendaEvent, type AgendaOverview } from '@wings/shared';
import { useEffect, useRef, type CSSProperties, type MouseEvent } from 'react';
import { ariaLabelOf, colorStyle, timeRangeOf, titleOf } from './format.js';
import { calendarOf, colorsOf, daySegments, eventKey, laneBars, packOverlaps } from './layout.js';
import { dayLabel, minutesOf, partsOf, timeLabel, WEEKDAY_SHORT } from './time.js';

/** Height of one hour on the grid, in pixels; the stylesheet reads it as --hour. */
export const HOUR_PX = 48;
/** The shortest block drawn, in minutes; a shorter event still gets this much room. */
const MIN_BLOCK_MINUTES = 20;
/** Where the grid opens: the working morning. */
const FIRST_HOUR = 7;
const LABEL_ROOM_PX = 10;
/** Below this length an event is one line: "Título, 09:00". */
const ONE_LINE_MINUTES = 40;

const HOURS = Array.from({ length: 24 }, (_, hour) => `${String(hour).padStart(2, '0')}:00`);

/**
 * The week and day views: a header per day, the all-day lane, and a 24-hour
 * grid that scrolls inside the page. Events sit at their São Paulo wall-clock
 * minutes; overlapping ones share the column side by side; an event that
 * crosses midnight is drawn on each day it covers.
 */
export function TimeGrid({
  days,
  events,
  overview,
  today,
  now,
  onSlot,
  onOpen,
  onDay,
}: {
  days: string[];
  events: AgendaEvent[];
  overview: AgendaOverview;
  today: string;
  /** The current instant, refreshed by the page every minute. */
  now: number;
  onSlot: (day: string, minute: number) => void;
  onOpen: (event: AgendaEvent, element: HTMLElement) => void;
  onDay: (day: string) => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const showsToday = days.includes(today);
  const firstDay = days[0];

  // On open (and on another period): from 07:00, the working morning in view; when the current
  // time would fall below the fold, low enough that it shows with an hour or two after it.
  useEffect(() => {
    const node = scrollRef.current;
    if (!node) return;
    const sticky = node.querySelector<HTMLElement>('.agenda-tg-sticky')?.offsetHeight ?? 0;
    const visibleHours = Math.max(1, (node.clientHeight - sticky) / HOUR_PX);
    let hour = FIRST_HOUR;
    if (showsToday) {
      const nowHours = minutesOf(Date.now()) / 60;
      if (nowHours > FIRST_HOUR + visibleHours - 1) hour = nowHours - visibleHours + 2;
    }
    // A few pixels above the hour, so its label is not cut by the sticky header.
    node.scrollTop = Math.max(0, Math.max(0, hour) * HOUR_PX - LABEL_ROOM_PX);
    // Only when the period changes, not every minute.
  }, [firstDay, days.length, showsToday]);

  const lane = laneBars(events, days);
  const segments = daySegments(events, days);
  const nameOf = (event: AgendaEvent) =>
    calendarOf(overview.calendars, event.calendar)?.name ?? 'Wings Company';

  const slotClick = (day: string) => (event: MouseEvent<HTMLDivElement>) => {
    const top = event.currentTarget.getBoundingClientRect().top;
    const half = Math.floor((event.clientY - top) / (HOUR_PX / 2));
    onSlot(day, Math.min(47, Math.max(0, half)) * 30);
  };

  return (
    <div
      className={`agenda-tg${days.length === 1 ? ' is-day' : ''}`}
      style={{ '--cols': days.length, '--hour': `${HOUR_PX}px` } as CSSProperties}
    >
      <div className="agenda-tg-scroll" ref={scrollRef}>
        <div className="agenda-tg-sticky">
          <div className="agenda-tg-head">
            <div className="agenda-tg-gutter agenda-tg-zone">GMT-03</div>
            {days.map((day) => (
              <div key={day} className={`agenda-tg-dayhead${day === today ? ' is-today' : ''}`}>
                <span className="agenda-tg-weekday">{WEEKDAY_SHORT[weekdayOf(day)]}</span>
                <button
                  type="button"
                  className="agenda-tg-daynum"
                  aria-label={dayLabel(day)}
                  aria-current={day === today ? 'date' : undefined}
                  onClick={() => onDay(day)}
                >
                  {partsOf(day).day}
                </button>
              </div>
            ))}
          </div>
          <div className="agenda-tg-lanerow">
            <div className="agenda-tg-gutter" />
            <div
              className="agenda-lane"
              style={{ '--rows': Math.max(1, lane.rows) } as CSSProperties}
            >
              {lane.bars.map((bar) => (
                <button
                  key={`${eventKey(bar.event)}@${bar.start}`}
                  type="button"
                  className={`agenda-ev agenda-ev-bar${bar.event.tentative ? ' is-tentative' : ''}${bar.fromBefore ? ' from-before' : ''}${bar.toAfter ? ' to-after' : ''}`}
                  style={{
                    ...colorStyle(colorsOf(bar.event, overview)),
                    gridColumn: `${bar.start + 1} / span ${bar.span}`,
                    gridRow: bar.row + 1,
                  }}
                  aria-label={ariaLabelOf(bar.event, nameOf(bar.event))}
                  onClick={(click) => onOpen(bar.event, click.currentTarget)}
                >
                  <span className="agenda-ev-title">
                    {bar.event.allDay ? '' : `${timeLabel(bar.event.start)} `}
                    {titleOf(bar.event)}
                  </span>
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className="agenda-tg-body">
          <div className="agenda-tg-hours" aria-hidden="true">
            {HOURS.map((label) => (
              <span key={label} className="agenda-tg-hour">
                {label}
              </span>
            ))}
          </div>
          {days.map((day) => {
            const own = segments.filter((segment) => segment.day === day);
            const placements = packOverlaps(
              own.map((segment) => ({
                key: eventKey(segment.event),
                start: segment.startMinute,
                end: segment.endMinute,
              })),
              MIN_BLOCK_MINUTES,
            );
            return (
              <div
                key={day}
                className={`agenda-tg-col${day === today ? ' is-today' : ''}`}
                data-day={day}
                onClick={slotClick(day)}
              >
                {own.map((segment) => {
                  const key = eventKey(segment.event);
                  const place = placements.get(key) ?? { column: 0, columns: 1 };
                  const length = segment.endMinute - segment.startMinute;
                  const oneLine = length < ONE_LINE_MINUTES;
                  const classes = ['agenda-ev', 'agenda-ev-block'];
                  if (oneLine) classes.push('is-short');
                  if (segment.event.tentative) classes.push('is-tentative');
                  return (
                    <button
                      key={key}
                      type="button"
                      className={classes.join(' ')}
                      style={{
                        ...colorStyle(colorsOf(segment.event, overview)),
                        top: (segment.startMinute / 60) * HOUR_PX,
                        height: (Math.max(length, MIN_BLOCK_MINUTES) / 60) * HOUR_PX - 2,
                        left: `${(place.column / place.columns) * 100}%`,
                        width: `calc(${100 / place.columns}% - 4px)`,
                      }}
                      aria-label={ariaLabelOf(segment.event, nameOf(segment.event))}
                      onClick={(click) => {
                        click.stopPropagation();
                        onOpen(segment.event, click.currentTarget);
                      }}
                    >
                      {oneLine ? (
                        <span className="agenda-ev-title">
                          {titleOf(segment.event)}, {timeLabel(segment.event.start)}
                        </span>
                      ) : (
                        <>
                          <span className="agenda-ev-title">{titleOf(segment.event)}</span>
                          <span className="agenda-ev-time">{timeRangeOf(segment.event)}</span>
                        </>
                      )}
                    </button>
                  );
                })}
                {day === today && (
                  <div
                    className="agenda-now"
                    style={{ top: (minutesOf(now) / 60) * HOUR_PX }}
                    aria-hidden="true"
                  />
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
