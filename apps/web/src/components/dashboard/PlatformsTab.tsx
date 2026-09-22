import {
  AD_PLATFORM_LABEL,
  addTotals,
  deltaPercent,
  EMPTY_TOTALS,
  ratiosOf,
  type DashboardPlatforms,
  type MetricRatios,
  type MetricTotals,
  type PlatformPerformance,
} from '@wings/shared';
import { downloadCsv, percent, reais, toCsv, type CsvCell } from '../../lib/csv.js';
import { Button } from '../ui.js';
import { DailyLines } from './charts.js';
import {
  formatBrl,
  formatInt,
  formatMilli,
  formatMoney,
  formatPercentMilli,
  formatSignedPercent,
} from './format.js';

/**
 * Por plataforma: the same ten figures for Meta and Google side by side, each
 * against the window before it. The table is the chart's twin — every number
 * on the line is in a cell.
 */

type Figures = MetricTotals & MetricRatios;

const figuresOf = (totals: MetricTotals): Figures => ({ ...totals, ...ratiosOf(totals) });

interface MetricSpec {
  key: keyof Figures;
  label: string;
  format: (value: number | null) => string;
  /** Whether a rise is good news: costs read the other way. */
  upIsGood: boolean;
  csv: (value: number | null) => CsvCell;
}

const METRICS: MetricSpec[] = [
  { key: 'spendCents', label: 'Gasto', format: formatMoney, upIsGood: false, csv: reais },
  { key: 'impressions', label: 'Impressões', format: formatInt, upIsGood: true, csv: (v) => v },
  { key: 'reach', label: 'Alcance', format: formatInt, upIsGood: true, csv: (v) => v },
  { key: 'clicks', label: 'Cliques', format: formatInt, upIsGood: true, csv: (v) => v },
  { key: 'ctrMilli', label: 'CTR', format: formatPercentMilli, upIsGood: true, csv: percent },
  { key: 'cpcCents', label: 'CPC', format: formatMoney, upIsGood: false, csv: reais },
  { key: 'cpmCents', label: 'CPM', format: formatMoney, upIsGood: false, csv: reais },
  { key: 'conversions', label: 'Leads', format: formatInt, upIsGood: true, csv: (v) => v },
  { key: 'costPerLeadCents', label: 'CPL', format: formatMoney, upIsGood: false, csv: reais },
  { key: 'frequencyMilli', label: 'Frequência', format: formatMilli, upIsGood: false, csv: (v) => (v === null ? null : v / 1000) },
];

export function Delta({ current, previous, upIsGood }: { current: number | null; previous: number | null; upIsGood: boolean }) {
  const delta = deltaPercent(current, previous);
  if (delta === null) return <span className="delta delta-none">—</span>;
  const tone = delta === 0 ? 'flat' : (delta > 0) === upIsGood ? 'good' : 'bad';
  return (
    <span className={`delta delta-${tone}`} title="em relação ao período anterior">
      {formatSignedPercent(delta)}
    </span>
  );
}

const COLOR: Record<PlatformPerformance['platform'], string> = {
  meta: 'var(--viz-meta)',
  google: 'var(--viz-google)',
};

export function PlatformsTab({ data }: { data: DashboardPlatforms }) {
  const columns = data.platforms.map((platform) => ({
    platform,
    current: figuresOf(platform.current),
    previous: figuresOf(platform.previous),
  }));
  const total = {
    current: figuresOf(data.platforms.reduce((sum, p) => addTotals(sum, p.current), EMPTY_TOTALS)),
    previous: figuresOf(data.platforms.reduce((sum, p) => addTotals(sum, p.previous), EMPTY_TOTALS)),
  };

  const exportCsv = () => {
    const header = ['Métrica', ...columns.flatMap((c) => [AD_PLATFORM_LABEL[c.platform.platform], 'Anterior', 'Variação %']), 'Total', 'Total anterior'];
    const rows = METRICS.map((metric) => [
      metric.label,
      ...columns.flatMap((c) => [
        metric.csv(c.current[metric.key]),
        metric.csv(c.previous[metric.key]),
        deltaPercent(c.current[metric.key], c.previous[metric.key]),
      ]),
      metric.csv(total.current[metric.key]),
      metric.csv(total.previous[metric.key]),
    ]);
    downloadCsv(`plataformas-${data.since}-a-${data.until}.csv`, toCsv(header, rows));
  };

  const configured = data.platforms.filter((platform) => platform.accounts.length > 0);

  return (
    <>
      <div className="dash-toolbar">
        <p className="muted">
          {data.since.split('-').reverse().join('/')} a {data.until.split('-').reverse().join('/')},
          comparado com os {data.days} dias anteriores
        </p>
        <Button variant="ghost" onClick={exportCsv}>
          Exportar CSV
        </Button>
      </div>

      {configured.length === 0 ? (
        <p className="muted">Nenhuma conta de anúncios configurada.</p>
      ) : (
        <DailyLines
          series={configured.map((platform) => ({
            key: platform.platform,
            label: AD_PLATFORM_LABEL[platform.platform],
            color: COLOR[platform.platform],
            points: platform.daily,
          }))}
          format={formatBrl}
          ariaLabel="Gasto por dia, por plataforma"
        />
      )}

      <div className="table-wrap">
        <table className="table metric-table">
          <thead>
            <tr>
              <th scope="col">Métrica</th>
              {columns.map((c) => (
                <th key={c.platform.platform} scope="col" colSpan={2}>
                  <i className="legend-dot" style={{ background: COLOR[c.platform.platform] }} aria-hidden="true" />
                  {AD_PLATFORM_LABEL[c.platform.platform]}
                  {c.platform.accounts.length === 0 && <span className="cell-sub">sem conta</span>}
                </th>
              ))}
              <th scope="col" colSpan={2}>
                Total
              </th>
            </tr>
          </thead>
          <tbody>
            {METRICS.map((metric) => (
              <tr key={metric.key}>
                <th scope="row">{metric.label}</th>
                {columns.map((c) => (
                  <MetricCells key={c.platform.platform} metric={metric} current={c.current} previous={c.previous} />
                ))}
                <MetricCells metric={metric} current={total.current} previous={total.previous} />
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="cell-sub dash-note">
        Alcance e frequência somam dias e campanhas, então a frequência do período é um piso, não
        a da plataforma. Leads contam só a ação de lead da conta, nunca cliques.
      </p>
    </>
  );
}

function MetricCells({ metric, current, previous }: { metric: MetricSpec; current: Figures; previous: Figures }) {
  return (
    <>
      <td className="mono num">{metric.format(current[metric.key])}</td>
      <td className="num">
        <Delta current={current[metric.key]} previous={previous[metric.key]} upIsGood={metric.upIsGood} />
      </td>
    </>
  );
}
