import {
  LEAD_TASK_KIND_LABELS,
  LEAD_TASK_KINDS,
  type LeadTask,
  type LeadTaskKind,
} from '@wings/shared';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { hasPermission, useSession } from '../../api/auth.js';
import { useCompleteTask, useTaskList } from '../../api/crm.js';
import { useSellers } from '../../api/leads.js';
import { LoadFailure } from '../../components/LoadFailure.js';
import { dueLabel, isPast } from './format.js';

/** CRM Vendas → Tarefas: late, today and next, done on the line itself. */
export function TasksPage() {
  const session = useSession();
  const canSeeAll = hasPermission(session.data, 'leads.assign');
  const canWrite = hasPermission(session.data, 'leads.write');
  const [assignee, setAssignee] = useState('');
  const [kind, setKind] = useState<LeadTaskKind | ''>('');
  const [showDone, setShowDone] = useState(false);
  const sellers = useSellers();
  const tasks = useTaskList({
    status: showDone ? 'done' : 'open',
    everyone: canSeeAll,
    assignee: canSeeAll ? assignee : undefined,
    kind,
  });
  const complete = useCompleteTask();
  const rows = (tasks.data?.tasks ?? []).sort((a, b) => a.dueAt.localeCompare(b.dueAt));
  const now = new Date();
  const endOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime();
  const late = rows.filter((task) => isPast(task.dueAt));
  const today = rows.filter(
    (task) => !isPast(task.dueAt) && new Date(task.dueAt).getTime() < endOfDay,
  );
  const next = rows.filter((task) => new Date(task.dueAt).getTime() >= endOfDay);

  const Row = ({ task }: { task: LeadTask }) => (
    <div className={`crm-task-row${isPast(task.dueAt) && !task.doneAt ? ' is-late' : ''}`}>
      {canWrite ? (
        <input
          type="checkbox"
          checked={Boolean(task.doneAt)}
          disabled={complete.isPending}
          aria-label={`Concluir ${task.title}`}
          onChange={(e) =>
            complete.mutate({ leadId: task.leadId, taskId: task.id, done: e.target.checked })
          }
        />
      ) : (
        <span />
      )}
      <div>
        <div>
          {task.title} ·{' '}
          <Link to={`/crm-vendas/negociacoes/${task.leadId}`}>{task.leadName ?? 'negociação'}</Link>
          {task.leadCompanyName ? <span className="crm-sub"> · {task.leadCompanyName}</span> : null}
        </div>
        <div className="crm-sub">
          {LEAD_TASK_KIND_LABELS[task.kind]}
          {task.auto ? ' · automática' : ''}
          {canSeeAll ? ` · ${task.assigneeName ?? 'sem responsável'}` : ''}
        </div>
      </div>
      <span
        className={`crm-task-when${isPast(task.dueAt) && !task.doneAt ? ' crm-card-task is-late' : ''}`}
      >
        {dueLabel(task.dueAt)}
      </span>
      <span className="crm-sub">{task.doneAt ? `feita por ${task.doneByName ?? '—'}` : ''}</span>
    </div>
  );
  const Group = ({ title, items }: { title: string; items: LeadTask[] }) => (
    <section className="crm-task-group">
      <h2>
        {title} <span>{items.length}</span>
      </h2>
      {tasks.isSuccess && items.length === 0 && <p className="crm-muted">Nada aqui.</p>}
      {items.map((task) => (
        <Row key={task.id} task={task} />
      ))}
    </section>
  );

  return (
    <div className="crm-page">
      <header className="crm-head">
        <h1>Tarefas</h1>
        <span className="crm-head-spacer" />
        {canSeeAll && (
          <select
            className="crm-select"
            aria-label="Dono"
            value={assignee}
            onChange={(e) => setAssignee(e.target.value)}
          >
            <option value="">Toda a equipe</option>
            {(sellers.data?.sellers ?? [])
              .filter((s) => s.active)
              .map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
          </select>
        )}
        <select
          className="crm-select"
          aria-label="Tipo"
          value={kind}
          onChange={(e) => setKind(e.target.value as LeadTaskKind | '')}
        >
          <option value="">Todos os tipos</option>
          {LEAD_TASK_KINDS.map((k) => (
            <option key={k} value={k}>
              {LEAD_TASK_KIND_LABELS[k]}
            </option>
          ))}
        </select>
        <div className="crm-segment" role="group" aria-label="Situação">
          <button
            type="button"
            className={!showDone ? 'is-active' : ''}
            onClick={() => setShowDone(false)}
          >
            Abertas
          </button>
          <button
            type="button"
            className={showDone ? 'is-active' : ''}
            onClick={() => setShowDone(true)}
          >
            Concluídas
          </button>
        </div>
      </header>
      <div className="crm-page-scroll">
        {tasks.isLoading && <p className="crm-muted">Carregando…</p>}
        {tasks.isError && (
          <LoadFailure what="as tarefas" error={tasks.error} onRetry={() => void tasks.refetch()} />
        )}
        {/* No groups (and no "0" counts) until a list has arrived; a failed refresh keeps the old one. */}
        {tasks.data &&
          (showDone ? (
            <Group title="Concluídas" items={rows} />
          ) : (
            <>
              <Group title="Atrasadas" items={late} />
              <Group title="Hoje" items={today} />
              <Group title="Próximas" items={next} />
            </>
          ))}
      </div>
    </div>
  );
}
