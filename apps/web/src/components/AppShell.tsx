import { SECTORS, ROLES } from '@wings/shared';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { hasPermission, useLogout, useSession } from '../api/auth.js';
import { Button } from './ui.js';

/** Menu entries appear only when the viewer holds the permission behind them. */
const MENU = [
  { to: '/funcionarios', label: 'Funcionários', icon: '👥', permission: 'employees.read' },
  { to: '/trafego-pago', label: 'Tráfego pago', icon: '🚀', permission: 'ads.read' },
  { to: '/ponto', label: 'Ponto (RH/DP)', icon: '🕒', permission: 'timeclock.read' },
  { to: '/configuracoes', label: 'Configurações', icon: '⚙️', permission: 'settings.manage' },
] as const;

export function AppShell() {
  const session = useSession();
  const logout = useLogout();
  const navigate = useNavigate();
  const user = session.data;

  if (!user) return null;

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

        <nav className="sidebar-menu">
          {MENU.filter((item) => hasPermission(user, item.permission)).map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              className={({ isActive }) => `menu-item ${isActive ? 'active' : ''}`}
            >
              <span aria-hidden="true">{item.icon}</span>
              {item.label}
            </NavLink>
          ))}
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
