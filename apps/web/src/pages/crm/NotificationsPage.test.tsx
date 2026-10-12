import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../api/client.js';
import { NotificationsPage } from './NotificationsPage.js';

const mutate = vi.fn();
const refetch = vi.fn();
// What the next render of useNotifications answers: set per test, defaults to the loaded list.
let query: Record<string, unknown> = {};
vi.mock('../../api/automations.js', () => ({
  useNotifications: () => query,
  useMarkNotificationsRead: () => ({ mutate, isPending: false }),
}));

const loaded = {
  isLoading: false,
  isError: false,
  isSuccess: true,
  refetch,
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
};

afterEach(() => {
  cleanup();
  refetch.mockReset();
});

describe('Avisos', () => {
  it('lists the notices with a link to the deal and a way to mark them read', () => {
    query = loaded;
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

  it('says why, and not "Nenhum aviso" or "0 não lidos", when the request failed', () => {
    query = {
      isLoading: false,
      isError: true,
      isSuccess: false,
      error: new ApiError(500, {}),
      data: undefined,
      refetch,
    };
    render(
      <MemoryRouter>
        <NotificationsPage />
      </MemoryRouter>,
    );
    expect(screen.getByRole('alert').textContent).toContain('Não foi possível carregar os avisos');
    expect(screen.getByRole('alert').textContent).toContain('erro 500');
    expect(screen.queryByText(/Nenhum aviso/)).toBeNull();
    expect(screen.queryByText(/0 não lidos/)).toBeNull();
    expect(screen.getByRole('button', { name: 'Marcar todos como lidos' })).toHaveProperty(
      'disabled',
      true,
    );
  });

  it('shows neither the empty text nor a zero while it loads', () => {
    query = { isLoading: true, isError: false, isSuccess: false, data: undefined, refetch };
    render(
      <MemoryRouter>
        <NotificationsPage />
      </MemoryRouter>,
    );
    expect(screen.getByText('Carregando…')).toBeTruthy();
    expect(screen.queryByText(/Nenhum aviso/)).toBeNull();
    expect(screen.queryByText(/0 não lidos/)).toBeNull();
  });

  it('keeps the earlier notices and adds the failure line when a refresh failed', () => {
    query = { ...loaded, isError: true, isSuccess: false, error: new TypeError('x') };
    render(
      <MemoryRouter>
        <NotificationsPage />
      </MemoryRouter>,
    );
    expect(screen.getByRole('alert').textContent).toContain('sem conexão com o servidor');
    expect(screen.getByText('Primeiro contato atrasado: passou da 1 hora útil.')).toBeTruthy();
  });

  it('still says "Nenhum aviso" when the request succeeded with nothing', () => {
    query = { ...loaded, data: { unread: 0, notifications: [] } };
    render(
      <MemoryRouter>
        <NotificationsPage />
      </MemoryRouter>,
    );
    expect(screen.getByText(/Nenhum aviso/)).toBeTruthy();
    expect(screen.getByText('0 não lidos')).toBeTruthy();
  });
});
