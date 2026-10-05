import {
  AD_PLATFORM_LABEL,
  HEALTH_ITEM_LABEL,
  HEALTH_STATE_LABEL,
  KILL_SWITCH_RELEASE_HOWTO,
  KILL_SWITCH_RULE_LABEL,
  SPEND_SOURCE_LABEL,
  type AdPlatform,
  type DashboardOverview,
  type HealthItem,
  type SpendStrip,
} from '@wings/shared';
import { SERIES } from '../charts3d/spec.js';
import { Link } from 'react-router-dom';
import { Alert } from '../ui.js';
import { Chart3D } from '../charts3d/Chart3D.js';
import { ChartTable, KpiCard, SOURCE_SLOT } from './charts3d.js';
import { formatAmount, formatDateTime, formatDayShort, formatMonth, since } from './format.js';
import { StatePill, stateOfHealth } from './icons.js';

/**
 * Visão geral: one strip per source of money, all on the same day axis, so
 * the month reads across platforms at a glance. Paid platforms are never
 * pooled — each strip is its own budget, its own ceiling, its own balance.
 * Below the strips, the account's health: four checks per platform, each
 * with its state, what was seen and what to do about it.
 */

/** A setup note quotes the command to run; it is shown as code, not prose. */
function SetupNote({ note }: { note: string }) {
  const parts = note.split(/(`[^`]+`)/);
  return (
    <p className="strip-setup muted">
      {parts.map((part, index) =>
        part.startsWith('`') && part.endsWith('`') ? (
          <code key={index}>{part.slice(1, -1)}</code>
        ) : (
          <span key={index}>{part}</span>
        ),
      )}
    </p>
  );
}

function Strip({ strip }: { strip: SpendStrip }) {
  const money = (value: number | null) => formatAmount(value, strip.unit);
  const dailyLabel = strip.source === 'ai' ? 'Teto diário por pessoa' : 'Orçamento diário ativo';
  const slot = SOURCE_SLOT[strip.source];
  const paid = strip.source === 'meta' || strip.source === 'google';
  const forecastMissing = !strip.configured
    ? 'fonte não configurada'
    : paid
      ? 'nenhuma conta lida ainda'
      : 'sai depois do primeiro dia completo';
  // Reais arrive in cents, as the charts expect; credits are counted.
  const format = strip.unit === 'brl' ? 'brl' : 'int';
  const month: { label: string; value: number | null; missing: string; neutral?: boolean }[] = [
    { label: 'Gasto no mês', value: strip.spent, missing: 'sem gasto lido' },
    { label: 'Previsto', value: strip.forecast, missing: forecastMissing },
    { label: 'Teto do mês', value: strip.ceiling, missing: 'não cadastrado', neutral: true },
  ];

  return (
    <li className="card strip">
      <header className="strip-head">
        <h3>
          <i className="strip-dot" style={{ background: SERIES[slot] }} aria-hidden="true" />
          {SPEND_SOURCE_LABEL[strip.source]}
        </h3>
        <span className="muted">
          {!strip.configured
            ? 'não configurado'
            : strip.refreshedAt
              ? `atualizado ${since(strip.refreshedAt)}`
              : strip.setupNote
                ? 'sem dados ainda'
                : 'lido do nosso registro'}
        </span>
      </header>

      {strip.killSwitchEngaged && (
        <Alert kind="error">
          <strong>
            Trava de segurança acionada
            {strip.killSwitch?.engagedAt ? ` em ${formatDateTime(strip.killSwitch.engagedAt)}` : ''}
            .
          </strong>{' '}
          {strip.killSwitch?.reason ? `${strip.killSwitch.reason}. ` : ''}
          Regra: {KILL_SWITCH_RULE_LABEL[strip.killSwitch?.rule ?? 'other']}. Nenhuma alteração é
          reservada ou executada nesta conta até a liberação.
          <br />
          {KILL_SWITCH_RELEASE_HOWTO.replace(
            '<conta>',
            strip.killSwitch?.accountExternalId ?? '<conta>',
          )}
        </Alert>
      )}
      {strip.setupNote && <SetupNote note={strip.setupNote} />}
      {strip.periodMissingNote && <Alert kind="warning">{strip.periodMissingNote}</Alert>}

      <div className="sales-kpis strip-kpis">
        <KpiCard title="Gasto no mês" value={money(strip.spent)} />
        <KpiCard
          title="Previsto para o mês"
          value={money(strip.forecast)}
          note={strip.forecast === null ? forecastMissing : undefined}
        />
        <KpiCard
          title="Disponível"
          value={money(strip.available)}
          note={strip.available === null ? 'nenhum teto limita esta fonte' : undefined}
        />
        <KpiCard
          title="Saldo na conta"
          value={money(strip.balance)}
          note={strip.balance === null ? 'a plataforma não informa' : undefined}
        />
        <KpiCard
          title="Teto do mês"
          value={money(strip.ceiling)}
          note={strip.ceiling === null ? 'não cadastrado' : undefined}
        />
      </div>
      {strip.configured && (
        <details className="strip-how">
          <summary>Como calculamos o previsto</summary>
          <p>
            {strip.forecastRule ??
              'Linha reta: o gasto até hoje dividido pelos dias passados, vezes os dias do mês.'}
          </p>
        </details>
      )}

      <div className="strip-charts">
        <Chart3D
          className="strip-month"
          height={170}
          ariaLabel={`${SPEND_SOURCE_LABEL[strip.source]}: gasto, previsto e teto do mês`}
          spec={{
            kind: 'ranked',
            sort: false,
            limit: Infinity,
            slot,
            format,
            totalLabel: strip.ceiling ? 'do teto' : 'do previsto',
            shareBase: strip.ceiling ?? strip.forecast ?? undefined,
            items: month.map((row) => ({
              label: row.label,
              value: row.value ?? 0,
              neutral: row.neutral,
            })),
          }}
          table={
            <ChartTable
              caption={`${SPEND_SOURCE_LABEL[strip.source]} no mês`}
              head={['', 'Valor']}
              rows={month.map((row) => ({
                key: row.label,
                cells: [row.label, row.value === null ? `— (${row.missing})` : money(row.value)],
                neutral: row.neutral,
              }))}
            />
          }
        />
        <Chart3D
          className="strip-daily"
          height={200}
          ariaLabel={`${SPEND_SOURCE_LABEL[strip.source]}, gasto por dia no mês`}
          spec={{
            kind: 'columns',
            categories: strip.daily.map((point) => formatDayShort(point.day)),
            series: [{ name: 'Gasto', values: strip.daily.map((point) => point.amount), slot }],
            format,
            reference:
              strip.activeDailyBudget !== null && strip.activeDailyBudget > 0
                ? { value: strip.activeDailyBudget, label: dailyLabel }
                : null,
          }}
          table={
            <ChartTable
              caption={`${SPEND_SOURCE_LABEL[strip.source]}, gasto por dia`}
              head={['Dia', 'Gasto']}
              rows={strip.daily.map((point) => ({
                key: point.day,
                cells: [formatDayShort(point.day), money(point.amount)],
              }))}
            />
          }
        />
      </div>
    </li>
  );
}

function HealthRow({ item }: { item: HealthItem }) {
  return (
    <li className="health-row">
      <StatePill state={stateOfHealth(item.state)}>{HEALTH_STATE_LABEL[item.state]}</StatePill>
      <div className="health-body">
        <strong>{HEALTH_ITEM_LABEL[item.key]}</strong>
        <p>{item.detail}</p>
        {item.action && (
          <p className="health-action">
            <span>O que fazer:</span> {item.action}
          </p>
        )}
      </div>
    </li>
  );
}

function Health({ items }: { items: HealthItem[] }) {
  const platforms = [...new Set(items.map((item) => item.platform))] as AdPlatform[];
  if (platforms.length === 0) return null;
  return (
    <section className="dash-section health" aria-labelledby="health-title">
      <h2 id="health-title">Saúde da conta</h2>
      <div className="health-grid">
        {platforms.map((platform) => (
          <div key={platform} className="health-platform">
            <h3>{AD_PLATFORM_LABEL[platform]}</h3>
            <ul>
              {items
                .filter((item) => item.platform === platform)
                .map((item) => (
                  <HealthRow key={`${platform}:${item.key}`} item={item} />
                ))}
            </ul>
          </div>
        ))}
      </div>
    </section>
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

      <Health items={overview.health} />

      <section className="dash-counts" aria-label="O que pede uma pessoa">
        <div>
          <span>Alertas abertos</span>
          <strong className={counts.criticalAlerts > 0 ? 'error-text' : ''}>
            {counts.openAlerts}
            {counts.criticalAlerts > 0 && <small> {counts.criticalAlerts} crítico(s)</small>}
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
