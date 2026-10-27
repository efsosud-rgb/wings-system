import type { DealWhatsApp, WaConversationItem, WaNewTarget } from '@wings/shared';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../api/client.js';
import { WhatsAppInboxPage, WhatsAppWaitingPage } from './WhatsAppInboxPage.js';

/**
 * CRM Vendas → WhatsApp as WhatsApp Web: the list with unread and status, the
 * open conversation (marked read), and "Nova conversa" with the template
 * notice, an existing deal and a new number.
 */

const { state } = vi.hoisted(() => ({
  state: {
    asked: [] as { filter: string; q: string }[],
    read: [] as string[],
    created: [] as unknown[],
    targets: [] as WaNewTarget[],
    permissions: { 'leads.whatsapp': 'all', 'leads.write': 'all' } as Record<string, string>,
    officialLive: false,
    // Overrides for what the two queries answer (a failed request, an empty list); reset per test.
    listQuery: {} as Record<string, unknown>,
    threadQuery: {} as Record<string, unknown>,
    targetsQuery: {} as Record<string, unknown>,
  },
}));

const rows: WaConversationItem[] = [
  {
    conversationId: 'c1',
    leadId: 'l1',
    leadName: 'Elena Prado',
    profileName: 'Elena',
    phone: '5521999990001',
    lastAt: new Date().toISOString(),
    lastDirection: 'in',
    preview: 'Oi, tudo bem?',
    unanswered: true,
    windowOpen: true,
    unreadCount: 2,
    lastStatus: null,
    attendance: 'waiting_seller',
    ownerName: 'Daniele',
  },
  {
    conversationId: 'c2',
    leadId: null,
    leadName: null,
    profileName: 'Carlos',
    phone: '5521988887777',
    lastAt: new Date().toISOString(),
    lastDirection: 'out',
    preview: 'Qual é o seu nome?',
    unanswered: false,
    windowOpen: true,
    unreadCount: 0,
    lastStatus: 'read',
    attendance: 'sofia',
    ownerName: null,
  },
];

const thread: DealWhatsApp = {
  conversationId: 'c1',
  leadId: 'l1',
  profileName: 'Elena',
  configured: true,
  calling: false,
  phone: '5521999990001',
  window: { open: true, expiresAt: new Date(Date.now() + 3_600_000).toISOString() },
  optedOut: false,
  callPermission: { status: null, expiresAt: null, requestedAt: null },
  attendance: 'waiting_seller',
  speaksFor: null,
  messages: [
    {
      id: 'm1',
      direction: 'in',
      kind: 'text',
      text: 'Oi, tudo bem?',
      media: null,
      template: null,
      status: null,
      error: null,
      authorName: null,
      bySofia: false,
      imported: null,
      fromTemplate: null,
      withArt: false,
      at: new Date().toISOString(),
    },
  ],
};

vi.mock('../../api/auth.js', () => ({
  useSession: () => ({ data: { id: 'e1', role: 'admin_master', permissions: state.permissions } }),
  hasPermission: (session: { permissions: Record<string, string> } | undefined, key: string) =>
    Boolean(session?.permissions[key]),
  permissionScope: (session: { permissions: Record<string, string> } | undefined, key: string) =>
    session?.permissions[key],
}));

vi.mock('../../api/whatsapp.js', () => ({
  useOfficialNumber: () => ({ data: { live: state.officialLive } }),
  useSetOfficialNumber: () => ({ mutate: vi.fn(), isPending: false, isError: false }),
  useWhatsAppInbox: (filter: string, q: string) => {
    state.asked.push({ filter, q });
    return {
      isLoading: false,
      isError: false,
      isSuccess: true,
      data: { conversations: rows },
      ...state.listQuery,
    };
  },
  useWhatsAppConversation: (id: string | undefined) => ({
    isLoading: false,
    isError: false,
    data: id === 'c1' ? thread : undefined,
    ...state.threadQuery,
  }),
  useMarkWhatsAppRead: () => ({ mutate: (id: string) => state.read.push(id) }),
  useWhatsAppTargets: (q: string) => ({
    isFetching: false,
    isError: false,
    isSuccess: q.trim().length >= 2,
    data: { targets: q.length >= 2 ? state.targets : [] },
    ...state.targetsQuery,
  }),
}));

vi.mock('../../api/leads.js', () => ({
  useCreateLead: () => ({
    isPending: false,
    error: null,
    mutate: (input: unknown, opts: { onSuccess: (data: { lead: { id: string } }) => void }) => {
      state.created.push(input);
      opts.onSuccess({ lead: { id: 'l9' } });
    },
  }),
}));

vi.mock('./WhatsAppChat.js', () => ({
  WhatsAppChat: ({ thread: t }: { thread: { leadId?: string; conversationId?: string } }) => (
    <div data-testid="chat">
      {t.leadId ? `deal:${t.leadId}` : `conversation:${t.conversationId}`}
    </div>
  ),
}));

beforeEach(() => {
  state.asked.length = 0;
  state.read.length = 0;
  state.created.length = 0;
  state.targets = [];
  state.permissions = { 'leads.whatsapp': 'all', 'leads.write': 'all' };
  state.officialLive = false;
  state.listQuery = {};
  state.threadQuery = {};
  state.targetsQuery = {};
});
afterEach(cleanup);

function renderAt(path: string) {
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/crm-vendas/whatsapp" element={<WhatsAppInboxPage />} />
        <Route path="/crm-vendas/whatsapp/:id" element={<WhatsAppWaitingPage />} />
        <Route path="/crm-vendas/negociacoes/:id/whatsapp" element={<p>aba da negociação</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('the WhatsApp screen', () => {
  it('lists conversations with unread counts, status and Sofia’s ones marked', () => {
    renderAt('/crm-vendas/whatsapp');
    const elena = screen.getByRole('link', { name: /Elena Prado/ });
    expect(elena.getAttribute('href')).toBe('/crm-vendas/whatsapp/c1');
    expect(screen.getByLabelText('2 não lidas')).toBeTruthy();
    const carlos = screen.getByRole('link', { name: /Carlos/ });
    expect(carlos.textContent).toContain('Sofia atendendo');
    expect(screen.getByLabelText('Lida')).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: 'Não lidas' }));
    expect(state.asked.at(-1)?.filter).toBe('unread');
    expect(screen.getByText(/Escolha uma conversa/)).toBeTruthy();
  });

  it('opens a deal’s conversation on the right, sends in that conversation and marks it read', async () => {
    renderAt('/crm-vendas/whatsapp/c1');
    expect(screen.getByTestId('chat').textContent).toBe('conversation:c1');
    expect(screen.getByRole('link', { name: 'Abrir negociação' }).getAttribute('href')).toBe(
      '/crm-vendas/negociacoes/l1',
    );
    await waitFor(() => expect(state.read).toEqual(['c1']));
  });

  it('"Nova conversa" warns about the template and opens an existing deal', () => {
    state.targets = [
      {
        leadId: 'l5',
        name: 'Patrícia',
        phone: '5521977776666',
        contactName: null,
        pipeline: 'formatacao',
        ownerName: 'Luana',
        open: true,
        conversationId: null,
      },
    ];
    renderAt('/crm-vendas/whatsapp');
    fireEvent.click(screen.getByRole('button', { name: 'Nova conversa' }));
    expect(screen.getByRole('dialog').textContent).toContain('modelo aprovado pela Meta');
    fireEvent.change(screen.getByPlaceholderText('Nome, telefone ou contato'), {
      target: { value: 'Patr' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Patrícia/ }));
    expect(screen.getByText('aba da negociação')).toBeTruthy();
  });

  it('a new number becomes a deal by the manual rule and opens its conversation', () => {
    renderAt('/crm-vendas/whatsapp');
    fireEvent.click(screen.getByRole('button', { name: 'Nova conversa' }));
    fireEvent.change(screen.getByPlaceholderText('Nome, telefone ou contato'), {
      target: { value: '21 98765-4321' },
    });
    fireEvent.change(screen.getByLabelText('Nome da pessoa'), { target: { value: 'João Reis' } });
    fireEvent.click(screen.getByRole('button', { name: 'Criar negociação e abrir a conversa' }));
    expect(state.created).toEqual([
      expect.objectContaining({ name: 'João Reis', phone: '21987654321', pipeline: 'formatacao' }),
    ]);
    expect(screen.getByText('aba da negociação')).toBeTruthy();
  });

  it('without leads.write a new number only says who can register it', () => {
    state.permissions = { 'leads.whatsapp': 'all' };
    renderAt('/crm-vendas/whatsapp');
    fireEvent.click(screen.getByRole('button', { name: 'Nova conversa' }));
    fireEvent.change(screen.getByPlaceholderText('Nome, telefone ou contato'), {
      target: { value: '21987654321' },
    });
    expect(screen.queryByRole('button', { name: /Criar negociação/ })).toBeNull();
    expect(screen.getByText(/precisa cadastrá-lo antes/)).toBeTruthy();
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

  it('the list says why, not "Nenhuma conversa ainda."', () => {
    state.listQuery = failed(new ApiError(500, {}));
    renderAt('/crm-vendas/whatsapp');
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('Não foi possível carregar as conversas');
    expect(alert.textContent).toContain('erro 500');
    expect(screen.queryByText(/Nenhuma conversa/)).toBeNull();
  });

  it('the "Não lidas" and "Sem resposta" tabs do not say "nothing waiting" when the request failed', () => {
    state.listQuery = failed(new ApiError(401, {}));
    renderAt('/crm-vendas/whatsapp');
    fireEvent.click(screen.getByRole('tab', { name: 'Não lidas' }));
    expect(screen.queryByText('Nenhuma conversa com mensagem não lida.')).toBeNull();
    fireEvent.click(screen.getByRole('tab', { name: 'Sem resposta' }));
    expect(screen.queryByText('Nenhuma conversa esperando resposta.')).toBeNull();
    expect(screen.getByRole('alert').textContent).toContain('sua sessão expirou');
  });

  it('the list still says "Nenhuma conversa esperando resposta." when it succeeded empty', () => {
    state.listQuery = { data: { conversations: [] } };
    renderAt('/crm-vendas/whatsapp');
    fireEvent.click(screen.getByRole('tab', { name: 'Sem resposta' }));
    expect(screen.getByText('Nenhuma conversa esperando resposta.')).toBeTruthy();
  });

  it('keeps the rows it had and adds the reason when only a refresh failed', () => {
    state.listQuery = { isError: true, isSuccess: false, error: new TypeError('x') };
    renderAt('/crm-vendas/whatsapp');
    expect(screen.getByRole('alert').textContent).toContain('sem conexão com o servidor');
    expect(screen.getByRole('link', { name: /Elena Prado/ })).toBeTruthy();
  });

  it('an open conversation that did not load says why, not "não encontrada"', () => {
    state.threadQuery = failed(new ApiError(500, {}));
    renderAt('/crm-vendas/whatsapp/c1');
    expect(screen.getByRole('alert').textContent).toContain('Não foi possível carregar a conversa');
    expect(screen.queryByText(/não encontrada/)).toBeNull();
    expect(screen.getByRole('link', { name: 'Voltar às conversas' })).toBeTruthy();
  });

  it('an unknown conversation (no error, no data) still reads "não encontrada"', () => {
    renderAt('/crm-vendas/whatsapp/zzz');
    expect(screen.getByText(/Conversa não encontrada/)).toBeTruthy();
  });

  it('a failed search for a typed number says why, and offers no "create a deal"', () => {
    state.targetsQuery = failed(new ApiError(500, {}));
    renderAt('/crm-vendas/whatsapp');
    fireEvent.click(screen.getByRole('button', { name: 'Nova conversa' }));
    fireEvent.change(screen.getByPlaceholderText('Nome, telefone ou contato'), {
      target: { value: '21 98765-4321' },
    });
    const dialog = within(screen.getByRole('dialog'));
    expect(dialog.getByRole('alert').textContent).toContain('Não foi possível carregar a busca');
    expect(dialog.queryByText(/Nenhuma negociação com/)).toBeNull();
    expect(dialog.queryByRole('button', { name: /Criar negociação/ })).toBeNull();
  });

  it('a failed search by name says why, not "Nada encontrado nas suas negociações."', () => {
    state.targetsQuery = failed(new TypeError('x'));
    renderAt('/crm-vendas/whatsapp');
    fireEvent.click(screen.getByRole('button', { name: 'Nova conversa' }));
    fireEvent.change(screen.getByPlaceholderText('Nome, telefone ou contato'), {
      target: { value: 'Patr' },
    });
    const dialog = within(screen.getByRole('dialog'));
    expect(dialog.getByRole('alert').textContent).toContain('sem conexão com o servidor');
    expect(dialog.queryByText(/Nada encontrado/)).toBeNull();
  });

  it('a search that answered with nobody still says "Nada encontrado nas suas negociações."', () => {
    renderAt('/crm-vendas/whatsapp');
    fireEvent.click(screen.getByRole('button', { name: 'Nova conversa' }));
    fireEvent.change(screen.getByPlaceholderText('Nome, telefone ou contato'), {
      target: { value: 'Patr' },
    });
    expect(screen.getByText('Nada encontrado nas suas negociações.')).toBeTruthy();
  });
});

describe('before the swap of the number (Eric, 14/10)', () => {
  const notice = /O WhatsApp do sistema começa a funcionar depois da troca do número/;

  it('tells a seller to use the phone and switches "Nova conversa" off', () => {
    state.permissions = { 'leads.whatsapp': 'own', 'leads.write': 'own' };
    renderAt('/crm-vendas/whatsapp');
    expect(screen.getByRole('status').textContent).toMatch(notice);
    expect(screen.getByRole('button', { name: 'Nova conversa' }).hasAttribute('disabled')).toBe(
      true,
    );
  });

  it('opens it for the seller once the official number is live, with no deploy', () => {
    state.permissions = { 'leads.whatsapp': 'own', 'leads.write': 'own' };
    state.officialLive = true;
    renderAt('/crm-vendas/whatsapp');
    expect(screen.queryByText(notice)).toBeNull();
    expect(screen.getByRole('button', { name: 'Nova conversa' }).hasAttribute('disabled')).toBe(
      false,
    );
  });

  it('changes nothing for the other levels', () => {
    state.permissions = { 'leads.whatsapp': 'all', 'leads.write': 'all' };
    renderAt('/crm-vendas/whatsapp');
    expect(screen.queryByText(notice)).toBeNull();
    expect(screen.getByRole('button', { name: 'Nova conversa' }).hasAttribute('disabled')).toBe(
      false,
    );
  });
});

describe('the "Importar em lote" link', () => {
  it('opens the lote import page for someone with whatsapp.import_bulk', () => {
    state.permissions = { 'leads.whatsapp': 'all', 'whatsapp.import_bulk': 'all' };
    renderAt('/crm-vendas/whatsapp');
    expect(screen.getByRole('link', { name: 'Importar em lote' }).getAttribute('href')).toBe(
      '/crm-vendas/whatsapp/importar-lote',
    );
  });

  it.each([
    ['a seller', { 'leads.whatsapp': 'own', 'leads.write': 'own' }],
    ['someone who sees every conversation but may not import in bulk', { 'leads.whatsapp': 'all' }],
  ])('is not shown to %s', (_who, permissions) => {
    state.permissions = permissions;
    renderAt('/crm-vendas/whatsapp');
    expect(screen.queryByRole('link', { name: 'Importar em lote' })).toBeNull();
  });
});
