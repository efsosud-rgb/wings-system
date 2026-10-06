import type { Lead } from '@wings/shared';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DealPage } from './DealPage.js';

/**
 * Previsão de fechamento on the deal's page: a date field next to the value
 * and the stage, clearable, with a "vencida" note in words when the day is
 * behind us and the deal is still open.
 */

const { dealMutate, queryState, idle, mutation } = vi.hoisted(() => ({
  dealMutate: vi.fn(),
  queryState: { lead: null as Lead | null },
  idle: () => ({ data: undefined, isLoading: false, isError: false }),
  mutation: (mutate = vi.fn()) => ({ mutate, isPending: false, error: null }),
}));

const lead = (over: Omit<Partial<Lead>, 'work'> & { work?: Partial<Lead['work']> }): Lead => ({
  id: 'l1',
  name: 'Elena',
  email: null,
  phone: null,
  fields: { instagram: null, website: null, companyName: null, cnpj: null },
  checks: {},
  city: null,
  formAnswers: null,
  status: 'new',
  ownerEmployeeId: 'e1',
  firstMessage: null,
  whatsapp: null,
  origin: {
    clientId: 'c1',
    clientName: 'Wings Company',
    clientMapped: false,
    source: 'site_form',
    channel: null,
    landingPage: null,
    campaignId: null,
    campaignName: null,
    formId: null,
    trackingCode: null,
    externalId: null,
  },
  pipeline: 'expansao',
  brand: null,
  valueCents: 4500000,
  expectedCloseAt: null,
  company: null,
  contacts: [],
  crm: null,
  consent: { legalBasis: null, consentedAt: null, source: null, text: null },
  research: {
    state: 'none',
    summary: null,
    score: null,
    criteria: [],
    links: [],
    facts: null,
    error: null,
    updatedAt: null,
    costUsd: 0,
  },
  createdAt: '2026-10-01T12:00:00.000Z',
  updatedAt: '2026-10-01T12:00:00.000Z',
  ...over,
  work: {
    stageId: 's1',
    stage: 'Proposta',
    stageChangedAt: '2026-10-01T12:00:00.000Z',
    won: null,
    closedAt: null,
    lostReason: null,
    ownerName: 'Eric',
    managedBy: 'wings',
    ...over.work,
  },
});

vi.mock('../../api/auth.js', async () => {
  const actual = await vi.importActual<typeof import('../../api/auth.js')>('../../api/auth.js');
  return {
    ...actual,
    useSession: () => ({
      data: {
        id: 'e1',
        fullName: 'Eric Souza',
        role: 'vendedor_expansao',
        permissions: { 'leads.read': 'own', 'leads.write': 'own' },
      },
    }),
  };
});

vi.mock('../../api/leads.js', () => ({
  useLead: () => ({
    isLoading: false,
    isError: false,
    data: queryState.lead && {
      lead: queryState.lead,
      events: [],
      notes: [],
      tasks: [],
      history: [],
      activities: [],
    },
  }),
  useSellers: idle,
  useStages: idle,
  useCheckLead: idle,
  useUpdateLead: () => mutation(),
  useUpdateTask: () => mutation(),
  useAddNote: () => mutation(),
  useCreateTask: () => mutation(),
}));

vi.mock('../../api/crm.js', () => ({
  useUpdateDeal: () => mutation(dealMutate),
  useAddActivity: () => mutation(),
  useBrands: idle,
  useLinkContact: () => mutation(),
  useUnlinkContact: () => mutation(),
  useContacts: idle,
  useCompanies: idle,
}));

const show = () =>
  render(
    <MemoryRouter initialEntries={['/crm-vendas/negociacoes/l1']}>
      <Routes>
        <Route path="/crm-vendas/negociacoes/:id" element={<DealPage />} />
      </Routes>
    </MemoryRouter>,
  );

const field = () => screen.getByLabelText('Previsão de fechamento') as HTMLInputElement;

beforeEach(() => dealMutate.mockClear());
afterEach(cleanup);

describe('Previsão de fechamento', () => {
  it('shows a date field next to the value, empty while nobody said, and saves the day picked', () => {
    queryState.lead = lead({});
    show();
    expect(field().type).toBe('date');
    expect(field().value).toBe('');
    expect(screen.queryByText('vencida')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Limpar previsão de fechamento' })).toBeNull();
    fireEvent.change(field(), { target: { value: '2026-12-15' } });
    expect(dealMutate).toHaveBeenCalledWith({ expectedCloseAt: '2026-12-15' });
  });

  it('waits for a full year before saving while the person is still typing', () => {
    queryState.lead = lead({});
    show();
    fireEvent.change(field(), { target: { value: '0002-12-15' } });
    expect(dealMutate).not.toHaveBeenCalled();
  });

  it('can be cleared, by the button or by emptying the field', () => {
    queryState.lead = lead({ expectedCloseAt: '2099-01-10' });
    show();
    expect(field().value).toBe('2099-01-10');
    fireEvent.click(screen.getByRole('button', { name: 'Limpar previsão de fechamento' }));
    expect(dealMutate).toHaveBeenCalledWith({ expectedCloseAt: null });
    dealMutate.mockClear();
    fireEvent.change(field(), { target: { value: '' } });
    expect(dealMutate).toHaveBeenCalledWith({ expectedCloseAt: null });
  });

  it('says "vencida" in words when the day passed and the deal is still open', () => {
    queryState.lead = lead({ expectedCloseAt: '2020-01-10' });
    show();
    expect(screen.getByText('vencida')).toBeTruthy();
  });

  it('is not "vencida" for a deal already won, nor for a day still ahead', () => {
    queryState.lead = lead({ expectedCloseAt: '2020-01-10', work: { won: true } });
    show();
    expect(screen.queryByText('vencida')).toBeNull();
    cleanup();
    queryState.lead = lead({ expectedCloseAt: '2099-01-10' });
    show();
    expect(screen.queryByText('vencida')).toBeNull();
  });

  it('reads as plain text, in DD/MM/AAAA, for who cannot edit', async () => {
    const auth = await import('../../api/auth.js');
    vi.spyOn(auth, 'useSession').mockReturnValue({
      data: {
        id: 'e2',
        fullName: 'Leitor',
        role: 'marketing',
        permissions: { 'leads.read': 'all' },
      },
    } as unknown as ReturnType<typeof auth.useSession>);
    queryState.lead = lead({ expectedCloseAt: '2026-11-20' });
    show();
    expect(screen.queryByLabelText('Previsão de fechamento')).toBeNull();
    expect(screen.getByText('20/11/2026')).toBeTruthy();
  });
});
