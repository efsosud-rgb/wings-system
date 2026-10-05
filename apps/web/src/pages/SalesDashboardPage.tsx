import {
  LEAD_PIPELINE_LABELS,
  LEAD_PIPELINES,
  type LeadPipeline,
  type SalesDashboard,
} from '@wings/shared';
import { useRef, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useSalesDashboard } from '../api/crm.js';
import { Chart3D } from '../components/charts3d/Chart3D.js';
import { SERIES_TONES, type Tone } from '../components/charts3d/spec.js';
import { DASH, formatInt, formatMoney } from '../components/dashboard/format.js';

/**
 * Dashboard › Vendas: one funnel's deals in the caller's scope (a seller sees
 * their own), from the CRM's own tables. Aggregates only, never a contact.
 */

const isPipeline = (value: string | null): value is LeadPipeline =>
  (LEAD_PIPELINES as readonly string[]).includes(value ?? '');

const percent = (rate: number) =>
  `${(rate * 100).toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%`;

const countAndValue = (total: number, valueCents: number) =>
  valueCents > 0 ? `${formatInt(total)} · ${formatMoney(valueCents)}` : formatInt(total);

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

function Kpi({ title, value, note }: { title: string; value: string; note?: string }) {
  return (
    <TiltCard label={`${title}: ${value}${note ? ` (${note})` : ''}`}>
      <span className="muted">{title}</span>
      <strong>{value}</strong>
      {note && <span className="cell-sub">{note}</span>}
    </TiltCard>
  );
}

function Indicators({ data }: { data: SalesDashboard }) {
  const valued = data.open.total - data.openWithoutValue;
  const noValue =
    data.open.total === 0
      ? 'nenhuma negociação aberta'
      : valued === 0
        ? 'nenhuma negociação aberta tem valor'
        : null;
  const missing =
    data.openWithoutValue > 0 && valued > 0
      ? `${formatInt(data.openWithoutValue)} sem valor ficam de fora`
      : undefined;
  return (
    <section className="sales-kpis" aria-label="Indicadores">
      <Kpi title="Negociações abertas" value={formatInt(data.open.total)} />
      <Kpi
        title="Valor em aberto"
        value={noValue ? DASH : formatMoney(data.open.valueCents)}
        note={noValue ?? missing}
      />
      <Kpi
        title="Valor ponderado"
        value={noValue ? DASH : formatMoney(data.open.weightedCents)}
        note={noValue ?? 'pela probabilidade de cada etapa'}
      />
      <Kpi
        title="Ganhas no mês"
        value={formatInt(data.wonMonth.total)}
        note={data.wonMonth.valueCents > 0 ? formatMoney(data.wonMonth.valueCents) : undefined}
      />
      <Kpi
        title="Taxa de conversão"
        value={data.conversion.rate === null ? DASH : percent(data.conversion.rate)}
        note={
          data.conversion.rate === null
            ? `nada fechado nos últimos ${data.conversion.days} dias`
            : `${formatInt(data.conversion.won)} ganhas, ${formatInt(data.conversion.lost)} perdidas em ${data.conversion.days} dias`
        }
      />
    </section>
  );
}

function Empty({ reason }: { reason: string }) {
  return (
    <p className="muted sales-empty">
      {DASH} {reason}
    </p>
  );
}

function StageFunnel({ data, pipeline }: { data: SalesDashboard; pipeline: LeadPipeline }) {
  const steps = data.stages.map((row) => ({
    key: row.stage?.id ?? 'none',
    label: row.stage?.name ?? 'Sem etapa',
    value: row.total,
    text: countAndValue(row.total, row.valueCents),
  }));
  if (steps.length === 0) return <Empty reason="este funil ainda não tem etapas." />;
  if (data.open.total === 0) return <Empty reason="nenhuma negociação aberta neste funil." />;
  return (
    <Chart3D
      spec={{ kind: 'funnel', steps }}
      replayKey={pipeline}
      height={Math.max(260, steps.length * 46 + 60)}
      ariaLabel={`Funil ${LEAD_PIPELINE_LABELS[pipeline]}: negociações abertas por etapa`}
      table={
        <table>
          <thead>
            <tr>
              <th>Etapa</th>
              <th className="num">Abertas</th>
              <th className="num">Valor</th>
              <th className="num">Ponderado</th>
            </tr>
          </thead>
          <tbody>
            {data.stages.map((row) => (
              <tr key={row.stage?.id ?? 'none'}>
                <td>{row.stage?.name ?? 'Sem etapa'}</td>
                <td className="num">{formatInt(row.total)}</td>
                <td className="num">{formatMoney(row.valueCents)}</td>
                <td className="num">{formatMoney(row.weightedCents)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      }
    />
  );
}

const MAX_BRANDS = 4;

function BrandDonut({ data, pipeline }: { data: SalesDashboard; pipeline: LeadPipeline }) {
  if (data.open.total === 0)
    return <Empty reason="nenhuma negociação aberta para dividir por marca." />;
  const named = data.brands.slice(0, MAX_BRANDS - 1);
  const rest = data.brands.slice(MAX_BRANDS - 1);
  const rows =
    rest.length > 1
      ? [
          ...named,
          {
            brand: `Outras (${rest.length})`,
            total: rest.reduce((sum, row) => sum + row.total, 0),
            valueCents: rest.reduce((sum, row) => sum + row.valueCents, 0),
            weightedCents: 0,
          },
        ]
      : data.brands;
  const tones: Tone[] = SERIES_TONES;
  return (
    <Chart3D
      spec={{
        kind: 'donut',
        slices: rows.map((row, i) => ({
          key: row.brand ?? 'none',
          label: row.brand ?? 'Sem marca',
          value: row.total,
          text: countAndValue(row.total, row.valueCents),
          tone: tones[i % tones.length]!,
        })),
      }}
      replayKey={pipeline}
      height={280}
      ariaLabel="Negociações abertas por marca"
      table={
        <table>
          <thead>
            <tr>
              <th>Marca</th>
              <th className="num">Abertas</th>
              <th className="num">Valor</th>
            </tr>
          </thead>
          <tbody>
            {data.brands.map((row) => (
              <tr key={row.brand ?? 'none'}>
                <td>{row.brand ?? 'Sem marca'}</td>
                <td className="num">{formatInt(row.total)}</td>
                <td className="num">{formatMoney(row.valueCents)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      }
    />
  );
}

function SellerBars({ data, pipeline }: { data: SalesDashboard; pipeline: LeadPipeline }) {
  if (data.sellers.length === 0)
    return <Empty reason="nenhuma negociação aberta ou ganha no mês." />;
  const nameOf = (row: SalesDashboard['sellers'][number]) => row.ownerName ?? 'Sem dono';
  return (
    <Chart3D
      spec={{
        kind: 'bars',
        orientation: 'vertical',
        showValues: true,
        categories: data.sellers.map((row) => ({
          key: row.ownerEmployeeId ?? 'none',
          label: nameOf(row),
        })),
        series: [
          {
            key: 'open',
            label: 'Abertas',
            tone: 'brand',
            values: data.sellers.map((row) => row.total),
            texts: data.sellers.map((row) => countAndValue(row.total, row.valueCents)),
            short: data.sellers.map((row) => formatInt(row.total)),
          },
          {
            key: 'won',
            label: 'Ganhas no mês',
            tone: 'graphite',
            values: data.sellers.map((row) => row.wonMonth),
            texts: data.sellers.map((row) => countAndValue(row.wonMonth, row.wonMonthCents)),
            short: data.sellers.map((row) => formatInt(row.wonMonth)),
          },
        ],
      }}
      replayKey={pipeline}
      height={260}
      ariaLabel="Negociações abertas e ganhas no mês por vendedor"
      table={
        <table>
          <thead>
            <tr>
              <th>Vendedor</th>
              <th className="num">Abertas</th>
              <th className="num">Valor em aberto</th>
              <th className="num">Ganhas no mês</th>
              <th className="num">Valor ganho</th>
            </tr>
          </thead>
          <tbody>
            {data.sellers.map((row) => (
              <tr key={row.ownerEmployeeId ?? 'none'}>
                <td>{nameOf(row)}</td>
                <td className="num">{formatInt(row.total)}</td>
                <td className="num">{formatMoney(row.valueCents)}</td>
                <td className="num">{formatInt(row.wonMonth)}</td>
                <td className="num">{formatMoney(row.wonMonthCents)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      }
    />
  );
}

export function SalesDashboardPage() {
  const [params, setParams] = useSearchParams();
  const raw = params.get('funil');
  const pipeline: LeadPipeline = isPipeline(raw) ? raw : 'expansao';
  const query = useSalesDashboard(pipeline);
  const data = query.data;

  return (
    <>
      <header className="page-header page-header-row sales-header">
        <div>
          <h1>Painel de vendas</h1>
          <p>
            Negociações do CRM por etapa, marca e vendedor. Conversão: ganhas ÷ (ganhas + perdidas)
            fechadas nos últimos 90 dias.
          </p>
        </div>
        <div className="sales-funnels" role="group" aria-label="Funil">
          {LEAD_PIPELINES.map((key) => (
            <button
              key={key}
              type="button"
              className={`btn btn-sm${key === pipeline ? ' btn-primary' : ''}`}
              aria-pressed={key === pipeline}
              onClick={() => {
                const next = new URLSearchParams(params);
                next.set('funil', key);
                setParams(next, { replace: true });
              }}
            >
              {LEAD_PIPELINE_LABELS[key]}
            </button>
          ))}
        </div>
      </header>

      {query.isError && !data && (
        <p className="muted">
          {DASH} Não foi possível carregar o painel agora. Tente de novo em instantes.
        </p>
      )}
      {!data && query.isLoading && <p className="muted">Carregando…</p>}
      {data && (
        <>
          <Indicators data={data} />
          <div className="sales-grid">
            <section className="card sales-card sales-card-wide" aria-labelledby="sales-funnel">
              <h2 id="sales-funnel">Funil por etapa · {LEAD_PIPELINE_LABELS[pipeline]}</h2>
              <StageFunnel data={data} pipeline={pipeline} />
            </section>
            <section className="card sales-card" aria-labelledby="sales-brands">
              <h2 id="sales-brands">Abertas por marca</h2>
              <BrandDonut data={data} pipeline={pipeline} />
            </section>
            <section className="card sales-card" aria-labelledby="sales-sellers">
              <h2 id="sales-sellers">Por vendedor</h2>
              <SellerBars data={data} pipeline={pipeline} />
            </section>
          </div>
        </>
      )}
    </>
  );
}
