import {
  SOFIA_DEFAULT_SETTINGS,
  type DealWhatsApp,
  type SofiaConversationDetail,
  type SofiaConversationItem,
  type SofiaOverview,
  type SofiaSettings,
} from '@wings/shared';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../api/client.js';
import type { SofiaFilter } from '../../api/sofia.js';
import { SofiaPage } from './SofiaPage.js';
import { keyFromLabel } from './SofiaSettingsForm.js';

/**
 * Sofia's screen: the list with who has each conversation, the open one with
 * what she found out and its deal, taking and giving back, and her settings —
 * checked by the same schema as the server before saving, read-only without
 * `sofia.manage`. The API and the chat itself are simulated.
 */

const { state, attend, save, filters } = vi.hoisted(() => ({
  state: {
    overview: null as SofiaOverview | null,
    rows: [] as SofiaConversationItem[],
    detail: null as SofiaConversationDetail | null,
    settings: null as SofiaSettings | null,
    // Overrides for what a query answers (a failed request); reset before every test.
    overviewQuery: {} as Record<string, unknown>,
    listQuery: {} as Record<string, unknown>,
    detailQuery: {} as Record<string, unknown>,
    settingsQuery: {} as Record<string, unknown>,
  },
  attend: vi.fn(),
  save: vi.fn(),
  filters: [] as SofiaFilter[],
}));

vi.mock('../../api/sofia.js', () => ({
  useSofiaOverview: () => ({
    isLoading: false,
    isError: false,
    data: state.overview,
    ...state.overviewQuery,
  }),
  useSofiaConversations: (filter: SofiaFilter) => {
    filters.push(filter);
    return {
      isLoading: false,
      isError: false,
      isSuccess: true,
      data: { conversations: state.rows },
      ...state.listQuery,
    };
  },
  useSofiaConversation: () => ({
    isLoading: false,
    isError: false,
    data: state.detail,
    ...state.detailQuery,
  }),
  useSofiaAttendance: () => ({ mutate: attend, isPending: false, error: null }),
  useSofiaSettings: () => ({
    isLoading: false,
    isError: false,
    data: { settings: state.settings, updatedAt: '2026-10-07T12:00:00.000Z', updatedBy: 'Eric' },
    ...state.settingsQuery,
  }),
  useSaveSofiaSettings: () => ({ mutate: save, reset: vi.fn(), isPending: false, error: null }),
}));

vi.mock('../../api/auth.js', async () => {
  const actual = await vi.importActual<typeof import('../../api/auth.js')>('../../api/auth.js');
  return {
    ...actual,
    useSession: () => ({
      data: {
        id: 'e1',
        fullName: 'Eric',
        role: 'admin_master',
        permissions: { 'leads.whatsapp': 'all', 'sofia.manage': 'all' },
      },
    }),
  };
});

vi.mock('../../api/whatsapp.js', () => ({
  useMarkWhatsAppRead: () => ({ mutate: () => undefined }),
}));

vi.mock('./WhatsAppChat.js', () => ({
  WhatsAppChat: ({ canSend }: { canSend: boolean }) => (
    <section aria-label="Conversa">{canSend ? 'chat com envio' : 'chat só leitura'}</section>
  ),
}));

const item = (over: Partial<SofiaConversationItem> = {}): SofiaConversationItem => ({
  conversationId: 'c1',
  leadId: 'l1',
  leadName: 'Elena Prado',
  profileName: 'Elena',
  phone: '5521999990001',
  lastAt: new Date().toISOString(),
  lastDirection: 'in',
  preview: 'Quero abrir uma franquia',
  unanswered: true,
  windowOpen: true,
  unreadCount: 2,
  lastStatus: null,
  attendance: 'waiting_seller',
  ownerName: 'Fernando',
  holderId: 'e2',
  holderName: 'Fernando',
  queue: null,
  number: null,
  state: 'waiting_seller',
  segment: 'expansao',
  brandName: 'Casa do Churros',
  stateChangedAt: new Date().toISOString(),
  reason: null,
  ...over,
});

const thread: DealWhatsApp = {
  conversationId: 'c1',
  leadId: 'l1',
  profileName: 'Elena',
  configured: true,
  calling: false,
  phone: '5521999990001',
  window: { open: true, expiresAt: new Date(Date.now() + 3_600_000).toISOString() },
  optedOut: false,
  contactBlock: { blocked: false, reason: null, origin: null },
  callBlock: { blocked: false, reason: null, origin: null },
  callPermission: { status: null, expiresAt: null, requestedAt: null },
  attendance: 'waiting_seller',
  speaksFor: 'Casa do Churros',
  number: null,
  numberChats: [],
  messages: [],
};

const overview = (over: Partial<SofiaOverview> = {}): SofiaOverview => ({
  enabled: true,
  whatsappConfigured: true,
  aiConfigured: true,
  model: 'deepseek/deepseek-v4-flash',
  dailyUsd: 2,
  spentTodayUsd: 0.125,
  counts: { sofia: 3, waiting_seller: 1, waiting_human: 2, with_person: 4, closed: 5 },
  canManage: true,
  ...over,
});

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/crm-vendas/sofia" element={<SofiaPage />} />
        <Route path="/crm-vendas/sofia/:id" element={<SofiaPage />} />
        <Route path="/crm-vendas/negociacoes/:id" element={<p>página da negociação</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  attend.mockReset();
  save.mockReset();
  filters.length = 0;
  state.overviewQuery = {};
  state.listQuery = {};
  state.detailQuery = {};
  state.settingsQuery = {};
  state.overview = overview();
  state.rows = [
    item(),
    item({
      conversationId: 'c2',
      leadId: null,
      leadName: null,
      profileName: null,
      phone: '5511988887777',
      preview: 'Sou fornecedor',
      unreadCount: 0,
      ownerName: null,
      state: 'waiting_human',
      attendance: 'waiting_human',
      segment: 'outro',
      brandName: null,
      reason: 'Fornecedor ou parceria',
    }),
  ];
  state.detail = {
    item: item(),
    facts: [
      { key: 'nome', label: 'Nome', answer: 'Elena Prado' },
      { key: 'cidade', label: 'Cidade de interesse', answer: 'Niterói, RJ' },
    ],
    origin: { code: 'CDC-IG', adHeadline: null, adId: null },
    lead: {
      id: 'l1',
      name: 'Elena Prado',
      pipeline: 'expansao',
      stage: 'Qualificação',
      ownerName: 'Fernando',
    },
    thread,
    can: { take: true, giveBack: true, close: true },
  };
  state.settings = structuredClone(SOFIA_DEFAULT_SETTINGS);
});
afterEach(cleanup);

describe('the conversation list', () => {
  it('shows the state chips with their counts and the rows, and filters by state', () => {
    renderAt('/crm-vendas/sofia');
    expect(screen.getByText('Ligada')).toBeTruthy();
    expect(screen.getByText('IA: US$ 0,13 de US$ 2,00 hoje')).toBeTruthy();
    const chips = within(screen.getByRole('group', { name: 'Quem atende' }));
    expect(chips.getByRole('button', { name: /^Todas\s*15$/ })).toBeTruthy();
    expect(chips.getByRole('button', { name: /^Sofia atendendo\s*3$/ })).toBeTruthy();
    expect(chips.getByRole('button', { name: /^Aguardando atendente\s*2$/ })).toBeTruthy();
    expect(chips.getByRole('button', { name: /^Encerradas\s*5$/ })).toBeTruthy();

    const elena = screen.getByRole('link', { name: /Elena Prado/ });
    expect(elena.getAttribute('href')).toBe('/crm-vendas/sofia/c1');
    expect(elena.textContent).toContain('Aguardando vendedor');
    expect(elena.textContent).toContain('Expansão · Casa do Churros');
    expect(elena.textContent).toContain('Quero abrir uma franquia');
    expect(elena.textContent).toContain('Fernando');
    // No name anywhere: the phone, and the reason Sofia passed it on.
    const supplier = screen.getByRole('link', { name: /\(11\) 98888-7777/ });
    expect(supplier.textContent).toContain('Fornecedor ou parceria');

    fireEvent.click(chips.getByRole('button', { name: /^Aguardando atendente/ }));
    expect(filters.at(-1)).toMatchObject({ state: 'waiting_human' });
    fireEvent.change(screen.getByRole('combobox', { name: 'Funil' }), {
      target: { value: 'none' },
    });
    expect(filters.at(-1)).toMatchObject({ state: 'waiting_human', segment: 'none' });
  });

  it('warns when the WhatsApp or the AI key is missing on the server', () => {
    state.overview = overview({ enabled: false, whatsappConfigured: false, aiConfigured: false });
    renderAt('/crm-vendas/sofia');
    expect(screen.getByText('Desligada')).toBeTruthy();
    expect(screen.getByText(/O WhatsApp oficial ainda não está ligado/)).toBeTruthy();
    expect(screen.getByText(/A chave da IA não está configurada/)).toBeTruthy();
  });
});

describe('an open conversation', () => {
  it('opens from the list with what Sofia found out, the origin and the deal link', () => {
    renderAt('/crm-vendas/sofia');
    fireEvent.click(screen.getByRole('link', { name: /Elena Prado/ }));
    const facts = within(screen.getByRole('region', { name: 'O que a Sofia descobriu' }));
    expect(facts.getByText('Cidade de interesse')).toBeTruthy();
    expect(facts.getByText('Niterói, RJ')).toBeTruthy();
    expect(within(screen.getByRole('region', { name: 'Origem' })).getByText('CDC-IG')).toBeTruthy();
    const deal = within(screen.getByRole('region', { name: 'Negociação' }));
    expect(deal.getByRole('link', { name: 'Elena Prado' }).getAttribute('href')).toBe(
      '/crm-vendas/negociacoes/l1',
    );
    expect(deal.getByText('Qualificação')).toBeTruthy();
    expect(screen.getByText('chat com envio')).toBeTruthy();
    expect(screen.getByText('Escrever na conversa tira a conversa da Sofia.')).toBeTruthy();
    expect(screen.getByRole('link', { name: '‹ Conversas' }).getAttribute('href')).toBe(
      '/crm-vendas/sofia',
    );
  });

  it('gives the conversation back to Sofia, and closes only after confirming', () => {
    renderAt('/crm-vendas/sofia/c1');
    fireEvent.click(screen.getByRole('button', { name: 'Devolver para a Sofia' }));
    expect(attend).toHaveBeenCalledWith('give_back');
    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false);
    fireEvent.click(screen.getByRole('button', { name: 'Encerrar' }));
    expect(attend).toHaveBeenCalledTimes(1);
    confirm.mockReturnValueOnce(true);
    fireEvent.click(screen.getByRole('button', { name: 'Encerrar' }));
    expect(attend).toHaveBeenLastCalledWith('close');
    confirm.mockRestore();
  });

  it('shows only the actions the server allows, and says when nothing was found out', () => {
    state.detail = {
      ...state.detail!,
      facts: [],
      origin: { code: null, adHeadline: null, adId: null },
      lead: null,
      can: { take: true, giveBack: false, close: true },
    };
    renderAt('/crm-vendas/sofia/c1');
    expect(screen.getByRole('button', { name: 'Assumir conversa' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Devolver para a Sofia' })).toBeNull();
    expect(screen.getByText('Ainda nada.')).toBeTruthy();
    expect(screen.getByText('Mensagem direta')).toBeTruthy();
    expect(screen.getByText(/Nenhuma negociação ainda/)).toBeTruthy();
  });
});

describe('the settings', () => {
  const openSettings = () => {
    renderAt('/crm-vendas/sofia');
    fireEvent.click(screen.getByRole('tab', { name: 'Configuração' }));
  };

  it('refuses a greeting that names Wings, then saves valid settings', () => {
    save.mockImplementation(
      (
        settings: SofiaSettings,
        options?: { onSuccess?: (r: { settings: SofiaSettings }) => void },
      ) => options?.onSuccess?.({ settings }),
    );
    openSettings();
    expect(screen.getByText(/Última alteração: .* por Eric/)).toBeTruthy();
    const greeting = screen.getByRole('textbox', { name: 'Apresentação' });
    fireEvent.change(greeting, {
      target: { value: 'Oi! Sou a Sofia, atendente virtual {quem}, da Wings.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Salvar' }));
    expect(save).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toMatch(/^Apresentação: Não escreva "Wings"/);

    fireEvent.change(greeting, {
      target: { value: 'Oi! Sou a Sofia, atendente virtual {quem}.' },
    });
    fireEvent.click(screen.getByRole('switch', { name: 'Sofia ligada' }));
    fireEvent.click(screen.getByRole('button', { name: 'Salvar' }));
    expect(save).toHaveBeenCalledTimes(1);
    const sent = save.mock.calls[0]![0] as SofiaSettings;
    expect(sent.texts.greeting).toBe('Oi! Sou a Sofia, atendente virtual {quem}.');
    expect(sent.enabled).toBe(!SOFIA_DEFAULT_SETTINGS.enabled);
    expect(sent.formatacao).toHaveLength(SOFIA_DEFAULT_SETTINGS.formatacao.length);
    expect(screen.getByRole('status').textContent).toBe('Salvo.');
  });

  it('adds a question whose key follows its label and stays unique', () => {
    openSettings();
    const expansao = within(screen.getByRole('region', { name: 'Perguntas de Expansão' }));
    fireEvent.click(expansao.getByRole('button', { name: 'Adicionar pergunta' }));
    const added = within(
      expansao.getByRole('listitem', {
        name: `Pergunta ${SOFIA_DEFAULT_SETTINGS.expansao.length + 1}`,
      }),
    );
    fireEvent.change(added.getByRole('textbox', { name: 'Nome na negociação' }), {
      target: { value: 'Cidade' },
    });
    expect(added.getByText(/chave: cidade_2/)).toBeTruthy();
    fireEvent.change(added.getByRole('combobox', { name: 'Tipo' }), {
      target: { value: 'choice' },
    });
    expect(added.getByText(/até 10 opções de até 24 caracteres/)).toBeTruthy();
  });

  it('keeps a half-edited form when the list is looked at in between', () => {
    openSettings();
    fireEvent.change(screen.getByRole('textbox', { name: 'Valores' }), {
      target: { value: 'Quem passa valores é o consultor.' },
    });
    fireEvent.click(screen.getByRole('tab', { name: 'Conversas' }));
    fireEvent.click(screen.getByRole('tab', { name: 'Configuração' }));
    expect((screen.getByRole('textbox', { name: 'Valores' }) as HTMLTextAreaElement).value).toBe(
      'Quem passa valores é o consultor.',
    );
  });

  it('is read-only without sofia.manage', () => {
    state.overview = overview({ canManage: false });
    openSettings();
    expect(screen.getByText(/só quem tem a permissão de configurar a Sofia altera/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Salvar' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Adicionar pergunta' })).toBeNull();
    expect(screen.getByRole('textbox', { name: 'Apresentação' }).matches(':disabled')).toBe(true);
  });
});

describe('question keys', () => {
  it('are lowercase ascii with underscores, unique and within the pattern', () => {
    expect(keyFromLabel('Faturamento anual (R$)', [])).toBe('faturamento_anual_r');
    expect(keyFromLabel('Cidade', ['cidade', 'cidade_2'])).toBe('cidade_3');
    expect(keyFromLabel('1º Ação', [])).toBe('acao');
    expect(keyFromLabel('', [])).toBe('pergunta');
    const long = keyFromLabel('x'.repeat(50), ['x'.repeat(31)]);
    expect(long).toMatch(/^[a-z][a-z0-9_]{1,30}$/);
    expect(long.endsWith('_2')).toBe(true);
  });
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

  it('the list says why, not "Nenhuma conversa com esses filtros."', () => {
    state.listQuery = failed(new ApiError(500, {}));
    renderAt('/crm-vendas/sofia');
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('Não foi possível carregar as conversas');
    expect(alert.textContent).toContain('erro 500');
    expect(screen.queryByText(/Nenhuma conversa com esses filtros/)).toBeNull();
  });

  it('the list still says "Nenhuma conversa com esses filtros." when it succeeded empty', () => {
    state.rows = [];
    renderAt('/crm-vendas/sofia');
    expect(screen.getByText('Nenhuma conversa com esses filtros.')).toBeTruthy();
  });

  it('the status and the chip counts show "—" and why when the overview failed, not zeros', () => {
    state.overview = null;
    state.overviewQuery = failed(new ApiError(401, {}));
    renderAt('/crm-vendas/sofia');
    expect(screen.queryByText('Desligada')).toBeNull();
    expect(screen.getByText(/Estado da Sofia/).textContent).toContain('sua sessão expirou');
    const chips = within(screen.getByRole('group', { name: 'Quem atende' }));
    expect(chips.getByRole('button', { name: /^Todas\s*—$/ })).toBeTruthy();
    expect(chips.queryByText('0')).toBeNull();
  });

  it('an open conversation that did not load says why, not "não encontrada"', () => {
    state.detail = null;
    state.detailQuery = failed(new TypeError('x'));
    renderAt('/crm-vendas/sofia/c1');
    const pane = within(screen.getByRole('region', { name: 'Conversa selecionada' }));
    expect(pane.getByRole('alert').textContent).toContain('sem conexão com o servidor');
    expect(pane.queryByText(/não encontrada/)).toBeNull();
  });

  it('a refresh that failed keeps the open conversation and adds the reason', () => {
    state.detailQuery = { isError: true, isSuccess: false, error: new ApiError(500, {}) };
    renderAt('/crm-vendas/sofia/c1');
    const pane = within(screen.getByRole('region', { name: 'Conversa selecionada' }));
    expect(pane.getByRole('alert').textContent).toContain('erro 500');
    expect(pane.getByText('Niterói, RJ')).toBeTruthy();
  });

  it('the settings that did not load show the reason and no form to save over them', () => {
    state.settingsQuery = failed(new ApiError(500, {}));
    renderAt('/crm-vendas/sofia');
    fireEvent.click(screen.getByRole('tab', { name: 'Configuração' }));
    expect(screen.getByRole('alert').textContent).toContain(
      'Não foi possível carregar a configuração da Sofia',
    );
    expect(screen.getByRole('alert').textContent).toContain('erro 500');
    expect(screen.queryByRole('button', { name: 'Salvar' })).toBeNull();
  });
});
