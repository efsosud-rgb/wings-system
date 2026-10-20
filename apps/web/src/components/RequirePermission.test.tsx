import {
  ALL_SUBMODULES,
  ROLE_PERMISSIONS,
  type NavSubmodule,
  type SessionUser,
} from '@wings/shared';
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

const { RequirePermission, RequireSubmodule } = await import('./RequirePermission.js');

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

/**
 * Every sub-module route sits behind RequireSubmodule (router.tsx): an address
 * typed by hand opens only what the menu would have offered (Eric, 13/10).
 */
describe('the sub-module gate', () => {
  const sofia = ALL_SUBMODULES.find((s) => s.path === '/crm-vendas/sofia');
  const placeholder = ALL_SUBMODULES.find((s) => s.path === '/contratos/cof');
  if (!sofia || !placeholder) throw new Error('navigation changed');

  function renderSubmodule(submodule: NavSubmodule) {
    render(
      <MemoryRouter>
        <RequireSubmodule submodule={submodule}>
          <div>conteúdo protegido</div>
        </RequireSubmodule>
      </MemoryRouter>,
    );
  }

  it('shows "Sem acesso" to a seller who types the Sofia address', () => {
    session.current = user(ROLE_PERMISSIONS.vendedor_expansao as Record<string, string>);
    renderSubmodule(sofia);
    expect(screen.getByRole('heading', { name: 'Sem acesso' })).toBeTruthy();
    expect(screen.queryByText('conteúdo protegido')).toBeNull();
  });

  it('shows "Sem acesso" on an "em breve" placeholder to a seller', () => {
    session.current = user(ROLE_PERMISSIONS.vendedor_formatacao as Record<string, string>);
    renderSubmodule(placeholder);
    expect(screen.getByRole('heading', { name: 'Sem acesso' })).toBeTruthy();
  });

  // Eric, 19/10: the two screens marked `sellers` open to a seller who types the address; the
  // others of Produtividade stay shut, and so does a seller's typed address outside the CRM.
  it('opens Agenda and Reuniões to a seller by address, and keeps the Drive and the Dashboard shut', () => {
    for (const role of ['vendedor_expansao', 'vendedor_formatacao'] as const) {
      session.current = {
        ...user(ROLE_PERMISSIONS[role] as Record<string, string>),
        role,
        sector: 'comercial',
      };
      for (const path of ['/produtividade/agenda', '/produtividade/reunioes']) {
        renderSubmodule(ALL_SUBMODULES.find((s) => s.path === path)!);
        expect(screen.getByText('conteúdo protegido'), `${role} ${path}`).toBeTruthy();
        cleanup();
      }
      for (const path of ['/produtividade/drive', '/dashboard/vendas']) {
        renderSubmodule(ALL_SUBMODULES.find((s) => s.path === path)!);
        expect(screen.getByRole('heading', { name: 'Sem acesso' }), `${role} ${path}`).toBeTruthy();
        cleanup();
      }
    }
  });

  it('opens both to the Admin Master', () => {
    session.current = user(ROLE_PERMISSIONS.admin_master as Record<string, string>);
    renderSubmodule(placeholder);
    expect(screen.getByText('conteúdo protegido')).toBeTruthy();
  });
});
