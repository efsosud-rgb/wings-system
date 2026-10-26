import type { Productivity, ProductivityPerson } from '@wings/shared';
import { cleanup, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SalesDashboardPage } from '../SalesDashboardPage.js';

/** The Produtividade tab inside the sales panel, with made-up people. */
const person = (overrides: Partial<ProductivityPerson> = {}): ProductivityPerson => ({
  employeeId: 'e1',
  name: 'Ana Exemplo',
  active: true,
  received: 5,
  firstContact: { inTime: 3, decided: 4, medianMinutes: 42 },
  activities: {
    ligacao: 2,
    mensagem: 0,
    email: 1,
    reuniao_agendada: 1,
    reuniao_realizada: 1,
    nota: 3,
    tarefa: 2,
  },
  stageAdvances: 1,
  won: 1,
  lost: 0,
  whatsappMedianMinutes: null,
  ...overrides,
});

const answer = (overrides: Partial<Productivity> = {}): Productivity => ({
  scope: 'own',
  pipeline: null,
  range: { from: '2026-10-01', to: '2026-10-26' },
  people: [person()],
  team: {
    people: 3,
    received: 12,
    firstContact: { inTime: 6, decided: 9, medianMinutes: 55 },
    activities: {
      ligacao: 6,
      mensagem: 0,
      email: 3,
      reuniao_agendada: 2,
      reuniao_realizada: 2,
      nota: 6,
      tarefa: 4,
    },
    stageAdvances: 3,
    won: 2,
    lost: 1,
    whatsappMedianMinutes: null,
  },
  stages: [],
  lostReasons: [{ reason: 'sem orçamento', count: 1 }],
  unavailable: {
    whatsapp:
      'WhatsApp ainda fora do sistema: os vendedores respondem pelo celular até a troca do número',
    ficha: 'o CRM ainda não registra o envio da ficha',
    cof: 'o CRM ainda não registra o envio da COF',
    projects: 'o Quadro de Projetos ainda não grava prazo nem responsável por tarefa',
  },
  loadedAt: '2026-10-26T15:00:00.000Z',
  ...overrides,
});

let data = answer();
const calls: Record<string, string>[] = [];

vi.mock('../../api/crm.js', () => ({
  useProductivity: (query: Record<string, string>) => {
    calls.push(query);
    return { data, isLoading: false, isError: false };
  },
  useSalesDashboard: () => ({ data: undefined, isLoading: true, isError: false }),
  useBrands: () => ({ data: { brands: [] } }),
}));
vi.mock('../../api/leads.js', () => ({
  useSellers: () => ({ data: { sellers: [] } }),
}));

afterEach(() => {
  cleanup();
  calls.length = 0;
  data = answer();
});

const open = (url = '/dashboard/vendas?aba=produtividade') =>
  render(
    <MemoryRouter initialEntries={[url]}>
      <SalesDashboardPage />
    </MemoryRouter>,
  );

describe('Painel de vendas › Produtividade', () => {
  it('opens from the address, shows the seller their own row and the team average, and "—" with the reason where the CRM has no record', () => {
    open();
    expect(screen.getByRole('button', { name: 'Produtividade' }).getAttribute('aria-current')).toBe(
      'page',
    );
    const table = screen.getAllByRole('table')[0]!;
    const row = within(table).getByRole('row', { name: /Ana Exemplo/ });
    expect(row.textContent).toContain('75% (3/4)');
    expect(row.textContent).toContain('42 min');
    const gaps = within(row).getAllByLabelText(/sem dado/);
    expect(gaps.map((gap) => gap.getAttribute('title'))).toEqual([
      'WhatsApp ainda fora do sistema: os vendedores respondem pelo celular até a troca do número',
    ]);
    const team = within(table).getByRole('row', { name: /Média da equipe/ });
    expect(team.textContent).toContain('67%');
    expect(team.textContent).toContain('4'); // 12 leads / 3 people
    expect(screen.queryByLabelText('Pessoa')).toBeNull();
    expect(screen.getByText(/Fichas enviadas: —/)).toBeTruthy();
    expect(screen.getByText(/Tarefas de Projetos no prazo: —/)).toBeTruthy();
    expect(screen.getByText(/Atualizado em/)).toBeTruthy();
    expect(calls[0]).toEqual({ pipeline: 'todos', period: 'month' });
  });

  it('shows the manager one row per person, the person filter and the stages of the chosen funnel', () => {
    data = answer({
      scope: 'sector',
      pipeline: 'formatacao',
      people: [
        person(),
        person({ employeeId: 'e2', name: 'Bia Exemplo', received: 0, active: false }),
      ],
      stages: [
        { id: 's1', name: 'Sem contato', order: 1, reached: 12 },
        { id: 's2', name: 'Reunião', order: 2, reached: 3 },
      ],
    });
    open('/dashboard/vendas?aba=produtividade&funil=formatacao&periodo=90d');
    expect(screen.getByLabelText('Pessoa')).toBeTruthy();
    expect(screen.getByRole('row', { name: /Bia Exemplo/ }).textContent).toContain('(inativo)');
    expect(screen.getByRole('row', { name: /Reunião/ }).textContent).toContain('25%');
    expect(calls[0]).toEqual({ pipeline: 'formatacao', period: '90d' });
  });

  it('says the load has not run yet instead of showing zeros', () => {
    data = answer({ loadedAt: null, people: [] });
    open();
    expect(screen.getByText(/a carga do modelo ainda não rodou/)).toBeTruthy();
    expect(screen.queryByText('Ninguém com registro no período.')).toBeNull();
  });
});
