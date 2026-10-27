import type { DealWhatsApp, Lead, LeadNote, WaTemplate, WaTemplatePreview } from '@wings/shared';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../api/client.js';
import { DealWhatsAppPage } from './DealWhatsAppPage.js';

/**
 * The WhatsApp conversation screen of a deal: the official conversation with
 * its statuses; free text inside the 24-hour window and an approved template
 * outside it; off, and saying so, while the API is not connected; video "em
 * breve"; the voice button opening the call panel; the panel on the right
 * carries Visão geral, Anotações and Arquivos.
 */

const {
  noteMutate,
  textMutate,
  templateMutate,
  previewCalls,
  refetchPreview,
  queryState,
  mutation,
} = vi.hoisted(() => ({
  noteMutate: vi.fn(),
  textMutate: vi.fn(),
  templateMutate: vi.fn(),
  previewCalls: [] as unknown[],
  refetchPreview: vi.fn(),
  queryState: {
    lead: null as Lead | null,
    notes: [] as LeadNote[],
    thread: null as DealWhatsApp | null,
    templates: [] as WaTemplate[],
    preview: null as WaTemplatePreview | null,
    previews: {} as Record<string, WaTemplatePreview>,
    shown: null as WaTemplatePreview | null,
    loading: new Set<string>(),
    permissions: {} as Record<string, string>,
    // Overrides for what a query answers (a failed request); reset before every test.
    leadQuery: {} as Record<string, unknown>,
    threadQuery: {} as Record<string, unknown>,
    filesQuery: {} as Record<string, unknown>,
    templatesQuery: {} as Record<string, unknown>,
    artQuery: {} as Record<string, unknown>,
    // A seller before the official number is live (useWhatsAppSoon).
    soon: false,
  },
  mutation: (mutate = vi.fn()) => ({ mutate, isPending: false, error: null }),
}));

const thread = (over: Partial<DealWhatsApp> = {}): DealWhatsApp => ({
  conversationId: null,
  leadId: 'l1',
  profileName: 'Elena',
  configured: true,
  calling: false,
  phone: '5521999990001',
  window: { open: true, expiresAt: '2026-10-07T18:00:00.000Z' },
  optedOut: false,
  callPermission: { status: null, expiresAt: null, requestedAt: null },
  attendance: null,
  speaksFor: null,
  messages: [],
  ...over,
});

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
    ad: null,
    utm: null,
    trafficSource: null,
    conversionIdentifier: null,
  },
  pipeline: 'expansao',
  brand: null,
  valueCents: 4500000,
  expectedCloseAt: '2026-12-15',
  company: { id: 'co1', name: 'Padaria Sol', clientId: null },
  contacts: [],
  crm: null,
  consent: { legalBasis: null, consentedAt: null, source: null, text: null },
  googlePlaceId: null,
  fields: { instagram: null, website: null, companyName: null, cnpj: null },
  checks: {},
  aiSummary: null,
  suspect: null,
  instagramCheck: null,
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
        permissions: queryState.permissions,
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
    ...queryState.leadQuery,
  }),
  useAddNote: () => mutation(noteMutate),
  useUpdateTask: () => mutation(),
}));

vi.mock('../../api/crm.js', () => ({
  useAddActivity: () => mutation(),
  useLeadFiles: () => ({
    data: [],
    isLoading: false,
    isError: false,
    isSuccess: true,
    ...queryState.filesQuery,
  }),
  useRemoveLeadFile: () => mutation(),
  useSendLeadFile: () => ({ ...mutation(), mutateAsync: vi.fn() }),
}));

vi.mock('../../api/whatsapp.js', () => ({
  useWhatsAppSoon: () => queryState.soon,
  WHATSAPP_SOON_TEXT: 'Em breve: texto do bloqueio do vendedor.',
  useWhatsAppThread: () => ({
    isLoading: false,
    isError: false,
    data: queryState.thread,
    ...queryState.threadQuery,
  }),
  useWhatsAppTemplates: () => ({
    isLoading: false,
    isError: false,
    isSuccess: true,
    data: { templates: queryState.templates, configured: true, syncError: null },
    ...queryState.templatesQuery,
  }),
  useRefreshWhatsAppTemplates: () => mutation(),
  useSendWhatsAppText: () => mutation(textMutate),
  useSendWhatsAppTemplate: () => mutation(templateMutate),
  useTemplatePreview: (_thread: unknown, input: { name: string } | null) => {
    if (input) previewCalls.push(input);
    // Like react-query's placeholderData: while a template's preview loads, the previous one is returned.
    if (input && queryState.loading.has(input.name) && queryState.shown)
      return {
        isError: false,
        isPlaceholderData: true,
        refetch: refetchPreview,
        data: { preview: queryState.shown },
      };
    const preview = input
      ? (queryState.previews[input.name] ?? queryState.preview ?? undefined)
      : undefined;
    if (preview) queryState.shown = preview;
    return {
      isError: false,
      isPlaceholderData: false,
      refetch: refetchPreview,
      data: preview ? { preview } : undefined,
    };
  },

  useWhatsAppArt: (_thread: unknown, enabled: boolean) => ({
    isError: false,
    data: enabled
      ? { fileId: 'f1', url: 'https://r2.example/arte?sig=1', expiresAt: '' }
      : undefined,
    ...queryState.artQuery,
  }),
  whatsappMediaUrl: (id: string) => `/api/whatsapp/messages/${id}/media`,
}));

vi.mock('./LeadEmailTab.js', () => ({ LeadEmailTab: () => <div>Aba de e-mail</div> }));

// The import panel has its own test (ImportChatPanel.test.tsx); here only the button that opens it.
vi.mock('./ImportChatPanel.js', () => ({
  ImportChatPanel: ({ leadId, onClose }: { leadId: string; onClose: () => void }) => (
    <div role="dialog" aria-label="Importar conversa">
      Painel de importação de {leadId}
      <button type="button" onClick={onClose}>
        Fechar painel
      </button>
    </div>
  ),
}));

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
  textMutate.mockClear();
  templateMutate.mockClear();
  previewCalls.length = 0;
  queryState.thread = thread();
  queryState.templates = [];
  queryState.preview = null;
  queryState.previews = {};
  queryState.shown = null;
  queryState.loading = new Set();
  queryState.permissions = { 'leads.read': 'own', 'leads.write': 'own', 'leads.whatsapp': 'own' };
  queryState.leadQuery = {};
  queryState.threadQuery = {};
  queryState.filesQuery = {};
  queryState.templatesQuery = {};
  queryState.artQuery = {};
  queryState.soon = false;
  queryState.lead = lead();
  queryState.notes = [
    { id: 'n1', at: '2026-10-04T10:00:00.000Z', authorName: 'Eric', body: 'Pediu o catálogo' },
  ];
});
afterEach(cleanup);

describe('the WhatsApp conversation screen', () => {
  it('says when the official API is off: no sample message, no sending, video "em breve"', () => {
    queryState.thread = thread({ configured: false, window: { open: false, expiresAt: null } });
    show();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Elena Prado');
    expect(screen.getByText('(21) 99999-0001 · WhatsApp')).toBeTruthy();
    const chat = within(screen.getByRole('region', { name: 'Conversa' }));
    expect(chat.getByText(/A conversa aparece aqui quando a API oficial/)).toBeTruthy();
    expect(chat.queryAllByRole('listitem')).toHaveLength(0);
    expect(chat.queryByLabelText('Mensagem')).toBeNull();
    expect(chat.getByText(/O envio liga quando a API oficial/)).toBeTruthy();
    const calls = within(screen.getByRole('group', { name: 'Chamadas pelo WhatsApp' }));
    expect(
      (calls.getByRole('button', { name: 'Chamada de vídeo (em breve)' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(screen.getByRole('link', { name: '‹ Negociação' }).getAttribute('href')).toBe(
      '/crm-vendas/negociacoes/l1',
    );
  });

  it('shows the conversation with statuses and the reason a message did not go', () => {
    queryState.thread = thread({
      messages: [
        {
          id: 'm1',
          direction: 'in',
          kind: 'text',
          text: 'Oi, quero saber da franquia',
          media: null,
          template: null,
          status: null,
          error: null,
          authorName: null,
          bySofia: false,
          imported: null,
          fromTemplate: null,
          withArt: false,
          at: '2026-10-07T14:00:00.000Z',
        },
        {
          id: 'm2',
          direction: 'out',
          kind: 'text',
          text: 'Olá Elena!',
          media: null,
          template: null,
          status: 'read',
          error: null,
          authorName: 'Eric Souza',
          bySofia: false,
          imported: null,
          fromTemplate: null,
          withArt: false,
          at: '2026-10-07T14:01:00.000Z',
        },
        {
          id: 'm3',
          direction: 'out',
          kind: 'text',
          text: 'Segue o material',
          media: null,
          template: null,
          status: 'failed',
          error: 'Não entregue: o número pode não ter WhatsApp.',
          authorName: 'Eric Souza',
          bySofia: false,
          imported: null,
          fromTemplate: null,
          withArt: false,
          at: '2026-10-07T14:02:00.000Z',
        },
        {
          id: 'm4',
          direction: 'in',
          kind: 'document',
          text: null,
          media: { mimeType: 'application/pdf', filename: 'cnpj.pdf' },
          template: null,
          status: null,
          error: null,
          authorName: null,
          bySofia: false,
          imported: null,
          fromTemplate: null,
          withArt: false,
          at: '2026-10-07T14:03:00.000Z',
        },
      ],
    });
    show();
    const chat = within(screen.getByRole('region', { name: 'Conversa' }));
    expect(chat.getAllByRole('listitem')).toHaveLength(4);
    expect(chat.getByText('Oi, quero saber da franquia')).toBeTruthy();
    const metas = chat.getAllByText(
      (_, el) =>
        Boolean(el?.classList.contains('crm-wa-meta')) &&
        /Eric Souza · .+ · Lida/.test(el?.textContent ?? ''),
    );
    expect(metas).toHaveLength(1);
    expect(chat.getByText('Não entregue: o número pode não ter WhatsApp.')).toBeTruthy();
    expect(
      chat.getByRole('link', { name: /Baixar documento · cnpj.pdf/ }).getAttribute('href'),
    ).toBe('/api/whatsapp/messages/m4/media');
    expect(chat.getByText(/Janela de 24 h aberta até/)).toBeTruthy();
  });

  it('sends free text inside the window with Enter', () => {
    show();
    const chat = within(screen.getByRole('region', { name: 'Conversa' }));
    const field = chat.getByLabelText('Mensagem');
    fireEvent.change(field, { target: { value: 'Podemos falar às 15h?' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(textMutate).toHaveBeenCalledWith({ text: 'Podemos falar às 15h?' }, expect.anything());
  });

  it('before the official number is live a seller reads the conversation but has no composer, only "em breve"', () => {
    queryState.soon = true;
    queryState.thread = thread({
      messages: [
        {
          id: 'm1',
          direction: 'in',
          kind: 'text',
          text: 'Oi, quero saber da franquia',
          media: null,
          template: null,
          status: null,
          error: null,
          authorName: null,
          bySofia: false,
          fromTemplate: null,
          withArt: false,
          imported: null,
          at: '2026-10-07T14:00:00.000Z',
        },
      ],
    });
    show();
    const chat = within(screen.getByRole('region', { name: 'Conversa' }));
    expect(chat.getByText('Oi, quero saber da franquia')).toBeTruthy();
    expect(chat.queryByLabelText('Mensagem')).toBeNull();
    expect(chat.queryByRole('button', { name: /Enviar/ })).toBeNull();
    expect(chat.getByText('Em breve: texto do bloqueio do vendedor.')).toBeTruthy();
    expect(textMutate).not.toHaveBeenCalled();
  });

  it('before the number is live the template composer is gone too, outside the window', () => {
    queryState.soon = true;
    queryState.thread = thread({ window: { open: false, expiresAt: '2026-10-05T10:00:00.000Z' } });
    queryState.templates = [
      {
        name: 'retomar_conversa',
        language: 'pt_BR',
        category: 'UTILITY',
        body: 'Olá {{1}}, aqui é {{2}} da Wings.',
        paramCount: 2,
        artVersion: false,
      },
    ];
    show();
    const chat = within(screen.getByRole('region', { name: 'Conversa' }));
    expect(chat.queryByLabelText('Modelo')).toBeNull();
    expect(chat.getByText('Em breve: texto do bloqueio do vendedor.')).toBeTruthy();
  });

  it('outside the window offers only an approved template, with its fields filled in', () => {
    queryState.thread = thread({ window: { open: false, expiresAt: '2026-10-05T10:00:00.000Z' } });
    queryState.templates = [
      {
        name: 'retomar_conversa',
        language: 'pt_BR',
        category: 'UTILITY',
        body: 'Olá {{1}}, aqui é {{2}} da Wings.',
        paramCount: 2,
        artVersion: false,
      },
    ];
    queryState.preview = {
      family: 'retomar_conversa',
      version: 'retomar_conversa',
      language: 'pt_BR',
      category: 'UTILITY',
      sendAs: 'template',
      charged: true,
      reason: null,
      windowExpiresAt: null,
      text: 'Olá Elena, aqui é  da Wings.',
      footer: null,
      buttons: [],
      withArt: false,
      notices: [
        'Cadastre a arte do WhatsApp da Wings (Administração → Clientes, em Wings Company).',
      ],
      fields: [
        { index: 1, role: 'free', label: 'Campo {{1}}', value: 'Elena', locked: false },
        { index: 2, role: 'free', label: 'Campo {{2}}', value: '', locked: false },
      ],
      usesCompanyArticle: false,
      ready: false,
    };
    show();
    const chat = within(screen.getByRole('region', { name: 'Conversa' }));
    expect(chat.getByText(/Fora das 24 h/)).toBeTruthy();
    expect(chat.queryByLabelText('Mensagem')).toBeNull();
    fireEvent.change(chat.getByLabelText('Modelo'), {
      target: { value: 'retomar_conversa|pt_BR' },
    });
    // The server fills what it knows; the seller fills the rest.
    expect(previewCalls[0]).toEqual({
      name: 'retomar_conversa',
      language: 'pt_BR',
      params: [],
      companyArticle: 'a',
    });
    expect(chat.getByText('Modelo aprovado (utilidade: cobrado pela Meta)')).toBeTruthy();
    expect(chat.getByText(/Cadastre a arte do WhatsApp da Wings/)).toBeTruthy();
    const send = chat.getByRole('button', { name: 'Enviar modelo' }) as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    expect((chat.getByLabelText('Campo {{1}} ({{1}})') as HTMLInputElement).value).toBe('Elena');
    fireEvent.change(chat.getByLabelText('Campo {{2}} ({{2}})'), { target: { value: 'Eric' } });
    expect(send.disabled).toBe(false);
    fireEvent.click(send);
    expect(templateMutate).toHaveBeenCalledWith(
      {
        name: 'retomar_conversa',
        language: 'pt_BR',
        params: ['Elena', 'Eric'],
        companyArticle: 'a',
        expect: { sendAs: 'template', charged: true },
      },
      expect.anything(),
    );
  });

  it('inside the window shows the common message with the art, the buttons and the company article', () => {
    queryState.templates = [
      {
        name: 'wings_formatacao_boas_vindas',
        language: 'pt_BR',
        category: 'UTILITY',
        body: 'Olá, {{1}}! Aqui é {{2}}, da Wings Company. … transformar a {{3}} em franquia.',
        paramCount: 3,
        artVersion: true,
      },
    ];
    queryState.preview = {
      family: 'wings_formatacao_boas_vindas',
      version: 'wings_formatacao_boas_vindas_arte',
      language: 'pt_BR',
      category: 'UTILITY',
      sendAs: 'free',
      charged: false,
      reason: null,
      windowExpiresAt: '2026-10-07T18:00:00.000Z',
      text: 'Olá, Elena! Aqui é Eric, da Wings Company. … transformar a Padaria Sol em franquia.',
      footer: null,
      buttons: ['Sim, pode perguntar', 'Prefiro uma ligação'],
      withArt: true,
      notices: [],
      fields: [
        { index: 1, role: 'lead', label: 'Nome do lead', value: 'Elena', locked: false },
        { index: 2, role: 'seller', label: 'Seu nome', value: 'Eric', locked: false },
        {
          index: 3,
          role: 'company',
          label: 'Empresa do lead',
          value: 'Padaria Sol',
          locked: false,
        },
      ],
      usesCompanyArticle: true,
      ready: true,
    };
    show();
    const chat = within(screen.getByRole('region', { name: 'Conversa' }));
    fireEvent.click(chat.getByRole('button', { name: 'Usar modelo' }));
    expect(
      chat.getByRole('option', { name: /wings_formatacao_boas_vindas \(pt_BR\) · com arte/ }),
    ).toBeTruthy();
    fireEvent.change(chat.getByLabelText('Modelo'), {
      target: { value: 'wings_formatacao_boas_vindas|pt_BR' },
    });
    expect(
      chat.getByText(/^Mensagem comum, sem custo \(janela aberta até \d{2}:\d{2}\)$/),
    ).toBeTruthy();
    const card = within(chat.getByLabelText('Prévia da mensagem'));
    expect(card.getByRole('img', { name: 'Arte do cabeçalho' }).getAttribute('src')).toBe(
      'https://r2.example/arte?sig=1',
    );
    expect(card.getByText('Sim, pode perguntar')).toBeTruthy();
    fireEvent.click(chat.getByLabelText(/o \(do Bar\)/));
    expect(previewCalls.at(-1)).toMatchObject({ companyArticle: 'o' });
    fireEvent.click(chat.getByRole('button', { name: 'Enviar mensagem' }));
    expect(templateMutate).toHaveBeenCalledWith(
      {
        name: 'wings_formatacao_boas_vindas',
        language: 'pt_BR',
        params: ['Elena', 'Eric', 'Padaria Sol'],
        companyArticle: 'o',
        expect: { sendAs: 'free', charged: false },
      },
      expect.anything(),
    );
  });

  it("switching templates starts from the new template's values, never the previous ones", () => {
    const base = (name: string, fields: WaTemplatePreview['fields']): WaTemplatePreview => ({
      family: name,
      version: name,
      language: 'pt_BR',
      category: 'UTILITY',
      sendAs: 'free',
      charged: false,
      reason: null,
      windowExpiresAt: '2026-10-07T18:00:00.000Z',
      text: name,
      footer: null,
      buttons: [],
      withArt: false,
      notices: [],
      fields,
      usesCompanyArticle: false,
      ready: true,
    });
    queryState.templates = [
      {
        name: 'boas_vindas',
        language: 'pt_BR',
        category: 'UTILITY',
        body: 'x',
        paramCount: 2,
        artVersion: false,
      },
      {
        name: 'lembrete',
        language: 'pt_BR',
        category: 'UTILITY',
        body: 'y',
        paramCount: 3,
        artVersion: false,
      },
    ];
    queryState.previews = {
      boas_vindas: base('boas_vindas', [
        { index: 1, role: 'lead', label: 'Nome do lead', value: 'Elena', locked: false },
        { index: 2, role: 'seller', label: 'Seu nome', value: 'Eric', locked: false },
      ]),
      lembrete: base('lembrete', [
        { index: 1, role: 'lead', label: 'Nome do lead', value: 'Elena', locked: false },
        { index: 2, role: 'free', label: 'Dia', value: '', locked: false },
        { index: 3, role: 'free', label: 'Link da reunião', value: '', locked: false },
      ]),
    };
    const page = show();
    const chat = within(screen.getByRole('region', { name: 'Conversa' }));
    fireEvent.click(chat.getByRole('button', { name: 'Usar modelo' }));
    fireEvent.change(chat.getByLabelText('Modelo'), { target: { value: 'boas_vindas|pt_BR' } });
    fireEvent.change(chat.getByLabelText('Seu nome ({{2}})'), { target: { value: 'Thais' } });
    // The new template's preview is still loading: the old one is not shown nor used.
    queryState.loading.add('lembrete');
    fireEvent.change(chat.getByLabelText('Modelo'), { target: { value: 'lembrete|pt_BR' } });
    expect(chat.getByText('Montando a prévia…')).toBeTruthy();
    expect(chat.queryByLabelText('Seu nome ({{2}})')).toBeNull();
    expect(
      (chat.getByRole('button', { name: 'Enviar modelo' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    queryState.loading.delete('lembrete');
    page.rerender(
      <MemoryRouter initialEntries={['/crm-vendas/negociacoes/l1/whatsapp']}>
        <Routes>
          <Route path="/crm-vendas/negociacoes/:id/whatsapp" element={<DealWhatsAppPage />} />
        </Routes>
      </MemoryRouter>,
    );
    expect((chat.getByLabelText('Dia ({{2}})') as HTMLInputElement).value).toBe('');
    fireEvent.change(chat.getByLabelText('Link da reunião ({{3}})'), {
      target: { value: 'https://meet.google.com/abc' },
    });
    fireEvent.change(chat.getByLabelText('Dia ({{2}})'), { target: { value: 'sexta, 10/10' } });
    fireEvent.click(chat.getByRole('button', { name: 'Enviar mensagem' }));
    expect(templateMutate).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'lembrete',
        params: ['Elena', 'sexta, 10/10', 'https://meet.google.com/abc'],
      }),
      expect.anything(),
    );
  });

  it('keeps the field (and the focus) while the same template asks for a new preview', () => {
    queryState.templates = [
      {
        name: 'boas_vindas',
        language: 'pt_BR',
        category: 'UTILITY',
        body: 'x',
        paramCount: 1,
        artVersion: false,
      },
    ];
    queryState.preview = {
      family: 'boas_vindas',
      version: 'boas_vindas',
      language: 'pt_BR',
      category: 'UTILITY',
      sendAs: 'template',
      charged: true,
      reason: null,
      windowExpiresAt: null,
      text: 'Olá, transformar a sua empresa em franquia',
      footer: null,
      buttons: [],
      withArt: false,
      notices: [],
      fields: [
        {
          index: 1,
          role: 'company',
          label: 'Empresa do lead',
          value: 'sua empresa',
          locked: false,
        },
      ],
      usesCompanyArticle: true,
      ready: true,
    };
    const page = show();
    const chat = within(screen.getByRole('region', { name: 'Conversa' }));
    fireEvent.click(chat.getByRole('button', { name: 'Usar modelo' }));
    fireEvent.change(chat.getByLabelText('Modelo'), { target: { value: 'boas_vindas|pt_BR' } });
    const field = chat.getByLabelText('Empresa do lead ({{1}})') as HTMLInputElement;
    field.focus();
    fireEvent.change(field, { target: { value: 'Padaria' } });
    // The typed value asks the server again: while it answers, the field is the same element.
    queryState.loading.add('boas_vindas');
    page.rerender(
      <MemoryRouter initialEntries={['/crm-vendas/negociacoes/l1/whatsapp']}>
        <Routes>
          <Route path="/crm-vendas/negociacoes/:id/whatsapp" element={<DealWhatsAppPage />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(chat.getByLabelText('Empresa do lead ({{1}})')).toBe(field);
    expect(document.activeElement).toBe(field);
    expect(field.value).toBe('Padaria');
    expect(chat.queryByText('Montando a prévia…')).toBeNull();
    // Only a fresh preview can be sent.
    expect(
      (chat.getByRole('button', { name: 'Enviar modelo' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    queryState.loading.delete('boas_vindas');
  });

  it('keeps the conversation closed to who has no WhatsApp access', () => {
    queryState.permissions = { 'leads.read': 'own', 'leads.write': 'own' };
    show();
    expect(screen.getByText('Seu acesso não inclui o WhatsApp desta negociação.')).toBeTruthy();
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

  it('"Importar do celular" opens the import panel for this deal and closes it again', () => {
    show();
    expect(screen.queryByRole('dialog', { name: 'Importar conversa' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Importar do celular/ }));
    const panel = within(screen.getByRole('dialog', { name: 'Importar conversa' }));
    expect(panel.getByText('Painel de importação de l1')).toBeTruthy();
    fireEvent.click(panel.getByRole('button', { name: 'Fechar painel' }));
    expect(screen.queryByRole('dialog', { name: 'Importar conversa' })).toBeNull();
  });

  it('hides "Importar do celular" from who can read the WhatsApp but cannot write to the deal', () => {
    queryState.permissions = { 'leads.read': 'own', 'leads.whatsapp': 'own' };
    show();
    expect(screen.getByRole('button', { name: 'Ligação de voz' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Importar do celular/ })).toBeNull();
  });

  it('before the number is live the call panel says "em breve", keeping Copiar número and Registrar ligação', () => {
    queryState.soon = true;
    show();
    const calls = within(screen.getByRole('group', { name: 'Chamadas pelo WhatsApp' }));
    fireEvent.click(calls.getByRole('button', { name: 'Ligação de voz' }));
    const panel = within(screen.getByRole('dialog', { name: 'Ligação' }));
    expect(
      (panel.getByRole('button', { name: /Ligar pelo WhatsApp/ }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(panel.getByText('Em breve: texto do bloqueio do vendedor.')).toBeTruthy();
    expect(panel.getByRole('button', { name: 'Copiar número' })).toBeTruthy();
    expect(panel.getByRole('button', { name: 'Registrar ligação' })).toBeTruthy();
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

  describe('when a request fails', () => {
    const failed = (error: unknown) => ({
      data: undefined,
      isLoading: false,
      isError: true,
      isSuccess: false,
      error,
      refetch: vi.fn(),
    });
    const alerts = () => screen.getAllByRole('alert').map((node) => node.textContent ?? '');

    it('the deal that did not load says why, not "não encontrada"', () => {
      queryState.leadQuery = failed(new ApiError(401, {}));
      show();
      expect(alerts().join(' ')).toContain('Não foi possível carregar a negociação');
      expect(alerts().join(' ')).toContain('sua sessão expirou');
      expect(screen.queryByText(/não encontrada/)).toBeNull();
    });

    it('the conversation that did not load says why, not only "abrir a conversa"', () => {
      queryState.threadQuery = failed(new ApiError(500, {}));
      show();
      const chat = within(screen.getByRole('region', { name: 'Conversa' }));
      expect(chat.getByRole('alert').textContent).toContain('Não foi possível carregar a conversa');
      expect(chat.getByRole('alert').textContent).toContain('erro 500');
      expect(chat.queryByText(/Nenhuma mensagem ainda/)).toBeNull();
    });

    it('a refresh that failed keeps the messages and adds the reason', () => {
      queryState.thread = thread({
        messages: [
          {
            id: 'm1',
            direction: 'in',
            kind: 'text',
            text: 'Oi, quero saber mais',
            at: '2026-10-07T12:00:00.000Z',
            status: null,
            media: null,
            error: null,
          } as unknown as DealWhatsApp['messages'][number],
        ],
      });
      queryState.threadQuery = { isError: true, isSuccess: false, error: new TypeError('x') };
      show();
      const chat = within(screen.getByRole('region', { name: 'Conversa' }));
      expect(chat.getByRole('alert').textContent).toContain('sem conexão com o servidor');
      expect(chat.getByText('Oi, quero saber mais')).toBeTruthy();
    });

    it('the files that did not load say "—" and why, not "Nenhum arquivo nesta negociação."', () => {
      queryState.filesQuery = failed(new ApiError(403, {}));
      show();
      const files = within(screen.getByRole('region', { name: 'Arquivos' }));
      expect(files.getByRole('alert').textContent).toContain(
        'Não foi possível carregar os arquivos',
      );
      expect(files.queryByText('Nenhum arquivo nesta negociação.')).toBeNull();
    });

    it('the templates that did not load say why, not "Nenhum modelo aprovado ainda."', () => {
      queryState.thread = thread({ window: { open: false, expiresAt: null } });
      queryState.templatesQuery = failed(new ApiError(500, {}));
      show();
      const form = within(screen.getByRole('form', { name: 'Enviar modelo' }));
      expect(form.getByRole('alert').textContent).toContain('Não foi possível carregar os modelos');
      expect(form.queryByText(/Nenhum modelo aprovado/)).toBeNull();
    });

    it('a template art that did not load is said, not left as a card with no picture', () => {
      queryState.templates = [
        {
          name: 'boas_vindas',
          language: 'pt_BR',
          category: 'UTILITY',
          body: 'Olá, {{1}}!',
          paramCount: 1,
          artVersion: true,
        },
      ];
      queryState.preview = {
        family: 'boas_vindas',
        version: 'boas_vindas_arte',
        language: 'pt_BR',
        category: 'UTILITY',
        sendAs: 'free',
        charged: false,
        reason: null,
        windowExpiresAt: '2026-10-07T18:00:00.000Z',
        text: 'Olá, Elena!',
        footer: null,
        buttons: [],
        withArt: true,
        notices: [],
        fields: [],
        usesCompanyArticle: false,
        ready: true,
      };
      queryState.artQuery = failed(new ApiError(500, {}));
      show();
      const chat = within(screen.getByRole('region', { name: 'Conversa' }));
      fireEvent.click(chat.getByRole('button', { name: 'Usar modelo' }));
      fireEvent.change(chat.getByLabelText('Modelo'), { target: { value: 'boas_vindas|pt_BR' } });
      expect(chat.getByRole('alert').textContent).toContain(
        'Não foi possível carregar a arte do cabeçalho',
      );
      expect(chat.queryByRole('img', { name: 'Arte do cabeçalho' })).toBeNull();
    });

    it('still says "Nenhum modelo aprovado ainda." when the request succeeded with none', () => {
      queryState.thread = thread({ window: { open: false, expiresAt: null } });
      show();
      expect(screen.getByText(/Nenhum modelo aprovado ainda/)).toBeTruthy();
    });
  });
});
