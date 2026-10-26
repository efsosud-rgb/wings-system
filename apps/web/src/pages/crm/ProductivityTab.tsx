import {
  ALL_PIPELINES,
  LEAD_PIPELINE_LABELS,
  LEAD_PIPELINES,
  PRODUCTIVITY_ACTIVITY_LABELS,
  PRODUCTIVITY_ACTIVITY_TYPES,
  SALES_PERIOD_LABELS,
  SALES_PERIODS,
  type LeadPipeline,
  type Productivity,
  type ProductivityCounts,
  type SalesPeriod,
} from '@wings/shared';
import { useProductivity } from '../../api/crm.js';
import { DASH, formatDateTime, formatInt } from '../../components/dashboard/format.js';
import { LoadFailure } from '../../components/LoadFailure.js';

/**
 * Painel de Vendas › Produtividade (docs/crm/produtividade.md): what each person
 * did with their leads in the period, read from the dimensional model. No time
 * logged, no screen watched. A rate with nothing to divide by, and a measure the
 * CRM does not record, show "—" with the reason.
 */

export interface ProductivityFilters {
  period: SalesPeriod;
  from: string;
  to: string;
  pipeline: LeadPipeline | typeof ALL_PIPELINES;
  owner: string;
}

const NO_DECIDED = 'nenhum lead com o prazo da primeira hora decidido no período';
const NO_CONTACT = 'nenhum primeiro contato registrado no período';
const NO_MESSAGES = 'nenhuma resposta pelo WhatsApp do sistema no período';
const NO_LOAD = 'a carga do modelo ainda não rodou';

const percent = (part: number, whole: number) =>
  whole > 0
    ? `${((part / whole) * 100).toLocaleString('pt-BR', { maximumFractionDigits: 0 })}%`
    : null;
const minutes = (value: number | null) =>
  value === null ? null : `${formatInt(Math.round(value))} min`;
const average = (total: number, people: number) =>
  people > 0 ? (total / people).toLocaleString('pt-BR', { maximumFractionDigits: 1 }) : DASH;

/** "—" with the reason as the cell's tooltip, so the gap is never read as a zero. */
function Gap({ reason }: { reason: string }) {
  return (
    <span className="muted" title={reason} aria-label={`sem dado: ${reason}`}>
      {DASH}
    </span>
  );
}

function Cells({
  row,
  whatsappReason,
}: {
  row: ProductivityCounts;
  whatsappReason: string | null;
}) {
  const rate = percent(row.firstContact.inTime, row.firstContact.decided);
  const median = minutes(row.firstContact.medianMinutes);
  const reply = minutes(row.whatsappMedianMinutes);
  return (
    <>
      <td>{formatInt(row.received)}</td>
      <td>
        {rate ? (
          `${rate} (${row.firstContact.inTime}/${row.firstContact.decided})`
        ) : (
          <Gap reason={NO_DECIDED} />
        )}
      </td>
      <td>{median ?? <Gap reason={NO_CONTACT} />}</td>
      {PRODUCTIVITY_ACTIVITY_TYPES.map((type) => (
        <td key={type}>{formatInt(row.activities[type])}</td>
      ))}
      <td>{formatInt(row.stageAdvances)}</td>
      <td>{formatInt(row.won)}</td>
      <td>{formatInt(row.lost)}</td>
      <td>
        {whatsappReason ? <Gap reason={whatsappReason} /> : (reply ?? <Gap reason={NO_MESSAGES} />)}
      </td>
    </>
  );
}

export function ProductivityTab({
  filters,
  set,
}: {
  filters: ProductivityFilters;
  set: (patch: Record<string, string>) => void;
}) {
  const custom = filters.period === 'custom' && filters.from && filters.to;
  const query: Record<string, string> = {
    pipeline: filters.pipeline,
    period: filters.period === 'custom' && !custom ? 'month' : filters.period,
  };
  if (custom) Object.assign(query, { from: filters.from, to: filters.to });
  if (filters.owner) query.owner = filters.owner;
  const result = useProductivity(query);
  const data: Productivity | undefined = result.data;
  const own = data?.scope === 'own';

  return (
    <>
      <div className="filters-row sales-filters" role="group" aria-label="Filtros da produtividade">
        <label>
          <span className="sr-only">Período</span>
          <select
            value={filters.period}
            onChange={(event) =>
              set({ periodo: event.target.value === 'month' ? '' : event.target.value })
            }
          >
            {SALES_PERIODS.map((key) => (
              <option key={key} value={key}>
                {SALES_PERIOD_LABELS[key]}
              </option>
            ))}
          </select>
        </label>
        {filters.period === 'custom' && (
          <>
            <label>
              <span className="sr-only">De</span>
              <input
                type="date"
                value={filters.from}
                max={filters.to || undefined}
                onChange={(event) => set({ de: event.target.value })}
              />
            </label>
            <label>
              <span className="sr-only">Até</span>
              <input
                type="date"
                value={filters.to}
                min={filters.from || undefined}
                onChange={(event) => set({ ate: event.target.value })}
              />
            </label>
          </>
        )}
        <label>
          <span className="sr-only">Funil</span>
          <select
            value={filters.pipeline}
            onChange={(event) =>
              set({ funil: event.target.value === ALL_PIPELINES ? '' : event.target.value })
            }
          >
            <option value={ALL_PIPELINES}>Todos os funis</option>
            {LEAD_PIPELINES.map((key) => (
              <option key={key} value={key}>
                {LEAD_PIPELINE_LABELS[key]}
              </option>
            ))}
          </select>
        </label>
        {data && !own && (
          <label>
            <span className="sr-only">Pessoa</span>
            <select
              value={filters.owner}
              onChange={(event) => set({ vendedor: event.target.value })}
            >
              <option value="">Toda a equipe</option>
              {data.people.map((person) => (
                <option key={person.employeeId} value={person.employeeId}>
                  {person.name}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>

      {result.isError && (
        <LoadFailure
          what="a produtividade"
          error={result.error}
          onRetry={() => void result.refetch()}
        />
      )}
      {!data && result.isLoading && <p className="muted">Carregando…</p>}
      {data && (
        <>
          <p className="sales-note">
            Medido pelo que ficou registrado no CRM: nada de tempo logado, ponto ou tela.{' '}
            {data.loadedAt
              ? `Atualizado em ${formatDateTime(data.loadedAt)}.`
              : `Números: ${DASH} (${NO_LOAD}).`}{' '}
            {own
              ? `Os seus números e a média da equipe (${data.team.people} pessoa${data.team.people === 1 ? '' : 's'}).`
              : `${data.people.length} pessoa${data.people.length === 1 ? '' : 's'} no período.`}
          </p>
          <section
            className="card sales-card sales-card-wide"
            aria-labelledby="productivity-people"
          >
            <h2 id="productivity-people">Por pessoa</h2>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th scope="col">Pessoa</th>
                    <th scope="col">Leads recebidos</th>
                    <th scope="col">1º contato em até 1 h útil</th>
                    <th scope="col">Mediana até o 1º contato</th>
                    {PRODUCTIVITY_ACTIVITY_TYPES.map((type) => (
                      <th scope="col" key={type}>
                        {PRODUCTIVITY_ACTIVITY_LABELS[type]}
                      </th>
                    ))}
                    <th scope="col">Avanços de etapa</th>
                    <th scope="col">Ganhos</th>
                    <th scope="col">Perdas</th>
                    <th scope="col">Resposta no WhatsApp</th>
                  </tr>
                </thead>
                <tbody>
                  {data.people.map((person) => (
                    <tr key={person.employeeId}>
                      <th scope="row">
                        {person.name}
                        {!person.active && <span className="muted"> (inativo)</span>}
                      </th>
                      <Cells row={person} whatsappReason={data.unavailable.whatsapp} />
                    </tr>
                  ))}
                  {data.people.length === 0 && data.loadedAt && (
                    <tr>
                      <td colSpan={12} className="muted">
                        Ninguém com registro no período.
                      </td>
                    </tr>
                  )}
                  <tr className="sales-total">
                    <th scope="row">Média da equipe · {data.team.people} pessoas</th>
                    <td>{average(data.team.received, data.team.people)}</td>
                    <td>
                      {percent(data.team.firstContact.inTime, data.team.firstContact.decided) ?? (
                        <Gap reason={NO_DECIDED} />
                      )}
                    </td>
                    <td>
                      {minutes(data.team.firstContact.medianMinutes) ?? <Gap reason={NO_CONTACT} />}
                    </td>
                    {PRODUCTIVITY_ACTIVITY_TYPES.map((type) => (
                      <td key={type}>{average(data.team.activities[type], data.team.people)}</td>
                    ))}
                    <td>{average(data.team.stageAdvances, data.team.people)}</td>
                    <td>{average(data.team.won, data.team.people)}</td>
                    <td>{average(data.team.lost, data.team.people)}</td>
                    <td>
                      {data.unavailable.whatsapp ? (
                        <Gap reason={data.unavailable.whatsapp} />
                      ) : (
                        (minutes(data.team.whatsappMedianMinutes) ?? <Gap reason={NO_MESSAGES} />)
                      )}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
            <p className="sales-note">
              Taxas e medianas da equipe são da equipe junta; contagens, a média por pessoa. Avanços
              contam para quem moveu a etapa.
            </p>
          </section>

          <div className="sales-grid">
            <section className="card sales-card" aria-labelledby="productivity-stages">
              <h2 id="productivity-stages">Conversão por etapa</h2>
              {data.pipeline === null ? (
                <p className="muted">Escolha um funil para ver as etapas.</p>
              ) : (
                <table>
                  <thead>
                    <tr>
                      <th scope="col">Etapa</th>
                      <th scope="col">Chegaram</th>
                      <th scope="col">Dos recebidos</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.stages.map((stage) => (
                      <tr key={stage.id}>
                        <th scope="row">{stage.name}</th>
                        <td>{formatInt(stage.reached)}</td>
                        <td>
                          {percent(stage.reached, data.team.received) ?? (
                            <Gap reason="nenhum lead recebido no período" />
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </section>
            <section className="card sales-card" aria-labelledby="productivity-lost">
              <h2 id="productivity-lost">Perdas por motivo</h2>
              {data.lostReasons.length === 0 ? (
                <p className="muted">Nenhuma perda com motivo no período.</p>
              ) : (
                <ul>
                  {data.lostReasons.map((item) => (
                    <li key={item.reason}>
                      {item.reason} · {formatInt(item.count)}
                    </li>
                  ))}
                </ul>
              )}
            </section>
            <section className="card sales-card" aria-labelledby="productivity-gaps">
              <h2 id="productivity-gaps">Ainda sem dado</h2>
              <ul>
                <li>
                  Fichas enviadas: {DASH} ({data.unavailable.ficha}).
                </li>
                <li>
                  COF enviadas: {DASH} ({data.unavailable.cof}).
                </li>
                <li>
                  Tarefas de Projetos no prazo: {DASH} ({data.unavailable.projects}).
                </li>
                {data.unavailable.whatsapp && (
                  <li>
                    Resposta no WhatsApp: {DASH} ({data.unavailable.whatsapp}).
                  </li>
                )}
              </ul>
            </section>
          </div>
        </>
      )}
    </>
  );
}
