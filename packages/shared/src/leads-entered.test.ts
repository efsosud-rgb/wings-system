import { describe, expect, it } from 'vitest';
import { LEAD_ENTERED_SOURCE_LABELS, LEAD_ENTERED_SOURCES, resolveLeadEntered } from './leads.js';

const NOW = new Date('2026-10-07T15:00:00.000Z');
const minutes = (n: number) => new Date(NOW.getTime() + n * 60_000);

describe('resolveLeadEntered', () => {
  it("keeps the source's date and whose clock it is", () => {
    const at = minutes(-90);
    expect(
      resolveLeadEntered({ enteredAt: at, enteredAtSource: 'meta_created_time' }, NOW),
    ).toEqual({ enteredAt: at, enteredAtSource: 'meta_created_time' });
  });

  it('falls back to the moment of receipt, marked received, when the source brings nothing usable', () => {
    const received = { enteredAt: NOW, enteredAtSource: 'received' };
    expect(resolveLeadEntered({}, NOW)).toEqual(received);
    expect(resolveLeadEntered({ enteredAt: null, enteredAtSource: 'rd_conversion' }, NOW)).toEqual(
      received,
    );
    // A date with no source named is not trusted.
    expect(resolveLeadEntered({ enteredAt: minutes(-5) }, NOW)).toEqual(received);
    expect(
      resolveLeadEntered({ enteredAt: new Date('x'), enteredAtSource: 'rd_conversion' }, NOW),
    ).toEqual(received);
    // Asking for 'received' with a date is still the receipt time.
    expect(
      resolveLeadEntered({ enteredAt: minutes(-5), enteredAtSource: 'received' }, NOW),
    ).toEqual(received);
  });

  it('refuses a date from the future beyond clock skew and clamps a small skew to now', () => {
    expect(
      resolveLeadEntered({ enteredAt: minutes(120), enteredAtSource: 'form_submitted' }, NOW),
    ).toEqual({ enteredAt: NOW, enteredAtSource: 'received' });
    expect(
      resolveLeadEntered({ enteredAt: minutes(2), enteredAtSource: 'form_submitted' }, NOW),
    ).toEqual({ enteredAt: NOW, enteredAtSource: 'form_submitted' });
  });

  it('has a plain-language label for every source', () => {
    for (const source of LEAD_ENTERED_SOURCES) {
      expect(LEAD_ENTERED_SOURCE_LABELS[source].length).toBeGreaterThan(3);
    }
    expect(LEAD_ENTERED_SOURCE_LABELS.received).toBe('recebido pelo sistema');
  });
});
