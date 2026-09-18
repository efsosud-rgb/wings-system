import { moduleKeyForPath, ROLES, SECTORS, visibleNavigation } from '@wings/shared';
import { useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useLogout, useSession } from '../api/auth.js';
import { Button } from './ui.js';

/**
 * Sidebar and frame.
 *
 * The menu is generated from the navigation tree, never hand-listed: an entry
 * cannot exist without a route, and a route cannot hide from the menu. The two
 * used to be separate constants, which is how `/ponto` and `/configuracoes`
 * ended up as menu entries pointing at screens that were never built.
 *
 * Modules expand; sub-modules are the leaves. A sub-module the viewer's role
 * cannot reach is absent entirely, and one without a backend yet is shown but
 * marked, so the shape of the system is visible without pretending it is done.
 */
export function AppShell() {
  const session = useSession();
  const logout = useLogout();
  const navigate = useNavigate();
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

  const onLogout = async () => {
    await logout.mutateAsync();
    navigate('/login', { replace: true });
  };

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="sidebar-brand">
          <span className="brand">
            WING<span>S</span>
          </span>
          <small>SYSTEM</small>
        </div>

        <nav className="sidebar-menu" aria-label="Módulos">
          {modules.map((module) => {
            const open = isOpen(module.key);
            return (
              <div key={module.key} className="menu-module">
                <button
                  type="button"
                  className={`menu-module-header ${module.key === activeModule ? 'active' : ''}`}
                  aria-expanded={open}
                  onClick={() => toggle(module.key)}
                >
                  <span aria-hidden="true">{module.icon}</span>
                  <span className="menu-module-label">{module.label}</span>
                  <span aria-hidden="true" className={`chevron ${open ? 'open' : ''}`}>
                    ›
                  </span>
                </button>

                {open && (
                  <div className="menu-submodules">
                    {module.submodules.map((submodule) => (
                      <NavLink
                        key={submodule.path}
                        to={submodule.path}
                        className={({ isActive }) =>
                          `menu-item ${isActive ? 'active' : ''} ${
                            submodule.status === 'coming_soon' ? 'menu-item-soon' : ''
                          }`
                        }
                      >
                        {submodule.label}
                        {/* Marked, not hidden: the structure stays visible and
                            nobody mistakes it for a screen that failed to load. */}
                        {submodule.status === 'coming_soon' && (
                          <span className="soon-badge">em breve</span>
                        )}
                      </NavLink>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </nav>

        <div className="sidebar-user">
          <strong>{user.fullName}</strong>
          <span>{ROLES[user.role].name}</span>
          <span className="muted">{SECTORS[user.sector].name}</span>
          <Button variant="ghost" onClick={onLogout} disabled={logout.isPending}>
            {logout.isPending ? 'Saindo…' : 'Sair'}
          </Button>
        </div>
      </aside>

      <main className="content">
        <Outlet />
      </main>
    </div>
  );
}
