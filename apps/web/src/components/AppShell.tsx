import {
  moduleKeyForPath,
  NAV_GROUP_LABELS,
  NAV_GROUPS,
  visibleNavigation,
  type NavModule,
  type NavSubmodule,
} from '@wings/shared';
import { useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { useSession } from '../api/auth.js';
import { SidebarLogo } from '../brand/SidebarLogo.js';
import { Icon } from './Icon.js';
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
 */
export function AppShell() {
  const session = useSession();
  const { pathname } = useLocation();
  const user = session.data;

  // The module containing the current screen starts open; the rest collapsed.
  const [openModules, setOpenModules] = useState<Record<string, boolean>>({});

  if (!user) return null;

  const modules = visibleNavigation({ role: user.role, permissions: user.permissions });
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

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="sidebar-brand">
          <div className="sidebar-logo" id="wings-logo-slot">
            <SidebarLogo />
          </div>
        </div>

        <nav className="sidebar-menu" aria-label="Módulos">
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

      <div className="shell-main">
        <Topbar />
        <main className="content">
          <WhatsAppCallProvider>
            <Outlet />
          </WhatsAppCallProvider>
        </main>
      </div>
    </div>
  );
}
