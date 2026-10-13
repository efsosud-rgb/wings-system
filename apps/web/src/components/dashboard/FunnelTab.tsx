import { AD_PLATFORM_LABEL, type DashboardFunnel, type FunnelPlatformRow } from '@wings/shared';
import { Alert } from '../ui.js';
import { Chart3D } from '../charts3d/Chart3D.js';
import { ChartTable, SOURCE_SLOT } from './charts3d.js';
import { formatDateTime, formatInt, formatMoney, formatPercentMilli } from './format.js';

/**
 * Funil: each platform from the impression to the sale, and each campaign
 * from the impression to the lead, with the cost of each step (spend ÷ how
 * many reached it) and the share that passed from one step to the next.
 *
 * The CRM steps (leads in RD, meetings, sales) stop at the platform: RD's
 * deals carry its own labels, not the ad campaign. Bars from one base, one
 * length per count on a log scale (said under the chart), never a tapered funnel.
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
  const drawn = steps.filter(
    (step): step is typeof step & { count: number } => step.count !== null,
  );
  return (
    <section className="dash-section funnel" aria-labelledby={`funnel-${row.platform}`}>
      <h2 id={`funnel-${row.platform}`}>
        {AD_PLATFORM_LABEL[row.platform]}{' '}
        <span className="cell-sub">gasto {formatMoney(row.spendCents)}</span>
      </h2>
      <Chart3D
        height={Math.min(320, 70 + drawn.length * 36)}
        ariaLabel={`Funil de ${AD_PLATFORM_LABEL[row.platform]}, da impressão à venda, em escala logarítmica`}
        spec={{
          kind: 'funnel',
          // Impressions are thousands of times a sale: a linear bar would leave every step
          // after the click invisible, so lengths are logarithmic and the note says so.
          log: true,
          slot: SOURCE_SLOT[row.platform],
          stages: drawn.map((step) => ({ label: step.label, value: step.count })),
          format: 'int',
          totalLabel: 'das impressões',
          shareBase: row.impressions || undefined,
        }}
        table={
          <ChartTable
            caption={`Funil de ${AD_PLATFORM_LABEL[row.platform]}`}
            head={['Etapa', 'Quantidade', 'Custo por etapa', 'Passou da anterior']}
            rows={steps.map((step, index) => {
              const previous = index === 0 ? null : (steps[index - 1]?.count ?? null);
              return {
                key: step.label,
                neutral: step.count === null,
                cells: [
                  step.label,
                  step.count === null ? `— (${step.note ?? 'sem dado'})` : formatInt(step.count),
                  costPer(row.spendCents, step.count),
                  index === 0 ? '—' : passRate(step.count, previous),
                ],
              };
            })}
          />
        }
      />
      <p className="cell-sub">
        Barras em escala logarítmica, para que as etapas depois do clique apareçam: compare pelos
        números.
        {steps.some((step) => step.count === null) &&
          ' Etapas sem dado ficam fora do gráfico e aparecem na tabela com o motivo.'}
      </p>
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
      <p className="muted">
        Por campanha e por anúncio, "No CRM", reuniões e propostas contam os leads do Wings System
        que entraram no período: pelo anúncio que o lead guarda ou, sem ele, pela UTM da campanha
        (utm_campaign) e do anúncio (utm_content). Reunião e proposta são a etapa mais adiantada a
        que o lead chegou, mesmo se depois foi perdido; a venda conta em todas. Lead marcado como
        suspeito de robô não conta.
        {data.leadsWithoutCampaign > 0 &&
          ` ${data.leadsWithoutCampaign} lead(s) do período não têm anúncio nem UTM de uma campanha conhecida (orgânico, indicação, WhatsApp, cópia do RD sem UTM) e ficam fora das campanhas.`}
      </p>

      <section className="dash-section" aria-labelledby="funnel-campaigns">
        <h2 id="funnel-campaigns">Por campanha e por anúncio, até a proposta</h2>
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
                  <th scope="col" className="num">
                    No CRM
                  </th>
                  <th scope="col" className="num">
                    Reuniões
                  </th>
                  <th scope="col" className="num">
                    Propostas
                  </th>
                </tr>
              </thead>
              <tbody>
                {data.campaigns.map((row) => [
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
                    <td className="mono num">{formatInt(row.crm.leads)}</td>
                    <td className="mono num">{formatInt(row.crm.meetings)}</td>
                    <td className="mono num">{formatInt(row.crm.proposals)}</td>
                  </tr>,
                  ...row.ads.map((ad) => (
                    <tr
                      key={`${row.platform}:${row.externalId}:${ad.externalId}`}
                      className="is-sub"
                    >
                      <td>
                        <span className="cell-sub">Anúncio</span> {ad.name}
                      </td>
                      <td className="mono num">{formatMoney(ad.spendCents)}</td>
                      <td className="mono num">—</td>
                      <td className="mono num">—</td>
                      <td className="mono num">—</td>
                      <td className="mono num">—</td>
                      <td className="mono num">—</td>
                      <td className="mono num">{formatInt(ad.leads)}</td>
                      <td className="mono num">{costPer(ad.spendCents, ad.leads)}</td>
                      <td className="mono num">{formatInt(ad.crm.leads)}</td>
                      <td className="mono num">{formatInt(ad.crm.meetings)}</td>
                      <td className="mono num">{formatInt(ad.crm.proposals)}</td>
                    </tr>
                  )),
                ])}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
