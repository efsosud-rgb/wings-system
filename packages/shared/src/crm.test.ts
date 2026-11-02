import { describe, expect, it } from 'vitest';
import {
  addBusinessHours,
  endOfBusinessDay,
  isBusinessInstant,
  isCloseForecastOverdue,
  isoDateSchema,
  leadDealUpdateSchema,
  localIsoDate,
  nextBusinessInstant,
} from './crm.js';

// São Paulo is UTC-3 all year since 2019 (no DST).
const sp = (iso: string) => new Date(`${iso}-03:00`);
const NONE = new Set<string>();

describe('business hours (Mon–Fri, 9h–18h São Paulo)', () => {
  it('counts only working time: 1 hour inside the day is one hour', () => {
    expect(addBusinessHours(sp('2026-10-06T10:00:00'), 1, NONE)).toEqual(sp('2026-10-06T11:00:00'));
  });
  it('a lead at 17h30 on Friday is due Monday 9h30', () => {
    expect(addBusinessHours(sp('2026-10-09T17:30:00'), 1, NONE)).toEqual(sp('2026-10-12T09:30:00'));
  });
  it('a lead on Saturday waits for Monday 9h and the hour starts then', () => {
    expect(addBusinessHours(sp('2026-10-10T15:00:00'), 1, NONE)).toEqual(sp('2026-10-12T10:00:00'));
  });
  it('a lead before 9h on a workday starts at 9h', () => {
    expect(nextBusinessInstant(sp('2026-10-07T07:15:00'), NONE)).toEqual(sp('2026-10-07T09:00:00'));
    expect(addBusinessHours(sp('2026-10-07T07:15:00'), 1, NONE)).toEqual(sp('2026-10-07T10:00:00'));
  });
  it('spans several days for long SLAs', () => {
    // 24 working hours from Monday 9h = Wednesday 15h (9h/day).
    expect(addBusinessHours(sp('2026-10-05T09:00:00'), 24, NONE)).toEqual(
      sp('2026-10-07T15:00:00'),
    );
  });
  it('exactly at 18h is after hours', () => {
    expect(addBusinessHours(sp('2026-10-06T18:00:00'), 1, NONE)).toEqual(sp('2026-10-07T10:00:00'));
  });
  it('isBusinessInstant: inside the working day only', () => {
    expect(isBusinessInstant(sp('2026-10-06T09:00:00'), NONE)).toBe(true);
    expect(isBusinessInstant(sp('2026-10-06T17:59:59'), NONE)).toBe(true);
    expect(isBusinessInstant(sp('2026-10-06T18:00:00'), NONE)).toBe(false);
    expect(isBusinessInstant(sp('2026-10-06T08:59:59'), NONE)).toBe(false);
    expect(isBusinessInstant(sp('2026-10-10T12:00:00'), NONE)).toBe(false); // Saturday
    expect(isBusinessInstant(sp('2026-10-11T12:00:00'), NONE)).toBe(false); // Sunday
  });
});

describe('end of the business day (when an overdue first contact reaches the manager)', () => {
  it('a deadline during the day closes that same day at 18h', () => {
    expect(endOfBusinessDay(sp('2026-10-06T11:00:00'), NONE)).toEqual(sp('2026-10-06T18:00:00'));
    expect(endOfBusinessDay(sp('2026-10-06T09:00:00'), NONE)).toEqual(sp('2026-10-06T18:00:00'));
    expect(endOfBusinessDay(sp('2026-10-06T17:59:30'), NONE)).toEqual(sp('2026-10-06T18:00:00'));
  });
  it('a deadline on the 18h close itself, or after it, closes the next workday', () => {
    expect(endOfBusinessDay(sp('2026-10-06T18:00:00'), NONE)).toEqual(sp('2026-10-07T18:00:00'));
    expect(endOfBusinessDay(sp('2026-10-06T22:00:00'), NONE)).toEqual(sp('2026-10-07T18:00:00'));
  });
  it('a deadline before 9h counts the day it falls on', () => {
    expect(endOfBusinessDay(sp('2026-10-07T07:15:00'), NONE)).toEqual(sp('2026-10-07T18:00:00'));
  });
  it('skips the weekend: Friday evening and Saturday close on Monday', () => {
    expect(endOfBusinessDay(sp('2026-10-09T18:00:00'), NONE)).toEqual(sp('2026-10-12T18:00:00'));
    expect(endOfBusinessDay(sp('2026-10-10T12:00:00'), NONE)).toEqual(sp('2026-10-12T18:00:00'));
    expect(endOfBusinessDay(sp('2026-10-11T23:59:00'), NONE)).toEqual(sp('2026-10-12T18:00:00'));
  });
  it('is always a workday close, strictly after its input', () => {
    // A lead at Friday 17h30 is due Monday 9h30; the manager hears at Monday 18h.
    const due = addBusinessHours(sp('2026-10-09T17:30:00'), 1, NONE);
    expect(endOfBusinessDay(due, NONE)).toEqual(sp('2026-10-12T18:00:00'));
    expect(endOfBusinessDay(due, NONE).getTime()).toBeGreaterThan(due.getTime());
  });
});

describe('holidays (Eric, 31/10/2026: national, RJ state and Rio city)', () => {
  // The days these tests need, as the API loads them from the Ponto's `holidays` table.
  const RJ = new Set(['2026-01-20', '2026-04-21', '2026-04-23', '2026-11-02', '2026-11-20']);

  it('a lead on Saturday 31/10/2026 at 10h skips Finados (Monday 02/11) and is due Tuesday 10h', () => {
    expect(addBusinessHours(sp('2026-10-31T10:00:00'), 1, RJ)).toEqual(sp('2026-11-03T10:00:00'));
    // Without the holiday it would be the Monday, the bug found on 31/10.
    expect(addBusinessHours(sp('2026-10-31T10:00:00'), 1, NONE)).toEqual(sp('2026-11-02T10:00:00'));
  });
  it('the eve of a holiday at the end of the day: Thursday 19/11 17h30 is due Monday 23/11 9h30', () => {
    // 20/11/2026 (Consciência Negra) is a Friday.
    expect(addBusinessHours(sp('2026-11-19T17:30:00'), 1, RJ)).toEqual(sp('2026-11-23T09:30:00'));
  });
  it('a state holiday: São Jorge (23/04/2026, Thursday) is skipped', () => {
    expect(addBusinessHours(sp('2026-04-22T17:30:00'), 1, RJ)).toEqual(sp('2026-04-24T09:30:00'));
    expect(isBusinessInstant(sp('2026-04-23T11:00:00'), RJ)).toBe(false);
  });
  it('a state holiday next to a national one: Tiradentes (21/04) and São Jorge (23/04)', () => {
    // Monday 20/04 17h -> 1h left of the day, Tuesday is Tiradentes, so Wednesday 22/04 at 9h.
    expect(addBusinessHours(sp('2026-04-20T17:00:00'), 2, RJ)).toEqual(sp('2026-04-22T10:00:00'));
    // 9 working hours from Wednesday 22/04 13h: 5h that day, Thursday off, 4h on Friday.
    expect(addBusinessHours(sp('2026-04-22T13:00:00'), 9, RJ)).toEqual(sp('2026-04-24T13:00:00'));
  });
  it('a city holiday: São Sebastião (20/01/2026, Tuesday) is skipped', () => {
    expect(addBusinessHours(sp('2026-01-19T17:30:00'), 1, RJ)).toEqual(sp('2026-01-21T09:30:00'));
    expect(nextBusinessInstant(sp('2026-01-20T10:00:00'), RJ)).toEqual(sp('2026-01-21T09:00:00'));
  });
  it('a holiday is not a working day for the end of the day either', () => {
    // Friday's 18h close would roll to Monday, but Monday 02/11 is Finados: Tuesday 18h.
    expect(endOfBusinessDay(sp('2026-10-30T18:00:00'), RJ)).toEqual(sp('2026-11-03T18:00:00'));
    expect(endOfBusinessDay(sp('2026-11-02T10:00:00'), RJ)).toEqual(sp('2026-11-03T18:00:00'));
    expect(endOfBusinessDay(sp('2026-11-19T18:00:00'), RJ)).toEqual(sp('2026-11-23T18:00:00'));
  });
  it('a holiday on a weekend changes nothing', () => {
    // 15/11/2026 is a Sunday.
    const withSunday = new Set(['2026-11-15']);
    expect(addBusinessHours(sp('2026-11-13T17:30:00'), 1, withSunday)).toEqual(
      sp('2026-11-16T09:30:00'),
    );
  });
});

describe('previsão de fechamento', () => {
  it('accepts only AAAA-MM-DD days that exist on the calendar', () => {
    expect(isoDateSchema.safeParse('2026-11-20').success).toBe(true);
    expect(isoDateSchema.safeParse('2028-02-29').success).toBe(true);
    for (const bad of [
      '2026-02-30',
      '2027-02-29',
      '2026-13-01',
      '2026-11-20T00:00:00Z',
      '20/11/2026',
      '',
    ])
      expect(isoDateSchema.safeParse(bad).success, bad).toBe(false);
  });
  it('is a deal field of its own: alone it is a change, null clears it', () => {
    expect(leadDealUpdateSchema.safeParse({ expectedCloseAt: '2026-11-20' }).success).toBe(true);
    expect(leadDealUpdateSchema.safeParse({ expectedCloseAt: null }).success).toBe(true);
    expect(leadDealUpdateSchema.safeParse({}).success).toBe(false);
  });
  it('today is the local calendar day, and an open deal is overdue only after it', () => {
    const today = localIsoDate(new Date(2026, 9, 5, 23, 30));
    expect(today).toBe('2026-10-05');
    expect(isCloseForecastOverdue({ expectedCloseAt: '2026-10-04', won: null }, today)).toBe(true);
    expect(isCloseForecastOverdue({ expectedCloseAt: '2026-10-05', won: null }, today)).toBe(false);
    expect(isCloseForecastOverdue({ expectedCloseAt: '2026-10-04', won: true }, today)).toBe(false);
  });
});
