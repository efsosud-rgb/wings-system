/**
 * CSV, the way spreadsheets write it (RFC 4180 with the Brazilian habit of a
 * `;` separator): quoted fields, doubled quotes, line breaks inside quotes,
 * a BOM at the start. Used by the Funil's import and export; nothing here
 * knows what a column means.
 */

export type CsvDelimiter = ',' | ';' | '\t';

/** The delimiter the first line uses most, `,` when nothing is found. */
export function detectCsvDelimiter(text: string): CsvDelimiter {
  const firstLine = text.slice(0, text.indexOf('\n') === -1 ? undefined : text.indexOf('\n'));
  const candidates: CsvDelimiter[] = [';', ',', '\t'];
  let best: CsvDelimiter = ',';
  let bestCount = 0;
  for (const candidate of candidates) {
    const count = firstLine.split(candidate).length - 1;
    if (count > bestCount) {
      best = candidate;
      bestCount = count;
    }
  }
  return best;
}

/** Rows of fields; an empty trailing line is dropped. */
export function parseCsv(
  text: string,
  delimiter: CsvDelimiter = detectCsvDelimiter(text),
): string[][] {
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let index = 0; index < source.length; index++) {
    const char = source[index]!;
    if (quoted) {
      if (char === '"') {
        if (source[index + 1] === '"') {
          field += '"';
          index++;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"') {
      quoted = true;
    } else if (char === delimiter) {
      row.push(field);
      field = '';
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && source[index + 1] === '\n') index++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += char;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((cells) => cells.some((cell) => cell.trim() !== ''));
}

const needsQuotes = (value: string, delimiter: string) =>
  value.includes(delimiter) || value.includes('"') || value.includes('\n') || value.includes('\r');

/** One line per row, `;` separated (what Excel in pt-BR opens as columns), CRLF endings. */
export function toCsv(
  rows: readonly (readonly (string | number | null)[])[],
  delimiter: CsvDelimiter = ';',
): string {
  return rows
    .map((row) =>
      row
        .map((cell) => {
          const value = cell === null || cell === undefined ? '' : String(cell);
          return needsQuotes(value, delimiter) ? `"${value.replace(/"/g, '""')}"` : value;
        })
        .join(delimiter),
    )
    .join('\r\n');
}

/** Accent- and case-blind header, single spaces, for matching column names. */
export function csvHeaderKey(header: string): string {
  return header
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}
