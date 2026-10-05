import {
  LEAD_PIPELINE_LABELS,
  LEAD_PIPELINES,
  type CrmStage,
  type Distribution,
  type LeadPipeline,
} from '@wings/shared';
import { useState } from 'react';
import { ApiError } from '../../api/client.js';
import { useBrands, useCreateBrand, useSetBrandOnSale } from '../../api/crm.js';
import {
  useCreateStage,
  useDistribution,
  useReorderStages,
  useSellers,
  useSetDistribution,
  useStages,
  useUpdateStage,
} from '../../api/leads.js';
import { ago, stageTone } from './format.js';

/**
 * CRM Vendas → Configurações: the stages of each funnel with their chance of
 * closing, the rotation that hands new deals to sellers, and the brands of
 * interest (Expansão). `crm.manage` only.
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
  const move = (stage: CrmStage, delta: -1 | 1) => {
    const ids = active.map((s) => s.id);
    const index = ids.indexOf(stage.id);
    const target = index + delta;
    if (index < 0 || target < 0 || target >= ids.length) return;
    [ids[index], ids[target]] = [ids[target]!, ids[index]!];
    reorder.mutate({ pipeline, ids });
  };
  const error = create.error ?? update.error ?? reorder.error;
  return (
    <section className="crm-panel">
      <h2>Etapas · {LEAD_PIPELINE_LABELS[pipeline]}</h2>
      {error ? (
        <p className="crm-error">{errorText(error, 'Não foi possível alterar as etapas.')}</p>
      ) : null}
      <div className="crm-stage-list">
        {list.map((stage) => (
          <div key={stage.id} className="crm-stage-row" style={{ opacity: stage.active ? 1 : 0.6 }}>
            <span
              className="crm-stage-dot"
              style={stageTone(stage.position) as React.CSSProperties}
            />
            {editing?.id === stage.id ? (
              <form
                className="crm-quick-row"
                style={{ justifyContent: 'flex-start' }}
                onSubmit={(e) => {
                  e.preventDefault();
                  update.mutate(
                    { id: stage.id, name: editing.name },
                    { onSuccess: () => setEditing(null) },
                  );
                }}
              >
                <input
                  className="crm-input"
                  value={editing.name}
                  maxLength={60}
                  autoFocus
                  onChange={(e) => setEditing({ id: stage.id, name: e.target.value })}
                />
                <button
                  type="submit"
                  className="crm-btn is-small is-primary"
                  disabled={update.isPending}
                >
                  Salvar
                </button>
                <button
                  type="button"
                  className="crm-btn is-small is-quiet"
                  onClick={() => setEditing(null)}
                >
                  Cancelar
                </button>
              </form>
            ) : (
              <span>
                <b>
                  {stage.position}. {stage.name}
                </b>
                <span className="crm-sub">
                  {' '}
                  · {stage.openCount ?? 0} em andamento{stage.active ? '' : ' · desativada'}
                </span>
              </span>
            )}
            <label
              className="crm-sub"
              title="Chance de a negociação fechar nesta etapa; pondera o valor da coluna"
            >
              <input
                className="crm-input"
                type="number"
                min={0}
                max={100}
                defaultValue={stage.probability}
                style={{ width: 56, padding: '2px 6px' }}
                onBlur={(e) => {
                  const value = Number(e.target.value);
                  if (
                    Number.isInteger(value) &&
                    value >= 0 &&
                    value <= 100 &&
                    value !== stage.probability
                  )
                    update.mutate({ id: stage.id, probability: value });
                }}
              />{' '}
              %
            </label>
            <span className="crm-quick-row">
              {stage.active && (
                <>
                  <button
                    type="button"
                    className="crm-btn is-small is-quiet"
                    aria-label={`Subir ${stage.name}`}
                    disabled={reorder.isPending}
                    onClick={() => move(stage, -1)}
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    className="crm-btn is-small is-quiet"
                    aria-label={`Descer ${stage.name}`}
                    disabled={reorder.isPending}
                    onClick={() => move(stage, 1)}
                  >
                    ↓
                  </button>
                </>
              )}
              <button
                type="button"
                className="crm-btn is-small is-quiet"
                onClick={() => setEditing({ id: stage.id, name: stage.name })}
              >
                Renomear
              </button>
              <button
                type="button"
                className="crm-btn is-small is-quiet"
                disabled={update.isPending}
                onClick={() => update.mutate({ id: stage.id, active: !stage.active })}
              >
                {stage.active ? 'Desativar' : 'Reativar'}
              </button>
            </span>
          </div>
        ))}
      </div>
      <form
        className="crm-quick-row"
        style={{ justifyContent: 'flex-start' }}
        onSubmit={(e) => {
          e.preventDefault();
          create.mutate({ pipeline, name }, { onSuccess: () => setName('') });
        }}
      >
        <input
          className="crm-input"
          placeholder="Nova etapa"
          value={name}
          maxLength={60}
          onChange={(e) => setName(e.target.value)}
        />
        <button
          type="submit"
          className="crm-btn is-small"
          disabled={create.isPending || name.trim().length < 2}
        >
          Adicionar ao fim
        </button>
      </form>
    </section>
  );
}

function Rotation({ distribution }: { distribution: Distribution }) {
  const sellers = useSellers();
  const set = useSetDistribution();
  const [adding, setAdding] = useState('');
  const members = distribution.members;
  const save = (next: { employeeId: string; active: boolean }[]) =>
    set.mutate({ pipeline: distribution.pipeline, members: next });
  const available = (sellers.data?.sellers ?? []).filter(
    (s) => s.active && !members.some((m) => m.employeeId === s.id),
  );
  return (
    <section className="crm-panel">
      <h2>Rodízio · {LEAD_PIPELINE_LABELS[distribution.pipeline]}</h2>
      <p className="crm-sub">
        Uma negociação nova sem dono vai para quem está há mais tempo sem receber. Quem não está
        aqui pode ser dono, mas não recebe automaticamente.
      </p>
      {set.error && (
        <p className="crm-error">{errorText(set.error, 'Não foi possível salvar o rodízio.')}</p>
      )}
      {members.length === 0 && (
        <p className="crm-muted">
          Ninguém no rodízio: a negociação fica sem dono até alguém assumir.
        </p>
      )}
      {members.map((member) => (
        <div
          key={member.employeeId}
          className="crm-task-row"
          style={{ gridTemplateColumns: '1fr auto auto' }}
        >
          <span>
            <b>{member.name}</b>
            <span className="crm-sub">
              {' '}
              · {member.openLeads} em andamento · último recebido{' '}
              {member.lastAssignedAt ? `há ${ago(member.lastAssignedAt)}` : 'nunca'}
              {member.active ? '' : ' · pausado'}
            </span>
          </span>
          <button
            type="button"
            className="crm-btn is-small is-quiet"
            disabled={set.isPending}
            onClick={() =>
              save(
                members.map((m) => ({
                  employeeId: m.employeeId,
                  active: m.employeeId === member.employeeId ? !m.active : m.active,
                })),
              )
            }
          >
            {member.active ? 'Pausar' : 'Retomar'}
          </button>
          <button
            type="button"
            className="crm-btn is-small is-quiet is-danger"
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
          </button>
        </div>
      ))}
      {available.length > 0 && (
        <div className="crm-quick-row" style={{ justifyContent: 'flex-start' }}>
          <select className="crm-select" value={adding} onChange={(e) => setAdding(e.target.value)}>
            <option value="">Adicionar vendedor…</option>
            {available.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="crm-btn is-small"
            disabled={!adding || set.isPending}
            onClick={() => {
              save([
                ...members.map((m) => ({ employeeId: m.employeeId, active: m.active })),
                { employeeId: adding, active: true },
              ]);
              setAdding('');
            }}
          >
            Adicionar
          </button>
        </div>
      )}
    </section>
  );
}

function Brands() {
  const brands = useBrands(true);
  const create = useCreateBrand();
  const toggle = useSetBrandOnSale();
  const [name, setName] = useState('');
  const list = brands.data?.brands ?? [];
  const error = create.error ?? toggle.error;
  return (
    <section className="crm-panel">
      <h2>Marcas de interesse · Expansão</h2>
      <p className="crm-sub">
        As marcas cujas franquias a Wings vende. Uma marca é um cliente do cadastro; "à venda" é o
        que aparece para o vendedor escolher e no filtro do quadro.
      </p>
      {error ? (
        <p className="crm-error">{errorText(error, 'Não foi possível alterar as marcas.')}</p>
      ) : null}
      {list.map((brand) => (
        <label
          key={brand.clientId}
          className="crm-task-row"
          style={{ gridTemplateColumns: '20px 1fr auto' }}
        >
          <input
            type="checkbox"
            checked={brand.onSale}
            disabled={toggle.isPending}
            onChange={(e) => toggle.mutate({ clientId: brand.clientId, onSale: e.target.checked })}
          />
          <span>
            <b>{brand.name}</b>
            <span className="crm-sub"> · {brand.openLeads} negociação(ões) em andamento</span>
          </span>
          <span className="crm-sub">{brand.onSale ? 'à venda' : 'pausada'}</span>
        </label>
      ))}
      <form
        className="crm-quick-row"
        style={{ justifyContent: 'flex-start' }}
        onSubmit={(e) => {
          e.preventDefault();
          create.mutate({ name }, { onSuccess: () => setName('') });
        }}
      >
        <input
          className="crm-input"
          placeholder="Nova marca (ex.: Calçadão do Frango)"
          value={name}
          maxLength={80}
          onChange={(e) => setName(e.target.value)}
        />
        <button
          type="submit"
          className="crm-btn is-small"
          disabled={create.isPending || name.trim().length < 2}
        >
          Cadastrar marca
        </button>
      </form>
    </section>
  );
}

export function CrmSettingsPage() {
  const distribution = useDistribution();
  const [tab, setTab] = useState<'stages' | 'rotation' | 'brands'>('stages');
  return (
    <div className="crm-page">
      <header className="crm-head">
        <h1>Configurações do CRM</h1>
        <span className="crm-head-spacer" />
        <div className="crm-segment" role="group">
          <button
            type="button"
            className={tab === 'stages' ? 'is-active' : ''}
            onClick={() => setTab('stages')}
          >
            Etapas
          </button>
          <button
            type="button"
            className={tab === 'rotation' ? 'is-active' : ''}
            onClick={() => setTab('rotation')}
          >
            Distribuição
          </button>
          <button
            type="button"
            className={tab === 'brands' ? 'is-active' : ''}
            onClick={() => setTab('brands')}
          >
            Marcas
          </button>
        </div>
      </header>
      <div className="crm-page-scroll crm-stack">
        {tab === 'stages' &&
          LEAD_PIPELINES.map((pipeline) => <Stages key={pipeline} pipeline={pipeline} />)}
        {tab === 'rotation' &&
          (distribution.data?.distributions ?? []).map((item) => (
            <Rotation key={item.pipeline} distribution={item} />
          ))}
        {tab === 'brands' && <Brands />}
      </div>
    </div>
  );
}
