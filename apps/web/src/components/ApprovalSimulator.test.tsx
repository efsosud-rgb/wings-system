import type { ChangeSimulation, ExposureScenario, NextPendingLink } from '@wings/shared';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The simulator sits directly above an "Aprovar" button, so the things worth
 * testing are the ones that could mislead someone into pressing it: whether a
 * breach is visible, whether the reservation nuance is stated, and whether
 * exploring a value can ever change the request.
 */

const state: {
  simulation: ChangeSimulation;
  nextPending: NextPendingLink | null;
  lastArgs: [string | undefined, number | undefined] | null;
} = { simulation: buildSimulation(), nextPending: null, lastArgs: null };

vi.mock('../api/ads.js', () => ({
  useSimulation: (id: string | undefined, alternative?: number) => {
    state.lastArgs = [id, alternative];
    return {
      data: {
        simulation:
          alternative === undefined
            ? state.simulation
            : { ...state.simulation, simulated: buildScenario('simulated', alternative, 260_000) },
        nextPending: state.nextPending,
      },
      isLoading: false,
      isError: false,
    };
  },
}));

const { ApprovalSimulator } = await import('./ApprovalSimulator.js');

function buildScenario(
  label: ExposureScenario['label'],
  dailyBudgetCents: number,
  committedCents: number,
): ExposureScenario {
  return {
    label,
    dailyBudgetCents,
    campaignExposureCents: committedCents,
    committedCents,
    availableCents: Math.max(0, 280_000 - committedCents),
    usedOfUsablePercent: Math.round((committedCents / 280_000) * 100),
    usedOfCapPercent: Math.round((committedCents / 400_000) * 100),
    withinUsable: committedCents <= 280_000,
    withinCap: committedCents <= 400_000,
    runwayDays: dailyBudgetCents > 0 ? 7 : null,
  };
}

function buildSimulation(overrides: Partial<ChangeSimulation> = {}): ChangeSimulation {
  return {
    changeRequestId: 'cr-1',
    kind: 'set_daily_budget',
    campaignName: 'Institucional',
    campaignExternalId: '23851234567890123',
    budgetLevel: 'campaign',
    daysLeftInPeriod: 15,
    overdeliveryFactorMilli: 1250,
    period: {
      periodMonth: '2026-09-01',
      capCents: 400_000,
      usableCents: 280_000,
      spentCents: 20_000,
      committedWithRequestCents: 37_500,
      committedWithoutRequestCents: 0,
    },
    current: buildScenario('current', 2000, 0),
    requested: buildScenario('requested', 3000, 37_500),
    simulated: null,
    simulationAvailable: true,
    drift: null,
    campaignSyncedAt: '2026-09-17T11:00:00.000Z',
    ...overrides,
  };
}

function renderSimulator() {
  render(
    <MemoryRouter>
      <ApprovalSimulator approvalId="ap-1" />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  state.simulation = buildSimulation();
  state.nextPending = null;
  state.lastArgs = null;
});

afterEach(() => {
  cleanup();
});

describe('the before/after diff', () => {
  it('shows the budget moving and the exposure it carries', () => {
    renderSimulator();

    const rows = screen.getAllByRole('row').map((row) => row.textContent ?? '');
    const budgetRow = rows.find((text) => text.includes('Orçamento diário'));
    expect(budgetRow).toContain('20,00');
    expect(budgetRow).toContain('30,00');
  });

  it('states that exposure was reserved at request time, not at approval', () => {
    renderSimulator();
    // Without this, approving would look free: the committed total already
    // contains the request.
    expect(screen.getByText(/reservada quando a alteração é/)).toBeTruthy();
    expect(screen.getByText(/Recusar devolve/)).toBeTruthy();
  });

  it('warns when the platform budget drifted away from the request', () => {
    state.simulation = buildSimulation({
      drift: { field: 'daily_budget', expectedCents: 2000, mirroredCents: 2500 },
    });
    renderSimulator();

    expect(screen.getByText(/mudou na plataforma desde o pedido/)).toBeTruthy();
    expect(screen.getByText(/execução será recusada/i)).toBeTruthy();
  });
});

describe('the scenarios', () => {
  it('shows today beside the requested change', () => {
    renderSimulator();
    expect(screen.getByText('Hoje')).toBeTruthy();
    expect(screen.getByText('Como solicitado')).toBeTruthy();
    expect(screen.getByText(/se esta solicitação for recusada/)).toBeTruthy();
  });

  it('marks a scenario that would break the monthly limit', () => {
    state.simulation = buildSimulation({
      requested: buildScenario('requested', 40_000, 500_000),
    });
    renderSimulator();

    expect(screen.getByText(/Ultrapassaria/)).toBeTruthy();
  });
});

describe('trying another value', () => {
  it('asks the server for the alternative without touching the request', () => {
    renderSimulator();

    fireEvent.change(screen.getByPlaceholderText('Ex.: 25,00'), { target: { value: '25,00' } });
    fireEvent.click(screen.getByRole('button', { name: 'Simular' }));

    // 25,00 reais → 2500 cents, sent as exploration only.
    expect(state.lastArgs?.[1]).toBe(2500);
    expect(screen.getByText('Simulação')).toBeTruthy();
    expect(screen.getByText(/apenas exploração/)).toBeTruthy();
  });

  it('refuses a value that is not a number', () => {
    renderSimulator();

    fireEvent.change(screen.getByPlaceholderText('Ex.: 25,00'), { target: { value: 'abc' } });
    fireEvent.click(screen.getByRole('button', { name: 'Simular' }));

    expect(screen.getByText('Informe um valor em reais, por exemplo 25,00')).toBeTruthy();
    expect(state.lastArgs?.[1]).toBeUndefined();
  });

  it('explains why an ABO campaign has nothing to simulate', () => {
    state.simulation = buildSimulation({ simulationAvailable: false, budgetLevel: 'ad_set' });
    renderSimulator();

    expect(screen.queryByRole('button', { name: 'Simular' })).toBeNull();
    expect(screen.getByText(/orçamento fica nos conjuntos de anúncios/)).toBeTruthy();
  });
});

describe('moving to the next decision', () => {
  it('links onward while making clear each is decided separately', () => {
    state.nextPending = { approvalId: 'ap-2', remaining: 2 };
    renderSimulator();

    const link = screen.getByRole('link', { name: 'Ir para a próxima decisão' });
    expect(link.getAttribute('href')).toBe('/trafego-pago/aprovacoes/ap-2');
    expect(screen.getByText(/decidida e registrada separadamente/)).toBeTruthy();
  });

  it('says nothing when this is the only request on the campaign', () => {
    renderSimulator();
    expect(screen.queryByRole('link', { name: 'Ir para a próxima decisão' })).toBeNull();
  });
});
