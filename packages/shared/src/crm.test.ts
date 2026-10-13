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

describe('business hours (Mon–Fri, 9h–18h São Paulo)', () => {
  it('counts only working time: 1 hour inside the day is one hour', () => {
    expect(addBusinessHours(sp('2026-10-06T10:00:00'), 1)).toEqual(sp('2026-10-06T11:00:00'));
  });
  it('a lead at 17h30 on Friday is due Monday 9h30', () => {
    expect(addBusinessHours(sp('2026-10-09T17:30:00'), 1)).toEqual(sp('2026-10-12T09:30:00'));
  });
  it('a lead on Saturday waits for Monday 9h and the hour starts then', () => {
    expect(addBusinessHours(sp('2026-10-10T15:00:00'), 1)).toEqual(sp('2026-10-12T10:00:00'));
  });
  it('a lead before 9h on a workday starts at 9h', () => {
    expect(nextBusinessInstant(sp('2026-10-07T07:15:00'))).toEqual(sp('2026-10-07T09:00:00'));
    expect(addBusinessHours(sp('2026-10-07T07:15:00'), 1)).toEqual(sp('2026-10-07T10:00:00'));
  });
  it('spans several days for long SLAs', () => {
    // 24 working hours from Monday 9h = Wednesday 15h (9h/day).
    expect(addBusinessHours(sp('2026-10-05T09:00:00'), 24)).toEqual(sp('2026-10-07T15:00:00'));
  });
  it('exactly at 18h is after hours', () => {
    expect(addBusinessHours(sp('2026-10-06T18:00:00'), 1)).toEqual(sp('2026-10-07T10:00:00'));
  });
  it('isBusinessInstant: inside the working day only', () => {
    expect(isBusinessInstant(sp('2026-10-06T09:00:00'))).toBe(true);
    expect(isBusinessInstant(sp('2026-10-06T17:59:59'))).toBe(true);
    expect(isBusinessInstant(sp('2026-10-06T18:00:00'))).toBe(false);
    expect(isBusinessInstant(sp('2026-10-06T08:59:59'))).toBe(false);
    expect(isBusinessInstant(sp('2026-10-10T12:00:00'))).toBe(false); // Saturday
    expect(isBusinessInstant(sp('2026-10-11T12:00:00'))).toBe(false); // Sunday
  });
});

describe('end of the business day (when an overdue first contact reaches the manager)', () => {
  it('a deadline during the day closes that same day at 18h', () => {
    expect(endOfBusinessDay(sp('2026-10-06T11:00:00'))).toEqual(sp('2026-10-06T18:00:00'));
    expect(endOfBusinessDay(sp('2026-10-06T09:00:00'))).toEqual(sp('2026-10-06T18:00:00'));
    expect(endOfBusinessDay(sp('2026-10-06T17:59:30'))).toEqual(sp('2026-10-06T18:00:00'));
  });
  it('a deadline on the 18h close itself, or after it, closes the next workday', () => {
    expect(endOfBusinessDay(sp('2026-10-06T18:00:00'))).toEqual(sp('2026-10-07T18:00:00'));
    expect(endOfBusinessDay(sp('2026-10-06T22:00:00'))).toEqual(sp('2026-10-07T18:00:00'));
  });
  it('a deadline before 9h counts the day it falls on', () => {
    expect(endOfBusinessDay(sp('2026-10-07T07:15:00'))).toEqual(sp('2026-10-07T18:00:00'));
  });
  it('skips the weekend: Friday evening and Saturday close on Monday', () => {
    expect(endOfBusinessDay(sp('2026-10-09T18:00:00'))).toEqual(sp('2026-10-12T18:00:00'));
    expect(endOfBusinessDay(sp('2026-10-10T12:00:00'))).toEqual(sp('2026-10-12T18:00:00'));
    expect(endOfBusinessDay(sp('2026-10-11T23:59:00'))).toEqual(sp('2026-10-12T18:00:00'));
  });
  it('is always a workday close, strictly after its input', () => {
    // A lead at Friday 17h30 is due Monday 9h30; the manager hears at Monday 18h.
    const due = addBusinessHours(sp('2026-10-09T17:30:00'), 1);
    expect(endOfBusinessDay(due)).toEqual(sp('2026-10-12T18:00:00'));
    expect(endOfBusinessDay(due).getTime()).toBeGreaterThan(due.getTime());
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
