import {
  ALERT_KIND_LABEL,
  ALERT_SEVERITY_LABEL,
  type AlertItem,
  type CampaignPerformanceItem,
  type PacingSummary,
} from '@wings/shared';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useAcknowledgeAlert, useCockpit } from '../api/ads.js';
import { Alert, Button } from '../components/ui.js';

/**
 * The traffic cockpit.
 *
 * Everything here is read from data the ingest job already mirrored — opening
 * this screen never calls Meta, never spends and never changes anything. The
 * one action available is acknowledging an alert, which records that a person
 * saw it and nothing more.
 *
 * A metric that cannot be computed honestly renders as "—", never as zero.
 */

function formatBrl(cents: number): string {
  return (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

function formatDateTime(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
}

function formatMilli(value: number | null, suffix = ''): string {
  if (value === null) return '—';
  return `${(value / 1000).toLocaleString('pt-BR', { maximumFractionDigits: 2 })}${suffix}`;
}

function since(iso: string): string {
  const minutes = Math.floor((Date.now() - new Date(iso).getTime()) / 60_000);
  if (minutes < 60) return `há ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `há ${hours}h`;
  return `há ${Math.floor(hours / 24)} dia(s)`;
}

function BudgetCard({ pacing }: { pacing: PacingSummary }) {
  const usable = Math.max(pacing.usableCents, 1);
  const spentShare = Math.min((pacing.spentCents / usable) * 100, 100);
  const expectedShare = Math.min((pacing.expectedCents / usable) * 100, 100);
  const deviation = pacing.deviationPercent;

  return (
    <section className="card cockpit-budget">
      <header className="cockpit-budget-head">
        <h2>Orçamento do mês</h2>
        <span className="muted">
          dia {Math.floor(pacing.elapsedDays)} de {pacing.totalDays}
        </span>
      </header>

      <div className="pacing-bar" role="img" aria-label="Gasto em relação ao previsto">
        <div className="pacing-spent" style={{ width: `${spentShare}%` }} />
        <div className="pacing-expected" style={{ left: `${expectedShare}%` }} />
      </div>

      <dl className="cockpit-figures">
        <div>
          <dt>Gasto</dt>
          <dd className="mono">{formatBrl(pacing.spentCents)}</dd>
        </div>
        <div>
          <dt>Previsto até hoje</dt>
          <dd className="mono">{formatBrl(pacing.expectedCents)}</dd>
        </div>
        <div>
          <dt>Comprometido</dt>
          <dd className="mono">{formatBrl(pacing.committedCents)}</dd>
        </div>
        <div>
          <dt>Disponível</dt>
          <dd className="mono">{formatBrl(pacing.availableCents)}</dd>
        </div>
        <div>
          <dt>Utilizável (70%)</dt>
          <dd className="mono">{formatBrl(pacing.usableCents)}</dd>
        </div>
        <div>
          <dt>Teto do mês</dt>
          <dd className="mono">{formatBrl(pacing.capCents)}</dd>
        </div>
      </dl>

      {deviation !== null && (
        <p className="muted">
          {deviation === 0
            ? 'No ritmo previsto.'
            : deviation > 0
              ? `Gastando ${deviation}% acima do ritmo previsto para o mês.`
              : `Gastando ${Math.abs(deviation)}% abaixo do ritmo previsto para o mês.`}
        </p>
      )}
    </section>
  );
}

function AlertDetail({ alert }: { alert: AlertItem }) {
  const reasons = alert.detail.reasons;
  if (Array.isArray(reasons) && reasons.length > 0) {
    return <div className="cell-sub">Motivo da plataforma: {reasons.join('; ')}</div>;
  }
  if (alert.kind === 'creative_fatigue') {
    return (
      <div className="cell-sub">
        Frequência estimada {formatMilli(Number(alert.detail.frequencyMilli ?? 0))} em{' '}
        {String(alert.detail.lookbackDays ?? 7)} dias
      </div>
    );
  }
  if (alert.kind === 'budget_pacing') {
    return (
      <div className="cell-sub">
        Gasto {formatBrl(Number(alert.detail.spentCents ?? 0))} · previsto{' '}
        {formatBrl(Number(alert.detail.expectedCents ?? 0))}
      </div>
    );
  }
  return null;
}

function AlertFeed({ alerts }: { alerts: AlertItem[] }) {
  const acknowledge = useAcknowledgeAlert();

  if (alerts.length === 0) {
    return (
      <section className="approvals-section">
        <h2>Alertas</h2>
        <p className="muted">Nenhum alerta aberto.</p>
      </section>
    );
  }

  return (
    <section className="approvals-section">
      <h2>
        Alertas <span className="muted">({alerts.length})</span>
      </h2>
      <ul className="alert-feed">
        {alerts.map((alert) => (
          <li key={alert.id} className={`alert-row severity-${alert.severity}`}>
            <div>
              <span className={`status severity-tag-${alert.severity}`}>
                {ALERT_SEVERITY_LABEL[alert.severity]}
              </span>{' '}
              <strong>{alert.title}</strong>
              <div className="cell-sub">
                {ALERT_KIND_LABEL[alert.kind]} · detectado {since(alert.firstSeenAt)}
                {alert.notifiedAt && ' · avisado no WhatsApp'}
              </div>
              <AlertDetail alert={alert} />
              {alert.notificationError && (
                <div className="cell-sub error-text">
                  Falha ao avisar no WhatsApp: {alert.notificationError}
                </div>
              )}
            </div>
            <div className="alert-actions">
              {alert.acknowledgedAt ? (
                <span className="muted">
                  Visto por {alert.acknowledgedByName ?? 'alguém'} em{' '}
                  {formatDateTime(alert.acknowledgedAt)}
                </span>
              ) : (
                <Button
                  variant="ghost"
                  onClick={() => acknowledge.mutate(alert.id)}
                  disabled={acknowledge.isPending}
                >
                  Marcar como visto
                </Button>
              )}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

function CampaignTable({ campaigns }: { campaigns: CampaignPerformanceItem[] }) {
  if (campaigns.length === 0) {
    return <p className="muted">Nenhuma campanha espelhada ainda.</p>;
  }

  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            <th>Campanha</th>
            <th>Situação</th>
            <th>Orçamento</th>
            <th>Gasto</th>
            <th>Impressões</th>
            <th>Cliques</th>
            <th>CTR</th>
            <th>Frequência</th>
            <th>Leads</th>
            <th>CPL</th>
          </tr>
        </thead>
        <tbody>
          {campaigns.map((campaign) => (
            <tr key={campaign.campaignExternalId}>
              <td>
                {campaign.name}
                {campaign.alertCount > 0 && (
                  <span className="alert-badge" title="alertas abertos">
                    {campaign.alertCount}
                  </span>
                )}
                <div className="cell-sub">{campaign.campaignExternalId}</div>
              </td>
              <td>
                <span className={`status campaign-${campaign.status.toLowerCase()}`}>
                  {campaign.status}
                </span>
              </td>
              <td className="mono">
                {campaign.dailyBudgetCents === null
                  ? '—'
                  : `${formatBrl(campaign.dailyBudgetCents)}/dia`}
                <div className="cell-sub">
                  {campaign.budgetLevel === 'campaign'
                    ? 'CBO (campanha)'
                    : campaign.budgetLevel === 'ad_set'
                      ? 'ABO (conjuntos)'
                      : 'sem orçamento próprio'}
                </div>
              </td>
              <td className="mono">{formatBrl(campaign.spendCents)}</td>
              <td className="mono">{campaign.impressions.toLocaleString('pt-BR')}</td>
              <td className="mono">{campaign.clicks.toLocaleString('pt-BR')}</td>
              <td className="mono">{formatMilli(campaign.ctrMilli, '%')}</td>
              <td className="mono">{formatMilli(campaign.frequencyMilli)}</td>
              <td className="mono">{campaign.conversions.toLocaleString('pt-BR')}</td>
              {/* Empty on purpose when there are no leads: a cost per click
                  wearing a CPL label would be a lie. */}
              <td className="mono">
                {campaign.costPerLeadCents === null ? '—' : formatBrl(campaign.costPerLeadCents)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const WINDOWS = [7, 14, 30] as const;

export function CockpitPage() {
  const [days, setDays] = useState<number>(7);
  const query = useCockpit(days);
  const cockpit = query.data?.cockpit;

  return (
    <>
      <header className="page-header page-header-row">
        <div>
          <h1>Tráfego pago — cockpit</h1>
          <p>
            {cockpit
              ? `${cockpit.account.platform.toUpperCase()} — ${cockpit.account.name} · atualizado ${formatDateTime(cockpit.metricsFetchedAt)}`
              : 'Desempenho, orçamento e alertas da conta.'}
          </p>
        </div>
        <div className="window-picker">
          {WINDOWS.map((option) => (
            <Button
              key={option}
              variant={option === days ? 'primary' : 'ghost'}
              onClick={() => setDays(option)}
            >
              {option} dias
            </Button>
          ))}
        </div>
      </header>

      {query.isError && <Alert kind="error">Não foi possível carregar o cockpit.</Alert>}
      {query.isLoading && <p className="muted">Carregando…</p>}

      {cockpit && (
        <>
          {cockpit.pacing?.killSwitchEngaged && (
            <Alert kind="error">
              Trava de segurança acionada nesta conta: nenhuma alteração pode ser reservada ou
              executada até a revisão.
            </Alert>
          )}

          <div className="cockpit-counters">
            <div className="card">
              <span className="muted">Anúncios</span>
              <strong>{cockpit.counts.ads}</strong>
            </div>
            <div className="card">
              <span className="muted">Reprovados</span>
              <strong className={cockpit.counts.disapprovedAds > 0 ? 'error-text' : ''}>
                {cockpit.counts.disapprovedAds}
              </strong>
            </div>
            <div className="card">
              <span className="muted">Alertas abertos</span>
              <strong>{cockpit.counts.openAlerts}</strong>
            </div>
            <div className="card">
              <span className="muted">Aprovações pendentes</span>
              <strong>
                <Link to="/trafego-pago/aprovacoes">{cockpit.counts.pendingApprovals}</Link>
              </strong>
            </div>
          </div>

          {cockpit.pacing && <BudgetCard pacing={cockpit.pacing} />}

          <AlertFeed alerts={cockpit.alerts} />

          <section className="approvals-section">
            <h2>
              Campanhas <span className="muted">(desde {cockpit.sinceDate})</span>
            </h2>
            <CampaignTable campaigns={cockpit.campaigns} />
          </section>
        </>
      )}
    </>
  );
}
