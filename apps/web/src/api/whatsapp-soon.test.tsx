import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useWhatsAppSoon } from './whatsapp.js';

/**
 * Whether a seller's WhatsApp send and call are "em breve" (Eric, 19/10): true for a seller
 * (`leads.whatsapp` not "all") until the official number is known to be live, and only a seller
 * asks the server. `fetch` is a stub.
 */

const state = vi.hoisted(() => ({
  permissions: {} as Record<string, string>,
  asked: [] as string[],
  live: false,
  hold: null as null | Promise<void>,
}));

vi.mock('./auth.js', async () => {
  const actual = await vi.importActual<typeof import('./auth.js')>('./auth.js');
  return {
    ...actual,
    useSession: () => ({ data: { id: 'e1', role: 'vendedor', permissions: state.permissions } }),
  };
});

beforeEach(() => {
  state.asked = [];
  state.live = false;
  state.hold = null;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      state.asked.push(String(input));
      if (state.hold) await state.hold;
      return new Response(JSON.stringify({ live: state.live }), { status: 200 });
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const mount = () => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return renderHook(() => useWhatsAppSoon(), { wrapper });
};

describe('useWhatsAppSoon', () => {
  it('is true for a seller while the number is not live', async () => {
    state.permissions = { 'leads.whatsapp': 'own' };
    const { result } = mount();
    await waitFor(() => expect(state.asked).toHaveLength(1));
    expect(result.current).toBe(true);
  });

  it('is true for a seller while the answer is still loading (not known is not live)', () => {
    state.permissions = { 'leads.whatsapp': 'own' };
    let release = () => {};
    state.hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { result } = mount();
    expect(result.current).toBe(true);
    release();
  });

  it('turns false for a seller once the number is live', async () => {
    state.permissions = { 'leads.whatsapp': 'own' };
    state.live = true;
    const { result } = mount();
    await waitFor(() => expect(result.current).toBe(false));
  });

  it('is true for a seller whose scope is the sector, only "all" is free', async () => {
    state.permissions = { 'leads.whatsapp': 'sector' };
    const { result } = mount();
    await waitFor(() => expect(state.asked).toHaveLength(1));
    expect(result.current).toBe(true);
  });

  it('is false for scope "all" without asking the server', () => {
    state.permissions = { 'leads.whatsapp': 'all' };
    const { result } = mount();
    expect(result.current).toBe(false);
    expect(state.asked).toHaveLength(0);
  });
});
