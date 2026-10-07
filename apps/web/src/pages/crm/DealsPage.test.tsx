import type { Board, BoardCard, CrmStage } from '@wings/shared';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DealsPage } from './DealsPage.js';

/**
 * The kanban: the whole card opens the deal (click or Enter) without taking
 * the card's own links and buttons; who manages the CRM adds a column at
 * the end of the board and renames one in its head; who does not sees the
 * plain titles.
 */

const { state, stageMutate, createMutate, quickMutate, idle, mutation } = vi.hoisted(() => ({
  state: {
    permissions: {} as Record<string, string>,
    board: null as Board | null,
  },
  stageMutate: vi.fn(),
  createMutate: vi.fn(),
  quickMutate: vi.fn(),
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
      data: { id: 'e1', fullName: 'Eric Souza', role: 'admin', permissions: state.permissions },
    }),
  };
});

vi.mock('../../api/leads.js', () => ({
  useCreateLead: () => mutation(),
  useSellers: idle,
  useCreateStage: () => mutation(createMutate),
  useUpdateStage: () => mutation(stageMutate),
}));

vi.mock('../../api/crm.js', () => ({
  useBrands: idle,
  useCompleteTask: () => mutation(),
  useDealBoard: () => ({ data: state.board, isLoading: false, isError: false }),
  useDealCounters: idle,
  useDealList: idle,
  useDealQuickChange: () => mutation(quickMutate),
  useDeleteView: () => mutation(),
  useLoadColumn: () => mutation(),
  useSaveView: () => mutation(),
  useSavedViews: idle,
  useTaskList: idle,
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

const show = () =>
  render(
    <MemoryRouter initialEntries={['/crm-vendas/negociacoes']}>
      <Routes>
        <Route path="/crm-vendas/negociacoes" element={<DealsPage />} />
        <Route path="/crm-vendas/negociacoes/:id" element={<h1>Ficha da negociação</h1>} />
      </Routes>
    </MemoryRouter>,
  );

const theCard = () => screen.getByRole('article', { name: 'Elena' });

beforeEach(() => {
  state.permissions = { 'leads.read': 'all', 'leads.write': 'all' };
  state.board = board();
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
    expect(within(article).getByRole('link', { name: 'Ligar' }).getAttribute('href')).toBe(
      'tel:+5511999990000',
    );
    fireEvent.click(within(article).getByRole('link', { name: 'E-mail' }));
    expect(screen.queryByText('Ficha da negociação')).toBeNull();
    fireEvent.click(within(article).getByRole('button', { name: 'Ganho' }));
    expect(quickMutate).toHaveBeenCalledWith({ id: 'l1', won: true });
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
