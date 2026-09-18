import type { SessionUser } from '@wings/shared';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * The gap this closes: `ProtectedRoute` only asks whether you are signed in.
 * Anyone could type a path they had no permission for and watch the screen
 * mount and fill with errors — nothing leaked, because the API refused every
 * call, but the page looked broken instead of honest.
 */

const session: { current: SessionUser | null; loading: boolean } = {
  current: null,
  loading: false,
};

vi.mock('../api/auth.js', () => ({
  useSession: () => ({ data: session.current, isLoading: session.loading }),
  hasPermission: (user: SessionUser | null, permission: string) =>
    Boolean(user?.permissions[permission as keyof SessionUser['permissions']]),
}));

const { RequirePermission } = await import('./RequirePermission.js');

function user(permissions: Record<string, string>): SessionUser {
  return {
    employeeId: 'emp-1',
    fullName: 'Pessoa',
    email: 'p@wingscompany.com.br',
    cargo: 'Cargo',
    role: 'marketing',
    sector: 'marketing',
    isSectorManager: false,
    tracksTime: true,
    permissions: permissions as SessionUser['permissions'],
    lastLoginAt: null,
    sessionExpiresAt: new Date(Date.now() + 3600_000).toISOString(),
  };
}

function renderGate(permission: 'employees.read' | 'ads.read') {
  render(
    <MemoryRouter>
      <RequirePermission permission={permission}>
        <div>conteúdo protegido</div>
      </RequirePermission>
    </MemoryRouter>,
  );
}

afterEach(() => {
  cleanup();
  session.current = null;
  session.loading = false;
});

describe('the permission gate', () => {
  it('renders the screen when the permission is held', () => {
    session.current = user({ 'ads.read': 'all' });
    renderGate('ads.read');
    expect(screen.getByText('conteúdo protegido')).toBeTruthy();
  });

  it('replaces the screen with a plain refusal when it is not', () => {
    session.current = user({ 'ads.read': 'all' });
    renderGate('employees.read');

    expect(screen.queryByText('conteúdo protegido')).toBeNull();
    expect(screen.getByText('Sem acesso')).toBeTruthy();
    // It says how access is granted, so nobody files a bug about a blank page.
    expect(screen.getByText(/concedido por\s+papel/)).toBeTruthy();
  });

  it('waits rather than flashing a refusal while the session loads', () => {
    session.loading = true;
    renderGate('ads.read');
    expect(screen.getByText('Carregando…')).toBeTruthy();
    expect(screen.queryByText('Sem acesso')).toBeNull();
  });

  it('refuses an anonymous viewer', () => {
    renderGate('ads.read');
    expect(screen.getByText('Sem acesso')).toBeTruthy();
  });
});
