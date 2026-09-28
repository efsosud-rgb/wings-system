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
import { Link } from 'react-router-dom';
import { Alert } from '../ui.js';
import { DailyColumns, MonthMeter } from './charts.js';
import { formatAmount, formatDateTime, formatMonth, since } from './format.js';
import { StatePill, stateOfHealth } from './icons.js';

/**
 * Visão geral: one strip per source of money, all on the same day axis, so
 * the month reads across platforms at a glance. Paid platforms are never
 * pooled — each strip is its own budget, its own ceiling, its own balance.
 * Below the strips, the account's health: four checks per platform, each
 * with its state, what was seen and what to do about it.
 */

const COLOR: Record<SpendStrip['source'], string> = {
  meta: 'var(--viz-meta)',
  google: 'var(--viz-google)',
  kairogen: 'var(--viz-kairogen)',
  ai: 'var(--viz-ai)',
  media: 'var(--viz-media)',
};

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

      <dl className="strip-figures">
        <div>
          <dt>Gasto no mês</dt>
          <dd>{money(strip.spent)}</dd>
        </div>
        <div>
          <dt>Previsto para o mês</dt>
          <dd>
            {money(strip.forecast)}
            {strip.forecastRule && (
              <span className="cell-sub forecast-rule">{strip.forecastRule}</span>
            )}
          </dd>
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
