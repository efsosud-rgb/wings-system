import { describe, expect, it } from 'vitest';
import { percent, reais, toCsv } from './csv.js';

describe('CSV for a Brazilian spreadsheet', () => {
  it('separates with semicolons and writes decimals with a comma', () => {
    expect(toCsv(['Campanha', 'Gasto'], [['LEAD | FORMS', 45.5]])).toBe(
      'Campanha;Gasto\r\nLEAD | FORMS;45,5',
    );
  });

  it('quotes a cell that holds the separator, a quote or a line break', () => {
    expect(toCsv(['Nome'], [['Reels; 15s'], ['Diz "oi"'], ['duas\nlinhas']])).toBe(
      'Nome\r\n"Reels; 15s"\r\n"Diz ""oi"""\r\n"duas\nlinhas"',
    );
  });

  it('leaves an unknowable figure empty, never zero', () => {
    expect(toCsv(['CPL'], [[reais(null)]])).toBe('CPL\r\n');
    expect(reais(4871)).toBe(48.71);
    expect(percent(1425)).toBe(1.43);
    expect(percent(null)).toBeNull();
  });
});
