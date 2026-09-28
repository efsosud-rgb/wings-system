import {
  AD_PLATFORM_LABEL,
  CAMPAIGN_VERDICT_LABEL,
  MIRRORED_FORMAT_LABEL,
  VERDICT_RULES,
  VERDICT_SIGNAL_LABEL,
  ratiosOf,
  type AdNode,
  type AdSetNode,
  type CampaignNode,
  type DashboardCampaigns,
  type MetricTotals,
  type VerdictResult,
} from '@wings/shared';
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useRequestCampaignChange, type ChangeRequestInput } from '../../api/ads.js';
import { hasPermission, useSession } from '../../api/auth.js';
import { formatBrl, parseBrlToCents } from '../campaign-builder/format.js';
import { downloadCsv, percent, reais, toCsv, type CsvCell } from '../../lib/csv.js';
import { Alert, Button, Field, Input } from '../ui.js';
import { formatInt, formatMoney, formatPercentMilli } from './format.js';
import { StateIcon, StatePill, stateOfSignal, stateOfVerdict } from './icons.js';
import { statusLabel } from './labels.js';

/**
 * Campanhas: one table, three levels. A campaign opens into its ad sets, an
 * ad set into its ads, all in the same columns so a figure can be followed
 * down to the creative that produced it. Each campaign carries its verdict,
 * and the verdict carries its reasons with the numbers in them.
 */

function Figures({ totals }: { totals: MetricTotals }) {
  const ratios = ratiosOf(totals);
  return (
    <>
      <td className="mono num">{formatMoney(totals.spendCents)}</td>
      <td className="mono num">{formatInt(totals.impressions)}</td>
      <td className="mono num">{formatInt(totals.clicks)}</td>
      <td className="mono num">{formatPercentMilli(ratios.ctrMilli)}</td>
      <td className="mono num">{formatMoney(ratios.cpcCents)}</td>
      <td className="mono num">{formatInt(totals.conversions)}</td>
      {/* Empty when there are no leads: a cost per click wearing a CPL label would be a lie. */}
      <td className="mono num">{formatMoney(ratios.costPerLeadCents)}</td>
    </>
  );
}

function Toggle({ open, onClick, label }: { open: boolean; onClick: () => void; label: string }) {
  return (
    <button type="button" className="tree-toggle" onClick={onClick} aria-expanded={open} aria-label={label}>
      <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
        <path d={open ? 'M3 6l5 5 5-5' : 'M6 3l5 5-5 5'} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </button>
  );
}

/** The pill, and behind it the five signals that made it. */
export function Verdict({ verdict, name }: { verdict: VerdictResult; name: string }) {
  return (
    <details className="verdict">
      <summary aria-label={`Veredito de ${name}: ${CAMPAIGN_VERDICT_LABEL[verdict.verdict]}`}>
        <StatePill state={stateOfVerdict(verdict.verdict)}>{CAMPAIGN_VERDICT_LABEL[verdict.verdict]}</StatePill>
      </summary>
      <ul className="verdict-reasons">
        {verdict.reasons.map((reason) => (
          <li key={reason.signal} className={`verdict-reason state-${stateOfSignal(reason.state)}`}>
            <StateIcon state={stateOfSignal(reason.state)} />
            <span>
              <b>{VERDICT_SIGNAL_LABEL[reason.signal]}</b> {reason.text}
            </span>
          </li>
        ))}
        {verdict.verdict === 'no_target' && (
          <li className="verdict-reason verdict-hint">
            <Link to="/dashboard/marketing?aba=configuracoes">Confirmar a meta em Configurações</Link>
          </li>
        )}
      </ul>
    </details>
  );
}

function AdRow({ ad }: { ad: AdNode }) {
  return (
    <tr className="tree-ad">
      <td>
        <span className="tree-indent tree-indent-2">
          {ad.thumbnailUrl ? (
            <img className="thumb" src={ad.thumbnailUrl} alt="" loading="lazy" />
          ) : (
            <span className="thumb thumb-empty" aria-hidden="true" />
          )}
          <span>
            {ad.name}
            <span className="cell-sub">
              {MIRRORED_FORMAT_LABEL[ad.format]}
              {ad.effectiveStatus === 'DISAPPROVED' && <strong className="error-text"> · reprovado</strong>}
            </span>
          </span>
        </span>
      </td>
      <td />
      <td />
      <td className="mono">—</td>
      <td>
        <span className={`status campaign-${ad.status.toLowerCase()}`}>{statusLabel(ad.status)}</span>
      </td>
      <td className="mono">—</td>
      <Figures totals={ad.totals} />
      <td />
    </tr>
  );
}

function AdSetRows({ adSet }: { adSet: AdSetNode }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <tr className="tree-adset">
        <td>
          <span className="tree-indent tree-indent-1">
            {adSet.ads.length > 0 ? (
              <Toggle open={open} onClick={() => setOpen(!open)} label={`${open ? 'Recolher' : 'Abrir'} anúncios de ${adSet.name}`} />
            ) : (
              <span className="tree-toggle tree-toggle-empty" aria-hidden="true" />
            )}
            <span>
              {adSet.name}
              <span className="cell-sub">
                conjunto, {adSet.ads.length} {adSet.ads.length === 1 ? 'anúncio' : 'anúncios'}
              </span>
            </span>
          </span>
        </td>
        <td />
        <td />
        <td className="mono">—</td>
        <td>
          <span className={`status campaign-${adSet.status.toLowerCase()}`}>{statusLabel(adSet.status)}</span>
        </td>
        <td className="mono">{adSet.dailyBudgetCents === null ? '—' : `${formatMoney(adSet.dailyBudgetCents)}/dia`}</td>
        <Figures totals={adSet.totals} />
        <td />
      </tr>
      {open && adSet.ads.map((ad) => <AdRow key={ad.externalId} ad={ad} />)}
    </>
  );
}

const dayMonth = (date: string) => `${date.slice(8, 10)}/${date.slice(5, 7)}`;

/** Início – fim, from the draft that created it; a campaign made by hand has none here. */
function period(campaign: CampaignNode): string {
  if (!campaign.startDate || !campaign.endDate) return '—';
  return `${dayMonth(campaign.startDate)} – ${dayMonth(campaign.endDate)}`;
}

const isRunning = (status: string) => status === 'ACTIVE' || status === 'ENABLED';

const ACTION_LABEL: Record<ChangeRequestInput['kind'], string> = {
  pause_campaign: 'Pausar',
  resume_campaign: 'Retomar',
  set_daily_budget: 'Mudar verba diária',
};

/**
 * Pausar, Retomar, Mudar verba diária: each files a change request, the same
 * one the approval screen files. Nothing reaches the platform from here; the
 * request goes through the approval and the "Executar" click like any other.
 */
function CampaignActions({ campaign }: { campaign: CampaignNode }) {
  const request = useRequestCampaignChange();
  const [kind, setKind] = useState<ChangeRequestInput['kind'] | null>(null);
  const [reason, setReason] = useState('');
  const [budgetText, setBudgetText] = useState(
    campaign.dailyBudgetCents === null ? '' : (campaign.dailyBudgetCents / 100).toFixed(2).replace('.', ','),
  );
  const [error, setError] = useState<string | null>(null);
  const idBase = `acao-${campaign.platform}-${campaign.externalId}`;

  const kinds: ChangeRequestInput['kind'][] = [
    ...(isRunning(campaign.status) ? (['pause_campaign'] as const) : []),
    ...(campaign.status === 'PAUSED' ? (['resume_campaign'] as const) : []),
    ...(campaign.budgetLevel === 'campaign' ? (['set_daily_budget'] as const) : []),
  ];

  const submit = () => {
    if (!kind) return;
    if (reason.trim().length < 3) {
      setError('Escreva o motivo do pedido.');
      return;
    }
    let toDailyBudgetCents: number | undefined;
    if (kind === 'set_daily_budget') {
      toDailyBudgetCents = parseBrlToCents(budgetText);
      if (!Number.isFinite(toDailyBudgetCents) || toDailyBudgetCents < 100) {
        setError('Informe a nova verba por dia em reais, como 240,00.');
        return;
      }
    }
    setError(null);
    request.mutate({
      accountExternalId: campaign.accountExternalId,
      campaignExternalId: campaign.externalId,
      kind,
      reason: reason.trim(),
      ...(toDailyBudgetCents !== undefined ? { toDailyBudgetCents } : {}),
    });
  };

  if (request.isSuccess) {
    return (
      <p className="cell-sub" role="status">
        Pedido registrado, aguardando aprovação.{' '}
        {request.data.approvalId && (
          <Link to={`/marketing/trafego-pago-wings/aprovacoes/${request.data.approvalId}`}>Abrir a aprovação</Link>
        )}
      </p>
    );
  }

  if (!kind) {
    return (
      <div className="campaign-actions">
        {kinds.map((option) => (
          <Button key={option} type="button" variant="ghost" onClick={() => setKind(option)}>
            {ACTION_LABEL[option]}
          </Button>
        ))}
      </div>
    );
  }

  return (
    <form
      className="campaign-action-form"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <strong>{ACTION_LABEL[kind]}</strong>
      {kind === 'set_daily_budget' && (
        <Field label="Nova verba por dia (R$)">
          <Input id={`${idBase}-verba`} inputMode="decimal" value={budgetText} onChange={(event) => setBudgetText(event.target.value)} />
        </Field>
      )}
      <Field label="Motivo" error={error ?? undefined} errorId={`${idBase}-erro`}>
        <Input
          id={`${idBase}-motivo`}
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          aria-describedby={error ? `${idBase}-erro` : undefined}
        />
      </Field>
      <p className="cell-sub">
        Vira um pedido na fila de aprovações. Nada muda {campaign.platform === 'google' ? 'no Google' : 'na Meta'} até alguém
        aprovar e clicar em Executar.
        {kind === 'resume_campaign' &&
          (campaign.platform === 'google'
            ? ' Retomar liga a campanha, o grupo e o anúncio criados pelo sistema.'
            : ' Retomar liga a campanha, o conjunto e os anúncios criados pelo sistema.')}
        {kind === 'set_daily_budget' && campaign.dailyBudgetCents !== null && ` Hoje: ${formatBrl(campaign.dailyBudgetCents)} por dia.`}
      </p>
      {request.isError && (
        <Alert kind="error">{request.error instanceof Error ? request.error.message : 'Não foi possível registrar o pedido.'}</Alert>
      )}
      <div className="campaign-actions">
        <Button type="submit" disabled={request.isPending}>
          {request.isPending ? 'Enviando…' : 'Pedir aprovação'}
        </Button>
        <Button
          type="button"
          variant="ghost"
          onClick={() => {
            setKind(null);
            setError(null);
          }}
        >
          Cancelar
        </Button>
      </div>
    </form>
  );
}

function CampaignRows({ campaign, canRequest }: { campaign: CampaignNode; canRequest: boolean }) {
  const [open, setOpen] = useState(false);
  const children = campaign.adSets.length + campaign.orphanAds.length;
  return (
    <>
      <tr className="tree-campaign">
        <td>
          <span className="tree-indent">
            {children > 0 ? (
              <Toggle open={open} onClick={() => setOpen(!open)} label={`${open ? 'Recolher' : 'Abrir'} ${campaign.name}`} />
            ) : (
              <span className="tree-toggle tree-toggle-empty" aria-hidden="true" />
            )}
            <span>
              <strong>{campaign.name}</strong>
              {campaign.alertCount > 0 && (
                <span className="alert-badge" title="alertas abertos">
                  {campaign.alertCount}
                </span>
              )}
              <span className="cell-sub">
                {campaign.objective ? campaign.objective.replace('OUTCOME_', '').toLowerCase() : ''}
                {campaign.systemCreated ? `${campaign.objective ? ' · ' : ''}criada pelo sistema` : ''}
              </span>
            </span>
          </span>
        </td>
        <td>{AD_PLATFORM_LABEL[campaign.platform]}</td>
        <td className="mono">{period(campaign)}</td>
        <td>
          <Verdict verdict={campaign.verdict} name={campaign.name} />
          {campaign.targetCplCents !== null && (
            <span className="cell-sub">meta de CPL {formatMoney(campaign.targetCplCents)}</span>
          )}
        </td>
        <td>
          <span className={`status campaign-${campaign.status.toLowerCase()}`}>{statusLabel(campaign.status)}</span>
        </td>
        <td className="mono">
          {campaign.dailyBudgetCents === null ? '—' : `${formatMoney(campaign.dailyBudgetCents)}/dia`}
          <span className="cell-sub">
            {campaign.budgetLevel === 'campaign' ? 'CBO' : campaign.budgetLevel === 'ad_set' ? 'ABO, nos conjuntos' : 'sem orçamento próprio'}
          </span>
        </td>
        <Figures totals={campaign.totals} />
        <td>{campaign.systemCreated && canRequest ? <CampaignActions campaign={campaign} /> : null}</td>
      </tr>
      {open && campaign.adSets.map((adSet) => <AdSetRows key={adSet.externalId} adSet={adSet} />)}
      {open && campaign.orphanAds.map((ad) => <AdRow key={ad.externalId} ad={ad} />)}
    </>
  );
}

const csvFigures = (totals: MetricTotals): CsvCell[] => {
  const ratios = ratiosOf(totals);
  return [
    reais(totals.spendCents),
    totals.impressions,
    totals.clicks,
    percent(ratios.ctrMilli),
    reais(ratios.cpcCents),
    totals.conversions,
    reais(ratios.costPerLeadCents),
  ];
};

const pct = (ratio: number) => `${Math.round(ratio * 100)}%`;

export function CampaignsTab({ data }: { data: DashboardCampaigns }) {
  const { data: user } = useSession();
  const canRequest = hasPermission(user, 'ads.request');
  const [filter, setFilter] = useState('');
  const visible = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    return needle ? data.campaigns.filter((campaign) => campaign.name.toLowerCase().includes(needle)) : data.campaigns;
  }, [data.campaigns, filter]);

  const exportCsv = () => {
    const header = ['Nível', 'Plataforma', 'Campanha', 'Conjunto', 'Anúncio', 'Formato', 'Veredito', 'Motivos', 'Situação', 'Orçamento diário', 'Gasto', 'Impressões', 'Cliques', 'CTR %', 'CPC', 'Leads', 'CPL'];
    const rows: CsvCell[][] = [];
    for (const campaign of visible) {
      const platform = AD_PLATFORM_LABEL[campaign.platform];
      const reasons = campaign.verdict.reasons.map((reason) => `${VERDICT_SIGNAL_LABEL[reason.signal]}: ${reason.text}`).join(' | ');
      rows.push(['campanha', platform, campaign.name, '', '', '', CAMPAIGN_VERDICT_LABEL[campaign.verdict.verdict], reasons, statusLabel(campaign.status), reais(campaign.dailyBudgetCents), ...csvFigures(campaign.totals)]);
      for (const adSet of campaign.adSets) {
        rows.push(['conjunto', platform, campaign.name, adSet.name, '', '', '', '', statusLabel(adSet.status), reais(adSet.dailyBudgetCents), ...csvFigures(adSet.totals)]);
        for (const ad of adSet.ads) {
          rows.push(['anúncio', platform, campaign.name, adSet.name, ad.name, MIRRORED_FORMAT_LABEL[ad.format], '', '', statusLabel(ad.status), null, ...csvFigures(ad.totals)]);
        }
      }
      for (const ad of campaign.orphanAds) {
        rows.push(['anúncio', platform, campaign.name, '', ad.name, MIRRORED_FORMAT_LABEL[ad.format], '', '', statusLabel(ad.status), null, ...csvFigures(ad.totals)]);
      }
    }
    downloadCsv(`campanhas-${data.since}-a-${data.until}.csv`, toCsv(header, rows));
  };

  return (
    <>
      <div className="dash-toolbar">
        <Input
          type="search"
          placeholder="Filtrar campanhas pelo nome"
          aria-label="Filtrar campanhas pelo nome"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          className="dash-filter"
        />
        <Button variant="ghost" onClick={exportCsv}>
          Exportar CSV
        </Button>
      </div>

      {visible.length === 0 ? (
        <p className="muted">{data.campaigns.length === 0 ? 'Nenhuma campanha espelhada ainda.' : 'Nenhuma campanha com esse nome.'}</p>
      ) : (
        <>
          <div className="table-wrap">
            <table className="table tree-table">
              <thead>
                <tr>
                  <th scope="col">Campanha</th>
                  <th scope="col">Plataforma</th>
                  <th scope="col">Início – fim</th>
                  <th scope="col">Veredito</th>
                  <th scope="col">Situação</th>
                  <th scope="col">Orçamento</th>
                  <th scope="col" className="num">Gasto</th>
                  <th scope="col" className="num">Impressões</th>
                  <th scope="col" className="num">Cliques</th>
                  <th scope="col" className="num">CTR</th>
                  <th scope="col" className="num">CPC</th>
                  <th scope="col" className="num">Leads</th>
                  <th scope="col" className="num">CPL</th>
                  <th scope="col">Pedidos</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((campaign) => (
                  <CampaignRows
                    key={`${campaign.platform}:${campaign.externalId}`}
                    campaign={campaign}
                    canRequest={canRequest}
                  />
                ))}
              </tbody>
            </table>
          </div>
          <p className="dash-note cell-sub">
            O veredito segue o número do objetivo da campanha (CPL para leads, CTR para as demais) e mais quatro sinais: CTR contra a
            mediana da conta em 90 dias, tendência de 7 dias contra os 7 anteriores, frequência e ritmo de gasto. Positiva quando o
            CPL fica até {pct(1 - VERDICT_RULES.cplGoodRatio)} abaixo da meta, Atenção até {pct(VERDICT_RULES.cplAttentionRatio - 1)} acima,
            Negativa além disso ou com dois sinais ruins; frequência acima de {VERDICT_RULES.frequencyBadMilli / 1000} e gasto fora de{' '}
            {pct(VERDICT_RULES.pacingAttentionMin)} a {pct(VERDICT_RULES.pacingAttentionMax)} do orçamento contam contra. Abaixo de{' '}
            {formatMoney(VERDICT_RULES.minSpendCents)} ou {formatInt(VERDICT_RULES.minImpressions)} impressões não há veredito.
          </p>
        </>
      )}
    </>
  );
}
