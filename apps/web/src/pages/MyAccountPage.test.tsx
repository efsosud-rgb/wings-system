import type { GoogleWorkspaceStatus } from '@wings/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const get = vi.fn();
const post = vi.fn();
const del = vi.fn();

vi.mock('../api/client.js', async (original) => ({
  ...(await original<typeof import('../api/client.js')>()),
  api: {
    get: (path: string) => get(path),
    post: (path: string, body?: unknown) => post(path, body),
    delete: (path: string) => del(path),
  },
}));
vi.mock('../api/auth.js', () => ({
  useSession: () => ({
    data: { employeeId: 'e1', fullName: 'Daniele Vendas', email: 'daniele@wingscompany.com.br' },
  }),
}));

const { MyAccountPage } = await import('./MyAccountPage.js');

const status = (over: Partial<GoogleWorkspaceStatus> = {}): { status: GoogleWorkspaceStatus } => ({
  status: {
    configured: true,
    state: 'disconnected',
    email: null,
    scopes: [],
    calendars: { mine: null, wings: null },
    wingsCalendarConfigured: true,
    lastError: null,
    ...over,
  },
});

function renderPage(path = '/minha-conta') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <MyAccountPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  get.mockReset();
  post.mockReset();
  del.mockReset();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/**
 * The person's Google card: connect sends the browser to Google, Google's
 * return is read from the address, and the calendars tell what "Agendar" can do.
 */
describe('Minha conta — Google', () => {
  it('sends the browser to the address the API answers when connecting', async () => {
    get.mockResolvedValue(status());
    post.mockResolvedValue({ url: 'https://accounts.google.com/o/oauth2/v2/auth?state=abc' });
    const assign = vi.fn();
    vi.spyOn(window, 'location', 'get').mockReturnValue({
      ...window.location,
      assign,
    } as unknown as Location);
    renderPage();
    expect(await screen.findByText('Não conectado')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Conectar minha conta Google' }));
    await waitFor(() => expect(post).toHaveBeenCalledWith('/me/google/connect', undefined));
    await waitFor(() =>
      expect(assign).toHaveBeenCalledWith('https://accounts.google.com/o/oauth2/v2/auth?state=abc'),
    );
  });

  it('shows the account, both calendars and the Wings access once connected, and disconnects', async () => {
    get.mockResolvedValue(
      status({
        state: 'connected',
        email: 'daniele@wingscompany.com.br',
        calendars: {
          mine: { id: 'primary', name: 'Daniele' },
          wings: { id: 'w@group.calendar.google.com', name: 'Wings Company', access: 'reader' },
        },
      }),
    );
    del.mockResolvedValue(status());
    renderPage('/minha-conta?google=ok');
    expect(await screen.findByText('Conta Google conectada.')).toBeTruthy();
    expect(screen.getByText('daniele@wingscompany.com.br')).toBeTruthy();
    expect(screen.getByText(/só leitura: peça à Thais/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Desconectar' }));
    fireEvent.click(screen.getByRole('button', { name: 'Desconectar agora' }));
    await waitFor(() => expect(del).toHaveBeenCalledWith('/me/google'));
    expect(await screen.findByText('Não conectado')).toBeTruthy();
  });

  it('explains a refused return and a connection Google stopped accepting', async () => {
    get.mockResolvedValue(status({ state: 'needs_reconnect', lastError: 'invalid_grant' }));
    renderPage('/minha-conta?google=erro&motivo=denied');
    expect(await screen.findByText(/Você não autorizou o acesso/)).toBeTruthy();
    expect(screen.getByText(/O Google cancelou a autorização/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Conectar de novo' })).toBeTruthy();
  });

  it('says the OAuth client is still Eric’s step while the system is unconfigured', async () => {
    get.mockResolvedValue(status({ configured: false }));
    renderPage();
    expect(await screen.findByText(/GOOGLE_WORKSPACE_CLIENT_ID/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Conectar/ })).toBeNull();
  });
});
