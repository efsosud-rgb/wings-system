import type { SessionUser } from '@wings/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LoginPage } from './LoginPage.js';

/**
 * Signing in again after a session ended: the screen says why and brings the
 * person back to where they were, never to another site.
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
  permissions: {} as SessionUser['permissions'],
  lastLoginAt: null,
  sessionExpiresAt: new Date(Date.now() + 3600_000).toISOString(),
};

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

function Landed() {
  const location = useLocation();
  return <p data-testid="landed">{`${location.pathname}${location.search}${location.hash}`}</p>;
}

function renderLogin(state?: unknown) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[{ pathname: '/login', state }]}>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/*" element={<Landed />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

async function signIn() {
  fireEvent.change(screen.getByLabelText(/E-mail/), { target: { value: 'p@wingscompany.com.br' } });
  fireEvent.change(screen.getByLabelText(/Senha/), {
    target: { value: 'uma-senha-bem-longa-123' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Entrar' }));
  return screen.findByTestId('landed');
}

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path === '/api/auth/login') return json(200, { user });
      if (path === '/api/auth/me') return json(401, { error: 'unauthenticated' });
      return json(404, { error: 'not_found' });
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('Login after an expired session', () => {
  it('says the session expired when the route gate says so', async () => {
    renderLogin({ from: '/crm-vendas/tarefas', expired: true });
    expect(await screen.findByText('Sua sessão expirou. Entre de novo.')).toBeTruthy();
  });

  it('says nothing about expiry on a plain visit', async () => {
    renderLogin();
    await screen.findByRole('button', { name: 'Entrar' });
    expect(screen.queryByText('Sua sessão expirou. Entre de novo.')).toBeNull();
  });

  it('brings the person back to the screen they were on, query string and fragment included', async () => {
    renderLogin({ from: '/crm-vendas/tarefas?filtro=abertas#topo', expired: true });
    const landed = await signIn();
    expect(landed.textContent).toBe('/crm-vendas/tarefas?filtro=abertas#topo');
  });

  it('goes to the start when there was no screen to return to', async () => {
    renderLogin();
    const landed = await signIn();
    expect(landed.textContent).toBe('/');
  });

  it.each(['//evil.example/phish', 'https://evil.example', '/\\evil.example', '/login'])(
    'never returns to %s',
    async (from) => {
      renderLogin({ from, expired: true });
      const landed = await signIn();
      expect(landed.textContent).toBe('/');
    },
  );

  it('keeps the wrong-password message and does not call it an expired session', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) =>
        String(input) === '/api/auth/login'
          ? json(401, { error: 'invalid_credentials', message: 'E-mail ou senha incorretos' })
          : json(401, { error: 'unauthenticated' }),
      ),
    );
    renderLogin();
    fireEvent.change(screen.getByLabelText(/E-mail/), {
      target: { value: 'p@wingscompany.com.br' },
    });
    fireEvent.change(screen.getByLabelText(/Senha/), {
      target: { value: 'uma-senha-bem-longa-123' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Entrar' }));
    expect(await screen.findByText('E-mail ou senha incorretos')).toBeTruthy();
    expect(screen.queryByText('Sua sessão expirou. Entre de novo.')).toBeNull();
  });
});
