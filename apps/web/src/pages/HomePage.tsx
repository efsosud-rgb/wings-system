import { visibleNavigation } from '@wings/shared';
import { Link } from 'react-router-dom';
import { hasPermission, useSession } from '../api/auth.js';
import { useTaskList } from '../api/crm.js';
import { Icon } from '../components/Icon.js';
import { PageHeader } from '../components/PageHeader.js';
import { dueLabel, isPast } from './crm/format.js';

const firstNameOf = (fullName: string) => fullName.trim().split(/\s+/)[0] ?? '';

const greetingFor = (hour: number) =>
  hour < 12 ? 'Bom dia' : hour < 18 ? 'Boa tarde' : 'Boa noite';

/**
 * Início: where every login lands. It shows nothing of its own — only what
 * the person may already open, and, for who works the CRM, what is due
 * today. Each shortcut is a screen from the navigation tree, so the page can
 * never point at something that does not exist.
 */
export function HomePage() {
  const session = useSession();
  const user = session.data;
  if (!user) return null;
  const now = new Date();
  const modules = visibleNavigation({ role: user.role, permissions: user.permissions }).filter(
    (module) => module.key !== 'inicio',
  );
  const date = now.toLocaleDateString('pt-BR', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  });
  return (
    <div className="home">
      <PageHeader
        title={`${greetingFor(now.getHours())}, ${firstNameOf(user.fullName)}`}
        subtitle={date.charAt(0).toUpperCase() + date.slice(1)}
      />
      {hasPermission(user, 'leads.read') && <TodayCard />}
      <div className="home-grid">
        {modules.map((module) => {
          const ready = module.submodules.filter((submodule) => submodule.status === 'ready');
          const soon = module.submodules.length - ready.length;
          return (
            <section key={module.key} className="home-module">
              <h2>
                <Icon name={module.icon} size={18} />
                {module.label}
              </h2>
              {ready.length === 0 ? (
                <p className="home-soon">Em breve</p>
              ) : (
                <ul>
                  {ready.map((submodule) => (
                    <li key={submodule.path}>
                      <Link to={submodule.path}>
                        {submodule.label}
                        <Icon name="arrow-right" size={14} />
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
              {ready.length > 0 && soon > 0 && (
                <p className="home-soon">
                  {soon === 1 ? '1 tela em breve' : `${soon} telas em breve`}
                </p>
              )}
            </section>
          );
        })}
      </div>
    </div>
  );
}

/** The person's own tasks that are late or due today, straight from the CRM. */
function TodayCard() {
  const tasks = useTaskList({ status: 'open', everyone: false });
  const now = new Date();
  const endOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime();
  const rows = (tasks.data?.tasks ?? [])
    .filter((task) => new Date(task.dueAt).getTime() < endOfDay)
    .sort((a, b) => a.dueAt.localeCompare(b.dueAt));
  const late = rows.filter((task) => isPast(task.dueAt)).length;
  return (
    <section className="home-today">
      <h2>
        <Icon name="calendar-check" size={18} />
        Para hoje
        {rows.length > 0 && (
          <span className={`pill${late > 0 ? ' is-danger' : ''}`}>
            {late > 0 ? `${late} atrasada${late === 1 ? '' : 's'}` : `${rows.length}`}
          </span>
        )}
        <Link to="/crm-vendas/tarefas" className="home-more">
          Ver tarefas
        </Link>
      </h2>
      {tasks.isLoading && <p className="muted">Carregando…</p>}
      {tasks.isError && <p className="muted">Não foi possível carregar as tarefas.</p>}
      {tasks.isSuccess && rows.length === 0 && (
        <p className="muted">Nenhuma tarefa atrasada ou para hoje.</p>
      )}
      {rows.length > 0 && (
        <ul>
          {rows.slice(0, 5).map((task) => (
            <li key={task.id} className={isPast(task.dueAt) ? 'is-late' : ''}>
              <Icon name={isPast(task.dueAt) ? 'alert' : 'clock'} size={15} />
              <Link to={`/crm-vendas/negociacoes/${task.leadId}`}>{task.title}</Link>
              <span className="muted">{task.leadName ?? 'negociação'}</span>
              <span className="home-when">{dueLabel(task.dueAt)}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
