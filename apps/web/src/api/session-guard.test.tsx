import type { SessionUser } from '@wings/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProtectedRoute } from '../components/ProtectedRoute.js';
import { api } from './client.js';
import { clearSessionExpired, onUnauthorized } from './session-expiry.js';
import { installSessionGuard } from './session-guard.js';
import { useRingingCalls } from './whatsapp.js';

/**
 * The reported defect, end to end with the real hooks: a tab stays open, the
 * session dies on the server, and the screen used to keep asking for the ringing
 * calls every three seconds (5 000+ answers of 401 in a night) while showing
 * what it had loaded the day before. Now the first 401 signs the tab out, the
 * route gate sends it to the login with the address it was on, and nothing asks again.
 */

const user: SessionUser = {
  employeeId: 'emp-1',
  fullName: 'Pessoa',
  email: 'p@wingscompany.com.br',
  cargo: 'Cargo',
  role: 'marketing',
  sector: 'marketing',
  isSectorManager: false,
  tracksTime: true,
  permissions: { 'leads.whatsapp': 'all' } as SessionUser['permissions'],
  lastLoginAt: null,
  sessionExpiresAt: new Date(Date.now() + 3600_000).toISOString(),
};

interface Call {
  path: string;
  passive: boolean;
}

const server = { alive: true, calls: [] as Call[] };

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

function stubServer() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input).replace(/^\/api/, '');
      const headers = (init?.headers ?? {}) as Record<string, string>;
      server.calls.push({ path, passive: headers['x-wings-passive'] === '1' });
      if (!server.alive) {
        return json(401, { error: 'session_expired', message: 'Sessão expirada' });
      }
      if (path === '/auth/me') return json(200, { user });
      if (path === '/whatsapp/calls/ringing') return json(200, { calling: true, calls: [] });
      return json(404, { error: 'not_found' });
    }),
  );
}

const callsTo = (path: string) => server.calls.filter((call) => call.path === path);

/** A shell with the periodic query that caused the report. */
function RingingShell() {
  const ringing = useRingingCalls(true);
  return <p>{ringing.data?.calling ? 'linha de ligação ativa' : 'sem dados'}</p>;
}

/** A shell with no periodic query at all. */
function StaticShell() {
  return <p>tela parada</p>;
}

function LoginProbe() {
  const location = useLocation();
  return <pre data-testid="login">{JSON.stringify(location.state)}</pre>;
}

function renderTab(shell: ReactNode, queryClient: QueryClient) {
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/crm-vendas/tarefas?filtro=abertas#topo']}>
        <Routes>
          <Route path="/login" element={<LoginProbe />} />
          <Route path="/*" element={<ProtectedRoute>{shell}</ProtectedRoute>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const settle = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });

const loginState = () => JSON.parse(screen.getByTestId('login').textContent ?? 'null');

let queryClient: QueryClient;
let removeGuard: () => void;

beforeEach(() => {
  vi.useFakeTimers();
  server.alive = true;
  server.calls = [];
  localStorage.clear();
  clearSessionExpired();
  stubServer();
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
  });
  removeGuard = installSessionGuard(queryClient);
});

afterEach(() => {
  cleanup();
  removeGuard();
  onUnauthorized(null);
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('an open tab whose session died', () => {
  it('stops asking at the first 401, goes to the login and remembers where the person was', async () => {
    renderTab(<RingingShell />, queryClient);
    await settle(10);
    expect(screen.getByText('linha de ligação ativa')).toBeTruthy();
    expect(callsTo('/whatsapp/calls/ringing')).toHaveLength(1);

    // The server ends the session (idle timeout); the tab does not know yet.
    server.alive = false;
    await settle(3_100);

    expect(callsTo('/whatsapp/calls/ringing')).toHaveLength(2); // the one that found out
    expect(loginState()).toEqual({
      from: '/crm-vendas/tarefas?filtro=abertas#topo',
      expired: true,
    });

    // A night later: not one more request.
    const total = server.calls.length;
    await settle(8 * 60 * 60 * 1000);
    expect(server.calls).toHaveLength(total);
  });

  it('shows nothing of the old screen once signed out', async () => {
    renderTab(<RingingShell />, queryClient);
    await settle(10);
    server.alive = false;
    await settle(3_100);
    expect(screen.queryByText('linha de ligação ativa')).toBeNull();
  });

  it('is told the same by any other request, not only the ringing line', async () => {
    renderTab(<StaticShell />, queryClient);
    await settle(10);
    expect(screen.getByText('tela parada')).toBeTruthy();

    server.alive = false;
    await act(async () => {
      await api.get('/crm/tasks?status=open').catch(() => undefined);
      await vi.advanceTimersByTimeAsync(10);
    });

    expect(loginState().expired).toBe(true);
  });
});

describe('a visitor who was never signed in', () => {
  it('goes to the login without a notice about an expired session', async () => {
    server.alive = false;
    renderTab(<StaticShell />, queryClient);
    await settle(10);

    expect(loginState()).toEqual({ from: '/crm-vendas/tarefas?filtro=abertas#topo' });
  });
});

describe('a tab reloaded after the session died', () => {
  it('says the session expired when this browser had one', async () => {
    localStorage.setItem('wings:signed-in', '1');
    server.alive = false;
    renderTab(<StaticShell />, queryClient);
    await settle(10);

    expect(loginState()).toEqual({
      from: '/crm-vendas/tarefas?filtro=abertas#topo',
      expired: true,
    });
  });
});

describe('a tab that comes back to the front', () => {
  const show = () => {
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  };

  it('checks the session once, passively, and signs out when it is gone', async () => {
    renderTab(<StaticShell />, queryClient);
    await settle(10);
    expect(callsTo('/auth/me')).toHaveLength(1);

    server.alive = false;
    await settle(31_000);
    await act(async () => {
      show();
      await vi.advanceTimersByTimeAsync(10);
    });

    const probe = callsTo('/auth/me');
    expect(probe).toHaveLength(2);
    expect(probe[1]?.passive).toBe(true);
    expect(loginState().expired).toBe(true);
  });

  it('does not check again within 30 seconds', async () => {
    renderTab(<StaticShell />, queryClient);
    await settle(31_000);
    const before = callsTo('/auth/me').length;

    await act(async () => {
      show();
      show();
      show();
      await vi.advanceTimersByTimeAsync(10);
    });

    expect(callsTo('/auth/me')).toHaveLength(before + 1);
  });

  it('does not check anything when nobody is signed in', async () => {
    server.alive = false;
    renderTab(<StaticShell />, queryClient);
    await settle(31_000);
    const before = server.calls.length;

    await act(async () => {
      show();
      await vi.advanceTimersByTimeAsync(10);
    });

    expect(server.calls).toHaveLength(before);
  });
});
