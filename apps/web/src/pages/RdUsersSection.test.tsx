import type { SessionUser } from '@wings/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const get = vi.fn();
const put = vi.fn();
vi.mock('../api/client.js', async (original) => ({
  ...(await original<typeof import('../api/client.js')>()),
  api: {
    get: (path: string) => get(path),
    put: (path: string, body?: unknown) => put(path, body),
  },
}));

const { RdUsersSection } = await import('./IntegrationsPage.js');

const admin: SessionUser = {
  employeeId: 'e1',
  fullName: 'Gerente',
  email: 'g@wingscompany.com.br',
  cargo: 'Gerente',
  role: 'admin_master',
  sector: 'comercial',
  isSectorManager: false,
  tracksTime: false,
  permissions: { 'integrations.manage': 'all' },
  lastLoginAt: null,
  sessionExpiresAt: '2026-09-23T23:00:00Z',
};

beforeEach(() => {
  get.mockReset().mockImplementation(async (path: string) => {
    if (path === '/auth/me') return { user: admin };
    if (path === '/leads/rd-users')
      return {
        users: [
          {
            rdUserId: 'u1',
            rdName: 'Fernando RD',
            rdActive: true,
            employeeId: null,
            employeeName: null,
          },
          {
            rdUserId: 'u2',
            rdName: 'Antigo',
            rdActive: false,
            employeeId: 'e2',
            employeeName: 'Antigo Func',
          },
        ],
        employees: [
          { id: 'e1', name: 'Fernando Func' },
          { id: 'e2', name: 'Antigo Func' },
        ],
      };
    throw new Error(`unexpected GET ${path}`);
  });
  put.mockReset().mockResolvedValue({ ok: true });
});
afterEach(cleanup);

describe('Integrações → Usuários do RD CRM', () => {
  it('lists the RD users, marks the inactive ones, and links one to an employee', async () => {
    render(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <RdUsersSection />
      </QueryClientProvider>,
    );
    const select = await screen.findByLabelText('Funcionário de Fernando RD');
    expect(screen.getByText('inativo no RD')).toBeTruthy();
    fireEvent.change(select, { target: { value: 'e1' } });
    await waitFor(() =>
      expect(put).toHaveBeenCalledWith('/leads/rd-users/u1', { employeeId: 'e1' }),
    );
  });
});
