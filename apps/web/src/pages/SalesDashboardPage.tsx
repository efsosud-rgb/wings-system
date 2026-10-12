import {
  ALL_PIPELINES,
  LEAD_PIPELINE_LABELS,
  LEAD_PIPELINES,
  LEAD_SOURCE_LABELS,
  LEAD_SOURCES,
  NO_BRAND,
  NO_OWNER,
  SALES_COMPARISON_LABELS,
  SALES_COMPARISONS,
  SALES_PERIOD_LABELS,
  SALES_PERIODS,
  type LeadPipeline,
  type SalesComparison,
  type SalesDashboard,
  type SalesPeriod,
  type SalesRange,
  type SalesResults,
} from '@wings/shared';
import { useRef, useState, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useBrands, useSalesDashboard } from '../api/crm.js';
import { useSellers } from '../api/leads.js';
import { Chart3D } from '../components/charts3d/Chart3D.js';
import {
  COMPARISON_SLOT,
  firstName,
  type LineSpec,
  type RankedSpec,
} from '../components/charts3d/spec.js';
import { DASH, formatInt, formatMoney } from '../components/dashboard/format.js';
import { LoadFailure } from '../components/LoadFailure.js';

/**
 * Dashboard › Vendas v1: filters in one line, the executive row, the
 * diagnosis and the actions. Every number is what the API aggregated in the
 * caller's scope (a seller sees their own deals); a figure the data cannot
 * give yet shows "—" with the reason, never an estimate.
 */

const REASON = {
  goal: 'meta do mês não cadastrada',
  forecast: 'nenhuma negociação aberta tem data prevista de fechamento',
  stalled: 'as etapas ainda não têm prazo cadastrado',
} as const;

/** The CRM's deal list has no expected-date filter yet. */
const NO_DATE_LIST = 'a lista do CRM ainda não filtra por data prevista';
const NO_PHONE = 'Sem telefone ou DDD inválido';
const ABROAD = 'Telefone de fora do Brasil';

const percent = (rate: number) =>
  `${(rate * 100).toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%`;
const decimal = (value: number) => value.toLocaleString('pt-BR', { maximumFractionDigits: 1 });
const brDate = (day: string) => day.split('-').reverse().join('/');
const rangeText = (range: SalesRange) => `${brDate(range.from)} a ${brDate(range.to)}`;

const isIn = <T extends string>(list: readonly T[], value: string | null): value is T =>
  value !== null && (list as readonly string[]).includes(value);

// --- filters --------------------------------------------------------------------------

interface Filters {
  period: SalesPeriod;
  from: string;
  to: string;
  compare: SalesComparison;
  pipeline: LeadPipeline | typeof ALL_PIPELINES;
  owner: string;
  brand: string;
  source: string;
  campaign: string;
}

function useFilters() {
  const [params, setParams] = useSearchParams();
  const get = (key: string) => params.get(key) ?? '';
  const period = params.get('periodo');
  const compare = params.get('comparar');
  const pipeline = params.get('funil');
  const filters: Filters = {
    period: isIn(SALES_PERIODS, period) ? period : 'month',
    from: get('de'),
    to: get('ate'),
    compare: isIn(SALES_COMPARISONS, compare) ? compare : 'previous',
    pipeline: isIn(LEAD_PIPELINES, pipeline) ? pipeline : ALL_PIPELINES,
    owner: get('vendedor'),
    brand: get('marca'),
    source: isIn(LEAD_SOURCES, params.get('origem')) ? get('origem') : '',
    campaign: get('campanha'),
  };
  const set = (patch: Record<string, string>) => {
    const next = new URLSearchParams(params);
    for (const [key, value] of Object.entries(patch)) {
      if (value) next.set(key, value);
      else next.delete(key);
    }
    setParams(next, { replace: true });
  };
  return { filters, set, clear: () => setParams(new URLSearchParams(), { replace: true }) };
}

/** What the API is asked; a custom period waits for both ends (the month stands in meanwhile). */
function queryOf(filters: Filters): Record<string, string> {
  const custom = filters.period === 'custom' && filters.from && filters.to;
  const query: Record<string, string> = {
    pipeline: filters.pipeline,
    period: filters.period === 'custom' && !custom ? 'month' : filters.period,
  };
  if (custom) Object.assign(query, { from: filters.from, to: filters.to });
  if (filters.owner) query.owner = filters.owner;
  if (filters.brand) query.brand = filters.brand;
  if (filters.source) query.source = filters.source;
  if (filters.campaign) query.campaign = filters.campaign;
  return query;
}

function FilterBar({
  filters,
  set,
  clear,
  data,
}: ReturnType<typeof useFilters> & { data: SalesDashboard | undefined }) {
  const sellers = useSellers();
  const brands = useBrands();
  const own = data?.scope === 'own';
  const brandNames = [
    ...new Set([
      ...(brands.data?.brands ?? []).map((brand) => brand.name),
      ...(data?.brands ?? []).map((row) => row.brand).filter((name): name is string => !!name),
      ...(filters.brand && filters.brand !== NO_BRAND ? [filters.brand] : []),
    ]),
  ].sort((a, b) => a.localeCompare(b, 'pt-BR'));
  const campaigns = [
    ...new Set([...(data?.campaignOptions ?? []), ...(filters.campaign ? [filters.campaign] : [])]),
  ];
  const active =
    filters.period !== 'month' ||
    filters.compare !== 'previous' ||
    filters.pipeline !== ALL_PIPELINES ||
    !!(filters.owner || filters.brand || filters.source || filters.campaign);

  return (
    <>
      <div className="filters-row sales-filters" role="group" aria-label="Filtros do painel">
        <label>
          <span className="sr-only">Período</span>
          <select
            value={filters.period}
            onChange={(event) =>
              set({ periodo: event.target.value === 'month' ? '' : event.target.value })
            }
          >
            {SALES_PERIODS.map((key) => (
              <option key={key} value={key}>
                {SALES_PERIOD_LABELS[key]}
              </option>
            ))}
          </select>
        </label>
        {filters.period === 'custom' && (
          <>
            <label>
              <span className="sr-only">De</span>
              <input
                type="date"
                value={filters.from}
                max={filters.to || undefined}
                onChange={(event) => set({ de: event.target.value })}
              />
            </label>
            <label>
              <span className="sr-only">Até</span>
              <input
                type="date"
                value={filters.to}
                min={filters.from || undefined}
                onChange={(event) => set({ ate: event.target.value })}
              />
            </label>
          </>
        )}
        <label>
          <span className="sr-only">Comparar com</span>
          <select
            value={filters.compare}
            onChange={(event) =>
              set({ comparar: event.target.value === 'previous' ? '' : event.target.value })
            }
          >
            {SALES_COMPARISONS.map((key) => (
              <option key={key} value={key}>
                {key === 'none'
                  ? SALES_COMPARISON_LABELS[key]
                  : `vs. ${SALES_COMPARISON_LABELS[key].toLowerCase()}`}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span className="sr-only">Funil</span>
          <select
            value={filters.pipeline}
            onChange={(event) =>
              set({ funil: event.target.value === ALL_PIPELINES ? '' : event.target.value })
            }
          >
            <option value={ALL_PIPELINES}>Todos os funis</option>
            {LEAD_PIPELINES.map((key) => (
              <option key={key} value={key}>
                {LEAD_PIPELINE_LABELS[key]}
              </option>
            ))}
          </select>
        </label>
        {!own && (
          <label>
            <span className="sr-only">Vendedor</span>
            <select
              value={filters.owner}
              onChange={(event) => set({ vendedor: event.target.value })}
            >
              <option value="">Todos os vendedores</option>
              <option value={NO_OWNER}>Sem dono</option>
              {(sellers.data?.sellers ?? []).map((seller) => (
                <option key={seller.id} value={seller.id}>
                  {seller.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <label>
          <span className="sr-only">Marca</span>
          <select value={filters.brand} onChange={(event) => set({ marca: event.target.value })}>
            <option value="">Todas as marcas</option>
            <option value={NO_BRAND}>Sem marca</option>
            {brandNames.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span className="sr-only">Origem</span>
          <select value={filters.source} onChange={(event) => set({ origem: event.target.value })}>
            <option value="">Todas as origens</option>
            {LEAD_SOURCES.map((key) => (
              <option key={key} value={key}>
                {LEAD_SOURCE_LABELS[key]}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span className="sr-only">Campanha</span>
          <select
            value={filters.campaign}
            onChange={(event) => set({ campanha: event.target.value })}
          >
            <option value="">Todas as campanhas</option>
            {campaigns.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </label>
        {active && (
          <button type="button" className="btn btn-sm btn-ghost" onClick={clear}>
            Limpar filtros
          </button>
        )}
      </div>
      {/* A short dropdown is not "there are no sellers": say the list did not load. */}
      {!own && sellers.isError && !sellers.data && (
        <LoadFailure
          what="os vendedores do filtro"
          error={sellers.error}
          onRetry={() => void sellers.refetch()}
        />
      )}
      {brands.isError && !brands.data && (
        <LoadFailure
          what="as marcas do filtro"
          error={brands.error}
          onRetry={() => void brands.refetch()}
        />
      )}
    </>
  );
}

// --- row 1: executive -----------------------------------------------------------------

/** A card that leans a few degrees towards the pointer (none with reduced motion, in CSS). */
function TiltCard({ children, label }: { children: ReactNode; label: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const lean = (event: React.PointerEvent) => {
    const element = ref.current;
    if (!element || event.pointerType === 'touch') return;
    const rect = element.getBoundingClientRect();
    const x = (event.clientX - rect.left) / rect.width - 0.5;
    const y = (event.clientY - rect.top) / rect.height - 0.5;
    element.style.setProperty('--tilt-y', `${(x * 8).toFixed(2)}deg`);
    element.style.setProperty('--tilt-x', `${(-y * 8).toFixed(2)}deg`);
  };
  const rest = () => {
    ref.current?.style.setProperty('--tilt-x', '0deg');
    ref.current?.style.setProperty('--tilt-y', '0deg');
  };
  return (
    <div
      ref={ref}
      className="card kpi3d sales-kpi"
      onPointerMove={lean}
      onPointerLeave={rest}
      aria-label={label}
    >
      {children}
    </div>
  );
}

type Delta = { text: string; tone: 'up' | 'down' | 'flat' };

function Kpi({
  title,
  value,
  note,
  delta,
}: {
  title: string;
  value: string;
  note?: string;
  delta?: Delta | null;
}) {
  const parts = [delta?.text, note].filter(Boolean).join('; ');
  return (
    <TiltCard label={`${title}: ${value}${parts ? ` (${parts})` : ''}`}>
      <span className="muted">{title}</span>
      <strong>{value}</strong>
      {delta && <span className={`sales-delta is-${delta.tone}`}>{delta.text}</span>}
      {note && <span className="cell-sub">{note}</span>}
    </TiltCard>
  );
}

/** Change against the comparison range: a share for amounts, points for a rate. */
function deltaOf(
  now: number | null,
  before: number | null,
  kind: 'amount' | 'rate',
  against: string,
): Delta | null {
  if (now === null) return null;
  if (before === null || (kind === 'amount' && before === 0))
    return { text: `sem base ${against}`, tone: 'flat' };
  const change = kind === 'rate' ? (now - before) * 100 : ((now - before) / before) * 100;
  const tone = Math.abs(change) < 0.05 ? 'flat' : change > 0 ? 'up' : 'down';
  const sign = change >= 0.05 ? '+' : change <= -0.05 ? '−' : '';
  const size = Math.abs(change).toLocaleString('pt-BR', { maximumFractionDigits: 1 });
  return { text: `${sign}${size}${kind === 'rate' ? ' p.p.' : '%'} ${against}`, tone };
}

/** Won so far plus the weighted open deals expected by the period's end; "—" until someone fills a date. */
function Forecast({ data }: { data: SalesDashboard }) {
  const forecast = data.forecast;
  const end = brDate(data.ranges.current.to);
  if (forecast.ended)
    return (
      <Kpi
        title="Previsão do período"
        value={DASH}
        note={`o período terminou em ${end}: vale o realizado`}
      />
    );
  if (forecast.dated === 0)
    return <Kpi title="Previsão do período" value={DASH} note={REASON.forecast} />;
  const parts = [
    `ganho ${formatMoney(forecast.wonCents)}`,
    `+ ponderado ${formatMoney(forecast.weightedCents)} de ${formatInt(forecast.deals)} aberta(s) com previsão até ${end}`,
  ];
  if (forecast.withoutValue > 0) parts.push(`(${formatInt(forecast.withoutValue)} sem valor)`);
  return (
    <Kpi
      title="Previsão do período"
      value={formatMoney(forecast.wonCents + forecast.weightedCents)}
      note={parts.join(' ')}
    />
  );
}

function Executive({ data, compare }: { data: SalesDashboard; compare: SalesComparison }) {
  const now = data.results.current;
  const before: SalesResults | null =
    compare === 'previous'
      ? data.results.previous
      : compare === 'previous_year'
        ? data.results.previousYear
        : null;
  const against = compare === 'previous' ? 'no período anterior' : 'no ano anterior';
  const delta = (pick: (r: SalesResults) => number | null, kind: 'amount' | 'rate') =>
    before ? deltaOf(pick(now), pick(before), kind, against) : null;
  const closed = now.won + now.lost;
  const valued = data.open.total - data.open.withoutValue;
  const unvalued = now.won > 0 && now.wonCents === 0;

  return (
    <section className="sales-kpis" aria-label="Indicadores">
      <Kpi
        title="Vendas fechadas"
        value={unvalued ? DASH : formatMoney(now.wonCents)}
        note={
          unvalued
            ? 'nenhuma ganha no período tem valor'
            : now.wonWithoutValue > 0
              ? `${formatInt(now.wonWithoutValue)} ganha(s) sem valor ficam de fora`
              : undefined
        }
        delta={unvalued ? null : delta((r) => r.wonCents, 'amount')}
      />
      <Kpi title="Meta x realizado" value={DASH} note={REASON.goal} />
      <Kpi
        title="Contratos ganhos"
        value={formatInt(now.won)}
        delta={delta((r) => r.won, 'amount')}
      />
      <Kpi
        title="Ticket médio"
        value={now.ticketCents === null ? DASH : formatMoney(now.ticketCents)}
        note={now.ticketCents === null ? 'nenhuma ganha com valor no período' : undefined}
        delta={delta((r) => r.ticketCents, 'amount')}
      />
      <Kpi
        title="Conversão"
        value={now.conversionRate === null ? DASH : percent(now.conversionRate)}
        note={
          closed === 0
            ? 'nada fechado no período'
            : `${formatInt(now.won)} ganhas de ${formatInt(closed)} fechadas`
        }
        delta={delta((r) => r.conversionRate, 'rate')}
      />
      <Kpi
        title="Pipeline aberto hoje"
        value={valued === 0 ? DASH : formatMoney(data.open.valueCents)}
        note={
          data.open.total === 0
            ? 'nenhuma negociação aberta'
            : valued === 0
              ? `${formatInt(data.open.total)} abertas, nenhuma com valor`
              : `ponderado ${formatMoney(data.open.weightedCents)} · ${formatInt(data.open.total)} abertas${
                  data.open.withoutValue > 0
                    ? `, ${formatInt(data.open.withoutValue)} sem valor`
                    : ''
                }`
        }
      />
      <Forecast data={data} />
    </section>
  );
}

// --- row 2: trend ---------------------------------------------------------------------

const dayMonth = (day: string) => `${day.slice(8, 10)}/${day.slice(5, 7)}`;
const signedMoney = (cents: number) =>
  cents === 0 ? formatMoney(0) : `${cents > 0 ? '+' : '−'}${formatMoney(Math.abs(cents))}`;

/** Won value accumulated over the period, against the comparison at the same position. */
function Trend({ data, compare }: { data: SalesDashboard; compare: SalesComparison }) {
  const trend = data.trend;
  const before =
    compare === 'previous'
      ? trend.previous
      : compare === 'previous_year'
        ? trend.previousYear
        : null;
  const beforeName = compare === 'previous_year' ? 'Ano anterior' : 'Período anterior';
  const categories = trend.days.map(dayMonth);
  const spec: LineSpec = {
    kind: 'line',
    categories,
    format: 'brl',
    series: [
      { name: 'Este período', values: trend.current, slot: 0, area: true },
      ...(before
        ? [{ name: beforeName, values: before, slot: COMPARISON_SLOT, dashed: true }]
        : []),
    ],
    reference: trend.goalCents === null ? null : { value: trend.goalCents, label: 'Meta' },
  };
  const table = (
    <table>
      <thead>
        <tr>
          <th>{trend.bucket === 'week' ? 'Semana de' : 'Dia'}</th>
          <th className="num">Acumulado atual</th>
          {before && <th className="num">Acumulado {beforeName.toLowerCase()}</th>}
          {before && <th className="num">Diferença</th>}
        </tr>
      </thead>
      <tbody>
        {trend.days.map((day, i) => {
          const now = trend.current[i] ?? null;
          const then = before?.[i] ?? null;
          return (
            <tr key={day}>
              <td>{categories[i]}</td>
              <td className="num">{now === null ? DASH : formatMoney(now)}</td>
              {before && <td className="num">{then === null ? DASH : formatMoney(then)}</td>}
              {before && (
                <td className="num">
                  {now === null || then === null ? DASH : signedMoney(now - then)}
                </td>
              )}
            </tr>
          );
        })}
      </tbody>
    </table>
  );
  const anything = [...trend.current, ...(before ?? [])].some((value) => (value ?? 0) > 0);
  return anything ? (
    <Chart3D
      spec={spec}
      height={260}
      ariaLabel={`Vendas acumuladas no período${before ? `, comparadas com o ${beforeName.toLowerCase()}` : ''}`}
      table={table}
    />
  ) : (
    <TableOnly
      reason={`nenhuma venda ganha com valor no período${before ? ` nem no ${beforeName.toLowerCase()}` : ''}.`}
      table={table}
    />
  );
}

// --- row 3: diagnosis -----------------------------------------------------------------

function Empty({ reason }: { reason: string }) {
  return (
    <p className="muted sales-empty">
      {DASH} {reason}
    </p>
  );
}

function Card({
  id,
  title,
  note,
  wide,
  children,
}: {
  id: string;
  title: string;
  note?: ReactNode;
  wide?: boolean;
  children: ReactNode;
}) {
  return (
    <section className={`card sales-card${wide ? ' sales-card-wide' : ''}`} aria-labelledby={id}>
      <h2 id={id}>{title}</h2>
      {note && <p className="sales-note">{note}</p>}
      {children}
    </section>
  );
}

const rankedHeight = (count: number) => Math.max(180, Math.min(count, 7) * 36 + 50);

/** A table shown as is, with the reason the chart is not drawn. */
function TableOnly({ reason, table }: { reason: string; table: ReactNode }) {
  return (
    <>
      <Empty reason={reason} />
      <div className="c3d-flat-table">{table}</div>
    </>
  );
}

function Funnel({ data }: { data: SalesDashboard }) {
  if (!data.funnel)
    return (
      <Empty reason="escolha um funil no filtro para ver as etapas: cada funil tem as suas." />
    );
  const steps = data.funnel.filter((step) => step.stage);
  if (steps.length === 0) return <Empty reason="este funil ainda não tem etapas." />;
  const table = (
    <table>
      <thead>
        <tr>
          <th>Etapa</th>
          <th className="num">Abertas hoje</th>
          <th className="num">Chegaram</th>
          <th className="num">Passaram à seguinte</th>
          <th className="num">Dias na etapa</th>
        </tr>
      </thead>
      <tbody>
        {data.funnel.map((step) => (
          <tr key={step.stage?.id ?? 'none'}>
            <td>{step.stage?.name ?? 'Sem etapa'}</td>
            <td className="num">{formatInt(step.open.total)}</td>
            <td className="num">{step.stage ? formatInt(step.reached) : DASH}</td>
            <td className="num">{step.toNext === null ? DASH : percent(step.toNext)}</td>
            <td className="num">
              {step.avgDays === null
                ? DASH
                : `${decimal(step.avgDays)} (${formatInt(step.exits)} saídas)`}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
  return (
    <>
      {steps.some((step) => step.reached > 0) ? (
        <Chart3D
          spec={{
            kind: 'funnel',
            stages: steps.map((step) => ({ label: step.stage!.name, value: step.reached })),
            format: 'int',
            totalLabel: 'das que chegaram à primeira etapa',
            shareBase: Math.max(...steps.map((step) => step.reached)),
          }}
          height={Math.max(220, steps.length * 40 + 40)}
          ariaLabel="Negociações criadas no período por etapa alcançada"
          table={table}
        />
      ) : (
        <TableOnly reason="nenhuma negociação criada no período neste funil." table={table} />
      )}
      <p className="sales-note">
        Tempo médio até ganhar:{' '}
        {data.timeToClose.avgDays === null
          ? `${DASH} nenhuma ganha no período`
          : `${decimal(data.timeToClose.avgDays)} dias, da criação ao ganho (${formatInt(data.timeToClose.count)} ganhas)`}
      </p>
    </>
  );
}

function Sellers({ data }: { data: SalesDashboard }) {
  if (data.sellers.length === 0)
    return <Empty reason="nenhuma negociação aberta ou ganha no período." />;
  const name = (row: SalesDashboard['sellers'][number]) => firstName(row.ownerName, 'Sem dono');
  const byValue = data.sellers.some((row) => row.wonCents > 0);
  const spec: RankedSpec = {
    kind: 'ranked',
    format: byValue ? 'brl' : 'int',
    totalLabel: byValue ? 'do valor ganho' : 'das ganhas',
    items: data.sellers.map((row) => ({
      label: name(row),
      value: byValue ? row.wonCents : row.won,
      neutral: row.ownerEmployeeId === null,
    })),
  };
  const table = (
    <table>
      <thead>
        <tr>
          <th>Vendedor</th>
          <th className="num">Ganhas</th>
          <th className="num">Valor ganho</th>
          <th className="num">Meta</th>
          <th className="num">Abertas</th>
          <th className="num">Valor aberto</th>
          <th className="num">Atividades</th>
          <th className="num">1º contato (horas)</th>
        </tr>
      </thead>
      <tbody>
        {data.sellers.map((row) => (
          <tr key={row.ownerEmployeeId ?? 'none'}>
            <td>{name(row)}</td>
            <td className="num">{formatInt(row.won)}</td>
            <td className="num">{formatMoney(row.wonCents)}</td>
            <td className="num">{row.goalCents === null ? DASH : formatMoney(row.goalCents)}</td>
            <td className="num">{formatInt(row.open)}</td>
            <td className="num">{formatMoney(row.openCents)}</td>
            <td className="num">{row.ownerEmployeeId ? formatInt(row.activities) : DASH}</td>
            <td className="num">
              {row.firstContactHours === null
                ? DASH
                : `${decimal(row.firstContactHours)} (${formatInt(row.firstContactCount)})`}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
  return data.sellers.some((row) => row.won > 0) ? (
    <Chart3D
      spec={spec}
      height={rankedHeight(data.sellers.length)}
      ariaLabel="Ranking de vendedores pelas ganhas no período"
      table={table}
    />
  ) : (
    <TableOnly reason="ninguém ganhou negociação no período." table={table} />
  );
}

function Brands({ data }: { data: SalesDashboard }) {
  if (data.brands.length === 0)
    return <Empty reason="nenhuma negociação aberta ou ganha no período." />;
  const byWon = data.brands.some((row) => row.won > 0);
  const label = (brand: string | null) => brand ?? 'Sem marca';
  return (
    <>
      <Chart3D
        spec={{
          kind: 'ranked',
          format: 'int',
          totalLabel: byWon ? 'das ganhas' : 'das abertas',
          items: data.brands.map((row) => ({
            label: label(row.brand),
            value: byWon ? row.won : row.open,
            neutral: row.brand === null,
          })),
        }}
        height={rankedHeight(data.brands.length)}
        ariaLabel={byWon ? 'Ganhas no período por marca' : 'Negociações abertas por marca'}
        table={
          <table>
            <thead>
              <tr>
                <th>Marca</th>
                <th className="num">Ganhas</th>
                <th className="num">Valor ganho</th>
                <th className="num">Abertas</th>
                <th className="num">Valor aberto</th>
              </tr>
            </thead>
            <tbody>
              {data.brands.map((row) => (
                <tr key={row.brand ?? 'none'}>
                  <td>{label(row.brand)}</td>
                  <td className="num">{formatInt(row.won)}</td>
                  <td className="num">{formatMoney(row.wonCents)}</td>
                  <td className="num">{formatInt(row.open)}</td>
                  <td className="num">{formatMoney(row.openCents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        }
      />
      {data.services.length > 0 && (
        <div className="c3d-flat-table sales-subtable">
          <table aria-label="Por serviço">
            <thead>
              <tr>
                <th>Serviço (funil)</th>
                <th className="num">Ganhas</th>
                <th className="num">Valor ganho</th>
                <th className="num">Abertas</th>
                <th className="num">Valor aberto</th>
              </tr>
            </thead>
            <tbody>
              {data.services.map((row) => (
                <tr key={row.pipeline ?? 'none'}>
                  <td>{row.pipeline ? LEAD_PIPELINE_LABELS[row.pipeline] : 'Sem funil'}</td>
                  <td className="num">{formatInt(row.won)}</td>
                  <td className="num">{formatMoney(row.wonCents)}</td>
                  <td className="num">{formatInt(row.open)}</td>
                  <td className="num">{formatMoney(row.openCents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

function Origins({ data, ownerFiltered }: { data: SalesDashboard; ownerFiltered: boolean }) {
  if (data.sources.length === 0 && data.campaigns.length === 0)
    return <Empty reason="nenhuma negociação criada ou ganha no período." />;
  const spendReason = data.spendVisible
    ? null
    : ownerFiltered
      ? 'o investimento é da campanha inteira e não se divide por vendedor'
      : 'investimento, CPL, CAC e ROAS aparecem só para quem vê os gastos de tráfego pago';
  const money = (cents: number | null) => (cents === null ? DASH : formatMoney(cents));
  const sourceTable = (
    <table>
      <thead>
        <tr>
          <th>Origem</th>
          <th className="num">Criadas</th>
          <th className="num">Ganhas</th>
          <th className="num">Valor ganho</th>
        </tr>
      </thead>
      <tbody>
        {data.sources.map((row) => (
          <tr key={row.source}>
            <td>{LEAD_SOURCE_LABELS[row.source]}</td>
            <td className="num">{formatInt(row.leads)}</td>
            <td className="num">{formatInt(row.won)}</td>
            <td className="num">{formatMoney(row.wonCents)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
  return (
    <>
      {data.sources.some((row) => row.leads > 0) ? (
        <Chart3D
          spec={{
            kind: 'ranked',
            format: 'int',
            totalLabel: 'das criadas no período',
            items: data.sources.map((row) => ({
              label: LEAD_SOURCE_LABELS[row.source],
              value: row.leads,
            })),
          }}
          height={rankedHeight(data.sources.length)}
          ariaLabel="Negociações criadas no período por origem"
          table={sourceTable}
        />
      ) : (
        <TableOnly reason="nenhuma negociação criada no período." table={sourceTable} />
      )}
      <div className="c3d-flat-table sales-subtable">
        <table aria-label="Por campanha">
          <thead>
            <tr>
              <th>Campanha</th>
              <th className="num">Criadas</th>
              <th className="num">Ganhas</th>
              <th className="num">Valor ganho</th>
              <th className="num">Investimento</th>
              <th className="num">CPL</th>
              <th className="num">CAC</th>
              <th className="num">ROAS</th>
            </tr>
          </thead>
          <tbody>
            {data.campaigns.map((row) => (
              <tr key={row.campaign ?? 'none'}>
                <td>{row.campaign ?? 'Sem campanha'}</td>
                <td className="num">{formatInt(row.leads)}</td>
                <td className="num">{formatInt(row.won)}</td>
                <td className="num">{formatMoney(row.wonCents)}</td>
                <td className="num">{money(row.spendCents)}</td>
                <td className="num">{money(row.cplCents)}</td>
                <td className="num">{money(row.cacCents)}</td>
                <td className="num">{row.roas === null ? DASH : `${decimal(row.roas)}x`}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="sales-note">
        {spendReason
          ? `${DASH} ${spendReason}.`
          : `Investimento do período nas campanhas da Meta e do Google ligadas às negociações. CPL = investimento ÷ criadas; CAC = investimento ÷ ganhas; ROAS = valor ganho ÷ investimento. ${DASH} na linha: campanha sem gasto ligado.`}
      </p>
    </>
  );
}

function Regions({ data }: { data: SalesDashboard }) {
  const [view, setView] = useState<'uf' | 'city'>('uf');
  if (data.regions.length === 0)
    return <Empty reason="nenhuma negociação criada ou ganha no período." />;
  const rows =
    view === 'uf'
      ? data.regions.map((row) => ({
          key: row.uf ?? row.kind,
          label: row.kind === 'uf' ? row.uf! : row.kind === 'abroad' ? ABROAD : NO_PHONE,
          neutral: row.kind !== 'uf',
          leads: row.leads,
          won: row.won,
        }))
      : data.cities.map((row) => ({
          key: row.city ?? 'none',
          label: row.city ?? 'Cidade não informada',
          neutral: row.city === null,
          leads: row.leads,
          won: row.won,
        }));
  const table = (
    <table>
      <thead>
        <tr>
          <th>{view === 'uf' ? 'UF pelo DDD do telefone' : 'Cidade informada'}</th>
          <th className="num">Criadas</th>
          <th className="num">Ganhas</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.key} className={row.neutral ? 'is-neutral' : undefined}>
            <td>{row.label}</td>
            <td className="num">{formatInt(row.leads)}</td>
            <td className="num">{formatInt(row.won)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
  return (
    <>
      <div className="sales-toggle" role="group" aria-label="Ver por">
        {(
          [
            ['uf', 'UF'],
            ['city', 'Cidade'],
          ] as const
        ).map(([key, text]) => (
          <button
            key={key}
            type="button"
            className={`btn btn-sm${view === key ? ' btn-primary' : ''}`}
            aria-pressed={view === key}
            onClick={() => setView(key)}
          >
            {text}
          </button>
        ))}
      </div>
      {rows.some((row) => row.leads > 0) ? (
        <Chart3D
          key={view}
          spec={{
            kind: 'ranked',
            format: 'int',
            totalLabel: 'das criadas no período',
            items: rows.map((row) => ({
              label: row.label,
              value: row.leads,
              neutral: row.neutral,
            })),
          }}
          height={rankedHeight(rows.length)}
          ariaLabel={
            view === 'uf'
              ? 'Negociações criadas no período por UF, pelo DDD do telefone'
              : 'Negociações criadas no período por cidade informada'
          }
          table={table}
        />
      ) : (
        <TableOnly reason="nenhuma negociação criada no período." table={table} />
      )}
    </>
  );
}

function LostReasons({ data }: { data: SalesDashboard }) {
  if (data.lostReasons.length === 0)
    return <Empty reason="nenhuma negociação perdida no período." />;
  const label = (reason: string | null) => reason ?? 'Sem motivo';
  return (
    <Chart3D
      spec={{
        kind: 'ranked',
        format: 'int',
        totalLabel: 'das perdidas',
        items: data.lostReasons.map((row) => ({
          label: label(row.reason),
          value: row.total,
          neutral: row.reason === null,
        })),
      }}
      height={rankedHeight(data.lostReasons.length)}
      ariaLabel="Motivos de perda no período"
      table={
        <table>
          <thead>
            <tr>
              <th>Motivo</th>
              <th className="num">Perdidas</th>
            </tr>
          </thead>
          <tbody>
            {data.lostReasons.map((row) => (
              <tr key={row.reason ?? 'none'}>
                <td>{label(row.reason)}</td>
                <td className="num">{formatInt(row.total)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      }
    />
  );
}

// --- row 4: actions -------------------------------------------------------------------

interface Action {
  key: string;
  title: string;
  value: number | null;
  reason?: string;
  /** Under a count: its value, or why no list opens. */
  note?: string;
  /** Under a count with a list: what the list shows. */
  hint?: string;
  to: string | null;
}

function Actions({ data, filters }: { data: SalesDashboard; filters: Filters }) {
  /** The CRM's list of one funnel, with the filters it understands carried over. */
  const crm = (extra: Record<string, string>) => {
    if (!data.pipeline) return null;
    const params = new URLSearchParams({ funil: data.pipeline, ...extra });
    if (filters.source) params.set('source', filters.source);
    if (filters.campaign) params.set('campaign', filters.campaign);
    if (filters.owner && !extra.owner) params.set('owner', filters.owner);
    return `/crm-vendas/negociacoes?${params.toString()}`;
  };
  const dated = data.forecast.dated > 0;
  const items: Action[] = [
    {
      key: 'closing',
      title: 'Fecham em até 15 dias',
      value: dated ? data.actions.closingSoon : null,
      reason: REASON.forecast,
      note: [
        data.actions.closingSoonCents > 0 ? formatMoney(data.actions.closingSoonCents) : null,
        NO_DATE_LIST,
      ]
        .filter(Boolean)
        .join(' · '),
      to: null,
    },
    {
      key: 'overdue',
      title: 'Previsão de fechamento vencida',
      value: dated ? data.actions.forecastOverdue : null,
      reason: REASON.forecast,
      note: NO_DATE_LIST,
      to: null,
    },
    {
      key: 'stalled',
      title: 'Paradas além do prazo da etapa',
      value: data.actions.stalled,
      reason: REASON.stalled,
      to: null,
    },
    {
      key: 'first',
      title: 'Primeiro contato atrasado',
      value: data.actions.firstContactOverdue,
      hint: 'a lista abre todas as tarefas do funil, não só as de primeiro contato',
      to: crm({ visao: 'activities' }),
    },
    {
      key: 'goals',
      title: 'Metas em risco',
      value: data.actions.goalsAtRisk,
      reason: REASON.goal,
      to: null,
    },
  ];
  if (data.scope === 'all')
    items.push({
      key: 'owner',
      title: 'Sem dono',
      value: data.actions.noOwner,
      to: crm({ owner: NO_OWNER, aba: 'unowned', outcome: 'open', visao: 'list' }),
    });
  return (
    <ul className="sales-actions">
      {items.map((item) => {
        const open = item.value !== null && item.value > 0;
        const body = (
          <>
            <strong>{item.value === null ? DASH : formatInt(item.value)}</strong>
            <span>{item.title}</span>
            {item.value === null && <span className="cell-sub">{item.reason}</span>}
            {open && item.to && item.hint && <span className="cell-sub">{item.hint}</span>}
            {open && !item.to && (
              <span className="cell-sub">
                {item.note ?? 'escolha um funil no filtro para abrir a lista'}
              </span>
            )}
          </>
        );
        return (
          <li key={item.key}>
            {open && item.to ? (
              <Link className="card sales-action is-alert" to={item.to}>
                {body}
                <span className="sales-action-go" aria-hidden="true">
                  Abrir no CRM →
                </span>
              </Link>
            ) : (
              <div className="card sales-action">{body}</div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

// --- page -----------------------------------------------------------------------------

export function SalesDashboardPage() {
  const controls = useFilters();
  const { filters } = controls;
  const query = useSalesDashboard(queryOf(filters));
  const data = query.data;
  const own = data?.scope === 'own';
  const compared =
    data && filters.compare !== 'none'
      ? rangeText(filters.compare === 'previous' ? data.ranges.previous : data.ranges.previousYear)
      : null;

  return (
    <>
      <header className="page-header sales-header">
        <h1>Painel de vendas</h1>
        <p>
          {own ? 'As suas negociações' : 'Negociações do CRM'}
          {data ? ` · ${rangeText(data.ranges.current)}` : ''}
          {compared ? ` · comparado com ${compared}` : ''}
        </p>
      </header>
      <FilterBar {...controls} data={data} />

      {query.isError && (
        <LoadFailure what="o painel" error={query.error} onRetry={() => void query.refetch()} />
      )}
      {!data && query.isLoading && <p className="muted">Carregando…</p>}
      {data && (
        <>
          <Executive data={data} compare={filters.compare} />
          <div className="sales-grid">
            <Card
              id="sales-trend"
              title="Tendência · vendas acumuladas"
              note={
                <>
                  Valor das ganhas somado{' '}
                  {data.trend.bucket === 'week' ? 'semana a semana' : 'dia a dia'}
                  {filters.compare === 'none'
                    ? '.'
                    : `, contra o ${filters.compare === 'previous_year' ? 'mesmo período do ano anterior' : 'período anterior'} no mesmo ponto do período.`}
                  {data.trend.bucket === 'week' && ' Por semana porque o período passa de 92 dias.'}{' '}
                  {data.trend.goalCents === null
                    ? `Meta: ${DASH} (${REASON.goal}).`
                    : `Meta: ${formatMoney(data.trend.goalCents)}.`}
                </>
              }
              wide
            >
              <Trend data={data} compare={filters.compare} />
            </Card>
            <Card
              id="sales-funnel"
              title={`Funil${data.pipeline ? ` · ${LEAD_PIPELINE_LABELS[data.pipeline]}` : ''}`}
              note="Das negociações criadas no período, quantas chegaram a cada etapa e quantas passaram à seguinte. Dias na etapa: média das saídas no período."
              wide
            >
              <Funnel data={data} />
            </Card>
            {!own && (
              <Card
                id="sales-sellers"
                title="Ranking de vendedores"
                note={`Pelas ganhas no período. Meta: ${DASH} ${REASON.goal}.`}
                wide
              >
                <Sellers data={data} />
              </Card>
            )}
            {!own && (
              <Card id="sales-origins" title="Por origem e campanha" wide>
                <Origins data={data} ownerFiltered={!!filters.owner} />
              </Card>
            )}
            {!own && (
              <Card id="sales-brands" title={data.pipeline ? 'Por marca' : 'Por marca e serviço'}>
                <Brands data={data} />
              </Card>
            )}
            {!own && (
              <Card id="sales-regions" title="Por região · UF pelo DDD do telefone">
                <Regions data={data} />
              </Card>
            )}
            <Card id="sales-lost" title="Motivos de perda" wide>
              <LostReasons data={data} />
            </Card>
          </div>
          <section aria-labelledby="sales-actions" className="sales-actions-row">
            <h2 id="sales-actions">Ações</h2>
            <Actions data={data} filters={filters} />
          </section>
        </>
      )}
    </>
  );
}
