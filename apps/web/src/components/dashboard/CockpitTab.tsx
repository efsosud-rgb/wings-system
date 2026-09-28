import {
  AD_ISSUE_LABEL,
  AD_PLATFORM_LABEL,
  BRAZIL_STATE_TILES,
  MIRRORED_FORMAT_LABEL,
  ratiosOf,
  type CockpitFigures,
  type DashboardCockpit,
} from '@wings/shared';
import { useEffect, useState } from 'react';
import { DailyLines } from './charts.js';
import {
  formatDayShort,
  formatInt,
  formatMoney,
  formatPercentMilli,
  formatSignedPercent,
} from './format.js';

/**
 * Cockpit: the executive screen. Big figures that count up, the funnel that
 * fills in, the days against the window before, Brazil by state, the
 * creatives that worked and what needs a look. Flat marks only: bars, lines
 * and a tile map; no 3-D, no pies (they distort the reading). Every animation
 * gives way to `prefers-reduced-motion`.
 */

function reducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true
  );
}

/** Counts from 0 to `target` in ~0.8 s, easing out; jumps straight there with reduced motion. */
export function useCountUp(target: number, duration = 800): number {
  const [value, setValue] = useState(() => (reducedMotion() ? target : 0));
  useEffect(() => {
    if (reducedMotion() || typeof requestAnimationFrame === 'undefined') {
      setValue(target);
      return;
    }
    let frame = 0;
    const start = performance.now();
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / duration);
      setValue(target * (1 - (1 - t) ** 3));
      if (t < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [target, duration]);
  return value;
}

type Better = 'up' | 'down';

function Delta({
  current,
  previous,
  better,
}: {
  current: number | null;
  previous: number | null;
  better: Better;
}) {
  if (current === null || previous === null || previous === 0) {
    return <span className="kpi-delta muted">sem comparação</span>;
  }
  const change = Math.round(((current - previous) / previous) * 100);
  const good = change === 0 ? null : change > 0 === (better === 'up');
  return (
    <span className={`kpi-delta ${good === null ? 'muted' : good ? 'kpi-good' : 'kpi-bad'}`}>
      {change > 0 ? '▲' : change < 0 ? '▼' : '•'} {formatSignedPercent(change)} contra o período
      anterior
    </span>
  );
}

function Kpi({
  label,
  value,
  previous,
  format,
  better,
  big,
}: {
  label: string;
  value: number | null;
  previous: number | null;
  format: (value: number) => string;
  better: Better;
  big?: boolean;
}) {
  const shown = useCountUp(value ?? 0);
  return (
    <div className={`kpi${big ? ' kpi-big' : ''}`}>
      <span className="kpi-label">{label}</span>
      <span
        className="kpi-value mono"
        aria-label={`${label}: ${value === null ? 'sem dado' : format(value)}`}
      >
        {value === null ? '—' : format(shown)}
      </span>
      <Delta current={value} previous={previous} better={better} />
    </div>
  );
}

const cpl = (figures: CockpitFigures) =>
  figures.leads > 0 ? figures.spendCents / figures.leads : null;
const ctr = (figures: CockpitFigures) =>
  figures.impressions > 0 ? (figures.clicks / figures.impressions) * 100_000 : null;

function Funnel({ figures }: { figures: CockpitFigures }) {
  const [filled, setFilled] = useState(reducedMotion());
  useEffect(() => {
    const id = setTimeout(() => setFilled(true), 30);
    return () => clearTimeout(id);
  }, []);
  const steps = [
    { label: 'Impressões', count: figures.impressions },
    { label: 'Cliques', count: figures.clicks },
    { label: 'Sessões', count: figures.sessions },
    { label: 'Leads', count: figures.leads },
    { label: 'Leads no CRM', count: figures.crmLeads },
    { label: 'Reuniões', count: figures.meetings },
    { label: 'Vendas', count: figures.sales },
  ];
  const top = Math.log10(Math.max(1, figures.impressions) + 1);
  return (
    <ol className="cockpit-funnel">
      {steps.map((step) => {
        const width = step.count
          ? Math.max(3, Math.round((Math.log10(step.count + 1) / top) * 100))
          : 0;
        return (
          <li key={step.label}>
            <span className="cockpit-funnel-label">{step.label}</span>
            <span className="cockpit-funnel-bar" aria-hidden="true">
              <span style={{ width: filled ? `${width}%` : '0%' }} />
            </span>
            <span className="mono num">{step.count === null ? '—' : formatInt(step.count)}</span>
            <span className="cell-sub">
              {step.count ? `${formatMoney(Math.round(figures.spendCents / step.count))} cada` : ''}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

function StateMap({ data }: { data: DashboardCockpit }) {
  const byUf = new Map(data.regions.map((region) => [region.uf, region]));
  const max = Math.max(1, ...data.regions.map((region) => region.spendCents));
  const size = 44;
  const gap = 4;
  const cols = 8;
  const rows = 9;
  return (
    <figure className="cockpit-map">
      <svg
        viewBox={`0 0 ${cols * (size + gap)} ${rows * (size + gap)}`}
        role="img"
        aria-label={`Gasto por estado: ${data.regions.map((region) => `${region.uf} ${formatMoney(region.spendCents)}`).join(', ') || 'sem entrega'}`}
      >
        {BRAZIL_STATE_TILES.map((state) => {
          const region = byUf.get(state.uf);
          const share = region ? region.spendCents / max : 0;
          return (
            <g
              key={state.uf}
              transform={`translate(${state.col * (size + gap)},${state.row * (size + gap)})`}
            >
              <title>
                {state.name}
                {region
                  ? `: ${formatMoney(region.spendCents)}, ${region.leads} lead(s)`
                  : ': sem entrega'}
              </title>
              <rect
                width={size}
                height={size}
                rx={6}
                className={region ? 'cockpit-tile cockpit-tile-on' : 'cockpit-tile'}
                style={region ? { fillOpacity: 0.25 + 0.75 * share } : undefined}
              />
              <text
                x={size / 2}
                y={size / 2 + 4}
                textAnchor="middle"
                className="cockpit-tile-label"
              >
                {state.uf}
              </text>
            </g>
          );
        })}
      </svg>
      <figcaption className="cell-sub">
        Cor mais forte, mais gasto no período. As plataformas informam a região por estado: dentro
        do RJ não há recorte por cidade ou bairro.
        {data.otherRegionsSpendCents > 0 &&
          ` Fora de um estado (desconhecido): ${formatMoney(data.otherRegionsSpendCents)}.`}
      </figcaption>
      <ul className="cockpit-map-list">
        {data.regions.slice(0, 5).map((region) => (
          <li key={region.uf}>
            <b>{region.uf}</b> {formatMoney(region.spendCents)} · {formatInt(region.leads)} lead(s)
          </li>
        ))}
      </ul>
    </figure>
  );
}

const SEVERITY_LABEL = { critical: 'Crítico', warning: 'Atenção', info: 'Aviso' } as const;

export function CockpitTab({ data }: { data: DashboardCockpit }) {
  const { current, previous } = data;
  const series = (pick: 'spend' | 'leads') => [
    {
      key: 'now',
      label: `${formatDayShort(data.since)} a ${formatDayShort(data.until)}`,
      color: 'var(--wings-accent)',
      points: data.daily.map((day) => ({
        day: day.day,
        amount: pick === 'spend' ? day.spendCents : day.leads,
      })),
    },
    {
      key: 'before',
      label: `período anterior (${formatDayShort(data.previousSince)} a ${formatDayShort(data.previousUntil)})`,
      color: 'var(--viz-ink)',
      points: data.daily.map((day) => ({
        day: day.day,
        amount: pick === 'spend' ? day.previousSpendCents : day.previousLeads,
      })),
    },
  ];

  return (
    <div className="cockpit">
      <section className="cockpit-scope" aria-label="Campanhas somadas">
        {data.activeCampaigns.length === 0 ? (
          <p className="muted">Nenhuma campanha ativa agora: os números abaixo ficam zerados.</p>
        ) : (
          <p>
            <b>Só campanhas ativas ({data.activeCampaigns.length}):</b>{' '}
            {data.activeCampaigns.map((campaign, index) => (
              <span key={`${campaign.platform}:${campaign.externalId}`}>
                {index > 0 && ' · '}
                {campaign.name}{' '}
                <span className="cell-sub">({AD_PLATFORM_LABEL[campaign.platform]})</span>
              </span>
            ))}
          </p>
        )}
      </section>

      {data.adWarnings.length > 0 && (
        <section className="cockpit-card cockpit-warnings" aria-labelledby="cockpit-ad-warnings">
          <h2 id="cockpit-ad-warnings">Anúncios ligados que não estão rodando</h2>
          <p className="cell-sub">Ficam fora de todos os números até a plataforma liberar.</p>
          <ul className="cockpit-alerts">
            {data.adWarnings.map((warning) => (
              <li
                key={`${warning.platform}:${warning.adExternalId}`}
                className="cockpit-alert cockpit-alert-warning"
              >
                <b>{AD_ISSUE_LABEL[warning.issue] ?? warning.issue}</b> {warning.adName}
                <span className="cell-sub">
                  {AD_PLATFORM_LABEL[warning.platform]} · {warning.campaignName}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="cockpit-kpis" aria-label="Indicadores do período">
        <Kpi
          big
          label="Investimento"
          value={current.spendCents}
          previous={previous.spendCents}
          format={(v) => formatMoney(Math.round(v))}
          better="up"
        />
        <Kpi
          big
          label="Leads"
          value={current.leads}
          previous={previous.leads}
          format={(v) => formatInt(Math.round(v))}
          better="up"
        />
        <Kpi
          big
          label="Custo por lead"
          value={cpl(current)}
          previous={cpl(previous)}
          format={(v) => formatMoney(Math.round(v))}
          better="down"
        />
        <Kpi
          label="CTR"
          value={ctr(current)}
          previous={ctr(previous)}
          format={(v) => formatPercentMilli(Math.round(v))}
          better="up"
        />
        <Kpi
          label="Sessões no site"
          value={current.sessions}
          previous={previous.sessions}
          format={(v) => formatInt(Math.round(v))}
          better="up"
        />
        <Kpi
          label="Reuniões"
          value={current.meetings}
          previous={previous.meetings}
          format={(v) => formatInt(Math.round(v))}
          better="up"
        />
        <Kpi
          label="Vendas"
          value={current.sales}
          previous={previous.sales}
          format={(v) => formatInt(Math.round(v))}
          better="up"
        />
      </section>

      <div className="cockpit-grid">
        <section className="cockpit-card" aria-labelledby="cockpit-evolution">
          <h2 id="cockpit-evolution">Evolução diária</h2>
          <DailyLines
            series={series('spend')}
            format={(v) => formatMoney(v)}
            ariaLabel="Investimento por dia contra o período anterior"
          />
          <DailyLines
            series={series('leads')}
            format={(v) => formatInt(v)}
            height={120}
            ariaLabel="Leads por dia contra o período anterior"
          />
        </section>

        <section className="cockpit-card" aria-labelledby="cockpit-funnel">
          <h2 id="cockpit-funnel">Funil</h2>
          <Funnel figures={current} />
          <p className="cell-sub">
            Meta e Google somados; CRM pelas etiquetas do RD. Detalhes na aba Funil.
          </p>
        </section>

        <section className="cockpit-card" aria-labelledby="cockpit-map">
          <h2 id="cockpit-map">Onde o dinheiro foi</h2>
          <StateMap data={data} />
        </section>

        <section className="cockpit-card" aria-labelledby="cockpit-creatives">
          <h2 id="cockpit-creatives">Criativos que mais trouxeram leads</h2>
          {data.creatives.length === 0 ? (
            <p className="muted">Nenhum anúncio entregou no período.</p>
          ) : (
            <ol className="cockpit-creatives">
              {data.creatives.map((creative, index) => {
                const ratios = ratiosOf(creative.totals);
                return (
                  <li key={`${creative.platform}:${creative.adExternalId}`}>
                    <span className="cockpit-rank mono">{index + 1}</span>
                    {creative.thumbnailUrl ? (
                      <img className="thumb" src={creative.thumbnailUrl} alt="" loading="lazy" />
                    ) : (
                      <span className="thumb thumb-empty" aria-hidden="true" />
                    )}
                    <span>
                      {creative.name}
                      <span className="cell-sub">
                        {AD_PLATFORM_LABEL[creative.platform]} ·{' '}
                        {MIRRORED_FORMAT_LABEL[creative.format]} ·{' '}
                        {formatInt(creative.totals.conversions)} lead(s) · CPL{' '}
                        {formatMoney(ratios.costPerLeadCents)} · CTR{' '}
                        {formatPercentMilli(ratios.ctrMilli)}
                      </span>
                    </span>
                  </li>
                );
              })}
            </ol>
          )}
        </section>

        <section className="cockpit-card" aria-labelledby="cockpit-alerts">
          <h2 id="cockpit-alerts">Alertas abertos</h2>
          {data.alerts.length === 0 ? (
            <p className="muted">Nenhum alerta aberto.</p>
          ) : (
            <ul className="cockpit-alerts">
              {data.alerts.map((alert) => (
                <li key={alert.id} className={`cockpit-alert cockpit-alert-${alert.severity}`}>
                  <b>{SEVERITY_LABEL[alert.severity]}</b> {alert.title}
                  <span className="cell-sub">{AD_PLATFORM_LABEL[alert.platform]}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}
