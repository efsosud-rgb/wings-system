import {
  EMPTY_TOTALS,
  type DashboardAudience,
  type DashboardCampaigns,
  type DashboardCreatives,
  type DashboardOverview,
  type DashboardPlatforms,
  type SpendStrip,
} from '@wings/shared';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The dashboard is read before somebody decides where money goes, so these
 * tests check that an unknowable figure stays visibly unknown, that a source
 * that is not configured says so rather than showing zeros, and that the
 * period and the tab travel in the address.
 */

const data = {
  overview: buildOverview(),
  platforms: buildPlatforms(),
  campaigns: buildCampaigns(),
  creatives: buildCreatives(),
  audience: buildAudience(),
};

const ok = <T,>(value: T) => ({ data: value, isLoading: false, isError: false });

vi.mock('../api/dashboard.js', () => ({
  useDashboardOverview: () => ok({ overview: data.overview }),
  useDashboardPlatforms: (days: number) => ok({ platforms: { ...data.platforms, days } }),
  useDashboardCampaigns: () => ok({ campaigns: data.campaigns }),
  useDashboardCreatives: () => ok({ creatives: data.creatives }),
  useDashboardAudience: () => ok({ audience: data.audience }),
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
    ...overrides,
  };
}

function buildOverview(overrides: Partial<DashboardOverview> = {}): DashboardOverview {
  return {
    periodMonth: '2026-09-01',
    elapsedDays: 15.5,
    totalDays: 30,
    strips: [
      strip({ source: 'meta' }),
      strip({ source: 'google', balanceSource: 'google.prepaid_balance', balance: 50_000 }),
      strip({ source: 'kairogen', unit: 'credits', spent: 10, forecast: 20, available: 990, balance: 990, ceiling: 1000, activeDailyBudget: null }),
      strip({ source: 'ai', spent: 275, forecast: 550, available: null, balance: null, ceiling: null, balanceSource: null, activeDailyBudget: 1100 }),
      strip({ source: 'media', configured: false, spent: 0, forecast: null, available: 30_000, balance: null, ceiling: 30_000, balanceSource: null, activeDailyBudget: null, refreshedAt: null }),
    ],
    counts: { openAlerts: 2, criticalAlerts: 1, pendingApprovals: 3, disapprovedAds: 1 },
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
        current: { ...EMPTY_TOTALS, spendCents: 40_000, impressions: 8000, clicks: 160, reach: 6000 },
        previous: { ...EMPTY_TOTALS, spendCents: 20_000, impressions: 4000, clicks: 100, reach: 3000 },
        daily: [{ day: '2026-09-15', amount: 10_000 }, { day: '2026-09-16', amount: 0 }],
      },
      {
        platform: 'google',
        accounts: [],
        current: EMPTY_TOTALS,
        previous: EMPTY_TOTALS,
        daily: [{ day: '2026-09-15', amount: 0 }, { day: '2026-09-16', amount: 0 }],
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
      },
    ],
  };
}

function buildCreatives(): DashboardCreatives {
  return {
    days: 7,
    since: '2026-09-10',
    until: '2026-09-16',
    formats: [{ format: 'video', ads: 1, totals: { ...EMPTY_TOTALS, spendCents: 4_500, impressions: 2000, clicks: 40, videoPlays: 600 } }],
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
        totals: { ...EMPTY_TOTALS, spendCents: 4_500, impressions: 2000, clicks: 40, reach: 800, videoPlays: 600, videoThruplays: 240, videoP100: 60 },
        fatigue: { firstHalfCtrMilli: 2500, secondHalfCtrMilli: 1500, frequencyMilli: 2500, wornOut: true },
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
      { kind: 'placement', key: 'instagram', subKey: 'instagram_reels', totals: { ...EMPTY_TOTALS, spendCents: 3_000, impressions: 1500, clicks: 30, conversions: 2 } },
      { kind: 'age_gender', key: '25-34', subKey: 'female', totals: { ...EMPTY_TOTALS, spendCents: 2_000, impressions: 900, clicks: 20 } },
      { kind: 'region', key: 'São Paulo', subKey: '', totals: { ...EMPTY_TOTALS, spendCents: 4_000, impressions: 1800, clicks: 36 } },
      { kind: 'hour', key: '20', subKey: '', totals: { ...EMPTY_TOTALS, spendCents: 1_000, impressions: 400, clicks: 8, conversions: 1 } },
    ],
  };
}

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
});

afterEach(() => {
  cleanup();
});

describe('the overview', () => {
  it('shows one strip per source, in reais or credits, with what is unknowable left as a dash', () => {
    renderAt();
    const strips = screen.getAllByRole('listitem');
    expect(strips).toHaveLength(5);
    expect(text(strips[0])).toContain('Meta Ads');
    expect(text(strips[0])).toContain('R$ 1.236,10');
    expect(text(strips[2])).toContain('10 cr.');
    // The agent has no monthly ceiling: a dash, not R$ 0,00.
    const ai = strips[3];
    expect(text(ai)).toContain('IA (OpenRouter)');
    expect(within(ai as HTMLElement).getAllByText('—').length).toBeGreaterThanOrEqual(2);
  });

  it('says when a source is not configured instead of showing zeros as spend', () => {
    renderAt();
    const media = screen.getAllByRole('listitem')[4] as HTMLElement;
    expect(within(media).getByText('não configurado')).toBeTruthy();
  });

  it('warns loudly when a kill switch is engaged', () => {
    data.overview = buildOverview({ strips: [strip({ killSwitchEngaged: true })] });
    renderAt();
    expect(screen.getByText(/Trava de segurança acionada/)).toBeTruthy();
  });

  it('links the pending approvals to the queue', () => {
    renderAt();
    const link = screen.getByRole('link', { name: '3' });
    expect(link.getAttribute('href')).toBe('/marketing/trafego-pago-wings/aprovacoes');
  });
});

describe('the tabs and the period', () => {
  it('opens the tab named in the address, with the period the address asks for', () => {
    renderAt('/dashboard/marketing?aba=plataformas&dias=30');
    expect(screen.getByRole('button', { name: '30 dias' }).getAttribute('aria-pressed')).toBe('true');
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
    fireEvent.click(screen.getByRole('button', { name: 'Abrir anúncios de Conjunto SP' }));
    expect(screen.getByText('Reels 15s')).toBeTruthy();
    expect(screen.getByText('Vídeo')).toBeTruthy();
  });

  it('filters campaigns by name', () => {
    renderAt('/dashboard/marketing?aba=campanhas');
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'institucional' } });
    expect(screen.getByText('Nenhuma campanha com esse nome.')).toBeTruthy();
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
});
