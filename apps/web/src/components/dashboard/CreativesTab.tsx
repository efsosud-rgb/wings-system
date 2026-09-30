import {
  AD_PLATFORM_LABEL,
  FATIGUE_CTR_DROP_PERCENT,
  FATIGUE_FREQUENCY_MILLI,
  MIRRORED_FORMAT_LABEL,
  deltaPercent,
  ratiosOf,
  type CreativePerformance,
  type DashboardCreatives,
} from '@wings/shared';
import { downloadCsv, percent, reais, toCsv } from '../../lib/csv.js';
import { Button } from '../ui.js';
import { BarList } from './charts.js';
import {
  formatInt,
  formatMilli,
  formatMoney,
  formatPercentMilli,
  formatSignedPercent,
} from './format.js';

/**
 * Criativos: formats ranked by what they cost and returned, then every ad
 * that delivered, with its video funnel and a wearing-out signal.
 */

function videoOnly(creative: CreativePerformance, value: number | null): number | null {
  // An image ad has no hook rate; a zero there would read as a bad video.
  return creative.totals.videoPlays > 0 ? value : null;
}

const seconds = (ms: number | null) =>
  ms === null ? null : `${(ms / 1000).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} s`;

/** 25 · 50 · 75 · 100%: the share of starts that reached each quarter of the video. */
function quartiles(creative: CreativePerformance): string | null {
  if (creative.totals.videoPlays === 0 && creative.totals.videoStarts === 0) return null;
  const r = ratiosOf(creative.totals);
  const pct = (milli: number | null) => (milli === null ? '—' : String(Math.round(milli / 1000)));
  return `${pct(r.p25Milli)} · ${pct(r.p50Milli)} · ${pct(r.p75Milli)} · ${pct(r.p100Milli)}%`;
}

function Fatigue({ creative }: { creative: CreativePerformance }) {
  const { fatigue } = creative;
  const trend = deltaPercent(fatigue.secondHalfCtrMilli, fatigue.firstHalfCtrMilli);
  if (fatigue.wornOut) {
    return (
      <span
        className="status status-worn"
        title={`CTR caiu ${Math.abs(trend ?? 0)}% na segunda metade do período, com frequência ${formatMilli(fatigue.frequencyMilli)}`}
      >
        desgastado
      </span>
    );
  }
  if (trend === null) return <span className="muted">—</span>;
  return (
    <span className="cell-sub" title="CTR da segunda metade do período em relação à primeira">
      CTR {formatSignedPercent(trend)}
    </span>
  );
}

export function CreativesTab({ data }: { data: DashboardCreatives }) {
  const exportCsv = () => {
    const header = [
      'Anúncio',
      'Campanha',
      'Plataforma',
      'Formato',
      'Gasto',
      'Impressões',
      'Cliques',
      'CTR %',
      'Leads',
      'CPL',
      'Plays 3s',
      'Gancho %',
      'ThruPlays',
      'Retenção %',
      'Assistiram até o fim %',
      'Inícios do vídeo',
      'Tempo médio assistido (s)',
      '25% %',
      '50% %',
      '75% %',
      '100% %',
      'Frequência',
      'CTR 1ª metade %',
      'CTR 2ª metade %',
      'Desgastado',
    ];
    const rows = data.creatives.map((creative) => {
      const ratios = ratiosOf(creative.totals);
      return [
        creative.name,
        creative.campaignName,
        AD_PLATFORM_LABEL[creative.platform],
        MIRRORED_FORMAT_LABEL[creative.format],
        reais(creative.totals.spendCents),
        creative.totals.impressions,
        creative.totals.clicks,
        percent(ratios.ctrMilli),
        creative.totals.conversions,
        reais(ratios.costPerLeadCents),
        creative.totals.videoPlays,
        percent(videoOnly(creative, ratios.hookRateMilli)),
        creative.totals.videoThruplays,
        percent(videoOnly(creative, ratios.holdRateMilli)),
        percent(videoOnly(creative, ratios.completionRateMilli)),
        creative.totals.videoStarts,
        ratios.avgWatchMs === null ? null : ratios.avgWatchMs / 1000,
        percent(ratios.p25Milli),
        percent(ratios.p50Milli),
        percent(ratios.p75Milli),
        percent(ratios.p100Milli),
        ratios.frequencyMilli === null ? null : ratios.frequencyMilli / 1000,
        percent(creative.fatigue.firstHalfCtrMilli),
        percent(creative.fatigue.secondHalfCtrMilli),
        creative.fatigue.wornOut ? 'sim' : 'não',
      ];
    });
    downloadCsv(`criativos-${data.since}-a-${data.until}.csv`, toCsv(header, rows));
  };

  return (
    <>
      <div className="dash-toolbar">
        <p className="muted">
          {data.creatives.length}{' '}
          {data.creatives.length === 1 ? 'anúncio entregou' : 'anúncios entregaram'} no período
        </p>
        <Button variant="ghost" onClick={exportCsv}>
          Exportar CSV
        </Button>
      </div>

      <section className="dash-section">
        <h2>Por formato</h2>
        <BarList
          color="var(--viz-meta)"
          emptyText="Nenhum anúncio entregou no período."
          rows={data.formats.map((format) => {
            const ratios = ratiosOf(format.totals);
            return {
              key: format.format,
              label: (
                <>
                  {MIRRORED_FORMAT_LABEL[format.format]}
                  <span className="cell-sub">
                    {format.ads} {format.ads === 1 ? 'anúncio' : 'anúncios'}
                  </span>
                </>
              ),
              amount: format.totals.spendCents,
              detail: (
                <>
                  <b className="mono">{formatMoney(format.totals.spendCents)}</b>
                  <span className="cell-sub">
                    CTR {formatPercentMilli(ratios.ctrMilli)} · CPL{' '}
                    {formatMoney(ratios.costPerLeadCents)}
                  </span>
                </>
              ),
            };
          })}
        />
      </section>

      <section className="dash-section">
        <h2>Anúncio a anúncio</h2>
        {data.creatives.length === 0 ? (
          <p className="muted">Nenhum anúncio entregou no período.</p>
        ) : (
          <div className="table-wrap">
            <table className="table creative-table">
              <thead>
                <tr>
                  <th scope="col">Anúncio</th>
                  <th scope="col">Formato</th>
                  <th scope="col" className="num">
                    Gasto
                  </th>
                  <th scope="col" className="num">
                    CTR
                  </th>
                  <th scope="col" className="num">
                    Leads
                  </th>
                  <th scope="col" className="num">
                    CPL
                  </th>
                  <th scope="col" className="num" title="Plays de 3 s por impressão">
                    Gancho
                  </th>
                  <th scope="col" className="num" title="ThruPlays por play de 3 s">
                    Retenção
                  </th>
                  <th scope="col" className="num" title="Assistiram até o fim, por play de 3 s">
                    Até o fim
                  </th>
                  <th
                    scope="col"
                    className="num"
                    title="Tempo médio assistido por início do vídeo (Meta)"
                  >
                    Tempo médio
                  </th>
                  <th scope="col" className="num">
                    ThruPlays
                  </th>
                  <th
                    scope="col"
                    className="num"
                    title="Parcela dos inícios que chegou a 25%, 50%, 75% e 100% do vídeo"
                  >
                    25 · 50 · 75 · 100%
                  </th>
                  <th scope="col" className="num">
                    Frequência
                  </th>
                  <th scope="col">Desgaste</th>
                </tr>
              </thead>
              <tbody>
                {data.creatives.map((creative) => {
                  const ratios = ratiosOf(creative.totals);
                  return (
                    <tr key={`${creative.platform}:${creative.adExternalId}`}>
                      <td>
                        <span className="tree-indent">
                          {creative.thumbnailUrl ? (
                            <img
                              className="thumb"
                              src={creative.thumbnailUrl}
                              alt=""
                              loading="lazy"
                            />
                          ) : (
                            <span className="thumb thumb-empty" aria-hidden="true" />
                          )}
                          <span>
                            {creative.name}
                            <span className="cell-sub">
                              {creative.format === 'text' && creative.headline
                                ? `${creative.headline} · `
                                : ''}
                              {creative.campaignName || AD_PLATFORM_LABEL[creative.platform]}
                              {creative.utmContent && (
                                <span className="mono"> · utm_content={creative.utmContent}</span>
                              )}
                              {creative.effectiveStatus === 'DISAPPROVED' && (
                                <strong className="error-text"> · reprovado</strong>
                              )}
                            </span>
                          </span>
                        </span>
                      </td>
                      <td>{MIRRORED_FORMAT_LABEL[creative.format]}</td>
                      <td className="mono num">{formatMoney(creative.totals.spendCents)}</td>
                      <td className="mono num">{formatPercentMilli(ratios.ctrMilli)}</td>
                      <td className="mono num">{formatInt(creative.totals.conversions)}</td>
                      <td className="mono num">{formatMoney(ratios.costPerLeadCents)}</td>
                      <td className="mono num">
                        {formatPercentMilli(videoOnly(creative, ratios.hookRateMilli))}
                      </td>
                      <td className="mono num">
                        {formatPercentMilli(videoOnly(creative, ratios.holdRateMilli))}
                      </td>
                      <td className="mono num">
                        {formatPercentMilli(videoOnly(creative, ratios.completionRateMilli))}
                      </td>
                      <td className="mono num">{seconds(ratios.avgWatchMs) ?? '—'}</td>
                      <td className="mono num">
                        {creative.totals.videoPlays > 0
                          ? formatInt(creative.totals.videoThruplays)
                          : '—'}
                      </td>
                      <td className="mono num">{quartiles(creative) ?? '—'}</td>
                      <td className="mono num">{formatMilli(ratios.frequencyMilli)}</td>
                      <td>
                        <Fatigue creative={creative} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <p className="cell-sub dash-note">
          Um anúncio conta como desgastado quando o CTR da segunda metade do período cai{' '}
          {FATIGUE_CTR_DROP_PERCENT}% ou mais em relação à primeira, com frequência acima de{' '}
          {formatMilli(FATIGUE_FREQUENCY_MILLI)}. Gancho, retenção e fim valem só para vídeo.
        </p>
      </section>
    </>
  );
}
