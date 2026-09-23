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
  active: true, expansionArea: [],
};
const WINGS: Client = {
  id: WINGS_CLIENT_ID,
  name: 'Wings Company',
  slug: 'wings-company',
  active: true, expansionArea: [],
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
  get.mockReset().mockImplementation(async (path: string) => {
    if (path === '/clients') return { clients: [WINGS, AURORA] };
    if (path === '/leads/source-rules') return { rules: [] };
    if (path.endsWith('/tracking-links')) return { links: [], phoneConfigured: true };
    throw new Error(`unexpected GET ${path}`);
  });
  post.mockReset();
  patch.mockReset();
});
afterEach(cleanup);

describe('Administração → Clientes', () => {
  it('lists Wings Company as the fixed default, with nothing to click on its row', async () => {
    renderPage();
    const wings = (await screen.findByRole('cell', { name: /Wings Company/ })).closest('tr') as HTMLElement;
    expect(within(wings).getByText('padrão')).toBeTruthy();
    expect(within(wings).queryByRole('button')).toBeNull();

    const aurora = screen.getByRole('cell', { name: 'Padaria Aurora' }).closest('tr') as HTMLElement;
    expect(within(aurora).getByRole('button', { name: 'Renomear' })).toBeTruthy();
    expect(within(aurora).getByRole('button', { name: 'Desativar' })).toBeTruthy();
  });

  it('registers a client by name, and says so when the name is taken', async () => {
    post.mockRejectedValueOnce(
      new ApiError(409, { error: 'client_exists', message: 'Já existe um cliente com este nome.' }),
    );
    renderPage();
    await screen.findByRole('cell', { name: 'Padaria Aurora' });
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
  it('opens the client\'s links and expansion area, generates a wa.me link and saves the area', async () => {
    get.mockImplementation(async (path: string) => {
      if (path === '/clients') return { clients: [WINGS, AURORA] };
      if (path === '/leads/source-rules') return { rules: [] };
      if (path === `/clients/${AURORA.id}/tracking-links`) {
        return {
          links: [
            {
              id: 'l1',
              clientId: AURORA.id,
              channel: 'instagram',
              code: 'K7M2QX',
              phone: '5511999990000',
              url: 'https://wa.me/5511999990000?text=K7M2QX',
              hits: 3,
              lastHitAt: null,
              createdAt: '2026-09-23T12:00:00Z',
            },
          ],
          phoneConfigured: true,
        };
      }
      throw new Error(`unexpected GET ${path}`);
    });
    post.mockResolvedValue({ link: { id: 'l2', url: 'https://wa.me/5511999990000?text=ABCDEF' } });
    patch.mockResolvedValue({ client: { ...AURORA, expansionArea: [{ uf: 'SP', city: 'Campinas' }] } });
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Links e expansão' }));

    // The existing link is on screen with its hits, and a new one is asked for the chosen channel.
    expect(await screen.findByText('https://wa.me/5511999990000?text=K7M2QX')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Canal do novo link de Padaria Aurora'), { target: { value: 'linktree' } });
    fireEvent.click(screen.getByRole('button', { name: 'Gerar link' }));
    await waitFor(() => expect(post).toHaveBeenCalledWith(`/clients/${AURORA.id}/tracking-links`, { channel: 'linktree' }));

    fireEvent.change(screen.getByLabelText('Área de expansão de Padaria Aurora'), { target: { value: 'SP, Campinas/SP' } });
    fireEvent.click(screen.getByRole('button', { name: 'Salvar área' }));
    await waitFor(() =>
      expect(patch).toHaveBeenCalledWith(`/clients/${AURORA.id}/expansion-area`, { expansionArea: ['SP', 'Campinas/SP'] }),
    );
    expect(await screen.findByText('Área salva.')).toBeTruthy();
  });

  it('adds a source rule for a landing page', async () => {
    post.mockResolvedValue({ rule: { id: 'r1' } });
    renderPage();
    await screen.findByRole('cell', { name: 'Padaria Aurora' });
    const submit = screen.getByRole('button', { name: 'Adicionar regra' });
    expect(submit).toHaveProperty('disabled', true);
    fireEvent.change(screen.getByLabelText('Padrão'), { target: { value: 'padaria-aurora' } });
    fireEvent.change(screen.getByLabelText('Cliente'), { target: { value: AURORA.id } });
    fireEvent.click(submit);
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith('/leads/source-rules', { kind: 'landing_page', pattern: 'padaria-aurora', clientId: AURORA.id }),
    );
  });
});
