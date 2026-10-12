import {
  ROADMAP_DELIVERABLE_STATUSES,
  ROADMAP_DELIVERABLE_STATUS_LABELS,
  ROADMAP_RECIPIENT_ROLES,
  ROADMAP_RECIPIENT_ROLE_LABELS,
  ROADMAP_REPORT_RUN_STATUS_LABELS,
  ROADMAP_WEIGHTS,
  ROADMAP_WEIGHT_LABELS,
  type RoadmapComputed,
  type RoadmapDeliverable,
  type RoadmapDeliverableStatus,
  type RoadmapModule,
  type RoadmapRecipientRole,
  type RoadmapReportRun,
  type RoadmapWeight,
} from '@wings/shared';
import { useState } from 'react';
import { useParams } from 'react-router-dom';
import {
  useApproveReport,
  useCreateRecipient,
  useDeleteRecipient,
  useRoadmapModules,
  useRoadmapRecipients,
  useRoadmapReports,
  useUpdateDeliverable,
  useUpdateRecipient,
} from '../api/roadmap.js';
import { ApiError } from '../api/client.js';
import { LoadFailure } from '../components/LoadFailure.js';
import { Alert, Button, Field, Input, Select } from '../components/ui.js';
import { PageHeader } from '../components/PageHeader.js';

/**
 * Administração → Roadmap: o progresso do sistema, módulo a módulo, e o
 * relatório diário que sai para Umberto e Thais depois que Eric aprova o
 * rascunho. Só Admin Master abre esta tela (RequirePermission + a API).
 */

type Tab = 'modulos' | 'relatorios' | 'destinatarios';

const formatPercent = (value: number | null) => (value === null ? 'sem dados' : `${value}%`);
const formatWeeks = (value: number | null) =>
  value === null ? 'indeterminado' : value === 0 ? '0 semanas' : `${value} semana(s)`;

function ComputedSummary({ computed }: { computed: RoadmapComputed }) {
  return (
    <section className="card">
      <h2>Progresso total: {formatPercent(computed.weightedTotalPercent)}</h2>
      <p>
        Velocidade: últimas 4 semanas{' '}
        {computed.velocity.last4WeeksPerWeek === null
          ? 'sem dados'
          : `${computed.velocity.last4WeeksPerWeek} de peso/semana`}
        ; desde o início{' '}
        {computed.velocity.sinceStartPerWeek === null
          ? 'sem dados'
          : `${computed.velocity.sinceStartPerWeek} de peso/semana`}
        .
      </p>
      <p>
        Previsão para concluir:{' '}
        {computed.forecast
          ? `otimista ${formatWeeks(computed.forecast.optimisticWeeks)}, provável ${formatWeeks(computed.forecast.provavelWeeks)}, pessimista ${formatWeeks(computed.forecast.pessimisticWeeks)}`
          : 'indeterminada (sem velocidade suficiente ainda)'}
      </p>
      {computed.scopeChangePercent !== null && (
        <p className="field-hint">
          Escopo {computed.scopeChangePercent >= 0 ? 'aumentou' : 'diminuiu'}{' '}
          {Math.abs(computed.scopeChangePercent)}% na semana.
        </p>
      )}
    </section>
  );
}

function DeliverableRow({ deliverable }: { deliverable: RoadmapDeliverable }) {
  const update = useUpdateDeliverable();
  const [notes, setNotes] = useState(deliverable.notes ?? '');

  return (
    <tr>
      <td>
        {deliverable.label}
        {deliverable.source === 'auto_draft' && (
          <span className="tag" title="Ainda não editado por ninguém">
            rascunho automático
          </span>
        )}
      </td>
      <td>
        <Select
          aria-label={`Status de ${deliverable.label}`}
          value={deliverable.status}
          disabled={update.isPending}
          onChange={(event) =>
            update.mutate({
              id: deliverable.id,
              status: event.target.value as RoadmapDeliverableStatus,
            })
          }
        >
          {ROADMAP_DELIVERABLE_STATUSES.map((status) => (
            <option key={status} value={status}>
              {ROADMAP_DELIVERABLE_STATUS_LABELS[status]}
            </option>
          ))}
        </Select>
      </td>
      <td>
        <Select
          aria-label={`Peso de ${deliverable.label}`}
          value={deliverable.weight}
          disabled={update.isPending}
          onChange={(event) =>
            update.mutate({ id: deliverable.id, weight: event.target.value as RoadmapWeight })
          }
        >
          {ROADMAP_WEIGHTS.map((weight) => (
            <option key={weight} value={weight}>
              {weight} — {ROADMAP_WEIGHT_LABELS[weight]}
            </option>
          ))}
        </Select>
      </td>
      <td>
        {deliverable.status === 'pronto' ? (
          <Input
            aria-label={`Concluído em, ${deliverable.label}`}
            type="date"
            defaultValue={deliverable.completedAt ?? ''}
            onBlur={(event) => {
              const value = event.target.value;
              if (value && value !== deliverable.completedAt) {
                update.mutate({ id: deliverable.id, completedAt: value });
              }
            }}
          />
        ) : (
          <span className="muted">—</span>
        )}
      </td>
      <td>
        <Input
          aria-label={`Notas de ${deliverable.label}`}
          value={notes}
          placeholder="Notas"
          onChange={(event) => setNotes(event.target.value)}
          onBlur={() => {
            if (notes !== (deliverable.notes ?? '')) update.mutate({ id: deliverable.id, notes });
          }}
        />
      </td>
    </tr>
  );
}

function ModuleBlock({ module }: { module: RoadmapModule }) {
  return (
    <section className="card roadmap-module">
      <header className="roadmap-module-head">
        <h2>
          {module.label}
          {module.isComingSoon && <span className="soon-badge">em breve</span>}
        </h2>
        <span className="roadmap-module-percent">{formatPercent(module.percent)}</span>
      </header>
      <div className="roadmap-bar" aria-hidden="true">
        <div className="roadmap-bar-fill" style={{ width: `${module.percent ?? 0}%` }} />
      </div>
      {module.deliverables.length === 0 ? (
        <p className="muted">Nenhum entregável ainda.</p>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Entregável</th>
                <th>Status</th>
                <th>Peso</th>
                <th>Concluído em</th>
                <th>Notas</th>
              </tr>
            </thead>
            <tbody>
              {module.deliverables.map((deliverable) => (
                <DeliverableRow key={deliverable.id} deliverable={deliverable} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function ModulesTab() {
  const modules = useRoadmapModules();

  if (modules.isLoading) return <p className="muted">Carregando…</p>;
  if (modules.isError && !modules.data) {
    return (
      <LoadFailure what="o roadmap" error={modules.error} onRetry={() => void modules.refetch()} />
    );
  }
  if (!modules.data) return null;

  return (
    <>
      {modules.isError && (
        <LoadFailure
          what="o roadmap"
          error={modules.error}
          onRetry={() => void modules.refetch()}
        />
      )}
      <ComputedSummary computed={modules.data.computed} />
      {modules.data.modules.map((module) => (
        <ModuleBlock key={module.id} module={module} />
      ))}
    </>
  );
}

function ReportRow({ run, focused }: { run: RoadmapReportRun; focused: boolean }) {
  const approve = useApproveReport();
  const [open, setOpen] = useState(focused);

  return (
    <>
      <tr className={focused ? 'roadmap-report-focused' : undefined}>
        <td>{new Date(`${run.reportDate}T00:00:00`).toLocaleDateString('pt-BR')}</td>
        <td>
          <span className="tag">{ROADMAP_REPORT_RUN_STATUS_LABELS[run.status]}</span>
        </td>
        <td>{run.approvedByName ?? '—'}</td>
        <td>{run.sentAt ? new Date(run.sentAt).toLocaleString('pt-BR') : '—'}</td>
        <td>
          <Button type="button" variant="ghost" onClick={() => setOpen((value) => !value)}>
            {open ? 'Ocultar' : 'Ver mensagem'}
          </Button>
          {run.status === 'rascunho' && (
            <Button
              type="button"
              onClick={() => approve.mutate(run.id)}
              disabled={approve.isPending}
            >
              Aprovar
            </Button>
          )}
        </td>
      </tr>
      {open && (
        <tr>
          <td colSpan={5}>
            <pre className="roadmap-message">{run.messageText}</pre>
          </td>
        </tr>
      )}
      {approve.isError && (
        <tr>
          <td colSpan={5}>
            <div className="field-error" role="alert">
              {approve.error instanceof ApiError
                ? approve.error.message
                : 'Não foi possível aprovar.'}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

function ReportsTab({ focusId }: { focusId?: string }) {
  const reports = useRoadmapReports();

  if (reports.isLoading) return <p className="muted">Carregando…</p>;
  if (reports.isError && !reports.data) {
    return (
      <LoadFailure
        what="os relatórios"
        error={reports.error}
        onRetry={() => void reports.refetch()}
      />
    );
  }
  const runs = reports.data?.runs ?? [];

  return (
    <>
      {reports.isError && (
        <LoadFailure
          what="os relatórios"
          error={reports.error}
          onRetry={() => void reports.refetch()}
        />
      )}
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>Data</th>
              <th>Status</th>
              <th>Aprovado por</th>
              <th>Enviado em</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {reports.isSuccess && runs.length === 0 && (
              <tr>
                <td colSpan={5} className="muted">
                  Nenhum relatório gerado ainda. O rascunho de hoje aparece aqui às 17:30.
                </td>
              </tr>
            )}
            {runs.map((run) => (
              <ReportRow key={run.id} run={run} focused={run.id === focusId} />
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function RecipientsTab() {
  const recipients = useRoadmapRecipients();
  const create = useCreateRecipient();
  const update = useUpdateRecipient();
  const remove = useDeleteRecipient();
  const [form, setForm] = useState<{ role: RoadmapRecipientRole; name: string; phone: string }>({
    role: 'preview',
    name: '',
    phone: '',
  });

  return (
    <>
      <form
        className="filters"
        onSubmit={(event) => {
          event.preventDefault();
          create.mutate(form, {
            onSuccess: () => setForm({ role: 'preview', name: '', phone: '' }),
          });
        }}
      >
        <Field label="Papel">
          <Select
            value={form.role}
            onChange={(event) =>
              setForm({ ...form, role: event.target.value as RoadmapRecipientRole })
            }
          >
            {ROADMAP_RECIPIENT_ROLES.map((role) => (
              <option key={role} value={role}>
                {ROADMAP_RECIPIENT_ROLE_LABELS[role]}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Nome">
          <Input
            value={form.name}
            required
            onChange={(event) => setForm({ ...form, name: event.target.value })}
          />
        </Field>
        <Field label="Telefone" hint="Com DDD, ex.: 11999998888">
          <Input
            value={form.phone}
            required
            onChange={(event) => setForm({ ...form, phone: event.target.value })}
          />
        </Field>
        <Button type="submit" disabled={create.isPending}>
          Adicionar
        </Button>
      </form>
      {create.isError && (
        <Alert kind="error">
          {create.error instanceof ApiError ? create.error.message : 'Não foi possível adicionar.'}
        </Alert>
      )}
      {recipients.isError && (
        <LoadFailure
          what="os destinatários"
          error={recipients.error}
          onRetry={() => void recipients.refetch()}
        />
      )}

      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>Papel</th>
              <th>Nome</th>
              <th>Telefone</th>
              <th>Ativo</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {recipients.isLoading && (
              <tr>
                <td colSpan={5} className="muted">
                  Carregando…
                </td>
              </tr>
            )}
            {recipients.isSuccess && recipients.data.recipients.length === 0 && (
              <tr>
                <td colSpan={5} className="muted">
                  Nenhum destinatário cadastrado.
                </td>
              </tr>
            )}
            {recipients.data?.recipients.map((recipient) => (
              <tr key={recipient.id}>
                <td>{ROADMAP_RECIPIENT_ROLE_LABELS[recipient.role]}</td>
                <td>{recipient.name}</td>
                <td className="mono">{recipient.phone}</td>
                <td>
                  <label className="field-inline">
                    <input
                      type="checkbox"
                      checked={recipient.active}
                      onChange={(event) =>
                        update.mutate({ id: recipient.id, active: event.target.checked })
                      }
                    />
                  </label>
                </td>
                <td>
                  <Button type="button" variant="ghost" onClick={() => remove.mutate(recipient.id)}>
                    Remover
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

const TABS: { key: Tab; label: string }[] = [
  { key: 'modulos', label: 'Módulos' },
  { key: 'relatorios', label: 'Relatórios' },
  { key: 'destinatarios', label: 'Destinatários' },
];

export function RoadmapPage() {
  // A WhatsApp preview link lands on /administracao/roadmap/relatorios/<id>:
  // open straight to that run instead of the module list.
  const { id: focusRunId } = useParams<{ id?: string }>();
  const [tab, setTab] = useState<Tab>(focusRunId ? 'relatorios' : 'modulos');

  return (
    <>
      <PageHeader
        title="Roadmap"
        subtitle="Progresso do sistema por módulo e o relatório diário para a diretoria. O rascunho sai para Eric às 17:30; aprovado, o final vai para Umberto e Thais às 18:00."
      />

      <div className="tab-row" role="tablist" aria-label="Seções do roadmap">
        {TABS.map((item) => (
          <button
            key={item.key}
            type="button"
            role="tab"
            aria-selected={tab === item.key}
            className={`tab-button ${tab === item.key ? 'tab-button-active' : ''}`}
            onClick={() => setTab(item.key)}
          >
            {item.label}
          </button>
        ))}
      </div>

      {tab === 'modulos' && <ModulesTab />}
      {tab === 'relatorios' && <ReportsTab focusId={focusRunId} />}
      {tab === 'destinatarios' && <RecipientsTab />}
    </>
  );
}
