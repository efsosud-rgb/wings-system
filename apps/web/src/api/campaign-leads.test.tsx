import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useCampaignLeads } from './campaign-leads.js';

/** Leads das Campanhas refreshes itself every minute: a passive read, never the person's activity. */

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('Leads das Campanhas polling', () => {
  it('reads the list as a passive request, so an open tab never keeps the session alive', async () => {
    const fetchMock = vi.fn(async () => new Response('{"leads":[]}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(() => useCampaignLeads(), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/campaign-leads');
    expect(new Headers(init.headers).get('x-wings-passive')).toBe('1');
  });
});
