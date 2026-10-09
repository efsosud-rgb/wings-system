import {
  AD_ISSUE_LABEL,
  AD_PLATFORM_LABEL,
  MIRRORED_FORMAT_LABEL,
  ratiosOf,
  type CockpitFigures,
  type DashboardCockpit,
} from '@wings/shared';
import { useEffect, useState } from 'react';
import { Chart3D } from '../charts3d/Chart3D.js';
import { COMPARISON_SLOT, HEAT_EMPTY, HEAT_RAMP, heatStep } from '../charts3d/spec.js';
import { BRAZIL_STATES, BRAZIL_VIEWBOX } from './brazil-map.js';
import { ChartTable } from './charts3d.js';
import {
  formatDateTime,
  formatDayShort,
  statusSummaryText,
  formatInt,
  formatMoney,
  formatPercentMilli,
  formatSignedPercent,
} from './format.js';

/**
 * Cockpit: the executive screen, in the graphite look Eric approved on
 * 2026-09-28. Big figures that count up, the funnel that fills in, the days
 * against the window before as orange areas, Brazil by state on IBGE's
 * outlines, the creatives that worked and what needs a look. Every figure
 * comes from the API; a missing one shows "—" and why. Every animation gives
 * way to `prefers-reduced-motion`.
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
  why,
  note,
}: {
  label: string;
  value: number | null;
  previous: number | null;
  format: (value: number) => string;
  better: Better;
  big?: boolean;
  /** Shown under a "—", so an empty figure always says why. */
  why?: string | null;
  /** Always shown under the figure (when it was read, for spend). */
  note?: string | null;
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
      {value === null && why && <span className="kpi-why muted">{why}</span>}
      {note && <span className="kpi-why muted">{note}</span>}
    </div>
  );
}

const cpl = (figures: CockpitFigures) =>
  figures.leads > 0 ? figures.spendCents / figures.leads : null;
const ctr = (figures: CockpitFigures) =>
  figures.impressions > 0 ? (figures.clicks / figures.impressions) * 100_000 : null;

function Funnel({
  figures,
  selection,
}: {
  figures: CockpitFigures;
  selection: DashboardCockpit['selection'];
}) {
  const steps = [
    { label: 'Impressões', count: figures.impressions, why: '' },
    { label: 'Cliques', count: figures.clicks, why: '' },
    {
      label: 'Sessões',
      count: figures.sessions,
      why: selection?.why.sessions ?? 'GA4 ainda não conectado',
    },
    { label: 'Leads', count: figures.leads, why: '' },
    { label: 'Leads no CRM', count: figures.crmLeads, why: selection?.why.crmLeads ?? '' },
    { label: 'Reuniões', count: figures.meetings, why: selection?.why.meetings ?? '' },
    { label: 'Vendas', count: figures.sales, why: selection?.why.sales ?? '' },
  ];
  const drawn = steps.filter(
    (step): step is typeof step & { count: number } => step.count !== null,
  );
  return (
    <Chart3D
      height={Math.min(320, 70 + drawn.length * 36)}
      ariaLabel="Funil das campanhas do filtro, da impressão à venda, em escala logarítmica"
      spec={{
        kind: 'funnel',
        log: true,
        stages: drawn.map((step) => ({ label: step.label, value: step.count })),
        format: 'int',
        totalLabel: 'das impressões',
        shareBase: figures.impressions || undefined,
      }}
      table={
        <ChartTable
          caption="Funil: quantidade e custo de cada etapa"
          head={['Etapa', 'Quantidade', 'Custo por etapa']}
          rows={steps.map((step) => ({
            key: step.label,
            neutral: step.count === null,
            cells: [
              step.label,
              step.count === null ? `— (${step.why || 'sem dado'})` : formatInt(step.count),
              step.count === null
                ? '—'
                : step.count > 0
                  ? formatMoney(Math.round(figures.spendCents / step.count))
                  : '— (nenhum no período)',
            ],
          }))}
        />
      }
    />
  );
}

/** Brazil on IBGE's state outlines; spend in the orange ramp's five steps, a balloon on the state with the most. */
function StateMap({ data }: { data: DashboardCockpit }) {
  const byUf = new Map(data.regions.map((region) => [region.uf, region]));
  const max = Math.max(1, ...data.regions.map((region) => region.spendCents));
  const topRegion = data.regions[0] ?? null;
  const topState = topRegion ? BRAZIL_STATES.find((state) => state.uf === topRegion.uf) : undefined;
  const [minX, minY, width, height] = BRAZIL_VIEWBOX.split(' ').map(Number) as [
    number,
    number,
    number,
    number,
  ];
  const balloon = topRegion
    ? `${topRegion.uf} ${formatMoney(topRegion.spendCents)} · ${formatInt(topRegion.leads)} lead(s)`
    : '';
  // The balloon is HTML over the map, so it reads at the page's size; it
  // opens to the left when the state sits in the map's right half.
  const left = topState ? ((topState.cx - minX) / width) * 100 : 0;
  const top = topState ? ((topState.cy - minY) / height) * 100 : 0;
  return (
    <figure className="cockpit-map">
      {data.regions.length === 0 ? (
        <p className="muted">— Nenhuma entrega com estado informado no período.</p>
      ) : null}
      <div className="cockpit-map-canvas">
        <svg
          viewBox={`${minX} ${minY} ${width} ${height}`}
          role="img"
          aria-label={`Gasto por estado: ${data.regions.map((region) => `${region.uf} ${formatMoney(region.spendCents)}`).join(', ') || 'sem entrega'}`}
        >
          <defs>
            <filter id="cockpit-glow" x="-50%" y="-50%" width="200%" height="200%">
              <feGaussianBlur stdDeviation="0.35" result="blur" />
              <feMerge>
                <feMergeNode in="blur" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>
          </defs>
          <g transform="scale(0.0001,-0.0001)">
            {BRAZIL_STATES.map((state) => {
              const region = byUf.get(state.uf);
              const step = region ? heatStep(region.spendCents, max) : 0;
              return (
                <path
                  key={state.uf}
                  d={state.d}
                  className={region ? 'cockpit-uf cockpit-uf-on' : 'cockpit-uf'}
                  // Five steps of the state with the most; grey without delivery.
                  style={{ fill: step ? HEAT_RAMP[step - 1] : HEAT_EMPTY }}
                  filter={region ? 'url(#cockpit-glow)' : undefined}
                >
                  <title>
                    {state.uf}
                    {region
                      ? `: ${formatMoney(region.spendCents)}, ${region.leads} lead(s)`
                      : ': sem entrega'}
                  </title>
                </path>
              );
            })}
          </g>
          {topState && (
            <circle cx={topState.cx} cy={topState.cy} r={0.45} className="cockpit-pin" />
          )}
        </svg>
        {topState && (
          <span
            className={`cockpit-balloon ${left > 55 ? 'cockpit-balloon-left' : ''}`}
            style={{ left: `${left}%`, top: `${top}%` }}
          >
            {balloon}
          </span>
        )}
      </div>
      <figcaption className="cell-sub">
        Contornos: malha pública do IBGE. As plataformas informam a região por estado: dentro do RJ
        não há recorte por cidade ou bairro.
        {data.otherRegionsSpendCents > 0 &&
          ` Fora de um estado (desconhecido): ${formatMoney(data.otherRegionsSpendCents)}.`}
      </figcaption>
      {data.regions.length > 0 && (
        <Chart3D
          height={Math.min(300, 70 + Math.min(data.regions.length, 6) * 38)}
          ariaLabel="Gasto por estado"
          spec={{
            kind: 'ranked',
            items: data.regions.map((region) => ({ label: region.uf, value: region.spendCents })),
            format: 'brl',
            totalLabel: 'do gasto com estado',
          }}
          table={
            <ChartTable
              caption="Gasto e leads por estado"
              head={['Estado', 'Gasto', 'Leads']}
              rows={data.regions.map((region) => ({
                key: region.uf,
                cells: [region.uf, formatMoney(region.spendCents), formatInt(region.leads)],
              }))}
            />
          }
        />
      )}
    </figure>
  );
}

/** Days of values: the period as an orange area, the period before as a dashed line. */
function AreaChart({
  days,
  current,
  previous,
  format,
  label,
  currentLabel,
  previousLabel,
}: {
  days: string[];
  current: number[];
  previous: number[];
  format: 'brl' | 'int';
  label: string;
  currentLabel: string;
  previousLabel: string;
}) {
  const show = (value: number | undefined) =>
    value === undefined
      ? '—'
      : format === 'brl'
        ? formatMoney(Math.round(value))
        : formatInt(value);
  return (
    <Chart3D
      height={230}
      ariaLabel={label}
      spec={{
        kind: 'line',
        categories: days.map(formatDayShort),
        series: [
          { name: currentLabel, values: current, area: true, slot: 0 },
          { name: previousLabel, values: previous, dashed: true, slot: COMPARISON_SLOT },
        ],
        format,
      }}
      table={
        <ChartTable
          caption={label}
          head={['Dia', currentLabel, previousLabel]}
          rows={days.map((day, index) => ({
            key: day,
            cells: [formatDayShort(day), show(current[index]), show(previous[index])],
          }))}
        />
      }
    />
  );
}

/** Performance ativa: the active campaigns judged by the RD leads they brought since 28/09. */
function ActivePerformance({
  data,
  spendReadAt,
}: {
  data: DashboardCockpit['activePerformance'];
  spendReadAt: string | null;
}) {
  const cell = (label: string, value: string, why?: string) => (
    <div className="kpi" key={label}>
      <span className="kpi-label">{label}</span>
      <span className="kpi-value mono">{value}</span>
      {why && <span className="kpi-delta muted">{why}</span>}
    </div>
  );
  const money = (cents: number | null, why: string) =>
    cents === null ? { value: '—', why } : { value: formatMoney(cents), why: undefined };
  const cpl = money(data.costPerLeadCents, 'sem lead no CRM ainda');
  const cpq = money(data.costPerQualifiedCents, 'sem lead qualificado ainda');
  const cac = money(data.cacCents, 'sem venda "Ganho" ainda');
  return (
    <section className="cockpit-card cockpit-active" aria-labelledby="cockpit-active">
      <h2 id="cockpit-active">
        Performance ativa desde {formatDayShort(data.since)}{' '}
        {data.smallSample && <span className="status status-on_leave">Amostra pequena</span>}
      </h2>
      <p className="cell-sub">
        Campanhas ativas julgadas pelos leads do RD CRM (Funil Formatação, sem negócios de teste),
        os mesmos da tela Leads das Campanhas.
        {data.fetchedAt
          ? ` Dados do RD ${formatDateTime(data.fetchedAt)}.`
          : ' A conferência do RD ainda não rodou.'}
      </p>
      <div className="cockpit-kpis">
        {cell(
          'Investimento',
          formatMoney(data.spendCents),
          spendReadAt ? `lido em ${formatDateTime(spendReadAt)}` : undefined,
        )}
        {cell('Leads no CRM', formatInt(data.leads))}
        {cell('CPL', cpl.value, cpl.why)}
        {cell('Qualificados', formatInt(data.qualified))}
        {cell('Custo por qualificado', cpq.value, cpq.why)}
        {cell('Vendas', formatInt(data.sales))}
        {cell('CAC', cac.value, cac.why)}
        {cell(
          'ROAS',
          data.roasCentuple === null
            ? '—'
            : `${(data.roasCentuple / 100).toFixed(2).replace('.', ',')}×`,
          data.roasCentuple === null ? 'sem venda "Ganho" ainda' : undefined,
        )}
      </div>
    </section>
  );
}

const SEVERITY_LABEL = { critical: 'Crítico', warning: 'Atenção', info: 'Aviso' } as const;

export function CockpitTab({ data }: { data: DashboardCockpit }) {
  const { current, previous } = data;
  const dayList = data.daily.map((day) => day.day);
  const currentLabel = `${formatDayShort(data.since)} a ${formatDayShort(data.until)}`;
  const previousLabel = `período anterior (${formatDayShort(data.previousSince)} a ${formatDayShort(data.previousUntil)})`;
  const spendNow = data.daily.map((day) => day.spendCents);
  const spendBefore = data.daily.map((day) => day.previousSpendCents);
  const leadsNow = data.daily.map((day) => day.leads);
  const leadsBefore = data.daily.map((day) => day.previousLeads);
  const hasAny = (values: number[]) => values.some((value) => value > 0);
  const scopeAll = data.campaignScope === 'todas';
  const statusNote = statusSummaryText(data.statusSummary);

  return (
    <div className="cockpit cockpit-grafite">
      <section className="cockpit-scope" aria-label="Campanhas somadas">
        {data.activeCampaigns.length === 0 ? (
          <p className="muted">
            {scopeAll
              ? 'Nenhuma campanha entregou no período: os números abaixo ficam zerados.'
              : 'Nenhuma campanha ativa agora: os números abaixo ficam zerados.'}
          </p>
        ) : (
          <p>
            <b>
              {scopeAll ? 'Todas as campanhas do período' : 'Só campanhas ativas'} (
              {data.activeCampaigns.length}):
            </b>{' '}
            {!scopeAll && statusNote && <span className="cell-sub">{statusNote} · </span>}
            {data.activeCampaigns.map((campaign, index) => (
              <span key={`${campaign.platform}:${campaign.externalId}`}>
                {index > 0 && ' · '}
                {campaign.name}{' '}
                <span className="cell-sub">
                  ({AD_PLATFORM_LABEL[campaign.platform]}
                  {campaign.delivering ? '' : ', pausada ou encerrada'})
                </span>
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

      <ActivePerformance data={data.activePerformance} spendReadAt={data.spendReadAt} />

      <section className="cockpit-kpis" aria-label="Indicadores do período">
        <Kpi
          big
          label="Investimento"
          value={current.spendCents}
          previous={previous.spendCents}
          format={(v) => formatMoney(Math.round(v))}
          better="up"
          note={data.spendReadAt ? `lido em ${formatDateTime(data.spendReadAt)}` : null}
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
          why={data.selection?.why.sessions ?? 'GA4 ainda não conectado'}
          value={current.sessions}
          previous={previous.sessions}
          format={(v) => formatInt(Math.round(v))}
          better="up"
        />
        <Kpi
          label="Reuniões"
          why={data.selection?.why.meetings}
          value={current.meetings}
          previous={previous.meetings}
          format={(v) => formatInt(Math.round(v))}
          better="up"
        />
        <Kpi
          label="Vendas"
          why={data.selection?.why.sales}
          value={current.sales}
          previous={previous.sales}
          format={(v) => formatInt(Math.round(v))}
          better="up"
        />
      </section>

      <div className="cockpit-grid">
        <section className="cockpit-card" aria-labelledby="cockpit-evolution">
          <h2 id="cockpit-evolution">Evolução diária</h2>
          <h3 className="cockpit-sub-title">Investimento por dia</h3>
          {hasAny(spendNow) || hasAny(spendBefore) ? (
            <AreaChart
              days={dayList}
              current={spendNow}
              previous={spendBefore}
              format="brl"
              label="Investimento por dia contra o período anterior"
              currentLabel={currentLabel}
              previousLabel={previousLabel}
            />
          ) : (
            <p className="cockpit-empty">
              — Sem gasto registrado nas campanhas do filtro, nem neste período nem no anterior.
            </p>
          )}
          <h3 className="cockpit-sub-title">Leads por dia (plataformas)</h3>
          {hasAny(leadsNow) || hasAny(leadsBefore) ? (
            <AreaChart
              days={dayList}
              current={leadsNow}
              previous={leadsBefore}
              format="int"
              label="Leads por dia contra o período anterior"
              currentLabel={currentLabel}
              previousLabel={previousLabel}
            />
          ) : (
            <p className="cockpit-empty">
              — As plataformas não contaram nenhum lead nas campanhas do filtro, neste período nem
              no anterior.
            </p>
          )}
        </section>

        <section className="cockpit-card" aria-labelledby="cockpit-funnel">
          <h2 id="cockpit-funnel">Funil</h2>
          <Funnel figures={current} selection={data.selection} />
          <p className="cell-sub">
            Meta e Google somados; CRM pelas etiquetas do RD. O custo de cada etapa (gasto ÷
            quantidade) está na tabela. Escala logarítmica. Detalhes na aba Funil.
          </p>
        </section>

        <section className="cockpit-card" aria-labelledby="cockpit-map">
          <h2 id="cockpit-map">Onde o dinheiro foi</h2>
          <StateMap data={data} />
        </section>

        <section className="cockpit-card" aria-labelledby="cockpit-creatives">
          <h2 id="cockpit-creatives">Criativos que mais trouxeram leads</h2>
          {data.creatives.length === 0 ? (
            <p className="muted">— Nenhum anúncio das campanhas do filtro entregou no período.</p>
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
            <p className="muted">
              Nenhum alerta aberto {scopeAll ? 'nas campanhas do período' : 'nas campanhas ativas'}.
            </p>
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
