import type { AlertItem, CampaignPerformanceItem, CockpitSnapshot } from '@wings/shared';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The cockpit is read before someone decides where money goes, so these tests
 * check that an unknowable number stays visibly unknown and that a rejected ad
 * arrives with the platform's own reason attached.
 */

const snapshot: { current: CockpitSnapshot } = { current: buildSnapshot() };
const acknowledge = vi.fn();

vi.mock('../api/ads.js', () => ({
  useCockpit: () => ({ data: { cockpit: snapshot.current }, isLoading: false, isError: false }),
  useAcknowledgeAlert: () => ({ mutate: acknowledge, isPending: false }),
}));

const { CockpitPage } = await import('./CockpitPage.js');

function buildCampaign(overrides: Partial<CampaignPerformanceItem> = {}): CampaignPerformanceItem {
  return {
    campaignExternalId: '23851234567890123',
    name: 'LEAD | FORMS',
    status: 'ACTIVE',
    budgetLevel: 'ad_set',
    dailyBudgetCents: 3000,
    spendCents: 4_500,
    impressions: 2000,
    clicks: 40,
    conversions: 0,
    ctrMilli: 2000,
    frequencyMilli: 1270,
    costPerLeadCents: null,
    alertCount: 0,
    ...overrides,
  };
}

function buildAlert(overrides: Partial<AlertItem> = {}): AlertItem {
  return {
    id: 'al-1',
    kind: 'ad_rejected',
    severity: 'critical',
    title: 'Anúncio reprovado: Institucional 01',
    detail: { reasons: ['Práticas de negócios inaceitáveis'] },
    entityLevel: 'ad',
    entityExternalId: 'ad-1',
    firstSeenAt: '2026-09-16T12:00:00.000Z',
    lastSeenAt: '2026-09-16T13:00:00.000Z',
    resolvedAt: null,
    acknowledgedAt: null,
    acknowledgedByName: null,
    notifiedAt: '2026-09-16T12:00:05.000Z',
    notificationError: null,
    ...overrides,
  };
}

function buildSnapshot(overrides: Partial<CockpitSnapshot> = {}): CockpitSnapshot {
  return {
    account: {
      id: 'acc-1',
      name: 'Wings Matriz',
      platform: 'meta',
      externalId: 'act_339488762500182',
    },
    pacing: {
      periodMonth: '2026-09-01',
      capCents: 400_000,
      usableCents: 280_000,
      committedCents: 35_000,
      spentCents: 20_000,
      availableCents: 245_000,
      expectedCents: 140_000,
      deviationPercent: -86,
      elapsedDays: 15,
      totalDays: 30,
      killSwitchEngaged: false,
    },
    campaigns: [buildCampaign()],
    alerts: [buildAlert()],
    metricsFetchedAt: '2026-09-16T13:00:00.000Z',
    sinceDate: '2026-09-09',
    counts: { ads: 13, disapprovedAds: 2, openAlerts: 1, pendingApprovals: 0 },
    ...overrides,
  };
}

function renderPage() {
  render(
    <MemoryRouter>
      <CockpitPage />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  snapshot.current = buildSnapshot();
  acknowledge.mockClear();
});

afterEach(() => {
  cleanup();
});

describe('the performance table', () => {
  it('shows an empty cost per lead rather than a number that would be a lie', () => {
    renderPage();

    expect(screen.getByText('LEAD | FORMS')).toBeTruthy();
    // Spend and clicks exist, so a CPL column filled from clicks would look
    // plausible and be wrong. It must read as unavailable.
    // pt-BR currency uses a non-breaking space after the symbol.
    const row = screen
      .getByText('LEAD | FORMS')
      .closest('tr')
      ?.textContent?.replace(/\u00a0/g, ' ');
    expect(row).toContain('R$ 45,00');
    expect(row).toContain('—');
  });

  it('keeps a campaign that never delivered on screen', () => {
    snapshot.current = buildSnapshot({
      campaigns: [
        buildCampaign(),
        buildCampaign({
          campaignExternalId: 'c-idle',
          name: 'Institucional parada',
          status: 'PAUSED',
          spendCents: 0,
          impressions: 0,
          clicks: 0,
          ctrMilli: null,
          frequencyMilli: null,
        }),
      ],
    });
    renderPage();

    expect(screen.getByText('Institucional parada')).toBeTruthy();
  });

  it('says where the budget lives, because a paused campaign starves its ad sets', () => {
    renderPage();
    expect(screen.getByText('ABO (conjuntos)')).toBeTruthy();
  });
});

describe('the alert feed', () => {
  it('carries the platform reason for a rejected ad', () => {
    renderPage();

    expect(screen.getByText('Anúncio reprovado: Institucional 01')).toBeTruthy();
    expect(
      screen.getByText(/Motivo da plataforma: Práticas de negócios inaceitáveis/),
    ).toBeTruthy();
  });

  it('acknowledges an alert without resolving it', () => {
    renderPage();

    fireEvent.click(screen.getByRole('button', { name: 'Marcar como visto' }));
    expect(acknowledge).toHaveBeenCalledWith('al-1');
  });

  it('shows who already saw it instead of offering the button again', () => {
    snapshot.current = buildSnapshot({
      alerts: [
        buildAlert({ acknowledgedAt: '2026-09-16T14:00:00.000Z', acknowledgedByName: 'Eric' }),
      ],
    });
    renderPage();

    expect(screen.queryByRole('button', { name: 'Marcar como visto' })).toBeNull();
    expect(screen.getByText(/Visto por Eric/)).toBeTruthy();
  });

  it('admits when the WhatsApp notice failed instead of looking delivered', () => {
    snapshot.current = buildSnapshot({
      alerts: [buildAlert({ notifiedAt: null, notificationError: 'instance disconnected' })],
    });
    renderPage();

    expect(screen.getByText(/Falha ao avisar no WhatsApp/)).toBeTruthy();
  });

  it('says so plainly when nothing is wrong', () => {
    snapshot.current = buildSnapshot({
      alerts: [],
      counts: { ads: 13, disapprovedAds: 0, openAlerts: 0, pendingApprovals: 0 },
    });
    renderPage();

    expect(screen.getByText('Nenhum alerta aberto.')).toBeTruthy();
  });
});

describe('the budget header', () => {
  it('states spend against what the month predicted', () => {
    renderPage();

    expect(screen.getByText('R$ 200,00')).toBeTruthy(); // spent
    expect(screen.getByText('R$ 1.400,00')).toBeTruthy(); // expected by now
    expect(screen.getByText(/86% abaixo do ritmo previsto/)).toBeTruthy();
  });

  it('warns loudly when the kill switch is engaged', () => {
    const base = buildSnapshot();
    snapshot.current = buildSnapshot({
      pacing: base.pacing ? { ...base.pacing, killSwitchEngaged: true } : null,
    });
    renderPage();

    expect(screen.getByText(/Trava de segurança acionada/)).toBeTruthy();
  });
});
