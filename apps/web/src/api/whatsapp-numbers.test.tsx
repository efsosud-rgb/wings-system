import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useConnectWhatsAppNumber, useWhatsAppNumbers } from './whatsapp-numbers.js';

/**
 * After Meta's window, the numbers screen shows the connected number without a reload: the
 * connection, ok or refused, reads the list again. `fetch` is a stub; made-up ids only.
 */

let asked: string[] = [];
beforeEach(() => {
  asked = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      asked.push(`${init?.method ?? 'GET'} ${url}`);
      if (url.endsWith('/connect'))
        return new Response(JSON.stringify({ error: 'busy', message: 'x' }), { status: 409 });
      return new Response(JSON.stringify({ signup: null, missing: [], numbers: [], people: [] }));
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('useConnectWhatsAppNumber', () => {
  it('reads the list again after the connection, even when it fails', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(
      () => ({ list: useWhatsAppNumbers(), connect: useConnectWhatsAppNumber() }),
      { wrapper },
    );
    await waitFor(() => expect(result.current.list.isSuccess).toBe(true));
    await act(async () => {
      await result.current.connect
        .mutateAsync({
          code: 'c',
          wabaId: '3100000000000001',
          numberId: '00000000-0000-4000-8000-000000000001',
        })
        .catch(() => undefined);
    });
    await waitFor(() =>
      expect(asked).toEqual([
        'GET /api/whatsapp/numbers',
        'POST /api/whatsapp/numbers/connect',
        'GET /api/whatsapp/numbers',
      ]),
    );
  });
});
