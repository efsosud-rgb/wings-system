import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { sessionKey, useLogout } from './auth.js';
import { onUnauthorized, reportUnauthorized } from './session-expiry.js';

/** "Sair" is the person leaving: nothing it meets on the way is a session that expired. */

afterEach(() => {
  cleanup();
  onUnauthorized(null);
  vi.unstubAllGlobals();
});

function mount() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queryClient.setQueryData(sessionKey, { employeeId: 'emp-1' });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return { queryClient, ...renderHook(() => useLogout(), { wrapper }) };
}

describe('signing out', () => {
  it('ignores a 401 reported while the request is on its way, and listens again after', async () => {
    const guard = vi.fn();
    onUnauthorized(guard);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        reportUnauthorized(); // the stream or a slow ask meeting the revoked session
        return new Response('{"ok":true}', { status: 200 });
      }),
    );
    const { result } = mount();
    await act(async () => {
      await result.current.mutateAsync();
    });
    expect(guard).not.toHaveBeenCalled();

    reportUnauthorized();
    expect(guard).toHaveBeenCalledTimes(1);
  });

  it('takes a 401 on the logout itself as already signed out, not as a failure', async () => {
    const guard = vi.fn();
    onUnauthorized(guard);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{"error":"unauthenticated"}', { status: 401 })),
    );
    const { result, queryClient } = mount();
    await act(async () => {
      await result.current.mutateAsync();
    });
    expect(result.current.isSuccess).toBe(true);
    expect(guard).not.toHaveBeenCalled();
    expect(queryClient.getQueryData(sessionKey)).toBeUndefined();
  });

  it('still fails on a real error, and listens again', async () => {
    const guard = vi.fn();
    onUnauthorized(guard);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{"error":"boom"}', { status: 500 })),
    );
    const { result } = mount();
    await act(async () => {
      await result.current.mutateAsync().catch(() => undefined);
    });
    expect(result.current.isError).toBe(true);
    reportUnauthorized();
    expect(guard).toHaveBeenCalledTimes(1);
  });
});
