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
import { useMemo } from 'react';
import { downloadCsv, percent, reais, toCsv, type CsvCell } from '../../lib/csv.js';
import { Button } from '../ui.js';
import { Chart3D } from '../charts3d/Chart3D.js';
import { shareSpec } from '../charts3d/spec.js';
import { ChartTable } from './charts3d.js';
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
  label: string;
  totals: MetricTotals;
}

function groupBy(
  rows: BreakdownRow[],
  keyOf: (row: BreakdownRow) => string | null,
  label: (key: string) => string,
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

/** Slices that are not a real value of the split: drawn in neutral. */
const UNKNOWN = new Set(['Não informada', 'Não informado', 'unknown']);

function Panel({
  title,
  groups,
  donut = false,
}: {
  title: string;
  groups: Group[];
  /** Parts of a whole (gender, device): a donut when it reads as one. */
  donut?: boolean;
}) {
  const items = groups.map((group) => ({
    label: group.label,
    value: group.totals.spendCents,
    neutral: UNKNOWN.has(group.label) || UNKNOWN.has(group.key),
  }));
  return (
    <section className="dash-section audience-panel" aria-label={title}>
      <h2>{title}</h2>
      {groups.length === 0 ? (
        <p className="muted">Sem dados no período.</p>
      ) : (
        <Chart3D
          height={donut ? 240 : Math.min(300, 70 + Math.min(groups.length, 6) * 38)}
          ariaLabel={`${title}: gasto por fatia`}
          spec={
            donut
              ? shareSpec(items, 'brl', { totalLabel: 'do gasto', centerLabel: 'gasto' })
              : { kind: 'ranked', items, format: 'brl', totalLabel: 'do gasto' }
          }
          table={
            <ChartTable
              caption={`${title}: gasto, leads e custo por lead`}
              head={[title, 'Gasto', 'CTR', 'Leads', 'CPL']}
              rows={groups.map((group) => {
                const ratios = ratiosOf(group.totals);
                return {
                  key: group.key,
                  neutral: UNKNOWN.has(group.label) || UNKNOWN.has(group.key),
                  cells: [
                    group.label,
                    formatMoney(group.totals.spendCents),
                    formatPercentMilli(ratios.ctrMilli),
                    formatInt(group.totals.conversions),
                    group.totals.conversions > 0
                      ? formatMoney(ratios.costPerLeadCents)
                      : '— (sem leads)',
                  ],
                };
              })}
            />
          }
        />
      )}
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

  const heatValues = WEEKDAY_LABEL.map((_, weekday) =>
    HOURS.map(
      (hour) =>
        data.heatmap.find((cell) => cell.weekday === weekday && cell.hour === hour)?.spendCents ??
        0,
    ),
  );
  const heatRows = [...data.heatmap]
    .filter((cell) => cell.spendCents > 0 || cell.clicks > 0 || cell.conversions > 0)
    .sort((a, b) => a.weekday - b.weekday || a.hour.localeCompare(b.hour));
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
        <Panel title="Idade" groups={by.age} />
        <Panel title="Gênero" groups={by.gender} donut />
        <Panel title="Dispositivo" groups={by.device} donut />
        <section className="dash-section audience-panel audience-hours">
          <h2>Hora do dia</h2>
          {by.hour.length === 0 ? (
            <p className="muted">Sem dados no período.</p>
          ) : (
            <>
              <Chart3D
                height={220}
                ariaLabel="Gasto por hora do dia, no fuso do anunciante"
                spec={{
                  kind: 'columns',
                  categories: hourPoints.map((point) => hourLabel(point.day)),
                  series: [{ name: 'Gasto', values: hourPoints.map((point) => point.amount) }],
                  format: 'brl',
                }}
                table={
                  <ChartTable
                    caption="Gasto e leads por hora do dia"
                    head={['Hora', 'Gasto', 'Leads', 'CPL']}
                    rows={HOURS.map((hour) => {
                      const group = by.hour.find((item) => item.key === hour);
                      const totals = group?.totals ?? EMPTY_TOTALS;
                      return {
                        key: hour,
                        cells: [
                          hourLabel(hour),
                          formatMoney(totals.spendCents),
                          formatInt(totals.conversions),
                          totals.conversions > 0
                            ? formatMoney(ratiosOf(totals).costPerLeadCents)
                            : '— (sem leads)',
                        ],
                      };
                    })}
                  />
                }
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
              <Chart3D
                height={300}
                ariaLabel="Gasto por dia da semana e hora, no fuso do anunciante"
                spec={{
                  kind: 'heat',
                  rows: [...WEEKDAY_LABEL],
                  columns: HOURS.map((hour) => `${hour}h`),
                  values: heatValues,
                  format: 'brl',
                }}
                table={
                  <ChartTable
                    caption="Gasto, cliques e leads por dia da semana e hora"
                    head={['Dia e hora', 'Gasto', 'Cliques', 'Leads']}
                    rows={heatRows.map((cell) => ({
                      key: `${cell.weekday}:${cell.hour}`,
                      cells: [
                        `${WEEKDAY_LABEL[cell.weekday]} ${cell.hour}h`,
                        formatMoney(cell.spendCents),
                        formatInt(cell.clicks),
                        formatInt(cell.conversions),
                      ],
                    }))}
                  />
                }
              />
              <p className="cell-sub">
                {bestCells.length > 0
                  ? `Melhores horários por CPL: ${bestCells
                      .map(
                        (cell) =>
                          `${WEEKDAY_LABEL[cell.weekday]} ${cell.hour}h (${formatMoney(Math.round(cell.spendCents / cell.conversions))})`,
                      )
                      .join(', ')}. Laranja mais escuro, mais gasto; cinza, sem gasto.`
                  : 'Laranja mais escuro, mais gasto; cinza, sem gasto. Nenhum lead atribuído a um horário no período.'}
              </p>
            </>
          )}
        </section>
      </div>
    </>
  );
}
