import type { SalesDashboard } from '@wings/shared';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SalesDashboardPage } from './SalesDashboardPage.js';

const board = (overrides: Partial<SalesDashboard> = {}): SalesDashboard => ({
  pipeline: 'expansao',
  stages: [
    {
      stage: { id: 's1', name: 'Novo Contato', probability: 10 },
      total: 3,
      valueCents: 0,
      weightedCents: 0,
    },
    {
      stage: { id: 's2', name: 'Proposta', probability: 50 },
      total: 2,
      valueCents: 400_000,
      weightedCents: 200_000,
    },
  ],
  brands: [{ brand: 'Marca A', total: 5, valueCents: 400_000, weightedCents: 200_000 }],
  sellers: [
    {
      ownerEmployeeId: 'e1',
      ownerName: 'Fernando',
      total: 4,
      valueCents: 400_000,
      weightedCents: 200_000,
      wonMonth: 2,
      wonMonthCents: 90_000,
    },
    {
      ownerEmployeeId: null,
      ownerName: null,
      total: 1,
      valueCents: 0,
      weightedCents: 0,
      wonMonth: 0,
      wonMonthCents: 0,
    },
  ],
  open: { total: 5, valueCents: 400_000, weightedCents: 200_000 },
  wonMonth: { total: 2, valueCents: 90_000 },
  conversion: { won: 2, lost: 6, rate: 0.25, days: 90 },
  openWithoutValue: 3,
  monthStart: '2026-10-01T03:00:00.000Z',
  ...overrides,
});

const calls: string[] = [];
let answer: SalesDashboard = board();

vi.mock('../api/crm.js', () => ({
  useSalesDashboard: (pipeline: string) => {
    calls.push(pipeline);
    return { data: { ...answer, pipeline }, isLoading: false, isError: false };
  },
}));

afterEach(() => {
  cleanup();
  calls.length = 0;
  answer = board();
});

const show = (path = '/dashboard/vendas') =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <SalesDashboardPage />
    </MemoryRouter>,
  );

describe('Dashboard › Vendas', () => {
  it('shows the five indicators, saying what the open value leaves out', () => {
    show();
    const kpis = screen.getByRole('region', { name: 'Indicadores' });
    expect(within(kpis).getByLabelText(/Negociações abertas: 5/)).toBeTruthy();
    expect(
      within(kpis).getByLabelText(/Valor em aberto: R\$\s?4\.000,00 \(3 sem valor ficam de fora\)/),
    ).toBeTruthy();
    expect(within(kpis).getByLabelText(/Valor ponderado: R\$\s?2\.000,00/)).toBeTruthy();
    expect(within(kpis).getByLabelText(/Ganhas no mês: 2/)).toBeTruthy();
    expect(within(kpis).getByLabelText(/Taxa de conversão: 25%/)).toBeTruthy();
  });

  it('without WebGL every chart is its table, with the same numbers', () => {
    show();
    const funnel = screen.getByRole('region', { name: /Funil por etapa/ });
    expect(within(funnel).getByRole('cell', { name: 'Novo Contato' })).toBeTruthy();
    expect(within(funnel).getByRole('cell', { name: 'Proposta' })).toBeTruthy();
    const sellers = screen.getByRole('region', { name: 'Por vendedor' });
    expect(within(sellers).getByRole('cell', { name: 'Fernando' })).toBeTruthy();
    expect(within(sellers).getByRole('cell', { name: 'Sem dono' })).toBeTruthy();
    expect(
      within(screen.getByRole('region', { name: 'Abertas por marca' })).getByRole('cell', {
        name: 'Marca A',
      }),
    ).toBeTruthy();
  });

  it('switches funnels through the address and says "—" with the reason when there is nothing', () => {
    answer = board({
      stages: [],
      brands: [],
      sellers: [],
      open: { total: 0, valueCents: 0, weightedCents: 0 },
      wonMonth: { total: 0, valueCents: 0 },
      conversion: { won: 0, lost: 0, rate: null, days: 90 },
      openWithoutValue: 0,
    });
    show('/dashboard/vendas?funil=consultoria');
    expect(calls.at(-1)).toBe('consultoria');
    expect(screen.getByRole('button', { name: 'Consultoria' }).getAttribute('aria-pressed')).toBe(
      'true',
    );
    expect(screen.getByLabelText(/Valor em aberto: — \(nenhuma negociação aberta\)/)).toBeTruthy();
    expect(
      screen.getByLabelText(/Taxa de conversão: — \(nada fechado nos últimos 90 dias\)/),
    ).toBeTruthy();
    expect(screen.getByText(/este funil ainda não tem etapas/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Formatação' }));
    expect(calls.at(-1)).toBe('formatacao');
  });
});
