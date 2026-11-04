import type { ProspectSearchItem } from '@wings/shared';
import { act, render, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../api/client.js';
import { useInstagramFinder } from './ProspectInstagramFind.js';

const post = vi.fn();
vi.mock('../../api/client.js', async (original) => ({
  ...(await original<typeof import('../../api/client.js')>()),
  api: { post: (path: string, body?: unknown) => post(path, body) },
}));

/**
 * t090: a chunk that fails in the middle must give back to the queue every company still without
 * an answer, not only its own five, or the ones after it say "procurando…" forever.
 */

const company = (n: number) =>
  ({
    placeId: `ChIJ_fake_place_${n}`,
    name: `Empresa Exemplo ${n}`,
    instagram: null,
    instagramFind: `find-${n}`,
  }) as unknown as ProspectSearchItem;

function Probe({ items }: { items: ProspectSearchItem[] }) {
  useInstagramFinder(items);
  return null;
}

const tickets = () =>
  post.mock.calls.map(([, body]) =>
    (body as { items: { ticket: string }[] }).items.map((item) => item.ticket),
  );

describe('the Instagram finder queue', () => {
  it('gives every company without an answer back to a new search, the later chunks included', async () => {
    // Seven without an @: a first chunk of five, then a second of two (INSTAGRAM_FIND_MAX).
    const items = [1, 2, 3, 4, 5, 6, 7].map(company);
    // The first chunk answers for four of its five, the second chunk fails, the new search answers.
    const answers: unknown[] = [
      {
        items: [1, 2, 3, 4].map((n) => ({
          placeId: items[n - 1]!.placeId,
          instagram: null,
          miss: null,
        })),
      },
      'fail',
      { items: [] },
    ];
    post.mockImplementation(async () => {
      const answer = answers.shift();
      if (answer === 'fail') throw new ApiError(500, { error: 'x', message: 'x' });
      return answer;
    });
    const { rerender } = render(<Probe items={items} />);
    await waitFor(() => expect(post).toHaveBeenCalledTimes(2));
    await act(async () => {});
    // A new search asks again everyone still without an answer: five (failed chunk) and six, seven.
    rerender(<Probe items={[...items]} />);
    await waitFor(() => expect(post).toHaveBeenCalledTimes(3));
    expect(tickets()).toEqual([
      ['find-1', 'find-2', 'find-3', 'find-4', 'find-5'],
      ['find-6', 'find-7'],
      ['find-5', 'find-6', 'find-7'],
    ]);
  });
});
