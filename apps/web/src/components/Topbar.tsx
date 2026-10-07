import {
  initialsOf,
  NAV_GROUP_LABELS,
  ROLES,
  SECTORS,
  visibleNavigation,
  type NavIcon,
  type NavModule,
  type SessionUser,
} from '@wings/shared';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { hasPermission, useLogout, useSession } from '../api/auth.js';
import { useTaskList } from '../api/crm.js';
import { dueLabel, isPast } from '../pages/crm/format.js';
import { Icon } from './Icon.js';

/**
 * The white bar over every screen: the search (Ctrl K) that opens any screen
 * by name, "Criar" with the things the person may create, the bell with what
 * is late or due today, and the person with name and role. Nothing here
 * decides access: each entry only appears when the session already carries
 * the permission, and the API re-checks on the way in.
 */
export function Topbar() {
  const session = useSession();
  const user = session.data;
  if (!user) return null;
  const modules = visibleNavigation({ role: user.role, permissions: user.permissions });
  return (
    <header className="topbar">
      <SearchButton modules={modules} />
      <span className="topbar-spacer" />
      <CreateMenu user={user} />
      {hasPermission(user, 'leads.read') && <Bell />}
      <UserMenu user={user} />
    </header>
  );
}

/** Opens and closes on a click outside or on Escape; the trigger decides the rest. */
function useDismiss(open: boolean, close: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) close();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, close]);
  return ref;
}

function Menu({
  open,
  onClose,
  align = 'right',
  children,
}: {
  open: boolean;
  onClose: () => void;
  align?: 'left' | 'right';
  children: ReactNode;
}) {
  if (!open) return null;
  return (
    <div className={`topbar-menu is-${align}`} role="menu" onClick={onClose}>
      {children}
    </div>
  );
}

// --- search ------------------------------------------------------------------------------

interface Target {
  path: string;
  label: string;
  module: string;
  icon: NavIcon;
}

function targetsOf(modules: NavModule[]): Target[] {
  const out: Target[] = [];
  for (const module of modules) {
    for (const submodule of module.submodules) {
      if (submodule.status !== 'ready') continue;
      out.push({
        path: submodule.path,
        label: submodule.label,
        module: module.group === 'modulos' ? module.label : NAV_GROUP_LABELS[module.group],
        icon: submodule.icon ?? module.icon,
      });
    }
  }
  return out;
}

const fold = (text: string) => text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

function SearchButton({ modules }: { modules: NavModule[] }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setOpen((current) => !current);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);
  return (
    <>
      <button type="button" className="topbar-search" onClick={() => setOpen(true)}>
        <Icon name="search" size={16} />
        <span>Buscar tela</span>
        <kbd>Ctrl K</kbd>
      </button>
      {open && <SearchDialog targets={targetsOf(modules)} onClose={() => setOpen(false)} />}
    </>
  );
}

function SearchDialog({ targets, onClose }: { targets: Target[]; onClose: () => void }) {
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);
  const hits = useMemo(() => {
    const q = fold(query.trim());
    if (!q) return targets;
    return targets.filter(
      (target) => fold(target.label).includes(q) || fold(target.module).includes(q),
    );
  }, [query, targets]);
  const go = (target: Target | undefined) => {
    if (!target) return;
    onClose();
    navigate(target.path);
  };
  return (
    <div className="topbar-dialog-backdrop" onMouseDown={onClose}>
      <div
        className="topbar-dialog"
        role="dialog"
        aria-label="Buscar tela"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="topbar-dialog-input">
          <Icon name="search" size={18} />
          <input
            ref={input}
            value={query}
            placeholder="Para onde você quer ir?"
            onChange={(event) => {
              setQuery(event.target.value);
              setCursor(0);
            }}
            onKeyDown={(event) => {
              if (event.key === 'ArrowDown') {
                event.preventDefault();
                setCursor((c) => Math.min(c + 1, hits.length - 1));
              } else if (event.key === 'ArrowUp') {
                event.preventDefault();
                setCursor((c) => Math.max(c - 1, 0));
              } else if (event.key === 'Enter') {
                go(hits[cursor]);
              } else if (event.key === 'Escape') {
                onClose();
              }
            }}
          />
          <kbd>Esc</kbd>
        </div>
        <ul className="topbar-dialog-list">
          {hits.length === 0 && (
            <li className="topbar-dialog-empty">Nenhuma tela com esse nome.</li>
          )}
          {hits.map((target, index) => (
            <li key={target.path}>
              <button
                type="button"
                className={index === cursor ? 'is-active' : ''}
                onMouseEnter={() => setCursor(index)}
                onClick={() => go(target)}
              >
                <Icon name={target.icon} size={16} />
                <span>{target.label}</span>
                <small>{target.module}</small>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

// --- create -----------------------------------------------------------------------------

function CreateMenu({ user }: { user: SessionUser }) {
  const [open, setOpen] = useState(false);
  const ref = useDismiss(open, () => setOpen(false));
  const entries: {
    label: string;
    to: string;
    icon: 'columns' | 'users' | 'building' | 'briefcase' | 'user';
  }[] = [];
  if (hasPermission(user, 'leads.write')) {
    entries.push({ label: 'Negociação', to: '/crm-vendas/negociacoes?criar=1', icon: 'columns' });
    entries.push({ label: 'Contato', to: '/crm-vendas/contatos?criar=1', icon: 'users' });
    entries.push({ label: 'Empresa', to: '/crm-vendas/empresas?criar=1', icon: 'building' });
  }
  if (hasPermission(user, 'clients.manage')) {
    entries.push({ label: 'Cliente', to: '/formatacao/clientes#novo', icon: 'briefcase' });
  }
  if (hasPermission(user, 'employees.create')) {
    entries.push({ label: 'Funcionário', to: '/administracao/usuarios/novo', icon: 'user' });
  }
  if (entries.length === 0) return null;
  return (
    <div className="topbar-item" ref={ref}>
      <button
        type="button"
        className="topbar-create"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <Icon name="plus" size={16} />
        Criar
      </button>
      <Menu open={open} onClose={() => setOpen(false)}>
        {entries.map((entry) => (
          <Link key={entry.to} to={entry.to} role="menuitem" className="topbar-menu-item">
            <Icon name={entry.icon} size={16} />
            {entry.label}
          </Link>
        ))}
      </Menu>
    </div>
  );
}

// --- bell -------------------------------------------------------------------------------

function Bell() {
  const [open, setOpen] = useState(false);
  const ref = useDismiss(open, () => setOpen(false));
  const tasks = useTaskList({ status: 'open', everyone: false });
  const now = new Date();
  const endOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime();
  const rows = (tasks.data?.tasks ?? [])
    .filter((task) => new Date(task.dueAt).getTime() < endOfDay)
    .sort((a, b) => a.dueAt.localeCompare(b.dueAt));
  const late = rows.filter((task) => isPast(task.dueAt)).length;
  return (
    <div className="topbar-item" ref={ref}>
      <button
        type="button"
        className="topbar-icon-btn"
        aria-label={
          rows.length === 0
            ? 'Avisos: nada para hoje'
            : `Avisos: ${rows.length} tarefa${rows.length === 1 ? '' : 's'} para hoje`
        }
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <Icon name="bell" size={18} />
        {rows.length > 0 && (
          <span className={`topbar-badge${late > 0 ? ' is-late' : ''}`}>{rows.length}</span>
        )}
      </button>
      <Menu open={open} onClose={() => setOpen(false)}>
        <div className="topbar-menu-title">
          {rows.length === 0 ? 'Nada para hoje' : 'Para hoje'}
          <Link to="/crm-vendas/tarefas">Ver tarefas</Link>
        </div>
        {rows.slice(0, 6).map((task) => (
          <Link
            key={task.id}
            to={`/crm-vendas/negociacoes/${task.leadId}`}
            role="menuitem"
            className={`topbar-menu-item is-task${isPast(task.dueAt) ? ' is-late' : ''}`}
          >
            <Icon name={isPast(task.dueAt) ? 'alert' : 'clock'} size={16} />
            <span>
              {task.title}
              <small>
                {task.leadName ?? 'negociação'} · {dueLabel(task.dueAt)}
              </small>
            </span>
          </Link>
        ))}
        {rows.length > 6 && (
          <Link to="/crm-vendas/tarefas" role="menuitem" className="topbar-menu-item">
            <Icon name="arrow-right" size={16} />
            Mais {rows.length - 6}
          </Link>
        )}
      </Menu>
    </div>
  );
}

// --- the person -------------------------------------------------------------------------

function UserMenu({ user }: { user: SessionUser }) {
  const [open, setOpen] = useState(false);
  const ref = useDismiss(open, () => setOpen(false));
  const logout = useLogout();
  const navigate = useNavigate();
  const onLogout = async () => {
    await logout.mutateAsync();
    navigate('/login', { replace: true });
  };
  return (
    <div className="topbar-item" ref={ref}>
      <button
        type="button"
        className="topbar-user"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <span className="topbar-avatar" aria-hidden="true">
          {initialsOf(user.fullName)}
        </span>
        <span className="topbar-user-text">
          <strong>{user.fullName}</strong>
          <span>{ROLES[user.role].name}</span>
        </span>
        <Icon name="chevron-down" size={14} className="topbar-user-chevron" />
      </button>
      <Menu open={open} onClose={() => setOpen(false)}>
        <div className="topbar-menu-title">
          <span>
            {ROLES[user.role].name}
            <small>{SECTORS[user.sector].name}</small>
          </span>
        </div>
        <Link to="/minha-conta" role="menuitem" className="topbar-menu-item">
          <Icon name="user" size={16} />
          Minha conta (Google)
        </Link>
        <button
          type="button"
          role="menuitem"
          className="topbar-menu-item"
          disabled={logout.isPending}
          onClick={onLogout}
        >
          <Icon name="log-out" size={16} />
          {logout.isPending ? 'Saindo…' : 'Sair'}
        </button>
      </Menu>
    </div>
  );
}
