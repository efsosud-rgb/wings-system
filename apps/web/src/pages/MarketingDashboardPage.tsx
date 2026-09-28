import {
  DASHBOARD_WINDOWS,
  type CockpitCampaignScope,
  type DashboardWindow,
  type IngestionStatus,
} from '@wings/shared';
import { useSearchParams } from 'react-router-dom';
import {
  useDashboardAudience,
  useDashboardCampaigns,
  useDashboardCockpit,
  useDashboardCreatives,
  useDashboardFunnel,
  useDashboardSite,
  useDashboardOverview,
  useDashboardPlatforms,
} from '../api/dashboard.js';
import { AudienceTab } from '../components/dashboard/AudienceTab.js';
import { CampaignsTab } from '../components/dashboard/CampaignsTab.js';
import { CockpitTab } from '../components/dashboard/CockpitTab.js';
import { CreativesTab } from '../components/dashboard/CreativesTab.js';
import { FunnelTab } from '../components/dashboard/FunnelTab.js';
import { SiteTab } from '../components/dashboard/SiteTab.js';
import { DashboardRefresh } from '../components/dashboard/DashboardRefresh.js';
import { formatDateTime, formatWhen } from '../components/dashboard/format.js';
import { InsightsTab } from '../components/dashboard/InsightsTab.js';
import { OverviewTab } from '../components/dashboard/OverviewTab.js';
import { OwnedChannelsTab } from '../components/dashboard/OwnedChannelsTab.js';
import { PlatformsTab } from '../components/dashboard/PlatformsTab.js';
import { SettingsTab } from '../components/dashboard/SettingsTab.js';
import { Alert, Button } from '../components/ui.js';

/**
 * Dashboard → Marketing.
 *
 * Everything here is read from data the ingest job already mirrored: opening
 * a tab calls no platform, spends nothing and changes nothing. The only
 * buttons that act are the ones behind a person's click, and each of those
 * goes through the approval gate like every other change: "Criar pedido" on
 * an insight makes a request in that person's name, marked "sugerido pela
 * IA"; "Abrir no construtor" only fills the studio's form.
 *
 * The tab and the period live in the address, so a view can be sent as a link.
 */

const TABS = [
  { key: 'cockpit', label: 'Cockpit', windowed: true },
  { key: 'visao-geral', label: 'Visão geral', windowed: false },
  { key: 'plataformas', label: 'Por plataforma', windowed: true },
  { key: 'campanhas', label: 'Campanhas', windowed: true },
  { key: 'criativos', label: 'Criativos', windowed: true },
  { key: 'publico', label: 'Público e região', windowed: true },
  { key: 'site', label: 'Site (GA4)', windowed: true },
  { key: 'funil', label: 'Funil', windowed: true },
  { key: 'insights', label: 'Insights e sugestões', windowed: false },
  { key: 'canais-proprios', label: 'Canais próprios', windowed: true },
  { key: 'configuracoes', label: 'Configurações', windowed: false },
] as const;
type TabKey = (typeof TABS)[number]['key'];

function isTab(value: string | null): value is TabKey {
  return TABS.some((tab) => tab.key === value);
}

function isWindow(value: number): value is DashboardWindow {
  return DASHBOARD_WINDOWS.includes(value as DashboardWindow);
}

function Loading({
  query,
  children,
}: {
  query: { isLoading: boolean; isError: boolean };
  children: React.ReactNode;
}) {
  if (query.isError)
    return (
      <Alert kind="error">Não foi possível carregar esta aba. Tente de novo em instantes.</Alert>
    );
  if (query.isLoading) return <p className="muted">Carregando…</p>;
  return <>{children}</>;
}

/** One line: when a job last ran, how it went, and when the next one is due. */
function jobLine(label: string, status: IngestionStatus, cronEnvVar: string): string {
  const last = status.lastRunAt
    ? `${label} ${formatDateTime(status.lastRunAt)}${
        status.lastRunStatus === 'running'
          ? ' (em andamento)'
          : status.lastRunStatus === 'failed'
            ? ` (falhou em ${status.lastRunFailures.map((failure) => `${failure.step}, ${failure.platform}`).join('; ') || 'uma etapa'})`
            : ' (ok)'
      }`
    : `${label} nunca registrada`;
  const next = status.nextRunAt
    ? `próxima ${formatWhen(status.nextRunAt)}`
    : `agendamento não informado ao sistema (${cronEnvVar})`;
  return `${last} · ${next}.`;
}

export function MarketingDashboardPage() {
  const [params, setParams] = useSearchParams();
  const tabParam = params.get('aba');
  const tab: TabKey = isTab(tabParam) ? tabParam : 'visao-geral';
  const daysParam = Number(params.get('dias'));
  const days: DashboardWindow = isWindow(daysParam) ? daysParam : 7;
  const windowed = TABS.find((item) => item.key === tab)?.windowed ?? false;
  const campaignScope: CockpitCampaignScope =
    params.get('campanhas') === 'todas' ? 'todas' : 'ativas';

  const overview = useDashboardOverview();
  const platforms = useDashboardPlatforms(days);
  const campaigns = useDashboardCampaigns(days);
  const creatives = useDashboardCreatives(days);
  const audience = useDashboardAudience(days);
  const siteTraffic = useDashboardSite(days);
  const cockpitData = useDashboardCockpit(days, campaignScope);
  const funnel = useDashboardFunnel(days);

  const setParam = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    next.set(key, value);
    setParams(next, { replace: true });
  };

  const ingestion = overview.data?.overview.ingestion ?? null;
  const reconciliation = overview.data?.overview.reconciliation ?? null;

  return (
    <>
      <header className="page-header page-header-row">
        <div>
          <h1>Dashboard de marketing</h1>
          <p>
            Gastos, saldos e desempenho lidos das plataformas pela ingestão. Nada aqui altera uma
            conta.
            {ingestion && (
              <span className="dash-ingestion">
                {' '}
                {jobLine('Última ingestão', ingestion, 'ADS_INGEST_CRON')}
              </span>
            )}
          </p>
          {reconciliation && (
            <p className="field-hint">
              {jobLine('Última reconciliação', reconciliation, 'ADS_RECONCILE_CRON')}
            </p>
          )}
        </div>
        {windowed && (
          <div className="dash-controls">
            {tab === 'cockpit' && (
              <div className="window-picker" role="group" aria-label="Campanhas">
                <span className="window-picker-label">Campanhas:</span>
                {(
                  [
                    ['ativas', 'Só ativas'],
                    ['todas', 'Todas'],
                  ] as const
                ).map(([value, label]) => (
                  <Button
                    key={value}
                    variant={value === campaignScope ? 'primary' : 'ghost'}
                    onClick={() => setParam('campanhas', value)}
                    aria-pressed={value === campaignScope}
                  >
                    {label}
                  </Button>
                ))}
              </div>
            )}
            <div className="window-picker" role="group" aria-label="Período">
              {DASHBOARD_WINDOWS.map((option) => (
                <Button
                  key={option}
                  variant={option === days ? 'primary' : 'ghost'}
                  onClick={() => setParam('dias', String(option))}
                  aria-pressed={option === days}
                >
                  {option} dias
                </Button>
              ))}
            </div>
          </div>
        )}
      </header>

      {overview.data && <DashboardRefresh overview={overview.data.overview} />}

      {ingestion?.overdue && (
        <Alert kind="warning">
          A ingestão agendada não rodou desde {formatDateTime(ingestion.lastRunAt)}: confira a
          tarefa agendada no Coolify. Os números desta tela param nessa data.
        </Alert>
      )}
      {reconciliation?.overdue && (
        <Alert kind="warning">
          A reconciliação agendada (15 min) não rodou desde{' '}
          {formatDateTime(reconciliation.lastRunAt)}: confira a tarefa agendada no Coolify. O teto
          real da conta pode estar desatualizado.
        </Alert>
      )}

      <nav className="dash-tabs" aria-label="Seções do dashboard">
        {TABS.map((item) => (
          <button
            key={item.key}
            type="button"
            className={`dash-tab${item.key === tab ? ' dash-tab-current' : ''}`}
            aria-current={item.key === tab ? 'page' : undefined}
            onClick={() => setParam('aba', item.key)}
          >
            {item.label}
          </button>
        ))}
      </nav>

      {tab === 'cockpit' && (
        <Loading query={cockpitData}>
          {cockpitData.data && <CockpitTab data={cockpitData.data.cockpit} />}
        </Loading>
      )}
      {tab === 'visao-geral' && (
        <Loading query={overview}>
          {overview.data && <OverviewTab overview={overview.data.overview} />}
        </Loading>
      )}
      {tab === 'plataformas' && (
        <Loading query={platforms}>
          {platforms.data && <PlatformsTab data={platforms.data.platforms} />}
        </Loading>
      )}
      {tab === 'campanhas' && (
        <Loading query={campaigns}>
          {campaigns.data && <CampaignsTab data={campaigns.data.campaigns} />}
        </Loading>
      )}
      {tab === 'criativos' && (
        <Loading query={creatives}>
          {creatives.data && <CreativesTab data={creatives.data.creatives} />}
        </Loading>
      )}
      {tab === 'publico' && (
        <Loading query={audience}>
          {audience.data && <AudienceTab data={audience.data.audience} />}
        </Loading>
      )}
      {tab === 'site' && (
        <Loading query={siteTraffic}>
          {siteTraffic.data && <SiteTab data={siteTraffic.data.site} />}
        </Loading>
      )}
      {tab === 'funil' && (
        <Loading query={funnel}>{funnel.data && <FunnelTab data={funnel.data.funnel} />}</Loading>
      )}
      {tab === 'insights' && <InsightsTab />}
      {tab === 'canais-proprios' && <OwnedChannelsTab days={days} />}
      {tab === 'configuracoes' && <SettingsTab />}
    </>
  );
}
