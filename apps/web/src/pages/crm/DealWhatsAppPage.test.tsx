import type { Lead, LeadNote } from '@wings/shared';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DealWhatsAppPage } from './DealWhatsAppPage.js';

/**
 * The WhatsApp conversation screen of a deal: empty while the official API is
 * not connected (no sample message), sending and video disabled "em breve",
 * the voice button opening the call panel;
 * the panel on the right carries Visão geral, Anotações and Arquivos.
 */

const { noteMutate, queryState, mutation } = vi.hoisted(() => ({
  noteMutate: vi.fn(),
  queryState: { lead: null as Lead | null, notes: [] as LeadNote[] },
  mutation: (mutate = vi.fn()) => ({ mutate, isPending: false, error: null }),
}));

const lead = (): Lead => ({
  id: 'l1',
  name: 'Elena Prado',
  email: null,
  phone: '5521999990001',
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
    source: 'whatsapp_link',
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
  expectedCloseAt: '2026-12-15',
  company: { id: 'co1', name: 'Padaria Sol', clientId: null },
  contacts: [],
  crm: null,
  consent: { legalBasis: null, consentedAt: null, source: null, text: null },
  fields: { instagram: null, website: null, companyName: null, cnpj: null },
  checks: {},
  aiSummary: null,
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
  enteredAt: '2026-10-01T11:30:00.000Z',
  enteredAtSource: 'meta_created_time',
  createdAt: '2026-10-01T12:00:00.000Z',
  updatedAt: '2026-10-01T12:00:00.000Z',
  work: {
    stageId: 's1',
    stage: 'Proposta',
    stageChangedAt: '2026-10-01T12:00:00.000Z',
    won: null,
    closedAt: null,
    lostReason: null,
    ownerName: 'Eric',
    managedBy: 'wings',
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
      notes: queryState.notes,
      tasks: [],
      history: [],
      activities: [],
    },
  }),
  useAddNote: () => mutation(noteMutate),
  useUpdateTask: () => mutation(),
}));

vi.mock('../../api/crm.js', () => ({
  useAddActivity: () => mutation(),
  useLeadFiles: () => ({ data: [], isLoading: false, isError: false }),
  useRemoveLeadFile: () => mutation(),
  useSendLeadFile: () => ({ ...mutation(), mutateAsync: vi.fn() }),
}));

vi.mock('./LeadEmailTab.js', () => ({ LeadEmailTab: () => <div>Aba de e-mail</div> }));

const show = () =>
  render(
    <MemoryRouter initialEntries={['/crm-vendas/negociacoes/l1/whatsapp']}>
      <Routes>
        <Route path="/crm-vendas/negociacoes/:id/whatsapp" element={<DealWhatsAppPage />} />
      </Routes>
    </MemoryRouter>,
  );

beforeEach(() => {
  noteMutate.mockClear();
  queryState.lead = lead();
  queryState.notes = [
    { id: 'n1', at: '2026-10-04T10:00:00.000Z', authorName: 'Eric', body: 'Pediu o catálogo' },
  ];
});
afterEach(cleanup);

describe('the WhatsApp conversation screen', () => {
  it('opens empty, with no sample message, and sending and video disabled "em breve"', () => {
    show();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Elena Prado');
    expect(screen.getByText('(21) 99999-0001 · WhatsApp')).toBeTruthy();
    const chat = within(screen.getByRole('region', { name: 'Conversa' }));
    expect(chat.getByText(/Nenhuma mensagem ainda/)).toBeTruthy();
    expect(chat.queryAllByRole('listitem')).toHaveLength(0);
    expect((chat.getByLabelText('Mensagem') as HTMLInputElement).disabled).toBe(true);
    expect((chat.getByRole('button', { name: 'Enviar' }) as HTMLButtonElement).disabled).toBe(true);
    const calls = within(screen.getByRole('group', { name: 'Chamadas pelo WhatsApp' }));
    expect(
      (calls.getByRole('button', { name: 'Chamada de vídeo (em breve)' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(screen.getByRole('link', { name: '‹ Negociação' }).getAttribute('href')).toBe(
      '/crm-vendas/negociacoes/l1',
    );
  });

  it('the voice button opens the call panel, with WhatsApp calling off until the API is on', () => {
    show();
    const calls = within(screen.getByRole('group', { name: 'Chamadas pelo WhatsApp' }));
    fireEvent.click(calls.getByRole('button', { name: 'Ligação de voz' }));
    const panel = within(screen.getByRole('dialog', { name: 'Ligação' }));
    expect(panel.getByText('(21) 99999-0001')).toBeTruthy();
    expect(
      (panel.getByRole('button', { name: /Ligar pelo WhatsApp/ }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      panel.getByText(/Fica ativo quando a API oficial do WhatsApp estiver ligada/),
    ).toBeTruthy();
    expect(panel.getByRole('button', { name: 'Registrar ligação' })).toBeTruthy();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'Ligação' })).toBeNull();
  });

  it('keeps Visão geral, Anotações (working) and Arquivos on the right', () => {
    show();
    const overview = within(screen.getByRole('region', { name: 'Visão geral' }));
    expect(overview.getByText('Expansão')).toBeTruthy();
    expect(overview.getByText('Proposta')).toBeTruthy();
    expect(overview.getByText('Padaria Sol')).toBeTruthy();
    expect(overview.getByText('15/12/2026')).toBeTruthy();
    const notes = within(screen.getByRole('region', { name: 'Anotações' }));
    expect(notes.getByText('Pediu o catálogo')).toBeTruthy();
    fireEvent.change(notes.getByPlaceholderText('Anotar sobre a conversa'), {
      target: { value: 'Respondeu no WhatsApp' },
    });
    fireEvent.click(notes.getByRole('button', { name: 'Anotar' }));
    expect(noteMutate).toHaveBeenCalledWith({ body: 'Respondeu no WhatsApp' }, expect.anything());
    const files = within(screen.getByRole('region', { name: 'Arquivos' }));
    expect(files.getByText('Nenhum arquivo nesta negociação.')).toBeTruthy();
    expect(files.getByRole('button', { name: 'Enviar arquivo' })).toBeTruthy();
  });
});
