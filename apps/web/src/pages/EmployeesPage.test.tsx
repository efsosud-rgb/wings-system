import type { SessionUser } from '@wings/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const get = vi.fn();
vi.mock('../api/client.js', async (original) => ({
  ...(await original<typeof import('../api/client.js')>()),
  api: { get: (path: string) => get(path) },
}));
vi.mock('../api/auth.js', () => ({
  useSession: () => ({ data: { permissions: {} } as unknown as SessionUser }),
  hasPermission: () => false,
}));

const { EmployeesPage } = await import('./EmployeesPage.js');
const { ApiError } = await import('../api/client.js');

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <EmployeesPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  get.mockReset();
});
afterEach(cleanup);

describe('Usuários e acessos', () => {
  it('says "—" and why when the list failed, never "Nenhum funcionário" or "0 funcionários"', async () => {
    get.mockRejectedValue(new ApiError(500, {}));
    renderPage();

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(
      /Não foi possível carregar os funcionários: o servidor teve um problema \(erro 500\)/,
    );
    expect(screen.queryByText('Nenhum funcionário encontrado.')).toBeNull();
    expect(screen.queryByText(/^0 funcionários/)).toBeNull();
    // The headline carries the dash and the reason in place of the count.
    expect(
      screen.getByRole('heading', { name: 'Usuários e acessos' }).parentElement?.textContent,
    ).toMatch(/Funcionários no seu escopo de acesso:\s*—\s*o servidor teve um problema/);

    get.mockReset().mockResolvedValue({ employees: [], total: 0, page: 1, pageSize: 20 });
    fireEvent.click(screen.getByRole('button', { name: 'Tentar de novo' }));
    expect(await screen.findByText('Nenhum funcionário encontrado.')).toBeTruthy();
  });

  it('does not show a count or an empty list while the first answer is still coming', () => {
    get.mockReturnValue(new Promise(() => undefined));
    renderPage();
    expect(screen.getByText('Carregando…')).toBeTruthy();
    expect(screen.queryByText('Nenhum funcionário encontrado.')).toBeNull();
    expect(screen.queryByText(/^0 funcionários/)).toBeNull();
  });

  it('says "Nenhum funcionário encontrado." only for an answer with no one in it', async () => {
    get.mockResolvedValue({ employees: [], total: 0, page: 1, pageSize: 20 });
    renderPage();
    expect(await screen.findByText('Nenhum funcionário encontrado.')).toBeTruthy();
    await waitFor(() =>
      expect(screen.getByText('0 funcionários no seu escopo de acesso')).toBeTruthy(),
    );
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
