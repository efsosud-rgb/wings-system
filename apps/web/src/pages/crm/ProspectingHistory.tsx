import { PROSPECT_STATUS_LABELS, PROSPECT_STATUSES } from '@wings/shared';
import { useProspectHistory, useProspectingMetrics } from '../../api/prospecting.js';
import { LoadFailure } from '../../components/LoadFailure.js';
import { formatDate } from './format.js';

/**
 * Prospecção's Histórico and Números (docs/crm/prospeccao.md): what was searched (as typed) and
 * what came of it, from our own tables. A seller sees their own; a manager everyone's.
 */

export function HistoryTab({
  onUse,
}: {
  onUse: (segment: string | null, places: string[]) => void;
}) {
  const history = useProspectHistory();
  if (history.isLoading) return <p className="muted">Carregando…</p>;
  if (history.isError && !history.data)
    return (
      <LoadFailure
        what="o histórico"
        error={history.error}
        onRetry={() => void history.refetch()}
      />
    );
  const items = history.data ?? [];
  if (items.length === 0) return <p className="crm-sub">Nenhuma busca feita ainda.</p>;
  return (
    <section className="crm-panel" aria-label="Histórico de buscas">
      <h2>
        Buscas
        <span className="crm-sub">as últimas {items.length}, como foram digitadas</span>
      </h2>
      <div style={{ overflowX: 'auto' }}>
        <table className="crm-table">
          <thead>
            <tr>
              <th>Quando</th>
              <th>Quem</th>
              <th>Segmento</th>
              <th>Locais</th>
              <th className="is-num">Chamadas</th>
              <th>
                <span className="sr-only">Ações</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr key={item.id}>
                <td>{formatDate(item.at)}</td>
                <td>{item.mine ? 'Você' : (item.employeeName ?? '—')}</td>
                <td>{item.segment ?? '—'}</td>
                <td>{item.places.join(', ') || '—'}</td>
                <td className="is-num">{item.calls}</td>
                <td>
                  <button
                    type="button"
                    className="crm-btn is-small is-quiet"
                    title="Preenche o formulário; a busca só roda em Buscar"
                    onClick={() => onUse(item.segment, item.places)}
                  >
                    Usar no formulário
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="crm-sub">
        Os resultados do Google não ficam guardados: buscar de novo gasta chamadas.
      </p>
    </section>
  );
}

const percent = (rate: number | null) =>
  rate === null ? '—' : `${(rate * 100).toFixed(1).replace('.', ',')}%`;

export function MetricsTab() {
  const metrics = useProspectingMetrics();
  if (metrics.isLoading) return <p className="muted">Carregando…</p>;
  if (metrics.isError || !metrics.data)
    return (
      <LoadFailure what="os números" error={metrics.error} onRetry={() => void metrics.refetch()} />
    );
  const data = metrics.data;
  const shown = PROSPECT_STATUSES.filter((status) => (data.byStatus[status] ?? 0) > 0);
  return (
    <section className="crm-panel" aria-label="Números da prospecção">
      <h2>
        Números
        <span className="crm-sub">
          {data.total} prospects · {percent(data.conversionRate)} viraram lead ·{' '}
          {data.callsThisMonth} chamadas ao Google no mês
        </span>
      </h2>
      {data.owners.length === 0 ? (
        <p className="crm-sub">Nenhum prospect nem chamada ainda.</p>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table className="crm-table">
            <thead>
              <tr>
                <th>Vendedor</th>
                {shown.map((status) => (
                  <th key={status} className="is-num">
                    {PROSPECT_STATUS_LABELS[status]}
                  </th>
                ))}
                <th className="is-num">Total</th>
                <th className="is-num">Chamadas no mês</th>
              </tr>
            </thead>
            <tbody>
              {data.owners.map((owner) => (
                <tr key={owner.employeeId ?? 'none'}>
                  <td>{owner.name ?? 'Sem dono'}</td>
                  {shown.map((status) => (
                    <td key={status} className="is-num">
                      {owner.byStatus[status] ?? 0}
                    </td>
                  ))}
                  <td className="is-num">{owner.total}</td>
                  <td className="is-num">{owner.callsThisMonth}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
