import type { SessionUser } from '@wings/shared';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The sidebar is generated from the navigation tree, so these tests guard the
 * two properties that matter: nothing appears that the viewer cannot reach,
 * and nothing that is unbuilt pretends otherwise.
 */

const session: { current: SessionUser | null } = { current: null };

vi.mock('../api/auth.js', () => ({
  useSession: () => ({ data: session.current, isLoading: false }),
  useLogout: () => ({ mutateAsync: vi.fn(), isPending: false }),
  hasPermission: (user: SessionUser | null, permission: string) =>
    Boolean(user?.permissions[permission as keyof SessionUser['permissions']]),
}));

const { AppShell } = await import('./AppShell.js');

function makeUser(overrides: Partial<SessionUser> = {}): SessionUser {
  return {
    employeeId: 'emp-1',
    fullName: 'Quem Olha',
    email: 'quem@wingscompany.com.br',
    cargo: 'Cargo',
    role: 'marketing',
    sector: 'marketing',
    isSectorManager: false,
    tracksTime: true,
    permissions: { 'ads.read': 'all' },
    lastLoginAt: null,
    sessionExpiresAt: new Date(Date.now() + 3600_000).toISOString(),
    ...overrides,
  };
}

function renderShell(path = '/marketing/trafego-pago-wings') {
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="*" element={<AppShell />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  session.current = makeUser();
});

afterEach(() => {
  cleanup();
});

describe('which modules appear', () => {
  it('shows the module containing the current screen, expanded', () => {
    renderShell();
    expect(screen.getByRole('button', { name: /Marketing/ })).toBeTruthy();
    // Its sub-modules are visible because the active module starts open.
    expect(screen.getByRole('link', { name: /Agente de Tráfego Pago — Wings/ })).toBeTruthy();
  });

  it('hides a module the viewer cannot reach at all', () => {
    renderShell();
    // Marketing holds only ads.read, so Administração is entirely absent.
    expect(screen.queryByRole('button', { name: /Administração/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /SaaS/ })).toBeNull();
  });

  it('shows SaaS to Admin Master only', () => {
    session.current = makeUser({
      role: 'admin_master',
      permissions: { 'ads.read': 'all', 'employees.read': 'all' },
    });
    renderShell();
    expect(screen.getByRole('button', { name: /SaaS/ })).toBeTruthy();
  });

  it('collapses and expands a module on click', () => {
    renderShell();
    const marketing = screen.getByRole('button', { name: /Marketing/ });
    expect(marketing.getAttribute('aria-expanded')).toBe('true');

    fireEvent.click(marketing);
    expect(marketing.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('link', { name: /Copywriter/ })).toBeNull();

    fireEvent.click(marketing);
    expect(screen.getByRole('link', { name: /Copywriter/ })).toBeTruthy();
  });
});

describe('sub-modules without a backend', () => {
  it('shows them, marked, rather than hiding them', () => {
    renderShell();
    // Copywriter has no backend; it is present and labelled, so the shape of
    // the system is visible without pretending it is finished.
    const copywriter = screen.getByRole('link', { name: /Copywriter/ });
    expect(copywriter.className).toContain('menu-item-soon');
    expect(copywriter.textContent).toContain('em breve');
  });

  it('does not mark a screen that actually exists', () => {
    renderShell();
    const studio = screen.getByRole('link', { name: /Agente de Tráfego Pago — Wings/ });
    expect(studio.className).not.toContain('menu-item-soon');
    expect(studio.textContent).not.toContain('em breve');
  });
});

describe('the old flat menu is gone', () => {
  it('no longer offers "Tráfego pago" at the first level', () => {
    session.current = makeUser({
      role: 'admin_master',
      permissions: { 'ads.read': 'all', 'employees.read': 'all', 'timeclock.read': 'all' },
    });
    renderShell();

    // It moved under Marketing; a first-level entry would mean the old menu
    // survived the migration.
    expect(screen.queryByRole('link', { name: 'Tráfego pago' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Funcionários' })).toBeNull();
  });
});

describe('the brand', () => {
  it('is the Wings mark, named for screen readers', () => {
    renderShell();

    const mark = screen.getByRole('img', { name: 'Wings System' });
    expect(mark.getAttribute('src')).toBe('/brand/wings-logo-mark.png');
  });
});
