import {
  LEAD_PIPELINE_LABELS,
  LEAD_PIPELINES,
  type CrmStage,
  type Distribution,
  type LeadPipeline,
  type Seller,
} from '@wings/shared';
import { useState } from 'react';
import { ApiError } from '../api/client.js';
import {
  useCreateStage,
  useDistribution,
  useReorderStages,
  useSellers,
  useSetDistribution,
  useStages,
  useUpdateStage,
} from '../api/leads.js';
import { Alert, Button } from '../components/ui.js';
import { sinceLabel } from './LeadsPage.js';

/**
 * Administração → CRM: the stages of each funnel and the rotation that hands
 * new leads to sellers. The default stages are RD CRM's own (learned by the
 * import); nothing here is invented. `crm.manage` only.
 */

const errorText = (error: unknown, fallback: string) =>
  error instanceof ApiError ? error.message : fallback;

function Stages({ pipeline }: { pipeline: LeadPipeline }) {
  const stages = useStages(pipeline);
  const create = useCreateStage();
  const update = useUpdateStage();
  const reorder = useReorderStages();
  const [name, setName] = useState('');
  const [editing, setEditing] = useState<{ id: string; name: string } | null>(null);
  const list = stages.data?.stages ?? [];
  const active = list.filter((stage) => stage.active);

  const moveStage = (stage: CrmStage, delta: -1 | 1) => {
    const ids = active.map((s) => s.id);
    const index = ids.indexOf(stage.id);
    const target = index + delta;
    if (index < 0 || target < 0 || target >= ids.length) return;
    [ids[index], ids[target]] = [ids[target]!, ids[index]!];
    reorder.mutate({ pipeline, ids });
  };

  return (
    <section className="block">
      <h2>Etapas · {LEAD_PIPELINE_LABELS[pipeline]}</h2>
      {(create.error || update.error || reorder.error) && (
        <Alert kind="error">
          {errorText(
            create.error ?? update.error ?? reorder.error,
            'Não foi possível alterar as etapas.',
          )}
        </Alert>
      )}
      <ol className="stage-list">
        {list.map((stage) => (
          <li key={stage.id} className={stage.active ? '' : 'muted'}>
            {editing?.id === stage.id ? (
              <form
                className="lead-inline-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  update.mutate(
                    { id: stage.id, name: editing.name },
                    { onSuccess: () => setEditing(null) },
                  );
                }}
              >
                <input
                  className="control"
                  value={editing.name}
                  maxLength={60}
                  onChange={(event) => setEditing({ id: stage.id, name: event.target.value })}
                  autoFocus
                />
                <Button type="submit" variant="primary" disabled={update.isPending}>
                  Salvar
                </Button>
                <Button type="button" variant="ghost" onClick={() => setEditing(null)}>
                  Cancelar
                </Button>
              </form>
            ) : (
              <div className="lead-actions">
                <span>
                  <strong>
                    {stage.position}. {stage.name}
                  </strong>{' '}
                  <span className="cell-sub">
                    {stage.openCount ?? 0} em andamento
                    {stage.active ? '' : ' · desativada'}
                    {stage.rdStageId ? ' · espelha o RD' : ''}
                  </span>
                </span>
                {stage.active && (
                  <>
                    <Button
                      type="button"
                      variant="ghost"
                      aria-label={`Subir ${stage.name}`}
                      disabled={reorder.isPending}
                      onClick={() => moveStage(stage, -1)}
                    >
                      ↑
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      aria-label={`Descer ${stage.name}`}
                      disabled={reorder.isPending}
                      onClick={() => moveStage(stage, 1)}
                    >
                      ↓
                    </Button>
                  </>
                )}
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => setEditing({ id: stage.id, name: stage.name })}
                >
                  Renomear
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  disabled={update.isPending}
                  onClick={() => update.mutate({ id: stage.id, active: !stage.active })}
                >
                  {stage.active ? 'Desativar' : 'Reativar'}
                </Button>
              </div>
            )}
          </li>
        ))}
      </ol>
      <form
        className="lead-inline-form"
        onSubmit={(event) => {
          event.preventDefault();
          create.mutate({ pipeline, name }, { onSuccess: () => setName('') });
        }}
      >
        <input
          className="control"
          placeholder="Nova etapa (entra no fim)"
          value={name}
          maxLength={60}
          onChange={(event) => setName(event.target.value)}
        />
        <Button
          type="submit"
          variant="primary"
          disabled={create.isPending || name.trim().length < 2}
        >
          Adicionar etapa
        </Button>
      </form>
      <p className="muted">
        Desativar uma etapa não apaga nada: os leads que estão nela continuam lá, e ela some das
        opções de destino. Renomear muda o nome em todos os leads.
      </p>
    </section>
  );
}

function Rotation({ distribution, sellers }: { distribution: Distribution; sellers: Seller[] }) {
  const set = useSetDistribution();
  const members = distribution.members;
  const memberIds = new Set(members.map((m) => m.employeeId));
  const candidates = sellers.filter((seller) => seller.active && !memberIds.has(seller.id));
  const [adding, setAdding] = useState('');

  const save = (next: { employeeId: string; active: boolean }[]) =>
    set.mutate({ pipeline: distribution.pipeline, members: next });

  return (
    <section className="block">
      <h2>Distribuição · {LEAD_PIPELINE_LABELS[distribution.pipeline]}</h2>
      <p className="muted">
        Lead novo sem dono vai para quem está há mais tempo sem receber (rodízio). Pausado não
        recebe, mas mantém os leads que já tem.
      </p>
      {set.error && (
        <Alert kind="error">
          {errorText(set.error, 'Não foi possível alterar a distribuição.')}
        </Alert>
      )}
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>Vendedor</th>
              <th>Situação</th>
              <th>Em andamento</th>
              <th>Último lead</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {members.length === 0 && (
              <tr>
                <td colSpan={5} className="muted">
                  Ninguém no rodízio: leads novos ficam sem dono até alguém assumir.
                </td>
              </tr>
            )}
            {members.map((member) => (
              <tr key={member.employeeId}>
                <td>{member.name}</td>
                <td>
                  <span className={`status status-${member.active ? 'active' : 'on_leave'}`}>
                    {member.active ? 'recebendo' : 'pausado'}
                  </span>
                </td>
                <td>{member.openLeads}</td>
                <td>{member.lastAssignedAt ? sinceLabel(member.lastAssignedAt) : 'nunca'}</td>
                <td className="lead-actions">
                  <Button
                    type="button"
                    variant="ghost"
                    disabled={set.isPending}
                    onClick={() =>
                      save(
                        members.map((m) =>
                          m.employeeId === member.employeeId
                            ? { employeeId: m.employeeId, active: !m.active }
                            : { employeeId: m.employeeId, active: m.active },
                        ),
                      )
                    }
                  >
                    {member.active ? 'Pausar' : 'Retomar'}
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    disabled={set.isPending}
                    onClick={() =>
                      save(
                        members
                          .filter((m) => m.employeeId !== member.employeeId)
                          .map((m) => ({ employeeId: m.employeeId, active: m.active })),
                      )
                    }
                  >
                    Remover
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {candidates.length > 0 && (
        <form
          className="lead-inline-form"
          onSubmit={(event) => {
            event.preventDefault();
            if (!adding) return;
            save([
              ...members.map((m) => ({ employeeId: m.employeeId, active: m.active })),
              { employeeId: adding, active: true },
            ]);
            setAdding('');
          }}
        >
          <select
            className="control"
            value={adding}
            onChange={(event) => setAdding(event.target.value)}
          >
            <option value="">Adicionar vendedor…</option>
            {candidates.map((seller) => (
              <option key={seller.id} value={seller.id}>
                {seller.name}
              </option>
            ))}
          </select>
          <Button type="submit" variant="primary" disabled={!adding || set.isPending}>
            Adicionar
          </Button>
        </form>
      )}
    </section>
  );
}

export function CrmSettingsPage() {
  const distribution = useDistribution();
  const sellers = useSellers();
  return (
    <>
      <header className="page-header">
        <h1>CRM Vendas · configuração</h1>
        <p>
          Etapas de cada funil e a distribuição de leads novos entre os vendedores. As etapas padrão
          são as do RD CRM, trazidas pela importação.
        </p>
      </header>
      {LEAD_PIPELINES.map((pipeline) => (
        <Stages key={pipeline} pipeline={pipeline} />
      ))}
      {distribution.isError && (
        <Alert kind="error">Não foi possível carregar a distribuição.</Alert>
      )}
      {(distribution.data?.distributions ?? []).map((item) => (
        <Rotation key={item.pipeline} distribution={item} sellers={sellers.data?.sellers ?? []} />
      ))}
    </>
  );
}
