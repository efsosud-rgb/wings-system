import {
  moduleKeyForPath,
  NAV_GROUP_LABELS,
  NAV_GROUPS,
  visibleNavigation,
  type NavModule,
  type NavSubmodule,
} from '@wings/shared';
import { useEffect, useRef, useState, type MouseEvent } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { useSession } from '../api/auth.js';
import { useOfficialNumber } from '../api/whatsapp.js';
import { SidebarLogo } from '../brand/SidebarLogo.js';
import { Icon } from './Icon.js';
import { NewLeadAlerts } from './NewLeadAlerts.js';
import { Topbar } from './Topbar.js';
import { WhatsAppCallProvider } from '../pages/crm/WhatsAppCalls.js';

/**
 * Sidebar, top bar and frame.
 *
 * The menu is generated from the navigation tree, never hand-listed: an entry
 * cannot exist without a route, and a route cannot hide from the menu. The two
 * used to be separate constants, which is how `/ponto` and `/configuracoes`
 * ended up as menu entries pointing at screens that were never built.
 *
 * Three blocks (model A, 05/10/2026): Início; the CRM, listed flat because it
 * is the daily screen; and the other modules, which expand. A sub-module the
 * viewer's role cannot reach is absent entirely, and one without a backend yet
 * is shown but marked, so the shape of the system is visible without
 * pretending it is done.
 *
 * On a phone (700 px or less) the sidebar is a drawer: closed by default so
 * the screen comes first, opened by the ☰ button in the top bar, and closed
 * again by choosing a screen, Escape, the × or a tap outside it. While it is
 * open the page behind does not scroll and cannot take focus. Above 700 px
 * nothing of this shows: the button and the × are hidden by the stylesheet.
 */
const SIDEBAR_ID = 'app-sidebar';
/** The phone breakpoint, the same as the stylesheet's. */
const PHONE = '(max-width: 700px)';

export function AppShell() {
  const session = useSession();
  const { pathname } = useLocation();
  const user = session.data;

  // The module containing the current screen starts open; the rest collapsed.
  const [openModules, setOpenModules] = useState<Record<string, boolean>>({});

  // The phone drawer. A new screen closes it: the state is reset during render
  // when the path changes, so a closed menu never flashes open on the way back.
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuPath, setMenuPath] = useState(pathname);
  if (menuPath !== pathname) {
    setMenuPath(pathname);
    setMenuOpen(false);
  }
  const toggleRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  // Closed by Escape, the ×, the backdrop or choosing an entry, focus goes back
  // to ☰ (the entry itself is hidden with the drawer, so the browser would
  // drop focus on the page body).
  const returnFocus = useRef(false);
  const closeMenu = () => {
    returnFocus.current = true;
    setMenuOpen(false);
  };

  useEffect(() => {
    if (!menuOpen) {
      if (returnFocus.current) {
        returnFocus.current = false;
        toggleRef.current?.focus();
      }
      return;
    }
    closeRef.current?.focus({ preventScroll: true });
    const { overflow } = document.body.style;
    document.body.style.overflow = 'hidden';
    const onKey = (event: KeyboardEvent) => {
      // Ctrl K opens the search in the top bar: the drawer gives way to it in
      // the same render, so the page is no longer inert when the search focuses.
      const search = (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k';
      if (event.key !== 'Escape' && !search) return;
      returnFocus.current = !search;
      setMenuOpen(false);
    };
    // Turning a tablet or widening the window past 700 px leaves no drawer to
    // close, so it closes on its own and the page scrolls again.
    const phone = typeof window.matchMedia === 'function' ? window.matchMedia(PHONE) : null;
    const onWidth = () => {
      if (phone && !phone.matches) setMenuOpen(false);
    };
    document.addEventListener('keydown', onKey);
    phone?.addEventListener('change', onWidth);
    return () => {
      document.body.style.overflow = overflow;
      document.removeEventListener('keydown', onKey);
      phone?.removeEventListener('change', onWidth);
    };
  }, [menuOpen]);

  if (!user) return null;

  const modules = visibleNavigation({ role: user.role, permissions: user.permissions });
  const whatsappSeller =
    Boolean(user.permissions['leads.whatsapp']) && user.permissions['leads.whatsapp'] !== 'all';
  const activeModule = moduleKeyForPath(pathname);
  const isOpen = (key: string) => openModules[key] ?? key === activeModule;
  const toggle = (key: string) =>
    setOpenModules((current) => ({ ...current, [key]: !(current[key] ?? key === activeModule) }));

  const item = (submodule: NavSubmodule, withIcon: NavModule['icon'] | undefined) => (
    <NavLink
      key={submodule.path}
      to={submodule.path}
      className={({ isActive }) =>
        `menu-item ${isActive ? 'active' : ''} ${
          submodule.status === 'coming_soon' ? 'menu-item-soon' : ''
        }`
      }
    >
      {withIcon && <Icon name={submodule.icon ?? withIcon} size={18} className="menu-icon" />}
      <span className="menu-item-label">{submodule.label}</span>
      {/* Marked, not hidden: the structure stays visible and nobody mistakes
          it for a screen that failed to load. */}
      {submodule.status === 'coming_soon' && <span className="soon-badge">em breve</span>}
      {submodule.path === '/crm-vendas/whatsapp' && whatsappSeller && <WhatsAppSoonBadge />}
    </NavLink>
  );

  const block = (module: NavModule) => {
    // Início and the CRM: their screens are the entries themselves.
    if (module.group !== 'modulos') {
      return module.submodules.map((submodule) => item(submodule, module.icon));
    }
    const open = isOpen(module.key);
    const only = module.submodules.length === 1 ? module.submodules[0] : undefined;
    // A module with one screen is a first-level entry: nothing to unfold.
    if (only?.status === 'ready') {
      return (
        <div key={module.key} className="menu-module">
          <NavLink
            to={only.path}
            className={({ isActive }) => `menu-module-header ${isActive ? 'active' : ''}`}
          >
            <Icon name={module.icon} size={18} className="menu-icon" />
            <span className="menu-module-label">{module.label}</span>
          </NavLink>
        </div>
      );
    }
    return (
      <div key={module.key} className="menu-module">
        <button
          type="button"
          className={`menu-module-header ${module.key === activeModule ? 'active' : ''}`}
          aria-expanded={open}
          onClick={() => toggle(module.key)}
        >
          <Icon name={module.icon} size={18} className="menu-icon" />
          <span className="menu-module-label">{module.label}</span>
          <Icon name="chevron-right" size={14} className={`chevron ${open ? 'open' : ''}`} />
        </button>
        {open && (
          <div className="menu-submodules">
            {module.submodules.map((submodule) => item(submodule, undefined))}
          </div>
        )}
      </div>
    );
  };

  // Choosing an entry closes the drawer even when it is the screen already open.
  const onMenuClick = (event: MouseEvent<HTMLElement>) => {
    if (menuOpen && (event.target as Element).closest('a')) closeMenu();
  };

  const menuButton = (
    <button
      ref={toggleRef}
      type="button"
      className="topbar-icon-btn topbar-menu-toggle"
      aria-label="Menu"
      aria-expanded={menuOpen}
      aria-controls={SIDEBAR_ID}
      onClick={() => setMenuOpen((open) => !open)}
    >
      <Icon name="menu" size={20} />
    </button>
  );

  return (
    <div className={menuOpen ? 'shell is-menu-open' : 'shell'}>
      <aside
        className="sidebar"
        id={SIDEBAR_ID}
        // Open on a phone it covers the page like a dialog, and says so.
        {...(menuOpen ? { role: 'dialog', 'aria-modal': true, 'aria-label': 'Menu' } : {})}
      >
        <div className="sidebar-brand">
          <div className="sidebar-logo" id="wings-logo-slot">
            <SidebarLogo />
          </div>
          <button
            ref={closeRef}
            type="button"
            className="topbar-icon-btn sidebar-close"
            aria-label="Fechar menu"
            onClick={() => closeMenu()}
          >
            <Icon name="x" size={20} />
          </button>
        </div>

        <nav className="sidebar-menu" aria-label="Módulos" onClick={onMenuClick}>
          {NAV_GROUPS.map((group) => {
            const members = modules.filter((module) => module.group === group);
            if (members.length === 0) return null;
            return (
              <div key={group} className="menu-group">
                <div className="menu-group-label">{NAV_GROUP_LABELS[group]}</div>
                {members.map(block)}
              </div>
            );
          })}
        </nav>
      </aside>
      {menuOpen && (
        <div className="sidebar-backdrop" aria-hidden="true" onClick={() => closeMenu()} />
      )}
      {/* Outside the inert frame: a new lead is answerable with the menu open too. */}
      <NewLeadAlerts />

      {/* inert while the drawer is open: Tab stays in the menu, as in a dialog. */}
      <div className="shell-main" inert={menuOpen || undefined}>
        <Topbar leading={menuButton} />
        <main className="content">
          <WhatsAppCallProvider>
            <Outlet />
          </WhatsAppCallProvider>
        </main>
      </div>
    </div>
  );
}

/** Eric, 14/10: a seller's WhatsApp says "em breve" until the official number is live. */
function WhatsAppSoonBadge() {
  const official = useOfficialNumber();
  return official.data?.live === true ? null : <span className="soon-badge">em breve</span>;
}
