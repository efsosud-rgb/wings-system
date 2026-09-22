/**
 * CSV for Excel in Portuguese: semicolon-separated, a byte-order mark so the
 * accents survive, and numbers as the spreadsheet expects them (comma
 * decimal). Money is exported in reais, not cents, because the file is for a
 * person, not for a program.
 */

export type CsvCell = string | number | null | undefined;

function escape(cell: CsvCell): string {
  if (cell === null || cell === undefined) return '';
  const text = typeof cell === 'number' ? String(cell).replace('.', ',') : cell;
  return /[";\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function toCsv(header: string[], rows: CsvCell[][]): string {
  return [header, ...rows].map((row) => row.map(escape).join(';')).join('\r\n');
}

/** Cents to a reais figure with two decimals, for a numeric cell. */
export function reais(cents: number | null | undefined): number | null {
  return cents === null || cents === undefined ? null : Math.round(cents) / 100;
}

/** Percentage x1000 to a percentage with two decimals. */
export function percent(milli: number | null | undefined): number | null {
  return milli === null || milli === undefined ? null : Math.round(milli / 10) / 100;
}

/** Hands the file to the browser as a download. */
export function downloadCsv(fileName: string, content: string): void {
  const blob = new Blob([`﻿${content}`], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  URL.revokeObjectURL(url);
}
