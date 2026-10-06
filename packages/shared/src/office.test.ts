import { describe, expect, it } from 'vitest';
import {
  officeClock,
  officeDayStart,
  officeDisplayNames,
  officeLightAt,
  officeZoneOf,
} from './office.js';

describe('escritório virtual', () => {
  it('reads the clock in Rio', () => {
    expect(officeClock(new Date('2026-10-06T15:05:00Z'))).toEqual({ hour: 12, minute: 5 });
    expect(officeClock(new Date('2026-10-07T02:30:00Z'))).toEqual({ hour: 23, minute: 30 });
  });

  it('starts the day at midnight in Rio', () => {
    expect(officeDayStart(new Date('2026-10-06T15:05:00Z')).toISOString()).toBe(
      '2026-10-06T03:00:00.000Z',
    );
    expect(officeDayStart(new Date('2026-10-07T02:30:00Z')).toISOString()).toBe(
      '2026-10-06T03:00:00.000Z',
    );
  });

  it('lights the office by the hour', () => {
    expect(officeLightAt(7)).toBe('manha');
    expect(officeLightAt(12)).toBe('dia');
    expect(officeLightAt(17, 30)).toBe('por_do_sol');
    expect(officeLightAt(22)).toBe('noite');
    expect(officeLightAt(3)).toBe('noite');
  });

  it('names people by first name, adding an initial only when two share it', () => {
    const names = officeDisplayNames([
      { id: 'a', fullName: 'Ana Souza Lima' },
      { id: 'b', fullName: 'Bruno Costa' },
      { id: 'c', fullName: 'Ana Pereira' },
    ]);
    expect(names.get('a')).toBe('Ana S.');
    expect(names.get('b')).toBe('Bruno');
    expect(names.get('c')).toBe('Ana P.');
  });

  it('seats the Formatação parent sector in Processos e Projetos', () => {
    expect(officeZoneOf('formatacao')).toBe('formatacao-processos-projetos');
    expect(officeZoneOf('comercial')).toBe('comercial');
  });
});
