import { DASHBOARD_WINDOWS, type DashboardWindow } from '@wings/shared';
import { useSearchParams } from 'react-router-dom';
import {
  useDashboardAudience,
  useDashboardCampaigns,
  useDashboardCreatives,
  useDashboardOverview,
  useDashboardPlatforms,
} from '../api/dashboard.js';
import { AudienceTab } from '../components/dashboard/AudienceTab.js';
import { CampaignsTab } from '../components/dashboard/CampaignsTab.js';
import { CreativesTab } from '../components/dashboard/CreativesTab.js';
import { since } from '../components/dashboard/format.js';
import { OverviewTab } from '../components/dashboard/OverviewTab.js';
import { PlatformsTab } from '../components/dashboard/PlatformsTab.js';
import { Alert, Button } from '../components/ui.js';

/**
 * Dashboard → Marketing.
 *
 * Everything here is read from data the ingest job already mirrored: opening
 * a tab calls no platform, spends nothing and changes nothing. There is no
 * button on this screen that acts on an ad account; suggestions that become
 * requests are part 2, and they will go through the approval gate like every
 * other change.
 *
 * The tab and the period live in the address, so a view can be sent as a link.
 */

const TABS = [
  { key: 'visao-geral', label: 'Visão geral' },
  { key: 'plataformas', label: 'Por plataforma' },
  { key: 'campanhas', label: 'Campanhas' },
  { key: 'criativos', label: 'Criativos' },
  { key: 'publico', label: 'Público e região' },
] as const;
type TabKey = (typeof TABS)[number]['key'];

function isTab(value: string | null): value is TabKey {
  return TABS.some((tab) => tab.key === value);
}

function isWindow(value: number): value is DashboardWindow {
  return DASHBOARD_WINDOWS.includes(value as DashboardWindow);
}

function Loading({ query, children }: { query: { isLoading: boolean; isError: boolean }; children: React.ReactNode }) {
  if (query.isError) return <Alert kind="error">Não foi possível carregar esta aba. Tente de novo em instantes.</Alert>;
  if (query.isLoading) return <p className="muted">Carregando…</p>;
  return <>{children}</>;
}

export function MarketingDashboardPage() {
  const [params, setParams] = useSearchParams();
  const tabParam = params.get('aba');
  const tab: TabKey = isTab(tabParam) ? tabParam : 'visao-geral';
  const daysParam = Number(params.get('dias'));
  const days: DashboardWindow = isWindow(daysParam) ? daysParam : 7;

  const overview = useDashboardOverview();
  const platforms = useDashboardPlatforms(days);
  const campaigns = useDashboardCampaigns(days);
  const creatives = useDashboardCreatives(days);
  const audience = useDashboardAudience(days);

  const setParam = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    next.set(key, value);
    setParams(next, { replace: true });
  };

  const refreshedAt = platforms.data?.platforms.metricsFetchedAt ?? null;

  return (
    <>
      <header className="page-header page-header-row">
        <div>
          <h1>Dashboard de marketing</h1>
          <p>
            Gastos, saldos e desempenho lidos das plataformas
            {refreshedAt ? `, atualizados ${since(refreshedAt)}` : ''}. Nada aqui altera uma conta.
          </p>
        </div>
        {tab !== 'visao-geral' && (
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
        )}
      </header>

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

      {tab === 'visao-geral' && (
        <Loading query={overview}>{overview.data && <OverviewTab overview={overview.data.overview} />}</Loading>
      )}
      {tab === 'plataformas' && (
        <Loading query={platforms}>{platforms.data && <PlatformsTab data={platforms.data.platforms} />}</Loading>
      )}
      {tab === 'campanhas' && (
        <Loading query={campaigns}>{campaigns.data && <CampaignsTab data={campaigns.data.campaigns} />}</Loading>
      )}
      {tab === 'criativos' && (
        <Loading query={creatives}>{creatives.data && <CreativesTab data={creatives.data.creatives} />}</Loading>
      )}
      {tab === 'publico' && (
        <Loading query={audience}>{audience.data && <AudienceTab data={audience.data.audience} />}</Loading>
      )}
    </>
  );
}
