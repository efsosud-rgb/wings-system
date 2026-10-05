import { describe, expect, it } from 'vitest';
import { addBusinessHours, nextBusinessInstant } from './crm.js';

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
});
