import {
  addTotals,
  BREAKDOWN_KIND_LABEL,
  DEVICE_LABEL,
  EMPTY_TOTALS,
  WEEKDAY_LABEL,
  ratiosOf,
  type BreakdownRow,
  type DashboardAudience,
  type MetricTotals,
} from '@wings/shared';
import { useMemo, type ReactNode } from 'react';
import { downloadCsv, percent, reais, toCsv, type CsvCell } from '../../lib/csv.js';
import { Button } from '../ui.js';
import { BarList, DailyColumns, HeatGrid } from './charts.js';
import { formatInt, formatMoney, formatPercentMilli } from './format.js';
import { ageLabel, genderLabel, hourLabel, placementLabel } from './labels.js';

/**
 * Público e região: each split as a ranked list of spend with the cost per
 * lead beside it, the hours as columns, and the week as a map of weekday by
 * hour. Age and gender are read one side at a time, because Google reports
 * them separately and Meta crossed.
 */

interface Group {
  key: string;
  label: ReactNode;
  totals: MetricTotals;
}

function groupBy(
  rows: BreakdownRow[],
  keyOf: (row: BreakdownRow) => string | null,
  label: (key: string) => ReactNode,
): Group[] {
  const groups = new Map<string, MetricTotals>();
  for (const row of rows) {
    const key = keyOf(row);
    if (key === null) continue;
    groups.set(key, addTotals(groups.get(key) ?? EMPTY_TOTALS, row.totals));
  }
  return [...groups]
    .map(([key, totals]) => ({ key, label: label(key), totals }))
    .sort((a, b) => b.totals.spendCents - a.totals.spendCents);
}

function Detail({ totals }: { totals: MetricTotals }) {
  const ratios = ratiosOf(totals);
  return (
    <>
      <b className="mono">{formatMoney(totals.spendCents)}</b>
      <span className="cell-sub">
        {totals.conversions > 0
          ? `${formatInt(totals.conversions)} leads · CPL ${formatMoney(ratios.costPerLeadCents)}`
          : `CTR ${formatPercentMilli(ratios.ctrMilli)} · sem leads`}
      </span>
    </>
  );
}

function Panel({ title, groups, limit = 12 }: { title: string; groups: Group[]; limit?: number }) {
  return (
    <section className="dash-section audience-panel">
      <h2>{title}</h2>
      <BarList
        color="var(--viz-meta)"
        emptyText="Sem dados no período."
        rows={groups.slice(0, limit).map((group) => ({
          key: group.key,
          label: group.label,
          amount: group.totals.spendCents,
          detail: <Detail totals={group.totals} />,
        }))}
      />
      {groups.length > limit && <p className="cell-sub">Mais {groups.length - limit} no CSV.</p>}
    </section>
  );
}

const HOURS = Array.from({ length: 24 }, (_, hour) => String(hour).padStart(2, '0'));

export function deviceLabel(key: string): string {
  return DEVICE_LABEL[key] ?? key.replace(/_/g, ' ');
}

export function AudienceTab({ data }: { data: DashboardAudience }) {
  const by = useMemo(() => {
    const of = (kind: BreakdownRow['kind']) => data.rows.filter((row) => row.kind === kind);
    const ageGender = of('age_gender');
    return {
      placement: groupBy(
        of('placement'),
        (row) => `${row.key}|${row.subKey}`,
        (key) => {
          const [platform = '', position = ''] = key.split('|');
          return placementLabel(platform, position);
        },
      ),
      age: groupBy(ageGender, (row) => (row.key === 'all' ? null : row.key), ageLabel),
      gender: groupBy(ageGender, (row) => (row.subKey === 'all' ? null : row.subKey), genderLabel),
      region: groupBy(
        of('region'),
        (row) => row.key,
        (key) => key || 'Não informada',
      ),
      hour: groupBy(of('hour'), (row) => row.key, hourLabel),
      device: groupBy(of('device'), (row) => row.key || 'unknown', deviceLabel),
    };
  }, [data.rows]);

  const hourPoints = HOURS.map((hour) => ({
    day: hour,
    amount: by.hour.find((group) => group.key === hour)?.totals.spendCents ?? 0,
  }));
  const hourLeads = by.hour.reduce((total, group) => total + group.totals.conversions, 0);

  const heatCells = data.heatmap.map((cell) => ({
    weekday: cell.weekday,
    hour: cell.hour,
    amount: cell.spendCents,
    detail: `${formatInt(cell.clicks)} cliques, ${formatInt(cell.conversions)} leads`,
  }));
  const bestCells = [...data.heatmap]
    .filter((cell) => cell.conversions > 0)
    .sort((a, b) => a.spendCents / a.conversions - b.spendCents / b.conversions)
    .slice(0, 3);

  const exportCsv = () => {
    const header = [
      'Quebra',
      'Chave',
      'Subchave',
      'Gasto',
      'Impressões',
      'Cliques',
      'CTR %',
      'Alcance',
      'Leads',
      'CPL',
    ];
    const rows: CsvCell[][] = data.rows.map((row) => {
      const ratios = ratiosOf(row.totals);
      return [
        BREAKDOWN_KIND_LABEL[row.kind],
        row.kind === 'device' ? deviceLabel(row.key) : row.key,
        row.subKey,
        reais(row.totals.spendCents),
        row.totals.impressions,
        row.totals.clicks,
        percent(ratios.ctrMilli),
        row.totals.reach,
        row.totals.conversions,
        reais(ratios.costPerLeadCents),
      ];
    });
    for (const cell of data.heatmap) {
      const ratios = ratiosOf({
        ...EMPTY_TOTALS,
        spendCents: cell.spendCents,
        impressions: cell.impressions,
        clicks: cell.clicks,
        conversions: cell.conversions,
      });
      rows.push([
        'Dia × hora',
        WEEKDAY_LABEL[cell.weekday] ?? String(cell.weekday),
        `${cell.hour}h`,
        reais(cell.spendCents),
        cell.impressions,
        cell.clicks,
        percent(ratios.ctrMilli),
        null,
        cell.conversions,
        reais(ratios.costPerLeadCents),
      ]);
    }
    downloadCsv(`publico-${data.since}-a-${data.until}.csv`, toCsv(header, rows));
  };

  return (
    <>
      <div className="dash-toolbar">
        <p className="muted">
          {data.rows.length === 0
            ? 'Nenhuma quebra espelhada ainda: a ingestão passa a gravá-las no próximo ciclo.'
            : 'Gasto por fatia, com o custo por lead de cada uma quando houve lead.'}
        </p>
        <Button variant="ghost" onClick={exportCsv}>
          Exportar CSV
        </Button>
      </div>

      <div className="audience-grid">
        <Panel title="Posicionamento" groups={by.placement} />
        <Panel title="Região" groups={by.region} />
        <Panel title="Idade" groups={by.age} limit={8} />
        <Panel title="Gênero" groups={by.gender} limit={4} />
        <Panel title="Dispositivo" groups={by.device} limit={6} />
        <section className="dash-section audience-panel audience-hours">
          <h2>Hora do dia</h2>
          {by.hour.length === 0 ? (
            <p className="muted">Sem dados no período.</p>
          ) : (
            <>
              <DailyColumns
                points={hourPoints}
                color="var(--viz-meta)"
                format={formatMoney}
                label={hourLabel}
                height={110}
                ariaLabel="Gasto por hora do dia, no fuso do anunciante"
              />
              <p className="cell-sub">
                {hourLeads > 0
                  ? `Melhores horas por CPL: ${by.hour
                      .filter((group) => group.totals.conversions > 0)
                      .sort(
                        (a, b) =>
                          (ratiosOf(a.totals).costPerLeadCents ?? Infinity) -
                          (ratiosOf(b.totals).costPerLeadCents ?? Infinity),
                      )
                      .slice(0, 3)
                      .map(
                        (group) =>
                          `${hourLabel(group.key)} (${formatMoney(ratiosOf(group.totals).costPerLeadCents)})`,
                      )
                      .join(', ')}.`
                  : 'Nenhum lead atribuído a uma hora no período.'}
              </p>
            </>
          )}
        </section>
        <section className="dash-section audience-panel audience-hours">
          <h2>Dia × hora</h2>
          {data.heatmap.length === 0 ? (
            <p className="muted">Sem dados no período.</p>
          ) : (
            <>
              <HeatGrid
                cells={heatCells}
                rowLabels={WEEKDAY_LABEL}
                color="var(--viz-meta)"
                format={formatMoney}
                ariaLabel="Gasto por dia da semana e hora, no fuso do anunciante"
              />
              <p className="cell-sub">
                {bestCells.length > 0
                  ? `Melhores horários por CPL: ${bestCells
                      .map(
                        (cell) =>
                          `${WEEKDAY_LABEL[cell.weekday]} ${cell.hour}h (${formatMoney(Math.round(cell.spendCents / cell.conversions))})`,
                      )
                      .join(', ')}. Cor mais forte, mais gasto.`
                  : 'Cor mais forte, mais gasto. Nenhum lead atribuído a um horário no período.'}
              </p>
            </>
          )}
        </section>
      </div>
    </>
  );
}
