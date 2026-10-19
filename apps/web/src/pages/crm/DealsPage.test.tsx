import type { Board, BoardCard, CrmStage } from '@wings/shared';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../api/client.js';
import { DealsPage } from './DealsPage.js';

/**
 * The kanban: the whole card opens the deal (click or Enter) without taking
 * the card's own links and buttons; who manages the CRM adds a column at
 * the end of the board and renames one in its head; who does not sees the
 * plain titles.
 */

const { state, stageMutate, createMutate, quickMutate, activityMutate, idle, mutation } =
  vi.hoisted(() => ({
    state: {
      permissions: {} as Record<string, string>,
      role: 'admin',
      board: null as Board | null,
      // What the next render of each query answers; reset to "idle" before every test.
      boardQuery: {} as Record<string, unknown>,
      counters: {} as Record<string, unknown>,
      list: {} as Record<string, unknown>,
      tasks: {} as Record<string, unknown>,
    },
    stageMutate: vi.fn(),
    createMutate: vi.fn(),
    quickMutate: vi.fn(),
    activityMutate: vi.fn(),
    idle: () => ({ data: undefined, isLoading: false, isError: false }),
    mutation: (mutate = vi.fn()) => ({
      mutate,
      isPending: false,
      error: null,
      reset: vi.fn(),
    }),
  }));

vi.mock('../../api/auth.js', async () => {
  const actual = await vi.importActual<typeof import('../../api/auth.js')>('../../api/auth.js');
  return {
    ...actual,
    useSession: () => ({
      data: { id: 'e1', fullName: 'Eric Souza', role: state.role, permissions: state.permissions },
    }),
  };
});

// Not a seller before the official number is live (the lock has its own tests).
vi.mock('../../api/whatsapp.js', async () => {
  const actual =
    await vi.importActual<typeof import('../../api/whatsapp.js')>('../../api/whatsapp.js');
  return { ...actual, useWhatsAppSoon: () => false };
});

vi.mock('../../api/leads.js', () => ({
  useCreateLead: () => mutation(),
  useSellers: idle,
  useCreateStage: () => mutation(createMutate),
  useUpdateStage: () => mutation(stageMutate),
}));

vi.mock('../../api/crm.js', () => ({
  useAddActivity: () => mutation(activityMutate),
  useBrands: idle,
  useCompleteTask: () => mutation(),
  useDealBoard: () => ({
    data: state.board,
    isLoading: false,
    isError: false,
    ...state.boardQuery,
  }),
  useDealCounters: () => state.counters,
  useDealList: () => state.list,
  useDealQuickChange: () => mutation(quickMutate),
  useDeleteView: () => mutation(),
  useLoadColumn: () => mutation(),
  useSaveView: () => mutation(),
  useSavedViews: idle,
  useTaskList: () => state.tasks,
}));

const stage = (over: Partial<CrmStage>): CrmStage => ({
  id: 's1',
  pipeline: 'expansao',
  name: 'Novo contato',
  position: 1,
  active: true,
  rdStageId: null,
  sofiaEntry: false,
  probability: 10,
  ...over,
});

const card = (over: Partial<BoardCard>): BoardCard => ({
  id: 'l1',
  name: 'Elena',
  companyName: 'Padaria Sol',
  contactName: null,
  email: 'elena@example.com',
  phone: '5511999990000',
  valueCents: 4500000,
  expectedCloseAt: null,
  brand: null,
  clientName: 'Wings Company',
  ownerEmployeeId: 'e1',
  ownerName: 'Eric Souza',
  stageChangedAt: '2026-10-01T12:00:00.000Z',
  nextTask: null,
  source: 'site_form',
  won: null,
  enteredAt: '2026-10-01T11:30:00.000Z',
  enteredAtSource: 'meta_created_time',
  createdAt: '2026-10-01T12:00:00.000Z',
  ...over,
});

const board = (): Board => {
  const first = stage({});
  const second = stage({ id: 's2', name: 'Proposta', position: 2, probability: 50 });
  return {
    pipeline: 'expansao',
    total: 1,
    valueCents: 4500000,
    weightedCents: 450000,
    columns: [
      { stage: first, total: 1, valueCents: 4500000, weightedCents: 450000, cards: [card({})] },
      { stage: second, total: 0, valueCents: 0, weightedCents: 0, cards: [] },
    ],
  };
};

const show = (search = '') =>
  render(
    <MemoryRouter initialEntries={[`/crm-vendas/negociacoes${search}`]}>
      <Routes>
        <Route path="/crm-vendas/negociacoes" element={<DealsPage />} />
        <Route path="/crm-vendas/negociacoes/:id" element={<h1>Ficha da negociação</h1>} />
      </Routes>
    </MemoryRouter>,
  );

const theCard = () => screen.getByRole('article', { name: 'Elena' });

beforeEach(() => {
  state.permissions = { 'leads.read': 'all', 'leads.write': 'all' };
  state.role = 'admin';
  state.board = board();
  state.boardQuery = {};
  state.counters = idle();
  state.list = idle();
  state.tasks = idle();
  stageMutate.mockReset();
  createMutate.mockReset();
  quickMutate.mockReset();
});
afterEach(cleanup);

describe('the deal card', () => {
  it('opens the deal when clicked anywhere, not only on the name', () => {
    show();
    fireEvent.click(within(theCard()).getByText('Padaria Sol'));
    expect(screen.getByText('Ficha da negociação')).toBeTruthy();
  });

  it('opens the deal with Enter when the card has the focus', () => {
    show();
    const article = theCard();
    article.focus();
    fireEvent.keyDown(article, { key: 'Enter' });
    expect(screen.getByText('Ficha da negociação')).toBeTruthy();
  });

  it('keeps the phone and e-mail links, and the quick actions, to themselves', () => {
    show();
    const article = theCard();
    fireEvent.click(within(article).getByRole('link', { name: 'E-mail' }));
    expect(screen.queryByText('Ficha da negociação')).toBeNull();
    fireEvent.click(within(article).getByRole('button', { name: 'Ganho' }));
    expect(quickMutate).toHaveBeenCalledWith({ id: 'l1', won: true });
    expect(screen.queryByText('Ficha da negociação')).toBeNull();
  });

  it('"Ligar" opens the call panel in the system, never a tel: link, and its clicks stay in it', () => {
    show();
    const article = theCard();
    expect(article.querySelector('a[href^="tel:"]')).toBeNull();
    fireEvent.click(within(article).getByRole('button', { name: 'Ligar' }));
    const panel = within(screen.getByRole('dialog', { name: 'Ligação' }));
    expect(screen.queryByText('Ficha da negociação')).toBeNull();
    expect(panel.getByText('(11) 99999-0000')).toBeTruthy();
    expect(
      (panel.getByRole('button', { name: /Ligar pelo WhatsApp/ }) as HTMLButtonElement).disabled,
    ).toBe(true);
    fireEvent.change(panel.getByLabelText('Duração em minutos'), { target: { value: '3' } });
    fireEvent.click(panel.getByRole('button', { name: 'Registrar ligação' }));
    expect(activityMutate).toHaveBeenCalledWith(
      { kind: 'call', outcome: 'answered', durationSeconds: 180, note: undefined },
      expect.anything(),
    );
    fireEvent.click(panel.getByRole('button', { name: 'Fechar' }));
    expect(screen.queryByRole('dialog', { name: 'Ligação' })).toBeNull();
    expect(screen.queryByText('Ficha da negociação')).toBeNull();
  });
  it('does not open the deal from the click that ends a drag', () => {
    show();
    const article = theCard();
    fireEvent.dragStart(article, { dataTransfer: { setData: vi.fn(), effectAllowed: '' } });
    fireEvent.dragEnd(article);
    fireEvent.click(article);
    expect(screen.queryByText('Ficha da negociação')).toBeNull();
  });

  it('has one tab stop per card: the name link is reached through the card', () => {
    show();
    expect(within(theCard()).getByRole('link', { name: 'Elena' }).getAttribute('tabindex')).toBe(
      '-1',
    );
  });
});

describe('when the deal entered', () => {
  it("shows the source's date and time on the card, in Brasília time", () => {
    show();
    const entered = within(theCard()).getByText(/^Entrou 01\/10\/2026 08:30/);
    expect(entered.getAttribute('title')).toBe('Data da fonte: data de criação do lead na Meta');
    expect(entered.textContent).not.toContain('*');
  });

  it('marks a card whose source brought no date as received by the system', () => {
    state.board!.columns[0]!.cards[0] = card({ enteredAtSource: 'received' });
    show();
    const entered = within(theCard()).getByText(/^Entrou 01\/10\/2026 08:30 \*/);
    expect(entered.getAttribute('title')).toContain('recebeu o lead');
  });
});

describe('the columns, for who manages the CRM', () => {
  beforeEach(() => {
    state.permissions = { 'leads.read': 'all', 'leads.write': 'all', 'crm.manage': 'all' };
  });

  it('renames a stage in its head: click, type, Enter', () => {
    show();
    fireEvent.click(screen.getByRole('button', { name: 'Renomear Proposta' }));
    const field = screen.getByRole('textbox', { name: 'Nome da etapa' }) as HTMLInputElement;
    expect(field.value).toBe('Proposta');
    fireEvent.change(field, { target: { value: 'Proposta enviada' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(stageMutate).toHaveBeenCalledWith(
      { id: 's2', name: 'Proposta enviada' },
      expect.anything(),
    );
  });

  it('cancels the rename with Esc, keeping the name', () => {
    show();
    fireEvent.click(screen.getByRole('button', { name: 'Renomear Proposta' }));
    const field = screen.getByRole('textbox', { name: 'Nome da etapa' });
    fireEvent.change(field, { target: { value: 'Outra' } });
    fireEvent.keyDown(field, { key: 'Escape' });
    expect(stageMutate).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Renomear Proposta' })).toBeTruthy();
  });

  it('does not save a name shorter than two characters or equal to the current one', () => {
    show();
    fireEvent.click(screen.getByRole('button', { name: 'Renomear Proposta' }));
    const field = screen.getByRole('textbox', { name: 'Nome da etapa' });
    fireEvent.change(field, { target: { value: 'P' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    fireEvent.change(field, { target: { value: ' Proposta ' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(stageMutate).not.toHaveBeenCalled();
  });

  it('adds a column at the end of the funnel with "+ Coluna"', () => {
    show();
    fireEvent.click(screen.getByRole('button', { name: '+ Coluna' }));
    const field = screen.getByRole('textbox', { name: 'Nome da nova etapa' });
    fireEvent.change(field, { target: { value: 'Fechamento' } });
    fireEvent.submit(field.closest('form')!);
    expect(createMutate).toHaveBeenCalledWith(
      { pipeline: 'expansao', name: 'Fechamento' },
      expect.anything(),
    );
  });

  it('closes "+ Coluna" with Esc or Cancelar without creating anything', () => {
    show();
    fireEvent.click(screen.getByRole('button', { name: '+ Coluna' }));
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Nome da nova etapa' }), {
      key: 'Escape',
    });
    expect(screen.queryByRole('textbox', { name: 'Nome da nova etapa' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '+ Coluna' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }));
    expect(screen.queryByRole('textbox', { name: 'Nome da nova etapa' })).toBeNull();
    expect(createMutate).not.toHaveBeenCalled();
  });
});

describe('the columns, for who only works the deals', () => {
  it('shows plain titles and no "+ Coluna"', () => {
    show();
    expect(screen.getByText('Proposta')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Renomear Proposta' })).toBeNull();
    expect(screen.queryByRole('button', { name: '+ Coluna' })).toBeNull();
  });
});

describe('the 1º contato atrasado counter', () => {
  const answered = (data: unknown) => ({
    data,
    isLoading: false,
    isPending: false,
    isError: false,
    isSuccess: true,
    refetch: vi.fn(),
  });

  it('shows the number and, clicked, opens the list of those deals with a chip that clears it', () => {
    state.counters = answered({
      untouched: 1,
      today: 2,
      overdue: 3,
      firstContactOverdue: 5,
      since: '2026-10-09T03:00:00.000Z',
    });
    state.list = answered({ leads: [], total: 0 });
    show();
    const bar = screen.getByLabelText('Resumo do funil');
    const counter = within(bar).getByRole('button', { name: /1º contato atrasado/ });
    expect(within(counter).getByText('5')).toBeTruthy();
    expect(counter.getAttribute('title')).toContain('09/10/2026');
    expect(screen.queryByRole('button', { name: 'Tirar o filtro 1º contato atrasado' })).toBeNull();

    fireEvent.click(counter);
    const chip = screen.getByRole('button', { name: 'Tirar o filtro 1º contato atrasado' });
    fireEvent.click(chip);
    expect(screen.queryByRole('button', { name: 'Tirar o filtro 1º contato atrasado' })).toBeNull();
  });
});

/** The request failed: "—" and the reason, never "0 negociações" or the empty-state text. */
describe('when a request fails', () => {
  const failed = (error: unknown) => ({
    data: undefined,
    isLoading: false,
    isPending: false,
    isError: true,
    isSuccess: false,
    error,
    refetch: vi.fn(),
  });
  const succeeded = (data: unknown) => ({
    data,
    isLoading: false,
    isPending: false,
    isError: false,
    isSuccess: true,
    refetch: vi.fn(),
  });

  it('the funnel counters show "—" and why, not a zero', () => {
    state.counters = failed(new ApiError(500, {}));
    show();
    const bar = screen.getByLabelText('Resumo do funil');
    expect(within(bar).getAllByText('—').length).toBeGreaterThanOrEqual(3);
    expect(within(bar).getByRole('alert').textContent).toContain('o servidor teve um problema');
    expect(bar.textContent).not.toMatch(/\b0\b/);
  });

  it('the board says why instead of showing columns', () => {
    state.board = null;
    state.boardQuery = failed(new ApiError(401, {}));
    show();
    expect(screen.getByRole('alert').textContent).toContain('Não foi possível carregar o quadro');
    expect(screen.getByRole('alert').textContent).toContain('sua sessão expirou');
    expect(screen.queryByText('Nenhuma negociação')).toBeNull();
  });

  it('the board keeps the cards it had when only a refresh failed', () => {
    state.boardQuery = failed(new TypeError('x'));
    state.boardQuery.data = state.board;
    show();
    expect(screen.getByRole('alert').textContent).toContain('sem conexão com o servidor');
    expect(theCard()).toBeTruthy();
  });

  it('the list shows "—" and the reason, not "0 negociações" or "Nenhuma negociação"', () => {
    state.list = failed(new ApiError(403, {}));
    show('?visao=list');
    expect(screen.getByRole('alert').textContent).toContain('Não foi possível carregar a lista');
    expect(screen.getByRole('alert').textContent).toContain('você não tem permissão');
    expect(screen.queryByText(/Nenhuma negociação com estes filtros/)).toBeNull();
    expect(screen.queryByText(/0\s*negociações/)).toBeNull();
  });

  it('the list still says "Nenhuma negociação com estes filtros." when it succeeded empty', () => {
    state.list = succeeded({ leads: [], total: 0 });
    show('?visao=list');
    expect(screen.getByText(/Nenhuma negociação com estes filtros/)).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('the activities say why, not "Nenhuma atividade aberta."', () => {
    state.tasks = failed(new ApiError(500, {}));
    show('?visao=activities');
    expect(screen.getByRole('alert').textContent).toContain(
      'Não foi possível carregar as atividades',
    );
    expect(screen.queryByText(/Nenhuma atividade/)).toBeNull();
  });

  it('the activities still say "Nenhuma atividade aberta." when it succeeded empty', () => {
    state.tasks = succeeded({ tasks: [] });
    show('?visao=activities');
    expect(screen.getByText('Nenhuma atividade aberta.')).toBeTruthy();
  });

  it('the calendar says why instead of an empty month', () => {
    state.tasks = failed(new TypeError('x'));
    show('?visao=calendar');
    expect(screen.getByRole('alert').textContent).toContain(
      'Não foi possível carregar o calendário',
    );
    expect(screen.getByRole('alert').textContent).toContain('sem conexão com o servidor');
  });
});

describe('the funnel it opens on', () => {
  const funnel = () => (screen.getByRole('combobox', { name: 'Funil' }) as HTMLSelectElement).value;

  it('opens a Formatação seller on Formatação, not on an empty Expansão board', () => {
    state.role = 'vendedor_formatacao';
    show();
    expect(funnel()).toBe('formatacao');
  });

  it('keeps Expansão for an Expansão seller and for the board', () => {
    state.role = 'vendedor_expansao';
    show();
    expect(funnel()).toBe('expansao');
    cleanup();
    state.role = 'diretoria';
    show();
    expect(funnel()).toBe('expansao');
  });

  it('obeys the funnel named in the address, whatever the level', () => {
    state.role = 'vendedor_formatacao';
    show('?funil=expansao');
    expect(funnel()).toBe('expansao');
  });
});
