import { AD_PLATFORM_LABEL, type DashboardFunnel, type FunnelPlatformRow } from '@wings/shared';
import { Alert } from '../ui.js';
import { formatDateTime, formatInt, formatMoney, formatPercentMilli } from './format.js';

/**
 * Funil: each platform from the impression to the sale, and each campaign
 * from the impression to the lead, with the cost of each step (spend ÷ how
 * many reached it) and the share that passed from one step to the next.
 *
 * The CRM steps (leads in RD, meetings, sales) stop at the platform: RD's
 * deals carry its own labels, not the ad campaign. Plain horizontal bars,
 * one length per count, on purpose: a 3-D or tapered funnel distorts reading.
 */

const costPer = (spendCents: number, count: number | null) =>
  count && count > 0 ? formatMoney(Math.round(spendCents / count)) : '—';

const passRate = (count: number | null, previous: number | null) =>
  count !== null && previous ? formatPercentMilli(Math.round((count / previous) * 100_000)) : '—';

function PlatformFunnel({ row }: { row: FunnelPlatformRow }) {
  const steps: { label: string; count: number | null; note?: string }[] = [
    { label: 'Impressões', count: row.impressions },
    { label: 'Cliques', count: row.clicks },
    {
      label: 'Sessões no site (GA4)',
      count: row.sessions,
      note: row.sessions === null ? 'GA4 não conectado' : undefined,
    },
    { label: 'Leads (plataforma)', count: row.leads },
    { label: 'Leads no CRM (RD)', count: row.crmLeads },
    { label: 'Reuniões', count: row.meetings },
    { label: 'Vendas', count: row.sales },
  ];
  // Bars on a log scale: impressions are thousands of times a sale, and a
  // linear bar would leave every step after the click invisible.
  const top = Math.log10(Math.max(1, row.impressions) + 1);
  return (
    <section className="dash-section funnel" aria-labelledby={`funnel-${row.platform}`}>
      <h2 id={`funnel-${row.platform}`}>
        {AD_PLATFORM_LABEL[row.platform]}{' '}
        <span className="cell-sub">gasto {formatMoney(row.spendCents)}</span>
      </h2>
      <ol className="funnel-steps">
        {steps.map((step, index) => {
          const previous = index === 0 ? null : (steps[index - 1]?.count ?? null);
          const width = step.count
            ? Math.max(2, Math.round((Math.log10(step.count + 1) / top) * 100))
            : 0;
          return (
            <li key={step.label} className="funnel-step">
              <span className="funnel-label">{step.label}</span>
              <span className="funnel-bar" aria-hidden="true">
                <span style={{ width: `${width}%` }} />
              </span>
              <span className="mono num funnel-count">
                {step.count === null ? '—' : formatInt(step.count)}
              </span>
              <span className="cell-sub funnel-meta">
                {step.note ??
                  `custo por etapa ${costPer(row.spendCents, step.count)}${index > 0 ? ` · passou ${passRate(step.count, previous)}` : ''}`}
              </span>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

export function FunnelTab({ data }: { data: DashboardFunnel }) {
  return (
    <>
      {!data.siteConfigured && (
        <Alert kind="info">
          Sessões no site aparecem quando o GA4 estiver conectado (aba Site). O resto do funil já
          funciona.
        </Alert>
      )}
      {!data.crmConfigured && (
        <Alert kind="info">O RD Station CRM não está configurado neste ambiente.</Alert>
      )}
      <p className="muted">
        Leads no CRM, reuniões e vendas vêm do RD Station CRM
        {data.crmFetchedAt ? `, lido em ${formatDateTime(data.crmFetchedAt)}` : ''}, pelas
        negociações criadas no período e pelas etiquetas de origem que o RD deu a cada uma ("Busca
        Paga | Facebook Ads", "META ADS"…): por plataforma, não por campanha. Reunião é a etapa
        "Reunião realizada" ou depois, ou a venda; uma negociação perdida depois da reunião não
        conta, porque o RD não guarda o histórico das etapas.
        {data.crmUnattributed > 0 &&
          ` ${data.crmUnattributed} negociação(ões) do período não dizem a plataforma (orgânico, indicação, "tráfego pago" sem plataforma) e ficam fora.`}
      </p>
      {data.platforms.map((row) => (
        <PlatformFunnel key={row.platform} row={row} />
      ))}

      <section className="dash-section" aria-labelledby="funnel-campaigns">
        <h2 id="funnel-campaigns">Por campanha, até o lead</h2>
        {data.campaigns.length === 0 ? (
          <p className="muted">Nenhuma campanha entregou no período.</p>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Campanha</th>
                  <th scope="col" className="num">
                    Gasto
                  </th>
                  <th scope="col" className="num">
                    Impressões
                  </th>
                  <th scope="col" className="num">
                    Cliques
                  </th>
                  <th scope="col" className="num">
                    Custo/clique
                  </th>
                  <th scope="col" className="num">
                    Sessões
                  </th>
                  <th scope="col" className="num">
                    Custo/sessão
                  </th>
                  <th scope="col" className="num">
                    Leads
                  </th>
                  <th scope="col" className="num">
                    Custo/lead
                  </th>
                </tr>
              </thead>
              <tbody>
                {data.campaigns.map((row) => (
                  <tr key={`${row.platform}:${row.externalId}`}>
                    <td>
                      {row.name}
                      <span className="cell-sub">
                        {AD_PLATFORM_LABEL[row.platform]}
                        {row.sessions !== null &&
                          (row.matchedSiteCampaigns.length > 0
                            ? ` · no GA4 como ${row.matchedSiteCampaigns.join(', ')}`
                            : ' · nenhuma sessão com esta campanha no GA4')}
                      </span>
                    </td>
                    <td className="mono num">{formatMoney(row.spendCents)}</td>
                    <td className="mono num">{formatInt(row.impressions)}</td>
                    <td className="mono num">{formatInt(row.clicks)}</td>
                    <td className="mono num">{costPer(row.spendCents, row.clicks)}</td>
                    <td className="mono num">
                      {row.sessions === null ? '—' : formatInt(row.sessions)}
                    </td>
                    <td className="mono num">{costPer(row.spendCents, row.sessions)}</td>
                    <td className="mono num">{formatInt(row.leads)}</td>
                    <td className="mono num">{costPer(row.spendCents, row.leads)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
