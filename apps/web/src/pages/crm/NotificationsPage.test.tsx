import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NotificationsPage } from './NotificationsPage.js';

const mutate = vi.fn();
vi.mock('../../api/automations.js', () => ({
  useNotifications: () => ({
    isLoading: false,
    data: {
      unread: 1,
      notifications: [
        {
          id: 'n1',
          kind: 'first_contact_overdue',
          message: 'Primeiro contato atrasado: passou da 1 hora útil.',
          leadId: 'l1',
          createdAt: new Date(Date.now() - 30 * 60_000).toISOString(),
          readAt: null,
        },
        {
          id: 'n2',
          kind: 'stage_stuck',
          message: 'Parado há mais de 7 dias na etapa Proposta',
          leadId: null,
          createdAt: new Date(Date.now() - 3 * 86_400_000).toISOString(),
          readAt: new Date().toISOString(),
        },
      ],
    },
  }),
  useMarkNotificationsRead: () => ({ mutate, isPending: false }),
}));

afterEach(cleanup);

describe('Avisos', () => {
  it('lists the notices with a link to the deal and a way to mark them read', () => {
    render(
      <MemoryRouter>
        <NotificationsPage />
      </MemoryRouter>,
    );
    expect(screen.getByText('1 não lidos')).toBeTruthy();
    expect(screen.getByText('Primeiro contato atrasado: passou da 1 hora útil.')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Abrir a negociação' }).getAttribute('href')).toBe(
      '/crm-vendas/negociacoes/l1',
    );
    expect(screen.getAllByRole('button', { name: 'Marcar como lido' })).toHaveLength(1);
  });
});
