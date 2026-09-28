import { siteRatiosOf, type DashboardSite } from '@wings/shared';
import { Alert } from '../ui.js';
import { formatDateTime, formatInt, formatMilli, formatPercentMilli } from './format.js';

/**
 * Site (GA4): the sessions each source and campaign brought, and what they did
 * there. Read from the copy the hourly ingestion keeps, never from GA4 live.
 */

const seconds = (value: number | null) =>
  value === null
    ? '—'
    : value >= 60
      ? `${Math.floor(value / 60)} min ${value % 60} s`
      : `${value} s`;

export function SiteTab({ data }: { data: DashboardSite }) {
  if (!data.configured) {
    return (
      <Alert kind="info">
        O Google Analytics 4 ainda não está conectado. Falta autorizar a leitura com uma conta
        Google que acesse a propriedade (consentimento OAuth) e configurar GA4_PROPERTY_ID e
        GA4_REFRESH_TOKEN no servidor. Depois disso a coleta de hora em hora traz as sessões por
        origem e campanha.
      </Alert>
    );
  }
  const totals = siteRatiosOf(data.totals);
  return (
    <>
      <p className="muted">
        Propriedade {data.propertyId} · lido do GA4{' '}
        {data.fetchedAt ? `em ${formatDateTime(data.fetchedAt)}` : 'ainda não'}. Sessões por origem,
        mídia e campanha (utm_campaign, ou o nome da campanha do Google Ads).
      </p>
      <dl className="strip-figures">
        <div>
          <dt>Sessões</dt>
          <dd>{formatInt(data.totals.sessions)}</dd>
        </div>
        <div>
          <dt>Taxa de engajamento</dt>
          <dd>{formatPercentMilli(totals.engagementRateMilli)}</dd>
        </div>
        <div>
          <dt>Tempo médio de engajamento</dt>
          <dd>{seconds(totals.avgEngagementSeconds)}</dd>
        </div>
        <div>
          <dt>Páginas por sessão</dt>
          <dd>{formatMilli(totals.pagesPerSessionMilli)}</dd>
        </div>
        <div>
          <dt>Conversões (eventos-chave)</dt>
          <dd>{formatInt(data.totals.keyEvents)}</dd>
        </div>
      </dl>
      {data.rows.length === 0 ? (
        <p className="muted">Nenhuma sessão no período.</p>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Origem / mídia</th>
                <th scope="col">Campanha</th>
                <th scope="col" className="num">
                  Sessões
                </th>
                <th scope="col" className="num">
                  Engajamento
                </th>
                <th scope="col" className="num">
                  Tempo médio
                </th>
                <th scope="col" className="num">
                  Páginas/sessão
                </th>
                <th scope="col" className="num">
                  Conversões
                </th>
              </tr>
            </thead>
            <tbody>
              {data.rows.map((row) => {
                const ratios = siteRatiosOf(row);
                return (
                  <tr key={`${row.source}|${row.medium}|${row.campaign}`}>
                    <td>
                      {row.source} / {row.medium}
                    </td>
                    <td>{row.campaign}</td>
                    <td className="mono num">{formatInt(row.sessions)}</td>
                    <td className="mono num">{formatPercentMilli(ratios.engagementRateMilli)}</td>
                    <td className="mono num">{seconds(ratios.avgEngagementSeconds)}</td>
                    <td className="mono num">{formatMilli(ratios.pagesPerSessionMilli)}</td>
                    <td className="mono num">{formatInt(row.keyEvents)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
