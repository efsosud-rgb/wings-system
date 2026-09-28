import {
  AD_ISSUE_LABEL,
  AD_PLATFORM_LABEL,
  BRAZIL_STATE_TILES,
  HEALTH_ITEM_LABEL,
  HEALTH_STATE_LABEL,
  MIRRORED_FORMAT_LABEL,
  ratiosOf,
  type CockpitCampaign,
  type CockpitFigures,
  type DashboardCockpit,
  type DashboardOverview,
  type DashboardSite,
  type SiteTrafficRow,
} from '@wings/shared';
import { useEffect, useState, type ReactNode } from 'react';
import { DailyLines } from './charts.js';
import {
  formatCompact,
  formatDateTime,
  formatDayShort,
  formatInt,
  formatMoney,
  formatPercentMilli,
  formatSignedPercent,
} from './format.js';

/**
 * Cockpit: the executive screen, drawn as a tilted neon panel over an
 * isometric base. Only the look changed in this step: every figure is the
 * one the API computes, a missing one shows "—" with the reason, and a
 * change is only shown against a real previous window. Under 1100 px the
 * panel lies flat and the cards stack; `prefers-reduced-motion` stops every
 * animation and shows the final state.
 */

const FONT_HREF =
  'https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;600&family=Sora:wght@400;600;700&display=swap';

/** The two faces, loaded once and only when the Cockpit opens. */
function useCockpitFonts() {
  useEffect(() => {
    if (typeof document === 'undefined' || document.querySelector(`link[href="${FONT_HREF}"]`))
      return;
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = FONT_HREF;
    document.head.appendChild(link);
  }, []);
}

function reducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true
  );
}

/** Counts from 0 to `target` in ~0.9 s, easing out; jumps straight there with reduced motion. */
export function useCountUp(target: number, duration = 900): number {
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

/** False on the first paint, true right after: lets widths, arcs and needles animate in. */
function useEntered(): boolean {
  const [entered, setEntered] = useState(reducedMotion());
  useEffect(() => {
    const id = setTimeout(() => setEntered(true), 40);
    return () => clearTimeout(id);
  }, []);
  return entered;
}

/** A number that counts up, or "—" and why. */
function Figure({
  value,
  format,
  why,
  className = '',
  label,
}: {
  value: number | null;
  format: (value: number) => string;
  why?: string;
  className?: string;
  label: string;
}) {
  const shown = useCountUp(value ?? 0);
  return (
    <>
      <span
        className={`neon-figure ${className}`}
        aria-label={`${label}: ${value === null ? 'sem dado' : format(value)}`}
      >
        {value === null ? '—' : format(shown)}
      </span>
      {value === null && why && <span className="neon-why">{why}</span>}
    </>
  );
}

type Better = 'up' | 'down';

/** Against the previous window, only when that window really had the figure. */
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
    return <span className="neon-delta neon-muted">sem período anterior para comparar</span>;
  }
  const change = Math.round(((current - previous) / previous) * 100);
  const good = change === 0 ? null : change > 0 === (better === 'up');
  return (
    <span
      className={`neon-delta ${good === null ? 'neon-muted' : good ? 'neon-good' : 'neon-bad'}`}
    >
      {change > 0 ? '▲' : change < 0 ? '▼' : '•'} {formatSignedPercent(change)} contra o período
      anterior
    </span>
  );
}

function Card({
  title,
  span,
  children,
  className = '',
  id,
}: {
  title: ReactNode;
  span: number;
  children: ReactNode;
  className?: string;
  id: string;
}) {
  return (
    <section className={`neon-card neon-span-${span} ${className}`} aria-labelledby={id}>
      <h2 id={id}>{title}</h2>
      <div className="neon-card-body">{children}</div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Isometric drawing
// ---------------------------------------------------------------------------

const COS = Math.cos(Math.PI / 6);
const SIN = 0.5;
const isoXY = (x: number, y: number, z: number): [number, number] => [
  (x - y) * COS,
  (x + y) * SIN - z,
];
const iso = (x: number, y: number, z: number) =>
  isoXY(x, y, z)
    .map((n) => n.toFixed(1))
    .join(',');

type Tone = 'cyan' | 'orange' | 'green' | 'amber' | 'red' | 'violet';

/** A box standing on (x, y), w along x, d along y, h up; three shaded faces. */
function IsoBox({
  x,
  y,
  w,
  d,
  h,
  tone,
  delay = 0,
  className = '',
}: {
  x: number;
  y: number;
  w: number;
  d: number;
  h: number;
  tone: Tone;
  delay?: number;
  className?: string;
}) {
  const top = [iso(x, y, h), iso(x + w, y, h), iso(x + w, y + d, h), iso(x, y + d, h)].join(' ');
  const left = [
    iso(x, y + d, 0),
    iso(x + w, y + d, 0),
    iso(x + w, y + d, h),
    iso(x, y + d, h),
  ].join(' ');
  const right = [
    iso(x + w, y, 0),
    iso(x + w, y + d, 0),
    iso(x + w, y + d, h),
    iso(x + w, y, h),
  ].join(' ');
  return (
    <g className={`iso-box iso-${tone} ${className}`} style={{ animationDelay: `${delay}ms` }}>
      <polygon points={left} className="iso-left" />
      <polygon points={right} className="iso-right" />
      <polygon points={top} className="iso-top" />
    </g>
  );
}

// ---------------------------------------------------------------------------
// Cards
// ---------------------------------------------------------------------------

function Donut({ meta, google }: { meta: number; google: number }) {
  const entered = useEntered();
  const total = meta + google;
  const r = 38;
  const length = 2 * Math.PI * r;
  const metaShare = total > 0 ? meta / total : 0;
  return (
    <figure className="neon-donut">
      <svg
        viewBox="0 0 100 100"
        role="img"
        aria-label={`Meta ${formatMoney(meta)}, Google ${formatMoney(google)}`}
      >
        <circle cx={50} cy={50} r={r} className="donut-track" />
        {total > 0 && (
          <>
            <circle
              cx={50}
              cy={50}
              r={r}
              className="donut-google"
              strokeDasharray={`${entered ? length : 0} ${length}`}
            />
            <circle
              cx={50}
              cy={50}
              r={r}
              className="donut-meta"
              strokeDasharray={`${entered ? length * metaShare : 0} ${length}`}
            />
          </>
        )}
      </svg>
      <figcaption>
        <span>
          <i className="dot dot-cyan" /> Meta {total > 0 ? `${Math.round(metaShare * 100)}%` : '—'}
        </span>
        <span>
          <i className="dot dot-orange" /> Google{' '}
          {total > 0 ? `${100 - Math.round(metaShare * 100)}%` : '—'}
        </span>
      </figcaption>
    </figure>
  );
}

function InvestmentCard({
  data,
  overview,
}: {
  data: DashboardCockpit;
  overview: DashboardOverview | null;
}) {
  const google = overview?.strips.find((strip) => strip.source === 'google');
  return (
    <Card title="Investimento" span={4} id="neon-investment">
      <div className="neon-invest">
        <div>
          <Figure
            label="Investimento no período"
            value={data.current.spendCents}
            format={(v) => formatMoney(Math.round(v))}
            className="neon-figure-xl"
          />
          <Delta
            current={data.current.spendCents}
            previous={data.previous.spendCents}
            better="up"
          />
          <p className="neon-sub">
            {formatDayShort(data.since)} a {formatDayShort(data.until)}, só campanhas ativas
          </p>
        </div>
        <Donut meta={data.spendByPlatform.meta} google={data.spendByPlatform.google} />
      </div>
      <div className="neon-line">
        <span>Saldo pré-pago Google</span>
        {google?.balance !== null && google?.balance !== undefined ? (
          <b className="neon-mono">{formatMoney(google.balance)}</b>
        ) : (
          <span className="neon-why">
            {google?.configured ? 'o Google não informou saldo' : 'resumo do Google indisponível'}
          </span>
        )}
      </div>
    </Card>
  );
}

function CplGauge({ data }: { data: DashboardCockpit }) {
  const entered = useEntered();
  const value = data.activePerformance.costPerLeadCents;
  const target = data.cplTargetCents;
  const platformCpl =
    data.current.leads > 0 ? Math.round(data.current.spendCents / data.current.leads) : null;
  const max = target ? target * 2 : 1;
  // -90° (zero) to +90° (twice the target), clamped at the end.
  const angle = value !== null && target ? Math.min(90, -90 + (value / max) * 180) : -90;
  const arc = (from: number, to: number) => {
    const point = (share: number) => {
      const a = Math.PI * (1 - share);
      return `${(60 + 48 * Math.cos(a)).toFixed(1)},${(60 - 48 * Math.sin(a)).toFixed(1)}`;
    };
    return `M${point(from)} A48,48 0 0 1 ${point(to)}`;
  };
  const tone =
    value === null || !target
      ? 'neon-muted'
      : value <= target
        ? 'neon-good'
        : value <= target * 1.3
          ? 'neon-warn'
          : 'neon-bad';
  return (
    <Card title="Custo por lead (CRM)" span={4} id="neon-cpl">
      <figure className="neon-gauge">
        <svg
          viewBox="0 0 120 68"
          role="img"
          aria-label={`CPL ${formatMoney(value)}; meta ${formatMoney(target)}`}
        >
          {target ? (
            <>
              <path d={arc(0, 0.5)} className="gauge-green" />
              <path d={arc(0.5, 0.65)} className="gauge-amber" />
              <path d={arc(0.65, 1)} className="gauge-red" />
            </>
          ) : (
            <path d={arc(0, 1)} className="gauge-off" />
          )}
          <g
            className="gauge-needle"
            style={{ transform: `rotate(${entered ? angle : -90}deg)` }}
            opacity={value !== null && target ? 1 : 0.25}
          >
            <line x1={60} y1={60} x2={60} y2={18} />
          </g>
          <circle cx={60} cy={60} r={4} className="gauge-hub" />
        </svg>
      </figure>
      <div className={`neon-gauge-value ${tone}`}>
        <Figure
          label="CPL pelos leads do CRM"
          value={value}
          format={(v) => formatMoney(Math.round(v))}
          why="sem lead das campanhas ativas no CRM ainda"
          className="neon-figure-lg"
        />
      </div>
      <div className="neon-line">
        <span>Meta de CPL</span>
        {target ? (
          <b className="neon-mono">{formatMoney(target)}</b>
        ) : (
          <span className="neon-why">nenhuma meta confirmada (Configurações)</span>
        )}
      </div>
      <div className="neon-line">
        <span>CPL pelas plataformas</span>
        {platformCpl !== null ? (
          <b className="neon-mono">{formatMoney(platformCpl)}</b>
        ) : (
          <span className="neon-why">as plataformas não contaram lead no período</span>
        )}
      </div>
      <p className="neon-sub">Verde até a meta, âmbar até 1,3× a meta, vermelho acima.</p>
    </Card>
  );
}

/** Performance ativa: the active campaigns judged by the RD leads they brought since 28/09. */
function ActivePerformance({ data }: { data: DashboardCockpit['activePerformance'] }) {
  const money = (cents: number | null, why: string) =>
    cents === null ? { value: '—', why } : { value: formatMoney(cents), why: undefined };
  const cpl = money(data.costPerLeadCents, 'sem lead no CRM ainda');
  const cpq = money(data.costPerQualifiedCents, 'sem lead qualificado ainda');
  const cac = money(data.cacCents, 'sem venda "Ganho" ainda');
  const rows: [string, string, string | undefined][] = [
    ['Investimento', formatMoney(data.spendCents), undefined],
    ['Leads no CRM', formatInt(data.leads), undefined],
    ['CPL', cpl.value, cpl.why],
    ['Qualificados', formatInt(data.qualified), undefined],
    ['Custo por qualificado', cpq.value, cpq.why],
    ['Vendas', formatInt(data.sales), undefined],
    ['CAC', cac.value, cac.why],
    [
      'ROAS',
      data.roasCentuple === null
        ? '—'
        : `${(data.roasCentuple / 100).toFixed(2).replace('.', ',')}×`,
      data.roasCentuple === null ? 'sem venda "Ganho" ainda' : undefined,
    ],
  ];
  return (
    <Card
      span={4}
      id="cockpit-active"
      title={
        <>
          Performance ativa desde {formatDayShort(data.since)}{' '}
          {data.smallSample && <span className="neon-badge">Amostra pequena</span>}
        </>
      }
    >
      <dl className="neon-list">
        {rows.map(([label, value, why]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>
              <b className="neon-mono">{value}</b>
              {why && <span className="neon-why">{why}</span>}
            </dd>
          </div>
        ))}
      </dl>
      <p className="neon-sub">
        Leads do RD CRM (Funil Formatação, sem negócios de teste).{' '}
        {data.fetchedAt
          ? `Dados do RD ${formatDateTime(data.fetchedAt)}.`
          : 'A conferência do RD ainda não rodou.'}
      </p>
    </Card>
  );
}

const ctrOf = (figures: CockpitFigures) =>
  figures.impressions > 0 ? Math.round((figures.clicks / figures.impressions) * 100_000) : null;
const cpcOf = (figures: CockpitFigures) =>
  figures.clicks > 0 ? Math.round(figures.spendCents / figures.clicks) : null;

function DeliveryCard({ data }: { data: DashboardCockpit }) {
  const { current, previous } = data;
  const blocks: {
    label: string;
    value: number | null;
    previous: number | null;
    format: (v: number) => string;
    better: Better;
    why?: string;
  }[] = [
    {
      label: 'Impressões',
      value: current.impressions,
      previous: previous.impressions,
      format: (v) => formatCompact(Math.round(v)),
      better: 'up',
    },
    {
      label: 'Alcance',
      value: null,
      previous: null,
      format: formatCompact,
      better: 'up',
      why: 'o alcance do período não é a soma dos dias; ainda não é lido',
    },
    {
      label: 'Frequência',
      value: null,
      previous: null,
      format: formatCompact,
      better: 'down',
      why: 'depende do alcance do período',
    },
    {
      label: 'Cliques',
      value: current.clicks,
      previous: previous.clicks,
      format: (v) => formatInt(Math.round(v)),
      better: 'up',
    },
    {
      label: 'CTR',
      value: ctrOf(current),
      previous: ctrOf(previous),
      format: (v) => formatPercentMilli(Math.round(v)),
      better: 'up',
      why: 'sem impressão no período',
    },
    {
      label: 'CPC',
      value: cpcOf(current),
      previous: cpcOf(previous),
      format: (v) => formatMoney(Math.round(v)),
      better: 'down',
      why: 'sem clique no período',
    },
  ];
  return (
    <Card title="Entrega" span={6} id="neon-delivery">
      <div className="neon-blocks">
        {blocks.map((block) => (
          <div key={block.label} className="neon-block">
            <span className="neon-label">{block.label}</span>
            <Figure
              label={block.label}
              value={block.value}
              format={block.format}
              why={block.why}
              className="neon-figure-lg"
            />
            {block.value !== null && (
              <Delta current={block.value} previous={block.previous} better={block.better} />
            )}
          </div>
        ))}
      </div>
    </Card>
  );
}

function FunnelCard({ figures }: { figures: CockpitFigures }) {
  const entered = useEntered();
  const steps: { label: string; count: number | null; tone: Tone }[] = [
    { label: 'Impressões', count: figures.impressions, tone: 'cyan' },
    { label: 'Cliques', count: figures.clicks, tone: 'cyan' },
    { label: 'Sessões', count: figures.sessions, tone: 'cyan' },
    { label: 'Leads (plataformas)', count: figures.leads, tone: 'orange' },
    { label: 'Leads no CRM', count: figures.crmLeads, tone: 'orange' },
    { label: 'Reuniões', count: figures.meetings, tone: 'green' },
    { label: 'Vendas', count: figures.sales, tone: 'green' },
  ];
  const top = Math.log10(Math.max(1, figures.impressions) + 1);
  const width = (count: number | null) =>
    count ? Math.max(3, (Math.log10(count + 1) / top) * 100) : 0;
  return (
    <Card title="Funil" span={6} id="cockpit-funnel">
      <ol className="neon-funnel">
        {steps.map((step, index) => {
          const before = index > 0 ? steps[index - 1]!.count : null;
          const rate = before && step.count !== null ? (step.count / before) * 100 : null;
          return (
            <li key={step.label}>
              <span className="neon-funnel-label">{step.label}</span>
              <span className="neon-bar3d-track" aria-hidden="true">
                <span
                  className={`neon-bar3d neon-bar3d-${step.tone}`}
                  style={{
                    width: entered ? `${width(step.count)}%` : '0%',
                    transitionDelay: `${index * 80}ms`,
                  }}
                />
              </span>
              <b className="neon-mono">{step.count === null ? '—' : formatInt(step.count)}</b>
              <span className="neon-funnel-rate neon-sub">
                {step.count === null
                  ? 'GA4 não conectado'
                  : rate !== null
                    ? `${rate < 1 ? rate.toFixed(2).replace('.', ',') : Math.round(rate)}% da anterior`
                    : ''}
              </span>
            </li>
          );
        })}
      </ol>
      <p className="neon-sub">Escala logarítmica: cada etapa é muito menor que a anterior.</p>
    </Card>
  );
}

function AdsColumns({ data }: { data: DashboardCockpit }) {
  const ads = data.creatives.slice(0, 5);
  const metrics: {
    key: string;
    label: string;
    tone: Tone;
    pick: (ad: DashboardCockpit['creatives'][number]) => number | null;
    format: (value: number | null) => string;
  }[] = [
    {
      key: 'ctr',
      label: 'CTR',
      tone: 'cyan',
      pick: (ad) => ratiosOf(ad.totals).ctrMilli,
      format: formatPercentMilli,
    },
    {
      key: 'spend',
      label: 'Gasto',
      tone: 'orange',
      pick: (ad) => ad.totals.spendCents,
      format: formatMoney,
    },
    {
      key: 'clicks',
      label: 'Cliques',
      tone: 'green',
      pick: (ad) => ad.totals.clicks,
      format: formatInt,
    },
    {
      key: 'cpc',
      label: 'CPC',
      tone: 'amber',
      pick: (ad) => ratiosOf(ad.totals).cpcCents,
      format: formatMoney,
    },
  ];
  const values = ads.map((ad) => metrics.map((metric) => metric.pick(ad)));
  const maxOf = (index: number) => Math.max(1, ...values.map((row) => row[index] ?? 0));
  return (
    <Card title="Anúncios que estão rodando" span={8} id="cockpit-creatives">
      {ads.length === 0 ? (
        <p className="neon-why">Nenhum anúncio das campanhas ativas entregou no período.</p>
      ) : (
        <>
          <div className="neon-ads">
            {ads.map((ad, adIndex) => (
              <figure key={`${ad.platform}:${ad.adExternalId}`} className="neon-ad">
                {ad.thumbnailUrl ? (
                  <img className="neon-thumb" src={ad.thumbnailUrl} alt="" loading="lazy" />
                ) : (
                  <span className="neon-thumb neon-thumb-empty" aria-hidden="true">
                    {AD_PLATFORM_LABEL[ad.platform]}
                  </span>
                )}
                <svg
                  viewBox="-62 -78 118 96"
                  role="img"
                  aria-label={metrics
                    .map(
                      (metric, index) =>
                        `${metric.label} ${metric.format(values[adIndex]![index] ?? null)}`,
                    )
                    .join(', ')}
                >
                  {metrics.map((metric, index) => (
                    <IsoBox
                      key={metric.key}
                      x={index * 16 - 30}
                      y={0}
                      w={11}
                      d={11}
                      h={Math.max(1.5, ((values[adIndex]![index] ?? 0) / maxOf(index)) * 60)}
                      tone={metric.tone}
                      delay={adIndex * 80 + index * 40}
                      className="iso-grow"
                    />
                  ))}
                </svg>
                <figcaption>
                  <span className="neon-ad-name">{ad.name}</span>
                  <span className="neon-sub">
                    {AD_PLATFORM_LABEL[ad.platform]} · {MIRRORED_FORMAT_LABEL[ad.format]}
                  </span>
                  <span className="neon-ad-figures">
                    {metrics.map((metric, index) => (
                      <span key={metric.key}>
                        <i className={`dot dot-${metric.tone}`} /> {metric.label}{' '}
                        <b className="neon-mono">
                          {metric.format(values[adIndex]![index] ?? null)}
                        </b>
                      </span>
                    ))}
                  </span>
                </figcaption>
              </figure>
            ))}
          </div>
          <p className="neon-sub">Cada cor na escala da sua medida, entre os anúncios mostrados.</p>
        </>
      )}
    </Card>
  );
}

/** GA4 source/medium, in the words a person uses. */
export function channelOf(row: Pick<SiteTrafficRow, 'source' | 'medium'>): string {
  const source = row.source.toLowerCase();
  const medium = row.medium.toLowerCase();
  const paid = /cpc|ppc|paid|ads/.test(medium);
  if (paid && /facebook|instagram|\bfb\b|\big\b|meta/.test(source)) return 'Meta pago';
  if (paid && /google|youtube/.test(source)) return 'Google pago';
  if (paid) return 'Outros pagos';
  if (medium === 'organic') return 'Busca orgânica';
  if (source === '(direct)' || medium === '(none)') return 'Direto';
  if (/social|facebook|instagram/.test(`${source} ${medium}`)) return 'Social orgânico';
  if (medium === 'referral') return 'Referência';
  return 'Outros';
}

export function sessionsByChannel(
  site: DashboardSite | null,
): { channel: string; sessions: number }[] {
  if (!site?.configured) return [];
  const sums = new Map<string, number>();
  for (const row of site.rows)
    sums.set(channelOf(row), (sums.get(channelOf(row)) ?? 0) + row.sessions);
  return [...sums]
    .map(([channel, sessions]) => ({ channel, sessions }))
    .sort((a, b) => b.sessions - a.sessions);
}

function SessionsCard({ site }: { site: DashboardSite | null }) {
  const entered = useEntered();
  const channels = sessionsByChannel(site);
  const max = Math.max(1, ...channels.map((channel) => channel.sessions));
  return (
    <Card title="Sessões por canal (GA4)" span={4} id="neon-sessions">
      {!site?.configured ? (
        <p className="neon-why">
          — GA4 ainda não conectado: falta autorizar a leitura (consentimento OAuth) e o
          GA4_REFRESH_TOKEN no servidor.
        </p>
      ) : channels.length === 0 ? (
        <p className="neon-why">— O GA4 não devolveu sessões no período.</p>
      ) : (
        <ul className="neon-bars">
          {channels.map((channel) => (
            <li key={channel.channel}>
              <span>{channel.channel}</span>
              <span className="neon-bar">
                <span style={{ width: entered ? `${(channel.sessions / max) * 100}%` : '0%' }} />
              </span>
              <b className="neon-mono">{formatInt(channel.sessions)}</b>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

/** Share of the São Paulo day gone by: where today's spend would be if it were even. */
function dayShare(now = new Date()): number {
  const [hours = 0, minutes = 0] = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'America/Sao_Paulo',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  })
    .format(now)
    .split(':')
    .map(Number);
  return (hours * 60 + minutes) / 1440;
}

function PacingCard({ campaigns }: { campaigns: CockpitCampaign[] }) {
  const entered = useEntered();
  const expected = dayShare();
  return (
    <Card title="Campanhas ativas: ritmo do dia" span={5} id="neon-pacing">
      {campaigns.length === 0 ? (
        <p className="neon-why">Nenhuma campanha ativa agora.</p>
      ) : (
        <ul className="neon-pacing">
          {campaigns.map((campaign) => {
            const share = campaign.dailyBudgetCents
              ? campaign.spentTodayCents / campaign.dailyBudgetCents
              : null;
            return (
              <li key={`${campaign.platform}:${campaign.externalId}`}>
                <span className="neon-pacing-name">
                  <i
                    className={`dot ${campaign.platform === 'meta' ? 'dot-cyan' : 'dot-orange'}`}
                  />{' '}
                  {campaign.name}
                </span>
                {share === null ? (
                  <span className="neon-why">sem verba diária (orçamento total)</span>
                ) : (
                  <>
                    <span className="neon-bar neon-bar-pace">
                      <span
                        className={share > 1 ? 'pace-over' : ''}
                        style={{ width: entered ? `${Math.min(100, share * 100)}%` : '0%' }}
                      />
                      <i style={{ left: `${expected * 100}%` }} />
                    </span>
                    <span className="neon-sub">
                      {formatMoney(campaign.spentTodayCents)} de{' '}
                      {formatMoney(campaign.dailyBudgetCents)} hoje ({Math.round(share * 100)}%)
                    </span>
                  </>
                )}
              </li>
            );
          })}
        </ul>
      )}
      <p className="neon-sub">
        A marca vertical é a hora do dia: onde o gasto estaria se fosse igual ao longo das horas. O
        gasto de hoje é o que a última coleta leu.
      </p>
    </Card>
  );
}

const dayNumber = (day: string) => Date.parse(`${day}T12:00:00Z`) / 86_400_000;

function TimelineCard({ campaigns, today }: { campaigns: CockpitCampaign[]; today: string }) {
  const dated = campaigns.filter((campaign) => campaign.startDate);
  if (dated.length === 0) {
    return (
      <Card title="Linha do tempo das campanhas" span={7} id="neon-timeline">
        <p className="neon-why">
          — As plataformas ainda não informaram as datas das campanhas ativas.
        </p>
      </Card>
    );
  }
  const first = Math.min(
    dayNumber(today),
    ...dated.map((campaign) => dayNumber(campaign.startDate!)),
  );
  const last = Math.max(
    dayNumber(today) + 1,
    ...dated.map((campaign) => dayNumber(campaign.endDate ?? today) + 1),
  );
  const span = Math.max(1, last - first);
  const at = (day: number) => `${((day - first) / span) * 100}%`;
  return (
    <Card title="Linha do tempo das campanhas" span={7} id="neon-timeline">
      <div className="neon-timeline">
        {dated.map((campaign) => (
          <div key={`${campaign.platform}:${campaign.externalId}`} className="neon-timeline-row">
            <span className="neon-timeline-name">{campaign.name}</span>
            <span className="neon-timeline-track">
              <span
                className={campaign.platform === 'meta' ? 'tl-meta' : 'tl-google'}
                style={{
                  left: at(dayNumber(campaign.startDate!)),
                  width: `${((dayNumber(campaign.endDate ?? today) + 1 - dayNumber(campaign.startDate!)) / span) * 100}%`,
                }}
              />
              <i className="neon-today" style={{ left: at(dayNumber(today) + 0.5) }} />
            </span>
            <span className="neon-sub">
              {formatDayShort(campaign.startDate!)} →{' '}
              {campaign.endDate ? formatDayShort(campaign.endDate) : 'sem data de fim'}
            </span>
          </div>
        ))}
      </div>
      <p className="neon-sub">
        <i className="neon-today-key" /> hoje, {formatDayShort(today)}
      </p>
    </Card>
  );
}

function ScheduledBudgetCard({ campaigns }: { campaigns: CockpitCampaign[] }) {
  const byPlatform = { meta: 0, google: 0 };
  let known = 0;
  for (const campaign of campaigns) {
    if (!campaign.dailyBudgetCents) continue;
    known += 1;
    byPlatform[campaign.platform] += campaign.dailyBudgetCents;
  }
  return (
    <Card title="Verba diária programada" span={3} id="neon-budget">
      <Figure
        label="Verba diária das campanhas ativas"
        value={known ? byPlatform.meta + byPlatform.google : null}
        format={(v) => formatMoney(Math.round(v))}
        why="nenhuma campanha ativa com verba diária"
        className="neon-figure-xl"
      />
      <div className="neon-line">
        <span>
          <i className="dot dot-cyan" /> Meta
        </span>
        <b className="neon-mono">{formatMoney(byPlatform.meta)}</b>
      </div>
      <div className="neon-line">
        <span>
          <i className="dot dot-orange" /> Google
        </span>
        <b className="neon-mono">{formatMoney(byPlatform.google)}</b>
      </div>
    </Card>
  );
}

function TrackingCard({
  overview,
  site,
  leadsFetchedAt,
}: {
  overview: DashboardOverview | null;
  site: DashboardSite | null;
  leadsFetchedAt: string | null;
}) {
  const conversions = overview?.health.filter((item) => item.key === 'conversions_measuring') ?? [];
  const tone = (state: string) =>
    state === 'ok'
      ? 'neon-good'
      : state === 'attention'
        ? 'neon-warn'
        : state === 'problem'
          ? 'neon-bad'
          : 'neon-muted';
  const siteState = !site?.configured ? 'problem' : site.fetchedAt ? 'ok' : 'attention';
  return (
    <Card title="Saúde do rastreamento" span={4} id="neon-tracking">
      <ul className="neon-health">
        {conversions.map((item) => (
          <li key={`${item.platform}:${item.key}`}>
            <span className={`neon-state ${tone(item.state)}`}>
              {HEALTH_STATE_LABEL[item.state]}
            </span>
            <span>
              {HEALTH_ITEM_LABEL[item.key]}, {AD_PLATFORM_LABEL[item.platform]}
              <span className="neon-sub">{item.detail}</span>
            </span>
          </li>
        ))}
        {conversions.length === 0 && (
          <li>
            <span className="neon-state neon-muted">—</span>
            <span className="neon-why">o resumo das plataformas não carregou</span>
          </li>
        )}
        <li>
          <span className={`neon-state ${tone(siteState)}`}>{HEALTH_STATE_LABEL[siteState]}</span>
          <span>
            Site (GA4)
            <span className="neon-sub">
              {!site?.configured
                ? 'não conectado: falta o consentimento OAuth'
                : site.fetchedAt
                  ? `lido ${formatDateTime(site.fetchedAt)}`
                  : 'configurado, ainda sem leitura'}
            </span>
          </span>
        </li>
        <li>
          <span className={`neon-state ${tone(leadsFetchedAt ? 'ok' : 'attention')}`}>
            {HEALTH_STATE_LABEL[leadsFetchedAt ? 'ok' : 'attention']}
          </span>
          <span>
            RD CRM (leads)
            <span className="neon-sub">
              {leadsFetchedAt
                ? `conferido ${formatDateTime(leadsFetchedAt)}`
                : 'a conferência ainda não rodou'}
            </span>
          </span>
        </li>
      </ul>
    </Card>
  );
}

const SEVERITY_LABEL = { critical: 'Crítico', warning: 'Atenção', info: 'Aviso' } as const;

function AlertsCard({ data }: { data: DashboardCockpit }) {
  return (
    <Card title="Alertas abertos" span={5} id="cockpit-alerts">
      {data.alerts.length === 0 ? (
        <p className="neon-sub">Nenhum alerta aberto nas campanhas ativas.</p>
      ) : (
        <ul className="neon-alerts">
          {data.alerts.map((alert) => (
            <li key={alert.id} className={`neon-alert neon-alert-${alert.severity}`}>
              <b>{SEVERITY_LABEL[alert.severity]}</b> {alert.title}
              <span className="neon-sub">{AD_PLATFORM_LABEL[alert.platform]}</span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function StateMap({ data }: { data: DashboardCockpit }) {
  const byUf = new Map(data.regions.map((region) => [region.uf, region]));
  const max = Math.max(1, ...data.regions.map((region) => region.spendCents));
  const size = 44;
  const gap = 4;
  return (
    <Card title="Onde o dinheiro foi" span={4} id="cockpit-map">
      <figure className="neon-map">
        <svg
          viewBox={`0 0 ${8 * (size + gap)} ${9 * (size + gap)}`}
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
                  className={region ? 'neon-tile neon-tile-on' : 'neon-tile'}
                  style={region ? { fillOpacity: 0.25 + 0.75 * share } : undefined}
                />
                <text x={size / 2} y={size / 2 + 4} textAnchor="middle" className="neon-tile-label">
                  {state.uf}
                </text>
              </g>
            );
          })}
        </svg>
        <figcaption className="neon-sub">
          Cor mais forte, mais gasto. As plataformas informam a região por estado: dentro do RJ não
          há recorte por cidade.
          {data.otherRegionsSpendCents > 0 &&
            ` Fora de um estado: ${formatMoney(data.otherRegionsSpendCents)}.`}
        </figcaption>
        <ul className="neon-map-list">
          {data.regions.slice(0, 4).map((region) => (
            <li key={region.uf}>
              <b>{region.uf}</b> {formatMoney(region.spendCents)} · {formatInt(region.leads)}{' '}
              lead(s)
            </li>
          ))}
        </ul>
      </figure>
    </Card>
  );
}

function EvolutionCard({ data }: { data: DashboardCockpit }) {
  const series = (pick: 'spend' | 'leads') => [
    {
      key: 'now',
      label: `${formatDayShort(data.since)} a ${formatDayShort(data.until)}`,
      color: 'var(--neon-cyan)',
      points: data.daily.map((day) => ({
        day: day.day,
        amount: pick === 'spend' ? day.spendCents : day.leads,
      })),
    },
    {
      key: 'before',
      label: `anterior (${formatDayShort(data.previousSince)} a ${formatDayShort(data.previousUntil)})`,
      color: 'var(--neon-orange)',
      points: data.daily.map((day) => ({
        day: day.day,
        amount: pick === 'spend' ? day.previousSpendCents : day.previousLeads,
      })),
    },
  ];
  return (
    <Card title="Evolução diária" span={8} id="cockpit-evolution">
      <DailyLines
        series={series('spend')}
        format={(v) => formatMoney(v)}
        height={130}
        ariaLabel="Investimento por dia contra o período anterior"
      />
      <DailyLines
        series={series('leads')}
        format={(v) => formatInt(v)}
        height={90}
        ariaLabel="Leads por dia contra o período anterior"
      />
    </Card>
  );
}

// ---------------------------------------------------------------------------
// The isometric base under the panel
// ---------------------------------------------------------------------------

const COIN_CENTS = 5000;
const COINS_PER_STACK = 12;
const MAX_COINS = 240;

function Base({
  data,
  overview,
  site,
}: {
  data: DashboardCockpit;
  overview: DashboardOverview | null;
  site: DashboardSite | null;
}) {
  const monthSpend = (overview?.strips ?? [])
    .filter((strip) => (strip.source === 'meta' || strip.source === 'google') && strip.configured)
    .reduce((total, strip) => total + strip.spent, 0);
  const coins = overview ? Math.min(MAX_COINS, Math.floor(monthSpend / COIN_CENTS)) : 0;
  const stacks = Math.ceil(coins / COINS_PER_STACK);
  const channels = sessionsByChannel(site).slice(0, 5);
  const maxSessions = Math.max(1, ...channels.map((channel) => channel.sessions));
  const plates = [
    { label: 'Impressões', count: data.current.impressions },
    { label: 'Cliques', count: data.current.clicks },
    { label: 'Leads', count: data.current.leads },
  ];
  const plateTop = Math.log10(Math.max(1, data.current.impressions) + 1);
  const summary =
    `Gasto do mês (Meta e Google): ${overview ? formatMoney(monthSpend) : 'sem dado'}, ${coins} moeda(s) de R$ 50. ` +
    (channels.length
      ? `Sessões: ${channels.map((channel) => `${channel.channel} ${channel.sessions}`).join(', ')}. `
      : 'Sessões: GA4 não conectado. ') +
    `Funil: ${plates.map((plate) => `${plate.label} ${plate.count}`).join(', ')}.`;
  return (
    <figure className="neon-base">
      <svg viewBox="-40 -170 1200 350" role="img" aria-label={summary}>
        <g transform="translate(150,-10)">
          {Array.from({ length: stacks }, (_, stack) => {
            const inStack = Math.min(COINS_PER_STACK, coins - stack * COINS_PER_STACK);
            return (
              <g key={stack}>
                {Array.from({ length: inStack }, (_, index) => {
                  const [cx, cy] = isoXY((stack % 5) * 28, Math.floor(stack / 5) * 28, index * 4);
                  return (
                    <g
                      key={index}
                      className="neon-coin"
                      style={{ animationDelay: `${(stack * COINS_PER_STACK + index) * 35}ms` }}
                    >
                      <ellipse cx={cx} cy={cy + 3} rx={11} ry={5.5} className="coin-side" />
                      <ellipse cx={cx} cy={cy} rx={11} ry={5.5} className="coin-top" />
                    </g>
                  );
                })}
              </g>
            );
          })}
          <text x={-110} y={150} className="neon-base-label">
            {overview
              ? `Gasto do mês ${formatMoney(monthSpend)} · 1 moeda = R$ 50`
              : 'Gasto do mês: — resumo indisponível'}
          </text>
        </g>
        <g transform="translate(560,40)">
          {channels.map((channel, index) => (
            <IsoBox
              key={channel.channel}
              x={index * 34}
              y={0}
              w={22}
              d={22}
              h={Math.max(3, (channel.sessions / maxSessions) * 120)}
              tone="cyan"
              delay={index * 120}
              className="iso-grow"
            />
          ))}
          <text x={-80} y={80} className="neon-base-label">
            {channels.length ? 'Sessões por canal (GA4)' : 'Sessões por canal: — GA4 não conectado'}
          </text>
        </g>
        <g transform="translate(930,20)">
          {plates.map((plate, index) => {
            const side = plate.count
              ? Math.max(8, (Math.log10(plate.count + 1) / plateTop) * 110)
              : 0;
            return (
              <g key={plate.label} transform={`translate(0,${-index * 22})`}>
                <IsoBox
                  x={(110 - side) / 2}
                  y={(110 - side) / 2}
                  w={side}
                  d={side}
                  h={8}
                  tone={index === 0 ? 'cyan' : index === 1 ? 'violet' : 'orange'}
                  delay={index * 220}
                  className="iso-drop"
                />
              </g>
            );
          })}
          <text x={-150} y={150} className="neon-base-label">
            {plates.map((plate) => `${plate.label} ${formatCompact(plate.count)}`).join(' → ')}
          </text>
        </g>
      </svg>
    </figure>
  );
}

// ---------------------------------------------------------------------------

export function CockpitTab({
  data,
  overview = null,
  site = null,
}: {
  data: DashboardCockpit;
  overview?: DashboardOverview | null;
  site?: DashboardSite | null;
}) {
  useCockpitFonts();
  return (
    <div className="neon-cockpit">
      <div className="neon-particles" aria-hidden="true">
        {Array.from({ length: 18 }, (_, index) => (
          <span
            key={index}
            style={{ left: `${(index * 53) % 100}%`, animationDelay: `${(index * 0.7) % 9}s` }}
          />
        ))}
      </div>
      <div className="neon-stage">
        <div className="neon-panel">
          <div className="neon-glare" aria-hidden="true" />
          <section className="neon-scope neon-span-12" aria-label="Campanhas somadas">
            {data.activeCampaigns.length === 0 ? (
              <p className="neon-why">
                Nenhuma campanha ativa agora: os números abaixo ficam zerados.
              </p>
            ) : (
              <p>
                <b>Só campanhas ativas ({data.activeCampaigns.length}):</b>{' '}
                {data.activeCampaigns.map((campaign, index) => (
                  <span key={`${campaign.platform}:${campaign.externalId}`}>
                    {index > 0 && ' · '}
                    {campaign.name}{' '}
                    <span className="neon-sub">({AD_PLATFORM_LABEL[campaign.platform]})</span>
                  </span>
                ))}
              </p>
            )}
          </section>

          {data.adWarnings.length > 0 && (
            <section className="neon-card neon-span-12" aria-labelledby="cockpit-ad-warnings">
              <h2 id="cockpit-ad-warnings">Anúncios ligados que não estão rodando</h2>
              <div className="neon-card-body">
                <p className="neon-sub">Ficam fora de todos os números até a plataforma liberar.</p>
                <ul className="neon-alerts">
                  {data.adWarnings.map((warning) => (
                    <li
                      key={`${warning.platform}:${warning.adExternalId}`}
                      className="neon-alert neon-alert-warning"
                    >
                      <b>{AD_ISSUE_LABEL[warning.issue] ?? warning.issue}</b> {warning.adName}
                      <span className="neon-sub">
                        {AD_PLATFORM_LABEL[warning.platform]} · {warning.campaignName}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            </section>
          )}

          <InvestmentCard data={data} overview={overview} />
          <CplGauge data={data} />
          <ActivePerformance data={data.activePerformance} />
          <DeliveryCard data={data} />
          <FunnelCard figures={data.current} />
          <AdsColumns data={data} />
          <SessionsCard site={site} />
          <PacingCard campaigns={data.activeCampaigns} />
          <TimelineCard campaigns={data.activeCampaigns} today={data.today} />
          <ScheduledBudgetCard campaigns={data.activeCampaigns} />
          <TrackingCard
            overview={overview}
            site={site}
            leadsFetchedAt={data.activePerformance.fetchedAt}
          />
          <AlertsCard data={data} />
          <EvolutionCard data={data} />
          <StateMap data={data} />
        </div>
      </div>
      <Base data={data} overview={overview} site={site} />
    </div>
  );
}
