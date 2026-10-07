import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { EnteredAt } from './EnteredAt.js';
import { formatEntered, formatEnteredShort } from './format.js';

afterEach(cleanup);

describe('the entry date of a lead', () => {
  it('is written dd/mm/aaaa às hh:mm in Brasília time', () => {
    // 17:32 UTC is 14:32 in Brasília (UTC-3, no daylight saving time).
    expect(formatEntered('2026-10-07T17:32:00.000Z')).toBe('07/10/2026 às 14:32');
    expect(formatEnteredShort('2026-10-07T17:32:00.000Z')).toBe('07/10/2026 14:32');
    // Just after midnight in Brasília is still the day before in UTC.
    expect(formatEntered('2026-10-08T03:05:00.000Z')).toBe('08/10/2026 às 00:05');
    expect(formatEntered(null)).toBe('—');
  });

  it("names the source's clock and shows no warning when the source brought the date", () => {
    render(<EnteredAt at="2026-10-07T17:32:00.000Z" source="meta_created_time" />);
    expect(screen.getByText(/07\/10\/2026 às 14:32/).getAttribute('title')).toBe(
      'Data da fonte: data de criação do lead na Meta',
    );
    expect(screen.queryByText(/recebido pelo sistema/)).toBeNull();
  });

  it('says "recebido pelo sistema" when the source brought no date', () => {
    render(<EnteredAt at="2026-10-07T17:32:00.000Z" source="received" />);
    expect(screen.getByText(/recebido pelo sistema/)).toBeTruthy();
    expect(screen.getByText(/07\/10\/2026 às 14:32/).getAttribute('title')).toContain(
      'a fonte não trouxe a data'.replace('a fonte', 'A fonte'),
    );
  });
});
