import { SPEND_SOURCE_LABEL, type DashboardOverview, type SpendStrip } from '@wings/shared';
import { Link } from 'react-router-dom';
import { Alert } from '../ui.js';
import { DailyColumns, MonthMeter } from './charts.js';
import { formatAmount, formatMonth, since } from './format.js';

/**
 * Visão geral: one strip per source of money, all on the same day axis, so
 * the month reads across platforms at a glance. Paid platforms are never
 * pooled — each strip is its own budget, its own ceiling, its own balance.
 */

const COLOR: Record<SpendStrip['source'], string> = {
  meta: 'var(--viz-meta)',
  google: 'var(--viz-google)',
  kairogen: 'var(--viz-kairogen)',
  ai: 'var(--viz-ai)',
  media: 'var(--viz-media)',
};

function Strip({ strip }: { strip: SpendStrip }) {
  const money = (value: number | null) => formatAmount(value, strip.unit);
  const dailyLabel = strip.source === 'ai' ? 'Teto diário por pessoa' : 'Orçamento diário ativo';

  return (
    <li className="strip" style={{ '--strip-color': COLOR[strip.source] } as React.CSSProperties}>
      <header className="strip-head">
        <h3>
          <i className="strip-dot" aria-hidden="true" />
          {SPEND_SOURCE_LABEL[strip.source]}
        </h3>
        <span className="muted">
          {!strip.configured
            ? 'não configurado'
            : strip.refreshedAt
              ? `atualizado ${since(strip.refreshedAt)}`
              : 'lido do nosso registro'}
        </span>
      </header>

      {strip.killSwitchEngaged && (
        <Alert kind="error">
          Trava de segurança acionada: nenhuma alteração pode ser reservada ou executada nesta
          conta até a revisão.
        </Alert>
      )}

      <dl className="strip-figures">
        <div>
          <dt>Gasto no mês</dt>
          <dd>{money(strip.spent)}</dd>
        </div>
        <div>
          <dt>Previsto para o mês</dt>
          <dd>{money(strip.forecast)}</dd>
        </div>
        <div>
          <dt>Disponível</dt>
          <dd>{money(strip.available)}</dd>
        </div>
        <div>
          <dt>Saldo na conta</dt>
          <dd>{money(strip.balance)}</dd>
        </div>
        <div>
          <dt>Teto do mês</dt>
          <dd>{money(strip.ceiling)}</dd>
        </div>
      </dl>

      <MonthMeter
        spent={strip.spent}
        forecast={strip.forecast}
        ceiling={strip.ceiling}
        color={COLOR[strip.source]}
        label={`${SPEND_SOURCE_LABEL[strip.source]}: gasto ${money(strip.spent)} de ${money(strip.ceiling)}`}
      />

      <DailyColumns
        points={strip.daily}
        color={COLOR[strip.source]}
        format={money}
        reference={
          strip.activeDailyBudget !== null && strip.activeDailyBudget > 0
            ? { amount: strip.activeDailyBudget, label: dailyLabel }
            : null
        }
        ariaLabel={`${SPEND_SOURCE_LABEL[strip.source]}, gasto por dia no mês`}
      />
    </li>
  );
}

export function OverviewTab({ overview }: { overview: DashboardOverview }) {
  const { counts } = overview;
  return (
    <>
      <p className="dash-month">
        {formatMonth(overview.periodMonth)}, dia {Math.max(1, Math.ceil(overview.elapsedDays))} de{' '}
        {overview.totalDays}
      </p>

      <ol className="strips">
        {overview.strips.map((strip) => (
          <Strip key={strip.source} strip={strip} />
        ))}
      </ol>

      <section className="dash-counts" aria-label="O que pede uma pessoa">
        <div>
          <span>Alertas abertos</span>
          <strong className={counts.criticalAlerts > 0 ? 'error-text' : ''}>
            {counts.openAlerts}
            {counts.criticalAlerts > 0 && (
              <small> {counts.criticalAlerts} crítico(s)</small>
            )}
          </strong>
        </div>
        <div>
          <span>Aprovações pendentes</span>
          <strong>
            <Link to="/marketing/trafego-pago-wings/aprovacoes">{counts.pendingApprovals}</Link>
          </strong>
        </div>
        <div>
          <span>Anúncios reprovados</span>
          <strong className={counts.disapprovedAds > 0 ? 'error-text' : ''}>
            {counts.disapprovedAds}
          </strong>
        </div>
      </section>
    </>
  );
}
