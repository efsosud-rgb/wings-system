import type { WaConversationItem } from '@wings/shared';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WhatsAppInboxPage } from './WhatsAppInboxPage.js';

/** CRM Vendas → WhatsApp: waiting conversations first, a deal's opens on the deal. */

const { asked } = vi.hoisted(() => ({ asked: [] as boolean[] }));

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
  },
  {
    conversationId: 'c2',
    leadId: null,
    leadName: null,
    profileName: 'Carlos',
    phone: '5521988887777',
    lastAt: new Date().toISOString(),
    lastDirection: 'out',
    preview: 'Bom dia',
    unanswered: false,
    windowOpen: true,
  },
];

vi.mock('../../api/whatsapp.js', () => ({
  useWhatsAppConversations: (unanswered: boolean) => {
    asked.push(unanswered);
    return { isLoading: false, isError: false, data: { conversations: rows } };
  },
  useWhatsAppThread: () => ({ isLoading: true }),
}));

afterEach(cleanup);

describe('the WhatsApp inbox', () => {
  it('lists the conversations, linking a deal to its page and a waiting one to its own', () => {
    render(
      <MemoryRouter>
        <WhatsAppInboxPage />
      </MemoryRouter>,
    );
    expect(asked.at(-1)).toBe(true);
    expect(screen.getByRole('link', { name: /Elena Prado/ }).getAttribute('href')).toBe(
      '/crm-vendas/negociacoes/l1/whatsapp',
    );
    const waiting = screen.getByRole('link', { name: /Carlos/ });
    expect(waiting.getAttribute('href')).toBe('/crm-vendas/whatsapp/c2');
    expect(waiting.textContent).toContain('Sem negociação');
    expect(waiting.textContent).toContain('Você: Bom dia');
    fireEvent.click(screen.getByRole('tab', { name: 'Todas' }));
    expect(asked.at(-1)).toBe(false);
  });
});
