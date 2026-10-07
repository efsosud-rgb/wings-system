import type { DealWhatsApp, WaConversationItem, WaNewTarget } from '@wings/shared';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
      at: new Date().toISOString(),
    },
  ],
};

vi.mock('../../api/auth.js', () => ({
  useSession: () => ({ data: { id: 'e1', role: 'admin_master', permissions: state.permissions } }),
  hasPermission: (session: { permissions: Record<string, string> } | undefined, key: string) =>
    Boolean(session?.permissions[key]),
}));

vi.mock('../../api/whatsapp.js', () => ({
  useWhatsAppInbox: (filter: string, q: string) => {
    state.asked.push({ filter, q });
    return { isLoading: false, isError: false, data: { conversations: rows } };
  },
  useWhatsAppConversation: (id: string | undefined) => ({
    isLoading: false,
    isError: false,
    data: id === 'c1' ? thread : undefined,
  }),
  useMarkWhatsAppRead: () => ({ mutate: (id: string) => state.read.push(id) }),
  useWhatsAppTargets: (q: string) => ({
    isFetching: false,
    data: { targets: q.length >= 2 ? state.targets : [] },
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
