import type { ReactNode } from 'react';
import type { SessionUser } from '@wings/shared';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The sidebar is generated from the navigation tree, so these tests guard the
 * two properties that matter: nothing appears that the viewer cannot reach,
 * and nothing that is unbuilt pretends otherwise.
 */

const session: { current: SessionUser | null } = { current: null };

// The WhatsApp call center has its own tests; here it only wraps the screen.
vi.mock('../pages/crm/WhatsAppCalls.js', () => ({
  WhatsAppCallProvider: ({ children }: { children: ReactNode }) => children,
}));

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
    // modules.preview shows the "em breve" placeholders these shell tests look at.
    permissions: { 'ads.read': 'all', 'modules.preview': 'all' },
    lastLoginAt: null,
    sessionExpiresAt: new Date(Date.now() + 3600_000).toISOString(),
    ...overrides,
  };
}

/** The side menu alone: the top bar also names the person's role, which can read like a module. */
const menu = () => within(screen.getByRole('navigation', { name: 'Módulos' }));

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
    expect(menu().getByRole('button', { name: /Marketing/ })).toBeTruthy();
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
      permissions: { 'ads.read': 'all', 'employees.read': 'all', 'modules.preview': 'all' },
    });
    renderShell();
    expect(screen.getByRole('button', { name: /SaaS/ })).toBeTruthy();
  });

  it('collapses and expands a module on click', () => {
    renderShell();
    const marketing = menu().getByRole('button', { name: /Marketing/ });
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
      permissions: {
        'ads.read': 'all',
        'employees.read': 'all',
        'timeclock.read': 'all',
        'modules.preview': 'all',
      },
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

    // The official logo (brand/SidebarLogo) sits in the slot and names itself.
    const slot = document.getElementById('wings-logo-slot');
    expect(slot).not.toBeNull();
    expect(within(slot as HTMLElement).getByRole('img', { name: /Wings/ })).toBeTruthy();
  });
});

describe('on a phone, the menu is a drawer behind ☰', () => {
  const toggle = () => screen.getByRole('button', { name: 'Menu' });
  const shell = () => document.querySelector('.shell') as HTMLElement;
  const main = () => document.querySelector('.shell-main') as HTMLElement;

  afterEach(() => {
    document.body.style.overflow = '';
    vi.unstubAllGlobals();
  });

  it('starts closed, with the button pointing at the menu it opens', () => {
    renderShell();
    expect(toggle().getAttribute('aria-expanded')).toBe('false');
    const sidebar = document.getElementById(toggle().getAttribute('aria-controls') ?? '');
    expect(sidebar?.tagName).toBe('ASIDE');
    expect(
      within(sidebar as HTMLElement).getByRole('navigation', { name: 'Módulos' }),
    ).toBeTruthy();
    expect(shell().classList.contains('is-menu-open')).toBe(false);
    expect(main().hasAttribute('inert')).toBe(false);
    expect(document.querySelector('.sidebar-backdrop')).toBeNull();
  });

  it('opens over the page: focus in the menu, the page neither scrolls nor takes focus', () => {
    renderShell();
    fireEvent.click(toggle());

    expect(toggle().getAttribute('aria-expanded')).toBe('true');
    expect(shell().classList.contains('is-menu-open')).toBe(true);
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Fechar menu' }));
    expect(document.body.style.overflow).toBe('hidden');
    expect(main().hasAttribute('inert')).toBe(true);
    expect(document.querySelector('.sidebar-backdrop')).not.toBeNull();
  });

  it('closes on Escape and gives focus back to ☰', () => {
    renderShell();
    fireEvent.click(toggle());
    fireEvent.keyDown(document, { key: 'Escape' });

    expect(toggle().getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(toggle());
    expect(document.body.style.overflow).toBe('');
    expect(main().hasAttribute('inert')).toBe(false);
  });

  it('closes on × and on a tap outside it', () => {
    renderShell();
    fireEvent.click(toggle());
    fireEvent.click(screen.getByRole('button', { name: 'Fechar menu' }));
    expect(toggle().getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(toggle());

    fireEvent.click(toggle());
    fireEvent.click(document.querySelector('.sidebar-backdrop') as HTMLElement);
    expect(toggle().getAttribute('aria-expanded')).toBe('false');
    expect(document.querySelector('.sidebar-backdrop')).toBeNull();
  });

  it('closes when a screen is chosen and gives focus back to ☰', () => {
    renderShell();
    fireEvent.click(toggle());
    fireEvent.click(screen.getByRole('link', { name: /Copywriter/ }));

    expect(toggle().getAttribute('aria-expanded')).toBe('false');
    expect(document.body.style.overflow).toBe('');
    // The entry is hidden with the drawer; focus must not fall to the page body.
    expect(document.activeElement).toBe(toggle());
  });

  it('closes when the screen changes by other means (the browser back button)', () => {
    let go: ((to: string) => void) | null = null;
    function Page() {
      const navigate = useNavigate();
      go = (to) => void navigate(to);
      return null;
    }
    render(
      <MemoryRouter initialEntries={['/marketing/trafego-pago-wings']}>
        <Routes>
          <Route element={<AppShell />}>
            <Route path="*" element={<Page />} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );
    fireEvent.click(toggle());
    expect(toggle().getAttribute('aria-expanded')).toBe('true');

    act(() => go?.('/inicio'));

    expect(toggle().getAttribute('aria-expanded')).toBe('false');
    expect(document.body.style.overflow).toBe('');
    expect(main().hasAttribute('inert')).toBe(false);
  });

  it('is announced as a dialog only while open', () => {
    renderShell();
    const sidebar = () => document.getElementById('app-sidebar') as HTMLElement;
    expect(sidebar().getAttribute('role')).toBeNull();
    fireEvent.click(toggle());
    expect(sidebar().getAttribute('role')).toBe('dialog');
    expect(sidebar().getAttribute('aria-modal')).toBe('true');
    expect(screen.getByRole('dialog', { name: 'Menu' })).toBe(sidebar());
  });

  it('gives way to the search (Ctrl K) without pulling focus to ☰', () => {
    renderShell();
    fireEvent.click(toggle());
    fireEvent.keyDown(document, { key: 'k', ctrlKey: true });

    expect(toggle().getAttribute('aria-expanded')).toBe('false');
    expect(main().hasAttribute('inert')).toBe(false);
    expect(document.activeElement).not.toBe(toggle());
  });

  it('closes when the entry chosen is the screen already open', () => {
    renderShell();
    fireEvent.click(toggle());
    fireEvent.click(screen.getByRole('link', { name: /Agente de Tráfego Pago — Wings/ }));
    expect(toggle().getAttribute('aria-expanded')).toBe('false');
  });

  it('closes on its own when the window grows past the phone width', () => {
    const listeners = new Set<() => void>();
    const query = {
      matches: true,
      addEventListener: (_: string, listener: () => void) => listeners.add(listener),
      removeEventListener: (_: string, listener: () => void) => listeners.delete(listener),
    };
    const matchMedia = vi.fn(() => query);
    vi.stubGlobal('matchMedia', matchMedia);
    renderShell();
    fireEvent.click(toggle());
    expect(matchMedia).toHaveBeenCalledWith('(max-width: 700px)');
    expect(listeners.size).toBe(1);

    query.matches = false;
    act(() => listeners.forEach((listener) => listener()));

    expect(toggle().getAttribute('aria-expanded')).toBe('false');
    expect(document.body.style.overflow).toBe('');
    expect(listeners.size).toBe(0);
  });

  it('gives the page its scroll back when the shell goes away with the menu open', () => {
    renderShell();
    fireEvent.click(toggle());
    expect(document.body.style.overflow).toBe('hidden');
    cleanup();
    expect(document.body.style.overflow).toBe('');
  });
});
