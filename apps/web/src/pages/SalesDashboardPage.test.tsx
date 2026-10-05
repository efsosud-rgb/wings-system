import type { SalesDashboard, SalesResults } from '@wings/shared';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SalesDashboardPage } from './SalesDashboardPage.js';

const results = (overrides: Partial<SalesResults> = {}): SalesResults => ({
  wonCents: 0,
  won: 0,
  wonWithoutValue: 0,
  ticketCents: null,
  lost: 0,
  conversionRate: null,
  ...overrides,
});

const board = (overrides: Partial<SalesDashboard> = {}): SalesDashboard => ({
  pipeline: 'expansao',
  scope: 'all',
  ranges: {
    current: { from: '2026-10-01', to: '2026-10-15' },
    previous: { from: '2026-09-01', to: '2026-09-15' },
    previousYear: { from: '2025-10-01', to: '2025-10-15' },
  },
  results: {
    current: results({
      wonCents: 120_000,
      won: 2,
      ticketCents: 60_000,
      lost: 6,
      conversionRate: 0.25,
    }),
    previous: results({ wonCents: 100_000, won: 1, ticketCents: 100_000, conversionRate: 0.5 }),
    previousYear: results(),
  },
  goalCents: null,
  open: { total: 5, valueCents: 400_000, weightedCents: 200_000, withoutValue: 3 },
  forecast: {
    wonCents: 120_000,
    openCents: 0,
    weightedCents: 0,
    deals: 0,
    withoutValue: 0,
    dated: 0,
    ended: false,
  },
  funnel: [
    {
      stage: { id: 's1', name: 'Novo Contato', probability: 10 },
      open: { total: 3, valueCents: 0, weightedCents: 0 },
      reached: 10,
      toNext: 0.4,
      avgDays: 2.5,
      exits: 4,
    },
    {
      stage: { id: 's2', name: 'Proposta', probability: 50 },
      open: { total: 2, valueCents: 400_000, weightedCents: 200_000 },
      reached: 4,
      toNext: null,
      avgDays: null,
      exits: 0,
    },
  ],
  timeToClose: { avgDays: 12, count: 2 },
  sellers: [
    {
      ownerEmployeeId: 'e1',
      ownerName: 'Fernando Exemplo',
      won: 2,
      wonCents: 120_000,
      open: 4,
      openCents: 400_000,
      activities: 7,
      firstContactHours: 3.5,
      firstContactCount: 4,
      goalCents: null,
    },
    {
      ownerEmployeeId: null,
      ownerName: null,
      won: 0,
      wonCents: 0,
      open: 1,
      openCents: 0,
      activities: 0,
      firstContactHours: null,
      firstContactCount: 0,
      goalCents: null,
    },
  ],
  brands: [{ brand: 'Marca A', open: 5, openCents: 400_000, won: 2, wonCents: 120_000 }],
  services: [],
  sources: [{ source: 'rd_station', leads: 10, won: 2, wonCents: 120_000 }],
  campaigns: [
    {
      campaign: 'LP Marca A',
      leads: 10,
      won: 2,
      wonCents: 120_000,
      spendCents: null,
      cplCents: null,
      cacCents: null,
      roas: null,
    },
  ],
  spendVisible: false,
  regions: [
    { kind: 'uf', uf: 'SP', leads: 6, won: 2 },
    { kind: 'none', uf: null, leads: 3, won: 0 },
    { kind: 'abroad', uf: null, leads: 1, won: 0 },
  ],
  cities: [{ city: 'São Paulo', leads: 4, won: 1 }],
  lostReasons: [{ reason: 'Sem capital', total: 6 }],
  actions: {
    closingSoon: 0,
    closingSoonCents: 0,
    forecastOverdue: 0,
    stalled: null,
    firstContactOverdue: 2,
    goalsAtRisk: null,
    noOwner: 1,
  },
  campaignOptions: ['LP Marca A'],
  ...overrides,
});

const calls: Record<string, string>[] = [];
let answer: SalesDashboard = board();

vi.mock('../api/crm.js', () => ({
  useSalesDashboard: (query: Record<string, string>) => {
    calls.push(query);
    return { data: answer, isLoading: false, isError: false };
  },
  useBrands: () => ({ data: { brands: [] } }),
}));
vi.mock('../api/leads.js', () => ({
  useSellers: () => ({
    data: { sellers: [{ id: 'e1', name: 'Fernando Exemplo', role: 'x', active: true }] },
  }),
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

describe('Dashboard › Vendas v1', () => {
  it('shows the executive row, compared with the previous period, and "—" with the reason where data is missing', () => {
    show();
    const kpis = screen.getByRole('region', { name: 'Indicadores' });
    expect(
      within(kpis).getByLabelText(/Vendas fechadas: R\$\s?1\.200,00 \(\+20% no período anterior/),
    ).toBeTruthy();
    expect(
      within(kpis).getByLabelText(/Meta x realizado: — \(meta do mês não cadastrada\)/),
    ).toBeTruthy();
    expect(within(kpis).getByLabelText(/Contratos ganhos: 2 \(\+100%/)).toBeTruthy();
    expect(within(kpis).getByLabelText(/Conversão: 25% \(−25 p\.p\./)).toBeTruthy();
    expect(within(kpis).getByLabelText(/Pipeline aberto hoje: R\$\s?4\.000,00/)).toBeTruthy();
    expect(
      within(kpis).getByLabelText(
        /Previsão do período: — \(nenhuma negociação aberta tem data prevista/,
      ),
    ).toBeTruthy();
    expect(
      screen.getByText(/01\/10\/2026 a 15\/10\/2026 · comparado com 01\/09\/2026/),
    ).toBeTruthy();
  });

  it('asks the API with the filters from the address and writes changes back', () => {
    show('/dashboard/vendas?funil=expansao&periodo=30d&marca=Marca%20A');
    expect(calls.at(-1)).toEqual({ pipeline: 'expansao', period: '30d', brand: 'Marca A' });
    fireEvent.change(screen.getByLabelText('Origem'), { target: { value: 'meta_lead_ads' } });
    expect(calls.at(-1)).toMatchObject({ source: 'meta_lead_ads' });
    // A custom period waits for both ends.
    fireEvent.change(screen.getByLabelText('Período'), { target: { value: 'custom' } });
    expect(calls.at(-1)).toMatchObject({ period: 'month' });
    fireEvent.change(screen.getByLabelText('De'), { target: { value: '2026-08-01' } });
    fireEvent.change(screen.getByLabelText('Até'), { target: { value: '2026-08-31' } });
    expect(calls.at(-1)).toMatchObject({ period: 'custom', from: '2026-08-01', to: '2026-08-31' });
    fireEvent.click(screen.getByRole('button', { name: 'Limpar filtros' }));
    expect(calls.at(-1)).toEqual({ pipeline: 'todos', period: 'month' });
  });

  it('without WebGL every chart is its table: funnel, ranking, region by DDD, loss reasons', () => {
    show();
    const funnel = screen.getByRole('region', { name: /Funil · Expansão/ });
    expect(within(funnel).getByRole('cell', { name: '40%' })).toBeTruthy();
    expect(within(funnel).getByText(/12 dias, da criação ao ganho/)).toBeTruthy();
    const ranking = screen.getByRole('region', { name: 'Ranking de vendedores' });
    expect(within(ranking).getByRole('cell', { name: 'Fernando' })).toBeTruthy();
    expect(within(ranking).getByRole('cell', { name: 'Sem dono' })).toBeTruthy();
    const region = screen.getByRole('region', { name: /UF pelo DDD do telefone/ });
    expect(within(region).getByRole('cell', { name: 'Sem telefone ou DDD inválido' })).toBeTruthy();
    expect(within(region).getByRole('cell', { name: 'Telefone de fora do Brasil' })).toBeTruthy();
    fireEvent.click(within(region).getByRole('button', { name: 'Cidade' }));
    expect(within(region).getByRole('cell', { name: 'São Paulo' })).toBeTruthy();
    expect(
      within(screen.getByRole('region', { name: 'Motivos de perda' })).getByRole('cell', {
        name: 'Sem capital',
      }),
    ).toBeTruthy();
    expect(screen.getByText(/só para quem vê os gastos de tráfego pago/)).toBeTruthy();
  });

  it('turns each action into a filtered CRM list, and says why when it cannot count yet', () => {
    show('/dashboard/vendas?funil=expansao&origem=rd_station');
    const actions = screen.getByRole('region', { name: 'Ações' });
    const noOwner = within(actions).getByRole('link', { name: /Sem dono/ });
    const href = new URL(noOwner.getAttribute('href') ?? '', 'http://x');
    expect(href.pathname).toBe('/crm-vendas/negociacoes');
    expect(Object.fromEntries(href.searchParams)).toMatchObject({
      funil: 'expansao',
      owner: 'none',
      outcome: 'open',
      source: 'rd_station',
    });
    expect(within(actions).getByRole('link', { name: /Primeiro contato atrasado/ })).toBeTruthy();
    expect(within(actions).getByText('as etapas ainda não têm prazo cadastrado')).toBeTruthy();
    expect(within(actions).queryByRole('link', { name: /Fecham em até 15 dias/ })).toBeNull();
  });

  it('forecasts the period from the expected close dates once someone fills them', () => {
    answer = board({
      forecast: {
        wonCents: 120_000,
        openCents: 400_000,
        weightedCents: 200_000,
        deals: 2,
        withoutValue: 1,
        dated: 3,
        ended: false,
      },
      actions: {
        closingSoon: 2,
        closingSoonCents: 400_000,
        forecastOverdue: 1,
        stalled: null,
        firstContactOverdue: 0,
        goalsAtRisk: null,
        noOwner: 0,
      },
    });
    show();
    expect(
      screen.getByLabelText(
        /Previsão do período: R\$\s?3\.200,00 \(ganho R\$\s?1\.200,00 \+ ponderado R\$\s?2\.000,00 de 2 aberta\(s\) com previsão até 15\/10\/2026 \(1 sem valor\)\)/,
      ),
    ).toBeTruthy();
    const actions = screen.getByRole('region', { name: 'Ações' });
    expect(
      within(actions).getByText(/R\$\s?4\.000,00 · a lista do CRM ainda não filtra/),
    ).toBeTruthy();
    expect(within(actions).getByText('Previsão de fechamento vencida')).toBeTruthy();
  });

  it('shows a seller only their own numbers and next actions', () => {
    answer = board({ scope: 'own', sellers: [], brands: [], regions: [], campaigns: [] });
    show();
    expect(screen.getByText(/As suas negociações/)).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Ranking de vendedores' })).toBeNull();
    expect(screen.queryByRole('region', { name: /UF pelo DDD/ })).toBeNull();
    expect(screen.queryByLabelText('Vendedor')).toBeNull();
    expect(screen.queryByRole('link', { name: /Sem dono/ })).toBeNull();
  });

  it('asks for a funnel before drawing stages when every funnel is shown', () => {
    answer = board({ pipeline: null, funnel: null });
    show();
    expect(screen.getByText(/escolha um funil no filtro para ver as etapas/)).toBeTruthy();
  });
});
