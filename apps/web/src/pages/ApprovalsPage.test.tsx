import type { ApprovalListItem, PendingGroup } from '@wings/shared';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The grouped view exists so nobody approves the fourth budget increase on a
 * campaign without noticing the first three. What it must never become is a
 * way to approve them all at once — these tests hold that line.
 */

const approvals: { current: ApprovalListItem[] } = { current: [] };
const groups: { current: PendingGroup[] } = { current: [] };

vi.mock('../api/ads.js', () => ({
  useApprovals: () => ({
    data: { approvals: approvals.current },
    isLoading: false,
    isError: false,
  }),
  useApprovalGroups: () => ({ data: { groups: groups.current }, isLoading: false, isError: false }),
}));

const { ApprovalsPage } = await import('./ApprovalsPage.js');

function buildItem(overrides: Partial<PendingGroup['items'][number]> = {}) {
  return {
    approvalId: 'ap-1',
    changeRequestId: 'cr-1',
    status: 'pending' as const,
    changeKind: 'set_daily_budget',
    amountCents: 37_500,
    exposureDeltaCents: 37_500,
    fromValueCents: 2000,
    toValueCents: 3000,
    requestedAt: new Date(Date.now() - 3_600_000).toISOString(),
    escalatedAt: null,
    requestedByName: null,
    requestedByAgent: true,
    ...overrides,
  };
}

function buildGroup(overrides: Partial<PendingGroup> = {}): PendingGroup {
  const items = overrides.items ?? [buildItem()];
  return {
    campaignId: 'camp-1',
    campaignName: 'LEAD | FORMS',
    campaignExternalId: '23851234567890123',
    accountId: 'acc-1',
    accountName: 'Wings Matriz',
    platform: 'meta',
    items,
    totalExposureDeltaCents: items.reduce((sum, item) => sum + item.exposureDeltaCents, 0),
    totalAmountCents: items.reduce((sum, item) => sum + item.amountCents, 0),
    periodMonth: '2026-09-01',
    capCents: 400_000,
    usableCents: 280_000,
    committedCents: 37_500,
    spentCents: 0,
    shareOfUsablePercent: 13,
    oldestRequestedAt: items[0]?.requestedAt ?? new Date().toISOString(),
    anyEscalated: items.some((item) => item.status === 'escalated'),
    ...overrides,
  };
}

function renderPage() {
  render(
    <MemoryRouter>
      <ApprovalsPage />
    </MemoryRouter>,
  );
}

function switchToGroups() {
  fireEvent.click(screen.getByRole('button', { name: 'Por campanha' }));
}

beforeEach(() => {
  approvals.current = [];
  groups.current = [buildGroup()];
});

afterEach(() => {
  cleanup();
});

describe('the grouped view', () => {
  it('adds up what a campaign already holds of the month', () => {
    groups.current = [
      buildGroup({
        items: [
          buildItem(),
          buildItem({ approvalId: 'ap-2', exposureDeltaCents: 20_000, amountCents: 20_000 }),
        ],
      }),
    ];
    renderPage();
    switchToGroups();

    expect(screen.getByText('LEAD | FORMS')).toBeTruthy();
    // R$375,00 + R$200,00 reserved by the two waiting requests.
    expect(screen.getByText(/575,00/)).toBeTruthy();
    expect(screen.getByText(/13% do utilizável/)).toBeTruthy();
  });

  it('links each request to its own screen and offers no bulk decision', () => {
    groups.current = [
      buildGroup({
        items: [buildItem(), buildItem({ approvalId: 'ap-2' })],
      }),
    ];
    renderPage();
    switchToGroups();

    const links = screen
      .getAllByRole('link')
      .map((link) => link.getAttribute('href'))
      .filter((href): href is string => href !== null);
    expect(links).toContain('/trafego-pago/aprovacoes/ap-1');
    expect(links).toContain('/trafego-pago/aprovacoes/ap-2');

    // No button in this view decides anything.
    const buttonNames = screen.getAllByRole('button').map((button) => button.textContent);
    expect(buttonNames.some((name) => /aprovar|recusar/i.test(name ?? ''))).toBe(false);
    expect(screen.getByText(/decidida e registrada individualmente/)).toBeTruthy();
  });

  it('flags a group holding an escalated request', () => {
    groups.current = [
      buildGroup({
        items: [buildItem({ status: 'escalated', escalatedAt: new Date().toISOString() })],
      }),
    ];
    renderPage();
    switchToGroups();

    expect(screen.getByText(/escalada para a Diretoria neste grupo/i)).toBeTruthy();
  });

  it('says plainly when nothing is waiting', () => {
    groups.current = [];
    renderPage();
    switchToGroups();

    expect(screen.getByText('Nada aguardando no momento.')).toBeTruthy();
  });
});

describe('the flat list', () => {
  it('is what the page opens on', () => {
    approvals.current = [
      {
        id: 'ap-1',
        status: 'pending',
        trigger: 'policy_always',
        amountCents: 37_500,
        accountName: 'Wings Matriz',
        platform: 'meta',
        campaignName: 'LEAD | FORMS',
        changeKind: 'set_daily_budget',
        requestedAt: new Date().toISOString(),
        escalatedAt: null,
        decidedAt: null,
        requestedByName: null,
        requestedByAgent: true,
      },
    ];
    renderPage();

    // The heading and the row's own status tag share this wording.
    expect(screen.getAllByText('Aguardando decisão').length).toBeGreaterThan(0);
    expect(screen.queryByText('Por campanha')).toBeTruthy(); // the toggle exists
  });
});
