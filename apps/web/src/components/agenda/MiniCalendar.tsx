import { addDays } from '@wings/shared';
import { useEffect, useState } from 'react';
import { Icon } from '../Icon.js';
import { dayLabel, MONTH_LONG, monthStart, partsOf, WEEKDAY_INITIAL } from './time.js';

/**
 * The small month in the left column: Sunday first, six weeks, today in an
 * accent circle, the period on screen highlighted. Its arrows only turn its
 * own page; a click on a day takes the big calendar there.
 */
export function MiniCalendar({
  anchor,
  today,
  period,
  onPick,
}: {
  anchor: string;
  today: string;
  /** The visible period, `end` exclusive. */
  period: { start: string; end: string };
  onPick: (day: string) => void;
}) {
  const [page, setPage] = useState(() => monthStart(anchor));
  // The big calendar moved to another month: this page follows it.
  useEffect(() => setPage(monthStart(anchor)), [anchor]);

  const { year, month } = partsOf(page);
  const lead = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
  const start = addDays(page, -lead);
  const days = Array.from({ length: 42 }, (_, index) => addDays(start, index));

  return (
    <div className="agenda-mini">
      <div className="agenda-mini-head">
        <span className="agenda-mini-title">
          {MONTH_LONG[month - 1]} de {year}
        </span>
        <button
          type="button"
          className="agenda-icon-btn is-small"
          aria-label="Ver mês anterior"
          onClick={() => setPage(monthStart(page, -1))}
        >
          <Icon name="chevron-right" size={16} className="agenda-flip" />
        </button>
        <button
          type="button"
          className="agenda-icon-btn is-small"
          aria-label="Ver próximo mês"
          onClick={() => setPage(monthStart(page, 1))}
        >
          <Icon name="chevron-right" size={16} />
        </button>
      </div>
      <div
        className="agenda-mini-grid"
        role="group"
        aria-label={`${MONTH_LONG[month - 1]} de ${year}`}
      >
        <div className="agenda-mini-row">
          {WEEKDAY_INITIAL.map((initial, index) => (
            <span key={index} className="agenda-mini-weekday" aria-hidden="true">
              {initial}
            </span>
          ))}
        </div>
        {Array.from({ length: 6 }, (_, week) => (
          <div className="agenda-mini-row" key={week}>
            {days.slice(week * 7, week * 7 + 7).map((day) => {
              const classes = ['agenda-mini-day'];
              if (partsOf(day).month !== month) classes.push('is-outside');
              if (day >= period.start && day < period.end) classes.push('is-in-period');
              if (day === today) classes.push('is-today');
              return (
                <span key={day}>
                  <button
                    type="button"
                    className={classes.join(' ')}
                    aria-label={dayLabel(day)}
                    aria-current={day === today ? 'date' : undefined}
                    onClick={() => onPick(day)}
                  >
                    {partsOf(day).day}
                  </button>
                </span>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}
