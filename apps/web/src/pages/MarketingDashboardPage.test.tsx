import {
  EMPTY_TOTALS,
  type DashboardAudience,
  type DashboardCampaigns,
  type DashboardCockpit,
  type DashboardCreatives,
  type DashboardFunnel,
  type DashboardSite,
  type DashboardOverview,
  type DashboardPlatforms,
  type IngestionStatus,
  type SpendStrip,
  type VerdictResult,
} from '@wings/shared';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api/client.js';

/**
 * The dashboard is read before somebody decides where money goes, so these
 * tests check that an unknowable figure stays visibly unknown, that a source
 * that is not configured says so rather than showing zeros, and that the
 * period and the tab travel in the address.
 */

/** Every campaign filter the page asked the Cockpit for, in order. */
const cockpitScopes: string[] = [];
/** Every campaign pick (ids joined by commas, '' for none) the page asked for. */
const cockpitPicks: string[] = [];

// Filled after the builders below; the mocks read it lazily.
const data = {} as {
  overview: DashboardOverview;
  platforms: DashboardPlatforms;
  campaigns: DashboardCampaigns;
  creatives: DashboardCreatives;
  audience: DashboardAudience;
  site: DashboardSite;
  funnel: DashboardFunnel;
  cockpit: DashboardCockpit;
};

const ok = <T,>(value: T) => ({ data: value, isLoading: false, isError: false });

/** Queries (by hook name) that currently fail with this error and hold no data. */
const failures: Record<string, unknown> = {};
const failed = (error: unknown) => ({
  data: undefined,
  isLoading: false,
  isError: true,
  error,
  refetch: vi.fn(),
});
const answer = <T,>(name: string, value: T) =>
  name in failures ? failed(failures[name]) : ok(value);

vi.mock('../api/dashboard.js', () => ({
  useDashboardOverview: () => answer('overview', { overview: data.overview }),
  useDashboardPlatforms: (days: number) =>
    answer('platforms', { platforms: { ...data.platforms, days } }),
  useDashboardCampaigns: () => answer('campaigns', { campaigns: data.campaigns }),
  useDashboardCreatives: () => answer('creatives', { creatives: data.creatives }),
  useDashboardAudience: () => answer('audience', { audience: data.audience }),
  useDashboardSite: () => answer('site', { site: data.site }),
  useDashboardFunnel: () => answer('funnel', { funnel: data.funnel }),
  useDashboardCockpit: (_days: number, scope: string, picked: string[] = []) => {
    cockpitScopes.push(scope);
    cockpitPicks.push(picked.join(','));
    return answer('cockpit', { cockpit: data.cockpit });
  },
}));
const requests = { canRequest: true, filed: vi.fn() };
vi.mock('../api/auth.js', () => ({
  useSession: () => ({ data: {} }),
  hasPermission: (_user: unknown, key: string) =>
    key === 'ads.request' ? requests.canRequest : true,
}));
vi.mock('../api/ads.js', () => ({
  useRequestCampaignChange: () => ({
    mutate: requests.filed,
    isPending: false,
    isError: false,
    isSuccess: false,
    error: null,
  }),
}));
vi.mock('../components/dashboard/DashboardRefresh.js', () => ({
  DashboardRefresh: () => <p>dados até</p>,
}));
// The other tabs have their own tests; here they only need to mount.
vi.mock('../components/dashboard/InsightsTab.js', () => ({ InsightsTab: () => <p>insights</p> }));
vi.mock('../components/dashboard/OwnedChannelsTab.js', () => ({
  OwnedChannelsTab: () => <p>canais</p>,
}));
vi.mock('../components/dashboard/SettingsTab.js', () => ({
  SettingsTab: () => <p>configurações</p>,
}));

const { MarketingDashboardPage } = await import('./MarketingDashboardPage.js');

function strip(overrides: Partial<SpendStrip>): SpendStrip {
  return {
    source: 'meta',
    unit: 'brl',
    configured: true,
    spent: 123_610,
    forecast: 231_800,
    available: 156_390,
    balance: 186_310,
    balanceSource: 'meta.spend_cap',
    ceiling: 400_000,
    daily: [
      { day: '2026-09-14', amount: 10_000 },
      { day: '2026-09-15', amount: 12_000 },
      { day: '2026-09-16', amount: 0 },
    ],
    activeDailyBudget: 10_000,
    refreshedAt: '2026-09-16T12:00:00.000Z',
    killSwitchEngaged: false,
    killSwitch: null,
    setupNote: null,
    forecastRule: null,
    ...overrides,
  } as SpendStrip;
}

const ingestion: IngestionStatus = {
  lastRunAt: '2026-09-16T12:00:00.000Z',
  lastRunStatus: 'ok',
  lastRunFailures: [],
  schedule: '0 * * * *',
  nextRunAt: '2026-09-16T13:00:00.000Z',
  overdue: false,
  dataUntil: '2026-09-16T12:02:00.000Z',
};

const reconciliation: IngestionStatus = {
  lastRunAt: '2026-09-16T11:50:00.000Z',
  lastRunStatus: 'ok',
  lastRunFailures: [],
  schedule: '*/15 * * * *',
  nextRunAt: '2026-09-16T12:05:00.000Z',
  overdue: false,
  dataUntil: '2026-09-16T11:50:10.000Z',
};

const positive: VerdictResult = {
  verdict: 'positive',
  primary: 'cpl',
  reasons: [
    {
      signal: 'cpl',
      state: 'good',
      text: 'CPL R$ 38,20 contra a meta de R$ 45,00 (-15%), 3 lead(s).',
    },
    {
      signal: 'ctr',
      state: 'good',
      text: 'CTR 2% contra a mediana da conta de 1,5% em 90 dias (+33%).',
    },
    {
      signal: 'trend',
      state: 'neutral',
      text: 'CPL de R$ 38,20 nos últimos 7 dias contra R$ 40,00 nos 7 anteriores (-4%).',
    },
    { signal: 'frequency', state: 'good', text: 'Frequência 1,2 no período.' },
    {
      signal: 'pacing',
      state: 'unknown',
      text: 'Orçamento diário fora da campanha (nos conjuntos) ou não informado.',
    },
  ],
};

function buildOverview(overrides: Partial<DashboardOverview> = {}): DashboardOverview {
  return {
    periodMonth: '2026-09-01',
    elapsedDays: 15.5,
    totalDays: 30,
    strips: [
      strip({ source: 'meta' }),
      strip({ source: 'google', balanceSource: 'google.prepaid_balance', balance: 50_000 }),
      strip({
        source: 'kairogen',
        unit: 'credits',
        spent: 10,
        forecast: 20,
        available: 990,
        balance: 990,
        ceiling: 1000,
        activeDailyBudget: null,
      }),
      strip({
        source: 'ai',
        spent: 275,
        forecast: 550,
        available: null,
        balance: null,
        ceiling: null,
        balanceSource: null,
        activeDailyBudget: 1100,
      }),
      strip({
        source: 'media',
        configured: false,
        spent: 0,
        forecast: null,
        available: 30_000,
        balance: null,
        ceiling: 30_000,
        balanceSource: null,
        activeDailyBudget: null,
        refreshedAt: null,
      }),
    ],
    counts: { openAlerts: 2, criticalAlerts: 1, pendingApprovals: 3, disapprovedAds: 1 },
    ingestion,
    reconciliation,
    health: [
      {
        key: 'conversions_measuring',
        platform: 'meta',
        state: 'problem',
        detail: 'Nenhum evento de lead nos últimos 3 dias com R$ 120,00 gastos.',
        action: 'Confira o pixel e a CAPI no Gerenciador de Eventos.',
      },
      {
        key: 'spend_pacing',
        platform: 'meta',
        state: 'ok',
        detail: 'Gasto 4% acima do previsto para o mês.',
        action: '',
      },
    ],
    accounts: [{ id: '11111111-1111-4111-8111-111111111111', platform: 'meta', name: 'Fly High' }],
    ...overrides,
  };
}

function buildPlatforms(): DashboardPlatforms {
  return {
    days: 7,
    since: '2026-09-10',
    until: '2026-09-16',
    previousSince: '2026-09-03',
    metricsFetchedAt: '2026-09-16T12:00:00.000Z',
    platforms: [
      {
        platform: 'meta',
        accounts: [{ id: 'a1', name: 'Fly High', externalId: 'act_1' }],
        current: {
          ...EMPTY_TOTALS,
          spendCents: 40_000,
          impressions: 8000,
          clicks: 160,
          reach: 6000,
        },
        previous: {
          ...EMPTY_TOTALS,
          spendCents: 20_000,
          impressions: 4000,
          clicks: 100,
          reach: 3000,
        },
        daily: [
          { day: '2026-09-15', amount: 10_000 },
          { day: '2026-09-16', amount: 0 },
        ],
      },
      {
        platform: 'google',
        accounts: [],
        current: EMPTY_TOTALS,
        previous: EMPTY_TOTALS,
        daily: [
          { day: '2026-09-15', amount: 0 },
          { day: '2026-09-16', amount: 0 },
        ],
      },
    ],
  };
}

function buildCampaigns(): DashboardCampaigns {
  return {
    days: 7,
    since: '2026-09-10',
    until: '2026-09-16',
    campaigns: [
      {
        externalId: 'c1',
        platform: 'meta',
        accountName: 'Fly High',
        accountExternalId: 'act_694058302567457',
        systemCreated: true,
        launchDefaults: null,
        startDate: '2026-09-28',
        endDate: '2026-10-02',
        targetCplCents: 4500,
        mirroredAt: '2026-09-28T13:00:00.000Z',
        name: 'LEAD | FORMS',
        status: 'ACTIVE',
        objective: 'OUTCOME_LEADS',
        budgetLevel: 'ad_set',
        dailyBudgetCents: null,
        totals: { ...EMPTY_TOTALS, spendCents: 4_500, impressions: 2000, clicks: 40 },
        adSets: [
          {
            externalId: 'as1',
            name: 'Conjunto SP',
            status: 'ACTIVE',
            dailyBudgetCents: 3000,
            endDate: '2026-10-13',
            placements: { platforms: ['instagram'], positions: ['instagram:stream'] },
            totals: { ...EMPTY_TOTALS, spendCents: 4_500, impressions: 2000, clicks: 40 },
            ads: [
              {
                externalId: 'ad1',
                name: 'Reels 15s',
                status: 'ACTIVE',
                effectiveStatus: 'ACTIVE',
                format: 'video',
                thumbnailUrl: null,
                totals: { ...EMPTY_TOTALS, spendCents: 4_500, impressions: 2000, clicks: 40 },
              },
            ],
          },
        ],
        orphanAds: [],
        alertCount: 1,
        verdict: positive,
      },
    ],
  };
}

function buildCreatives(): DashboardCreatives {
  return {
    days: 7,
    since: '2026-09-10',
    until: '2026-09-16',
    formats: [
      {
        format: 'video',
        ads: 1,
        totals: {
          ...EMPTY_TOTALS,
          spendCents: 4_500,
          impressions: 2000,
          clicks: 40,
          videoPlays: 600,
        },
      },
    ],
    creatives: [
      {
        adExternalId: 'ad1',
        name: 'Reels 15s',
        campaignName: 'LEAD | FORMS',
        platform: 'meta',
        format: 'video',
        thumbnailUrl: null,
        headline: null,
        effectiveStatus: 'ACTIVE',
        utmContent: 'video-1',
        totals: {
          ...EMPTY_TOTALS,
          spendCents: 4_500,
          impressions: 2000,
          clicks: 40,
          reach: 800,
          videoPlays: 600,
          videoThruplays: 240,
          videoP25: 500,
          videoP50: 300,
          videoP75: 150,
          videoP100: 60,
          videoStarts: 1000,
          videoWatchMs: 6_400_000,
        },
        fatigue: {
          firstHalfCtrMilli: 2500,
          secondHalfCtrMilli: 1500,
          frequencyMilli: 2500,
          wornOut: true,
        },
      },
    ],
  };
}

function buildAudience(): DashboardAudience {
  return {
    days: 7,
    since: '2026-09-10',
    until: '2026-09-16',
    platforms: ['meta'],
    rows: [
      {
        kind: 'placement',
        key: 'instagram',
        subKey: 'instagram_reels',
        totals: {
          ...EMPTY_TOTALS,
          spendCents: 3_000,
          impressions: 1500,
          clicks: 30,
          conversions: 2,
        },
      },
      {
        kind: 'age_gender',
        key: '25-34',
        subKey: 'female',
        totals: { ...EMPTY_TOTALS, spendCents: 2_000, impressions: 900, clicks: 20 },
      },
      {
        kind: 'region',
        key: 'São Paulo',
        subKey: '',
        totals: { ...EMPTY_TOTALS, spendCents: 4_000, impressions: 1800, clicks: 36 },
      },
      {
        kind: 'hour',
        key: '20',
        subKey: '',
        totals: { ...EMPTY_TOTALS, spendCents: 1_000, impressions: 400, clicks: 8, conversions: 1 },
      },
      {
        kind: 'device',
        key: 'mobile_app',
        subKey: '',
        totals: {
          ...EMPTY_TOTALS,
          spendCents: 3_500,
          impressions: 1600,
          clicks: 32,
          conversions: 2,
        },
      },
    ],
    heatmap: [
      { weekday: 2, hour: '20', spendCents: 1_000, clicks: 8, impressions: 400, conversions: 1 },
      { weekday: 5, hour: '09', spendCents: 400, clicks: 3, impressions: 150, conversions: 0 },
    ],
  };
}

Object.assign(data, {
  overview: buildOverview(),
  platforms: buildPlatforms(),
  campaigns: buildCampaigns(),
  creatives: buildCreatives(),
  audience: buildAudience(),
});

function renderAt(path = '/dashboard/marketing') {
  render(
    <MemoryRouter initialEntries={[path]}>
      <MarketingDashboardPage />
    </MemoryRouter>,
  );
}

// pt-BR currency puts a non-breaking space after the symbol; read it as a space.
const text = (element: Element | null | undefined) =>
  element?.textContent?.replace(new RegExp(String.fromCharCode(160), 'g'), ' ') ?? '';

beforeEach(() => {
  data.overview = buildOverview();
  for (const key of Object.keys(failures)) delete failures[key];
});

afterEach(() => {
  cleanup();
});

describe('the overview', () => {
  it('shows one strip per source, in reais or credits, with what is unknowable left as a dash', () => {
    renderAt();
    const strips = screen
      .getAllByRole('listitem')
      .filter((item) => item.classList.contains('strip'));
    expect(strips).toHaveLength(5);
    expect(text(strips[0])).toContain('Meta Ads');
    expect(text(strips[0])).toContain('R$ 1.236,10');
    expect(text(strips[2])).toContain('10 cr.');
    // The agent has no monthly ceiling: a dash, not R$ 0,00.
    const ai = strips[3];
    expect(text(ai)).toContain('IA (OpenRouter)');
    expect(within(ai as HTMLElement).getAllByText('—').length).toBeGreaterThanOrEqual(2);
  });

  it('puts the figures in cards and the forecast arithmetic behind "como calculamos"', () => {
    data.overview = buildOverview({
      strips: [
        strip({
          forecastRule: 'R$ 1.236,10 gastos + R$ 100,00 por dia nos 11 dias que faltam',
        }),
      ],
    });
    renderAt();
    const meta = screen
      .getAllByRole('listitem')
      .filter((item) => item.classList.contains('strip'))[0] as HTMLElement;
    expect(within(meta).getByLabelText(/Previsto para o mês: R\$\s?2\.318,00/)).toBeTruthy();
    const how = within(meta).getByText('Como calculamos o previsto').closest('details')!;
    expect(how.open).toBe(false);
    expect(text(how)).toContain('R$ 100,00 por dia nos 11 dias que faltam');
    // Without WebGL each chart is its table: the month against the ceiling, then each day.
    expect(within(meta).getByRole('table', { name: 'Meta Ads no mês' })).toBeTruthy();
    expect(within(meta).getByRole('cell', { name: 'Teto do mês' })).toBeTruthy();
    expect(within(meta).getByRole('table', { name: 'Meta Ads, gasto por dia' })).toBeTruthy();
  });

  it('says when a source is not configured instead of showing zeros as spend', () => {
    renderAt();
    const media = screen
      .getAllByRole('listitem')
      .filter((item) => item.classList.contains('strip'))[4] as HTMLElement;
    expect(within(media).getByText('não configurado')).toBeTruthy();
  });

  it('says why the kill switch tripped, when, and how a person releases it', () => {
    data.overview = buildOverview({
      strips: [
        strip({
          killSwitchEngaged: true,
          killSwitch: {
            rule: 'budgets_exceed_plan',
            reason: 'Orçamentos na plataforma excedem o limite planejado do mês',
            engagedAt: '2026-09-19T18:00:00.000Z',
            accountExternalId: 'act_694058302567457',
          },
        }),
      ],
    });
    renderAt();
    const alert = screen
      .getByText(/Trava de segurança acionada/)
      .closest('[role="alert"], .alert') as HTMLElement;
    expect(alert.textContent).toContain('19/09');
    expect(alert.textContent).toContain('excedem o limite planejado');
    expect(alert.textContent).toContain('Orçamentos ativos na plataforma somam mais');
    expect(alert.textContent).toContain(
      'ops-cli release-kill-switch --account act_694058302567457',
    );
    expect(alert.textContent).toContain('resolve-unknown');
  });

  it('links the pending approvals to the queue', () => {
    renderAt();
    const link = screen.getByRole('link', { name: '3' });
    expect(link.getAttribute('href')).toBe('/marketing/trafego-pago-wings/aprovacoes');
  });

  it('says in the header when the ingestion last ran and when the next one is due', () => {
    renderAt();
    expect(screen.getByText(/Última ingestão 16\/09, 09:00 \(ok\)/)).toBeTruthy();
    // The next run is on another day than "now": the date travels with the hour.
    expect(screen.getByText(/próxima 16\/09, 10:00/)).toBeTruthy();
    expect(screen.queryByText(/não rodou desde/)).toBeNull();
  });

  it('warns when the scheduled ingestion is overdue, and names the failed step', () => {
    data.overview = buildOverview({
      ingestion: {
        ...ingestion,
        overdue: true,
        lastRunStatus: 'failed',
        lastRunFailures: [{ platform: 'google', step: 'breakdown:region' }],
      },
    });
    renderAt();
    expect(screen.getByText(/A ingestão agendada não rodou desde 16\/09, 09:00/)).toBeTruthy();
    expect(screen.getByText(/falhou em breakdown:region, google/)).toBeTruthy();
  });

  it('says when the schedule was never told to the system', () => {
    data.overview = buildOverview({ ingestion: { ...ingestion, schedule: null, nextRunAt: null } });
    renderAt();
    expect(screen.getByText(/agendamento ainda não configurado/)).toBeTruthy();
  });

  it('says in the header when the fast reconciliation last ran and when the next one is due', () => {
    renderAt();
    expect(screen.getByText(/Última reconciliação 16\/09, 08:50 \(ok\)/)).toBeTruthy();
    expect(screen.getByText(/próxima 16\/09, 09:05/)).toBeTruthy();
  });

  it('warns when the scheduled reconciliation is overdue, separately from the full ingestion', () => {
    data.overview = buildOverview({
      reconciliation: { ...reconciliation, overdue: true, lastRunStatus: 'failed' },
    });
    renderAt();
    expect(
      screen.getByText(/A reconciliação agendada \(15 min\) não rodou desde 16\/09, 08:50/),
    ).toBeTruthy();
    expect(screen.queryByText(/A ingestão agendada não rodou desde/)).toBeNull();
  });

  it('shows the setup note of a source with credentials but no account, with the command as code', () => {
    data.overview = buildOverview({
      strips: [
        strip({
          source: 'google',
          refreshedAt: null,
          setupNote:
            'Credenciais do Google configuradas, mas nenhuma conta foi semeada: rode `ingest-cli --seed --platform google`.',
        }),
      ],
    });
    renderAt();
    expect(screen.getByText(/nenhuma conta foi semeada/)).toBeTruthy();
    expect(screen.getByText('ingest-cli --seed --platform google').tagName).toBe('CODE');
    expect(screen.getByText('sem dados ainda')).toBeTruthy();
  });

  it('lists the health of the account with a state in words and what to do', () => {
    renderAt();
    const health = screen.getByRole('region', { name: 'Saúde da conta' });
    expect(within(health).getByText('Problema')).toBeTruthy();
    expect(within(health).getByText('Conversões medindo')).toBeTruthy();
    expect(within(health).getByText(/Confira o pixel e a CAPI/)).toBeTruthy();
    expect(within(health).getByText('Em ordem')).toBeTruthy();
    // No action when nothing is needed.
    expect(within(health).getAllByText(/O que fazer:/)).toHaveLength(1);
  });
});

describe('the tabs and the period', () => {
  it('opens the tab named in the address, with the period the address asks for', () => {
    renderAt('/dashboard/marketing?aba=plataformas&dias=30');
    expect(screen.getByRole('button', { name: '30 dias' }).getAttribute('aria-pressed')).toBe(
      'true',
    );
    expect(screen.getByText(/comparado com os 30 dias anteriores/)).toBeTruthy();
  });

  it('switches tabs on a click', () => {
    renderAt();
    fireEvent.click(screen.getByRole('button', { name: 'Campanhas' }));
    expect(screen.getByText('LEAD | FORMS')).toBeTruthy();
  });
});

describe('per platform', () => {
  it('reads the change against the previous window, and leaves CPL empty without leads', () => {
    renderAt('/dashboard/marketing?aba=plataformas');
    const spend = screen.getByRole('row', { name: /Gasto/ });
    expect(text(spend)).toContain('R$ 400,00');
    expect(text(spend)).toContain('+100%');
    const cpl = screen.getByRole('row', { name: /CPL/ });
    expect(within(cpl).getAllByText('—').length).toBeGreaterThan(0);
  });
});

describe('campaigns', () => {
  it('opens a campaign into its ad sets, and an ad set into its ads', () => {
    renderAt('/dashboard/marketing?aba=campanhas');
    expect(screen.queryByText('Conjunto SP')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Abrir LEAD | FORMS' }));
    expect(screen.getByText('Conjunto SP')).toBeTruthy();
    // Where the ad set delivers and its own end, when the platform told them.
    expect(screen.getByText(/conjunto, 1 anúncio · Instagram · até 13\/10/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Abrir anúncios de Conjunto SP' }));
    expect(screen.getByText('Reels 15s')).toBeTruthy();
    expect(screen.getByText('Vídeo')).toBeTruthy();
  });

  it('shows platform, period and the CPL target, and files a pause as a request, never directly', () => {
    requests.canRequest = true;
    renderAt('/dashboard/marketing?aba=campanhas');
    const row = screen.getByText('LEAD | FORMS').closest('tr')!;
    expect(text(row)).toContain('Meta');
    expect(text(row)).toContain('28/09 – 02/10');
    expect(text(row)).toContain('meta de CPL R$ 45,00');
    expect(text(row)).toContain('criada pelo sistema');
    // Running, budget in the ad sets: only Pausar applies.
    expect(within(row).queryByRole('button', { name: 'Retomar' })).toBeNull();
    expect(within(row).queryByRole('button', { name: 'Mudar verba diária' })).toBeNull();
    fireEvent.click(within(row).getByRole('button', { name: 'Pausar' }));
    fireEvent.click(within(row).getByRole('button', { name: 'Pedir aprovação' }));
    expect(requests.filed).not.toHaveBeenCalled();
    expect(text(row)).toContain('Escreva o motivo do pedido.');
    fireEvent.change(within(row).getByLabelText(/^Motivo/), {
      target: { value: 'CPL acima da meta há 5 dias' },
    });
    fireEvent.click(within(row).getByRole('button', { name: 'Pedir aprovação' }));
    expect(requests.filed).toHaveBeenCalledWith({
      accountExternalId: 'act_694058302567457',
      campaignExternalId: 'c1',
      kind: 'pause_campaign',
      reason: 'CPL acima da meta há 5 dias',
    });
  });

  it('offers no request buttons without the permission, or on a campaign made by hand', () => {
    requests.canRequest = false;
    renderAt('/dashboard/marketing?aba=campanhas');
    expect(screen.queryByRole('button', { name: 'Pausar' })).toBeNull();
    cleanup();
    requests.canRequest = true;
    data.campaigns = {
      ...data.campaigns,
      campaigns: data.campaigns.campaigns.map((c) => ({ ...c, systemCreated: false })),
    };
    renderAt('/dashboard/marketing?aba=campanhas');
    expect(screen.queryByRole('button', { name: 'Pausar' })).toBeNull();
    data.campaigns = buildCampaigns();
  });

  it('keeps the API order (newest start first), and can flip it or sort by spend', () => {
    const base = data.campaigns.campaigns[0]!;
    const search = {
      ...base,
      externalId: '24289782134',
      platform: 'google' as const,
      name: 'SEARCH | Formatação | Alta Intenção | Set26',
      startDate: '2026-09-29',
      endDate: null,
      systemCreated: false,
      totals: { ...base.totals, spendCents: 0 },
      adSets: [],
    };
    // The API sends it first: it starts later, whatever it spent.
    data.campaigns = { ...data.campaigns, campaigns: [search, base] };
    renderAt('/dashboard/marketing?aba=campanhas');
    const names = () =>
      screen.getAllByRole('row').flatMap((row) => {
        const strong = row.querySelector('strong');
        return strong ? [strong.textContent] : [];
      });
    expect(names()).toEqual(['SEARCH | Formatação | Alta Intenção | Set26', 'LEAD | FORMS']);
    expect(
      text(screen.getByText('SEARCH | Formatação | Alta Intenção | Set26').closest('tr')),
    ).toContain('29/09 – sem fim');
    fireEvent.change(screen.getByLabelText('Ordem das campanhas'), {
      target: { value: 'antigas' },
    });
    expect(names()).toEqual(['LEAD | FORMS', 'SEARCH | Formatação | Alta Intenção | Set26']);
    fireEvent.change(screen.getByLabelText('Ordem das campanhas'), { target: { value: 'gasto' } });
    expect(names()[0]).toBe('LEAD | FORMS');
    data.campaigns = buildCampaigns();
  });

  it('filters campaigns by name', () => {
    renderAt('/dashboard/marketing?aba=campanhas');
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'institucional' } });
    expect(screen.getByText('Nenhuma campanha com esse nome.')).toBeTruthy();
  });

  it('shows the verdict as a word, with the five reasons and their numbers behind it', () => {
    renderAt('/dashboard/marketing?aba=campanhas');
    expect(screen.getByText('Positiva')).toBeTruthy();
    expect(screen.getByText(/CPL R\$ 38,20 contra a meta/)).toBeTruthy();
    expect(screen.getByText('CTR contra a mediana da conta')).toBeTruthy();
    expect(screen.getByText(/Abaixo de R\$ 20,00 ou 500 impressões não há veredito/)).toBeTruthy();
  });

  it('sends a campaign without a target to the settings', () => {
    data.campaigns.campaigns[0]!.verdict = { ...positive, verdict: 'no_target' };
    renderAt('/dashboard/marketing?aba=campanhas');
    expect(screen.getByText('Sem meta')).toBeTruthy();
    const link = screen.getByRole('link', { name: 'Confirmar a meta em Configurações' });
    expect(link.getAttribute('href')).toBe('/dashboard/marketing?aba=configuracoes');
    data.campaigns.campaigns[0]!.verdict = positive;
  });
});

describe('creatives', () => {
  it('names a worn-out ad and reads its video funnel from plays', () => {
    renderAt('/dashboard/marketing?aba=criativos');
    expect(screen.getByText('desgastado')).toBeTruthy();
    const row = screen.getByText('Reels 15s').closest('tr');
    // 600 plays of 2000 impressions; 240 ThruPlays of 600 plays; 60 to the end.
    expect(text(row)).toContain('30%');
    expect(text(row)).toContain('40%');
    expect(text(row)).toContain('10%');
    // Which ad it is in the leads: its utm_content.
    expect(text(row)).toContain('utm_content=video-1');
  });

  it('shows the average time watched per start, ThruPlays and the four quarters', () => {
    renderAt('/dashboard/marketing?aba=criativos');
    const row = screen.getByText('Reels 15s').closest('tr');
    // 6,400 s over 1,000 starts; quarters on the starts: 500, 300, 150, 60 of 1,000.
    expect(text(row)).toContain('6,4 s');
    expect(text(row)).toContain('240');
    expect(text(row)).toContain('50 · 30 · 15 · 6%');
  });
});

describe('site and funnel', () => {
  it('explains what GA4 still needs when it is not connected', () => {
    data.site = {
      days: 7,
      since: '2026-09-22',
      until: '2026-09-28',
      configured: false,
      propertyId: null,
      fetchedAt: null,
      totals: { sessions: 0, engagedSessions: 0, engagementSeconds: 0, pageViews: 0, keyEvents: 0 },
      rows: [],
    };
    renderAt('/dashboard/marketing?aba=site');
    expect(screen.getByText(/consentimento OAuth/)).toBeTruthy();
  });

  it('shows sessions with engagement, time and pages per session', () => {
    data.site = {
      days: 7,
      since: '2026-09-22',
      until: '2026-09-28',
      configured: true,
      propertyId: '123',
      fetchedAt: '2026-09-28T18:00:00.000Z',
      totals: {
        sessions: 50,
        engagedSessions: 35,
        engagementSeconds: 1300,
        pageViews: 92,
        keyEvents: 2,
      },
      rows: [
        {
          source: 'facebook',
          medium: 'cpc',
          campaign: 'formatacao_jimmyogro_set26',
          sessions: 40,
          engagedSessions: 30,
          engagementSeconds: 1200,
          pageViews: 80,
          keyEvents: 2,
        },
      ],
    };
    renderAt('/dashboard/marketing?aba=site');
    const row = screen.getByText('formatacao_jimmyogro_set26').closest('tr');
    expect(text(row)).toContain('facebook / cpc');
    expect(text(row)).toContain('75');
    expect(text(row)).toContain('30 s');
  });

  it('follows a platform to the sale with the cost of each step, and a campaign to the lead', () => {
    data.funnel = {
      days: 7,
      since: '2026-09-22',
      until: '2026-09-28',
      siteConfigured: true,
      crmConfigured: true,
      crmFetchedAt: '2026-09-28T18:00:00.000Z',
      crmUnattributed: 3,
      platforms: [
        {
          platform: 'meta',
          spendCents: 60_000,
          impressions: 20_000,
          clicks: 300,
          sessions: 200,
          leads: 10,
          crmLeads: 8,
          meetings: 3,
          sales: 1,
        },
      ],
      campaigns: [
        {
          platform: 'meta',
          externalId: 'c1',
          name: 'LEAD | FORMS',
          spendCents: 60_000,
          impressions: 20_000,
          clicks: 300,
          sessions: 200,
          leads: 10,
          matchedSiteCampaigns: ['lead | forms'],
        },
      ],
    };
    renderAt('/dashboard/marketing?aba=funil');
    // Without WebGL the funnel is its table: count, cost per step and the share that passed.
    const sales = screen.getByRole('cell', { name: 'Vendas' }).closest('tr');
    expect(text(sales)).toContain('R$ 600,00');
    expect(text(sales)).toContain('33,33%');
    const meetings = screen.getByRole('cell', { name: 'Reuniões' }).closest('tr');
    expect(text(meetings)).toContain('R$ 200,00');
    expect(screen.getByText(/escala logarítmica/)).toBeTruthy();
    expect(screen.getByText(/3 negociação\(ões\) do período não dizem a plataforma/)).toBeTruthy();
    const row = screen.getByText('LEAD | FORMS').closest('tr');
    expect(text(row)).toContain('R$ 3,00');
    expect(text(row)).toContain('R$ 60,00');
  });
});

describe('audience and region', () => {
  it('names the slices in the words a person uses', () => {
    renderAt('/dashboard/marketing?aba=publico');
    expect(screen.getByText('Instagram · Reels')).toBeTruthy();
    expect(screen.getByText('Mulheres')).toBeTruthy();
    expect(screen.getByText('São Paulo')).toBeTruthy();
    expect(screen.getByText(/Melhores horas por CPL: 20h/)).toBeTruthy();
  });

  it("ranks devices in a person's words and draws the week as weekday by hour", () => {
    renderAt('/dashboard/marketing?aba=publico');
    expect(screen.getByText('Celular (app)')).toBeTruthy();
    // Without WebGL the weekday × hour map is its table: one row per hour with anything in it.
    const map = screen.getByRole('table', {
      name: 'Gasto, cliques e leads por dia da semana e hora',
    });
    const cell = within(map).getByRole('cell', { name: 'Ter 20h' }).closest('tr');
    expect(text(cell)).toMatch(/R\$\s?10,00.*8.*1/);
    expect(within(map).queryByRole('cell', { name: 'Dom 00h' })).toBeNull();
    expect(screen.getByText(/Laranja mais escuro, mais gasto; cinza, sem gasto/)).toBeTruthy();
    expect(screen.getByText(/Melhores horários por CPL: Ter 20h \(R\$ 10,00\)/)).toBeTruthy();
  });
});

describe('the new tabs', () => {
  it('opens insights, canais próprios and configurações from the address, with the period only where it applies', () => {
    renderAt('/dashboard/marketing?aba=insights');
    expect(screen.getByText('insights')).toBeTruthy();
    expect(screen.queryByRole('group', { name: 'Período' })).toBeNull();
    cleanup();
    renderAt('/dashboard/marketing?aba=canais-proprios');
    expect(screen.getByText('canais')).toBeTruthy();
    expect(screen.getByRole('group', { name: 'Período' })).toBeTruthy();
    cleanup();
    renderAt('/dashboard/marketing?aba=configuracoes');
    expect(screen.getByText('configurações')).toBeTruthy();
  });
});

describe('the cockpit', () => {
  it('names the active campaigns it sums, and warns about ads that are on but not serving', () => {
    data.cockpit = {
      days: 7,
      since: '2026-09-22',
      until: '2026-09-28',
      previousSince: '2026-09-15',
      previousUntil: '2026-09-21',
      current: {
        ...{
          spendCents: 0,
          impressions: 0,
          clicks: 0,
          leads: 0,
          sessions: null,
          crmLeads: 0,
          meetings: 0,
          sales: 0,
        },
        spendCents: 150_000,
        impressions: 40_000,
        clicks: 800,
        leads: 30,
      },
      previous: {
        spendCents: 0,
        impressions: 0,
        clicks: 0,
        leads: 0,
        sessions: null,
        crmLeads: 0,
        meetings: 0,
        sales: 0,
      },
      daily: [],
      regions: [],
      otherRegionsSpendCents: 0,
      creatives: [],
      alerts: [],
      activeCampaigns: [
        {
          id: 'c-meta',
          platform: 'meta',
          externalId: '1',
          name: 'Meta 28Set',
          deliveryStatus: 'ACTIVE',
          delivering: true,
          startDate: '2026-09-28',
          endDate: null,
          dailyBudgetCents: 24_000,
          spentTodayCents: 12_000,
        },
        {
          id: 'c-google',
          platform: 'google',
          externalId: '2',
          name: 'SEARCH | Formatação | Alta Intenção',
          deliveryStatus: 'SERVING',
          delivering: true,
          startDate: '2026-09-24',
          endDate: null,
          dailyBudgetCents: null,
          spentTodayCents: 3_000,
        },
      ],
      adWarnings: [
        {
          platform: 'meta',
          adExternalId: '9',
          adName: 'Vídeo novo',
          campaignName: 'Meta 28Set',
          issue: 'PENDING_REVIEW',
        },
      ],
      activePerformance: {
        since: '2026-09-28',
        spendCents: 48_000,
        leads: 3,
        qualified: 1,
        sales: 0,
        revenueCents: 0,
        costPerLeadCents: 16_000,
        costPerQualifiedCents: 48_000,
        cacCents: null,
        roasCentuple: null,
        smallSample: true,
        fetchedAt: '2026-09-28T20:00:00.000Z',
      },
      campaignOptions: [
        { id: 'c-meta', platform: 'meta', name: 'Meta 28Set', delivering: true },
        {
          id: 'c-google',
          platform: 'google',
          name: 'SEARCH | Formatação | Alta Intenção',
          delivering: true,
        },
      ],
      selection: null,
      campaignScope: 'ativas',
      statusSummary: {
        withStatus: 4,
        delivering: 2,
        ended: [
          { platform: 'meta', name: 'Meta Jimmy Ogro', endDate: '2026-10-05' },
          { platform: 'meta', name: 'Meta Vídeos Thais', endDate: '2026-10-05' },
        ],
        notDelivering: 0,
      },
      spendReadAt: '2026-09-22T12:00:00.000Z',
      spendByPlatform: { meta: 120_000, google: 30_000 },
      cplTargetCents: null,
      today: '2026-09-28',
    };
    renderAt('/dashboard/marketing?aba=cockpit');
    expect(screen.getByText(/Só campanhas ativas \(2\)/)).toBeTruthy();
    // The status a person set against what delivers, so 4 "ativas" and 2 in the figures read as intended.
    expect(screen.getByText(/2 de 4 com status ativo; 2 encerradas em 05\/10/)).toBeTruthy();
    // When the spend was last read, beside both investment figures.
    expect(screen.getAllByText(/lido em 22\/09,? 09:00/)).toHaveLength(2);
    expect(screen.getByText('Meta 28Set')).toBeTruthy();
    const warnings = screen
      .getByRole('heading', { name: 'Anúncios ligados que não estão rodando' })
      .closest('section')!;
    expect(within(warnings).getByText('Em análise')).toBeTruthy();
    expect(within(warnings).getByText(/Vídeo novo/)).toBeTruthy();
    // Only platform leads can draw the second chart: none here, so a dash and why.
    expect(screen.getByText(/As plataformas não contaram nenhum lead/)).toBeTruthy();
    const active = screen.getByRole('heading', { name: /Performance ativa/ }).closest('section')!;
    expect(within(active).getByText('Amostra pequena')).toBeTruthy();
    expect(within(active).getByText('R$ 160,00')).toBeTruthy();
    expect(within(active).getAllByText('sem venda "Ganho" ainda')).toHaveLength(2);
  });
});

describe('the cockpit campaign filter', () => {
  it('starts on "Só ativas", switches to "Todas" and keeps it in the address', () => {
    cockpitScopes.length = 0;
    renderAt('/dashboard/marketing?aba=cockpit');
    expect(cockpitScopes.at(-1)).toBe('ativas');
    const group = screen.getByRole('group', { name: 'Campanhas' });
    fireEvent.click(within(group).getByRole('button', { name: 'Todas' }));
    expect(cockpitScopes.at(-1)).toBe('todas');
    expect(within(group).getByRole('button', { name: 'Todas' }).getAttribute('aria-pressed')).toBe(
      'true',
    );
    cleanup();
    renderAt('/dashboard/marketing?aba=cockpit&campanhas=todas');
    expect(cockpitScopes.at(-1)).toBe('todas');
  });

  it('picks campaigns from a list, keeps the pick in the address, and clears it', () => {
    data.cockpit = {
      ...data.cockpit,
      campaignOptions: [
        { id: 'c-meta', platform: 'meta', name: 'Jimmy Ogro 28Set', delivering: true },
        { id: 'c-google', platform: 'google', name: 'SEARCH Formatação', delivering: true },
      ],
      selection: null,
    };
    cockpitPicks.length = 0;
    renderAt('/dashboard/marketing?aba=cockpit');
    expect(cockpitPicks.at(-1)).toBe('');
    fireEvent.click(screen.getByRole('button', { name: /Todas as ativas/ }));
    const panel = screen.getByRole('group', { name: 'Escolher campanhas' });
    // Each active campaign, by name, with its platform.
    expect(within(panel).getByText('Jimmy Ogro 28Set')).toBeTruthy();
    expect(within(panel).getByText('(Meta Ads)')).toBeTruthy();
    fireEvent.click(within(panel).getByLabelText(/Jimmy Ogro 28Set/));
    expect(cockpitPicks.at(-1)).toBe('c-meta');
    fireEvent.click(within(panel).getByLabelText(/SEARCH Formatação/));
    expect(cockpitPicks.at(-1)).toBe('c-meta,c-google');
    fireEvent.click(within(panel).getByLabelText('Todas as ativas'));
    expect(cockpitPicks.at(-1)).toBe('');
  });

  it('opens on the campaigns named in a shared link', () => {
    cockpitPicks.length = 0;
    renderAt('/dashboard/marketing?aba=cockpit&campanha=c-google');
    expect(cockpitPicks.at(-1)).toBe('c-google');
    expect(screen.getByRole('button', { name: /SEARCH Formatação/ })).toBeTruthy();
  });

  it('says why a figure is "—" while campaigns are picked', () => {
    data.cockpit = {
      ...data.cockpit,
      current: { ...data.cockpit.current, sessions: null, meetings: null, sales: null },
      previous: { ...data.cockpit.previous, sessions: null, meetings: null, sales: null },
      selection: {
        ids: ['c-meta'],
        unknown: 0,
        crmSince: '2026-09-28',
        why: {
          sessions: 'as sessões do site não são separadas por campanha',
          crmLeads: null,
          meetings: 'o RD não atribui reuniões a uma campanha',
          sales: null,
        },
      },
    };
    renderAt('/dashboard/marketing?aba=cockpit&campanha=c-meta');
    expect(
      screen.getAllByText('as sessões do site não são separadas por campanha').length,
    ).toBeGreaterThan(0);
    expect(screen.getAllByText('o RD não atribui reuniões a uma campanha').length).toBeGreaterThan(
      0,
    );
  });

  it('puts a balloon on the state with the most spend', () => {
    data.cockpit = {
      ...data.cockpit,
      regions: [
        { uf: 'RJ', spendCents: 7582, leads: 0, impressions: 900 },
        { uf: 'SP', spendCents: 1200, leads: 0, impressions: 100 },
      ],
    };
    renderAt('/dashboard/marketing?aba=cockpit');
    expect(text(document.querySelector('.cockpit-balloon'))).toBe('RJ R$ 75,82 · 0 lead(s)');
  });
});

describe('when a tab fails to load', () => {
  it.each([
    ['visao-geral', 'overview', 'a visão geral'],
    ['plataformas', 'platforms', 'os dados por plataforma'],
    ['campanhas', 'campaigns', 'as campanhas'],
    ['criativos', 'creatives', 'os criativos'],
    ['publico', 'audience', 'o público e as regiões'],
    ['site', 'site', 'os dados do site'],
    ['funil', 'funnel', 'o funil'],
    ['cockpit', 'cockpit', 'o cockpit'],
  ])('says "—" and why on %s, with no figures', (tab, query, what) => {
    failures[query] = new ApiError(500, {});
    renderAt(`/dashboard/marketing?aba=${tab}`);

    const alert = screen.getAllByRole('alert')[0]!;
    expect(alert.textContent).toContain(`Não foi possível carregar ${what}: o servidor teve um`);
    // No figure, no "sem dados" state and no zero stands in for the numbers.
    expect(screen.queryByText('Carregando…')).toBeNull();
    expect(screen.queryByText(/R\$ 0,00/)).toBeNull();
    expect(screen.queryByText('sem dados ainda')).toBeNull();
  });

  it('does not offer the campaign picker on the Cockpit without its options', () => {
    failures.cockpit = new ApiError(500, {});
    renderAt('/dashboard/marketing?aba=cockpit&campanha=c-meta');

    expect(screen.queryByText('Campanha:')).toBeNull();
  });

  it('flags the missing ingestion state on another tab, where its warnings would be', () => {
    failures.overview = new ApiError(403, {});
    renderAt('/dashboard/marketing?aba=campanhas');

    expect(
      screen.getByText(/Não foi possível carregar o estado da ingestão: você não tem permissão/),
    ).toBeTruthy();
    expect(screen.getByText('LEAD | FORMS')).toBeTruthy();
  });
});
