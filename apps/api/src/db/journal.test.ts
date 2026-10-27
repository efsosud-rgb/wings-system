import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * drizzle applies only the journal entries newer than the last one applied (by `when`), and
 * skips older ones without a word. Two branches merged in the wrong order would leave a
 * migration never run on staging and production, while CI (a fresh database) stays green.
 */
describe('the migrations journal', () => {
  it('has `when` strictly increasing in entry order', () => {
    const journal = JSON.parse(
      readFileSync(resolve(import.meta.dirname, '../../migrations/meta/_journal.json'), 'utf8'),
    ) as { entries: { tag: string; when: number }[] };
    const backwards = journal.entries
      .filter((entry, i) => i > 0 && entry.when <= journal.entries[i - 1]!.when)
      .map((entry) => entry.tag);
    expect(backwards).toEqual([]);
  });
});
