import { WINGS_CLIENT_ID, type Client } from '@wings/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const get = vi.fn();
const post = vi.fn();
const patch = vi.fn();
vi.mock('../api/client.js', async (original) => ({
  ...(await original<typeof import('../api/client.js')>()),
  api: {
    get: (path: string) => get(path),
    post: (path: string, body?: unknown) => post(path, body),
    patch: (path: string, body?: unknown) => patch(path, body),
  },
}));

const { ClientsPage } = await import('./ClientsPage.js');
const { ApiError } = await import('../api/client.js');

const AURORA: Client = {
  id: '11111111-1111-4111-8111-1111111111c2',
  name: 'Padaria Aurora',
  slug: 'padaria-aurora',
  active: true,
};
const WINGS: Client = {
  id: WINGS_CLIENT_ID,
  name: 'Wings Company',
  slug: 'wings-company',
  active: true,
};

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ClientsPage />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  get.mockReset().mockResolvedValue({ clients: [WINGS, AURORA] });
  post.mockReset();
  patch.mockReset();
});
afterEach(cleanup);

describe('Administração → Clientes', () => {
  it('lists Wings Company as the fixed default, with nothing to click on its row', async () => {
    renderPage();
    const wings = (await screen.findByText('Wings Company')).closest('tr') as HTMLElement;
    expect(within(wings).getByText('padrão')).toBeTruthy();
    expect(within(wings).queryByRole('button')).toBeNull();

    const aurora = screen.getByText('Padaria Aurora').closest('tr') as HTMLElement;
    expect(within(aurora).getByRole('button', { name: 'Renomear' })).toBeTruthy();
    expect(within(aurora).getByRole('button', { name: 'Desativar' })).toBeTruthy();
  });

  it('registers a client by name, and says so when the name is taken', async () => {
    post.mockRejectedValueOnce(
      new ApiError(409, { error: 'client_exists', message: 'Já existe um cliente com este nome.' }),
    );
    renderPage();
    await screen.findByText('Padaria Aurora');
    const submit = screen.getByRole('button', { name: 'Cadastrar cliente' });
    expect(submit).toHaveProperty('disabled', true);

    fireEvent.change(screen.getByLabelText('Novo cliente'), {
      target: { value: 'Padaria Aurora' },
    });
    fireEvent.click(submit);
    await waitFor(() => expect(post).toHaveBeenCalledWith('/clients', { name: 'Padaria Aurora' }));
    expect(await screen.findByText('Já existe um cliente com este nome.')).toBeTruthy();
  });

  it('deactivates a client with one click', async () => {
    patch.mockResolvedValue({ client: { ...AURORA, active: false } });
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Desativar' }));
    await waitFor(() =>
      expect(patch).toHaveBeenCalledWith(`/clients/${AURORA.id}`, {
        name: undefined,
        active: false,
      }),
    );
  });
});
