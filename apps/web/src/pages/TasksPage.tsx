import { isTaskOverdue, LEAD_TASK_KIND_LABELS, type LeadTask } from '@wings/shared';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { hasPermission, useSession } from '../api/auth.js';
import { useMyTasks, useUpdateTask } from '../api/leads.js';
import { Alert, Button } from '../components/ui.js';
import { formatDateTime } from './LeadsPage.js';

/**
 * CRM Vendas → Tarefas: what the seller has to do today, late ones first.
 * A manager can switch to everyone's. Done is one click; the rest is on the
 * lead's page.
 */
type Status = 'open' | 'overdue' | 'done' | 'all';
const STATUS_LABELS: Record<Status, string> = {
  open: 'Abertas',
  overdue: 'Atrasadas',
  done: 'Concluídas',
  all: 'Todas',
};

function Row({ task }: { task: LeadTask }) {
  const update = useUpdateTask(task.leadId);
  const overdue = isTaskOverdue(task);
  return (
    <tr className={overdue ? 'task-overdue' : ''}>
      <td>
        {!task.doneAt ? (
          <input
            type="checkbox"
            aria-label={`Concluir: ${task.title}`}
            checked={false}
            disabled={update.isPending}
            onChange={() => update.mutate({ taskId: task.id, done: true })}
          />
        ) : (
          <span className="status status-active">feita</span>
        )}
      </td>
      <td>
        <strong>{task.title}</strong>
        <div className="cell-sub">
          {LEAD_TASK_KIND_LABELS[task.kind]}
          {task.auto ? ' · automática' : ''}
        </div>
      </td>
      <td>
        <Link to={`/crm-vendas/funil/${task.leadId}`}>{task.leadName ?? 'Lead sem nome'}</Link>
      </td>
      <td>
        {formatDateTime(task.dueAt)}
        {overdue && <div className="cell-sub">atrasada</div>}
      </td>
      <td>{task.assigneeName ?? '—'}</td>
      <td>{task.doneAt ? `${formatDateTime(task.doneAt)} · ${task.doneByName ?? '—'}` : '—'}</td>
    </tr>
  );
}

export function TasksPage() {
  const session = useSession();
  const [status, setStatus] = useState<Status>('open');
  const [everyone, setEveryone] = useState(false);
  const canSeeAll = hasPermission(session.data, 'leads.assign');
  const tasks = useMyTasks(status, everyone && canSeeAll);
  const list = tasks.data?.tasks ?? [];
  const sorted = [...list].sort((a, b) => {
    const lateA = isTaskOverdue(a) ? 0 : 1;
    const lateB = isTaskOverdue(b) ? 0 : 1;
    return lateA - lateB || a.dueAt.localeCompare(b.dueAt);
  });
  return (
    <>
      <header className="page-header page-header-row">
        <div>
          <h1>Tarefas</h1>
          <p>
            Follow-ups e primeiros contatos dos seus leads. Atrasadas vêm primeiro; concluir é um
            clique. O resto se faz na ficha do lead.
          </p>
        </div>
        <div className="segmented" role="group" aria-label="Situação">
          {(Object.keys(STATUS_LABELS) as Status[]).map((option) => (
            <Button
              key={option}
              type="button"
              variant={option === status ? 'primary' : 'ghost'}
              onClick={() => setStatus(option)}
            >
              {STATUS_LABELS[option]}
            </Button>
          ))}
        </div>
      </header>
      {canSeeAll && (
        <label className="field">
          <input
            type="checkbox"
            checked={everyone}
            onChange={(e) => setEveryone(e.target.checked)}
          />{' '}
          Ver as tarefas de toda a equipe
        </label>
      )}
      {tasks.isError && <Alert kind="error">Não foi possível carregar as tarefas.</Alert>}
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th />
              <th>Tarefa</th>
              <th>Lead</th>
              <th>Vence em</th>
              <th>Responsável</th>
              <th>Concluída</th>
            </tr>
          </thead>
          <tbody>
            {tasks.isLoading && (
              <tr>
                <td colSpan={6} className="muted">
                  Carregando…
                </td>
              </tr>
            )}
            {!tasks.isLoading && sorted.length === 0 && (
              <tr>
                <td colSpan={6} className="muted">
                  Nenhuma tarefa aqui.
                </td>
              </tr>
            )}
            {sorted.map((task) => (
              <Row key={task.id} task={task} />
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
