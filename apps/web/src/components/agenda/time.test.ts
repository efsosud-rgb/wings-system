import { describe, expect, it } from 'vitest';
import {
  dayOf,
  instantAt,
  listDayLabel,
  monthGrid,
  periodOf,
  periodTitle,
  rangeOf,
  searchPeriod,
  stepAnchor,
  timeLabel,
} from './time.js';

/** Periods start on Sunday and are measured in São Paulo time, whatever the browser's zone. */
describe('agenda periods', () => {
  it('a week runs Sunday to Saturday, its range from Sunday 00:00 to the next Sunday 00:00 in São Paulo', () => {
    const week = periodOf('semana', '2026-10-14');
    expect(week.days).toEqual([
      '2026-10-11',
      '2026-10-12',
      '2026-10-13',
      '2026-10-14',
      '2026-10-15',
      '2026-10-16',
      '2026-10-17',
    ]);
    expect(rangeOf(week)).toEqual({
      from: '2026-10-11T03:00:00.000Z',
      to: '2026-10-18T03:00:00.000Z',
    });
  });

  it('a Sunday is the first day of its own week', () => {
    expect(periodOf('semana', '2026-10-11').start).toBe('2026-10-11');
    expect(periodOf('semana', '2026-10-17').start).toBe('2026-10-11');
  });

  it('a day is one column, São Paulo midnight to midnight', () => {
    const day = periodOf('dia', '2026-10-14');
    expect(day.days).toEqual(['2026-10-14']);
    expect(rangeOf(day)).toEqual({
      from: '2026-10-14T03:00:00.000Z',
      to: '2026-10-15T03:00:00.000Z',
    });
  });

  it('a month is whole weeks from Sunday, five or six of them', () => {
    const october = monthGrid('2026-10-14');
    expect(october[0]).toBe('2026-09-27');
    expect(october).toHaveLength(35);
    expect(october[34]).toBe('2026-10-31');
    // August 2026 starts on a Saturday: six weeks.
    expect(monthGrid('2026-08-10')).toHaveLength(42);
    // February 2026 starts on a Sunday and fits four weeks; the grid still shows five.
    expect(monthGrid('2026-02-10')).toHaveLength(35);
    const period = periodOf('mes', '2026-10-14');
    expect(rangeOf(period)).toEqual({
      from: '2026-09-27T03:00:00.000Z',
      to: '2026-11-01T03:00:00.000Z',
    });
  });

  it('the list covers 30 days from the anchor, the search half a year back and a year ahead', () => {
    const list = periodOf('agenda', '2026-10-14');
    expect(list.days).toHaveLength(30);
    expect(list.end).toBe('2026-11-13');
    const search = searchPeriod('2026-10-14');
    expect(search.start).toBe('2026-04-17');
    expect(search.end).toBe('2027-10-14');
  });

  it('steps by the view: a day, a week, a month (clamped), 30 days', () => {
    expect(stepAnchor('dia', '2026-10-14', 1)).toBe('2026-10-15');
    expect(stepAnchor('semana', '2026-10-14', -1)).toBe('2026-10-07');
    expect(stepAnchor('mes', '2026-01-31', 1)).toBe('2026-02-28');
    expect(stepAnchor('agenda', '2026-10-14', 1)).toBe('2026-11-13');
  });

  it('titles the period in Portuguese', () => {
    expect(periodTitle('mes', '2026-10-14')).toBe('outubro de 2026');
    expect(periodTitle('semana', '2026-10-14')).toBe('outubro de 2026');
    expect(periodTitle('semana', '2026-10-01')).toBe('set – out de 2026');
    expect(periodTitle('semana', '2026-12-30')).toBe('dez de 2026 – jan de 2027');
    expect(periodTitle('dia', '2026-10-14')).toBe('14 de outubro de 2026');
    expect(listDayLabel('2026-10-14')).toBe('14 OUT, QUA');
  });

  it('reads and writes São Paulo wall-clock times', () => {
    expect(instantAt('2026-10-14', 9 * 60).toISOString()).toBe('2026-10-14T12:00:00.000Z');
    expect(timeLabel('2026-10-14T12:30:00.000Z')).toBe('09:30');
    // 01:00 UTC on the 15th is still the 14th in São Paulo.
    expect(dayOf('2026-10-15T01:00:00.000Z')).toBe('2026-10-14');
  });
});
