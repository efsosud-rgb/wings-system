import type { KairogenStatus } from '@wings/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const get = vi.fn();
const post = vi.fn();
const put = vi.fn();
vi.mock('../api/client.js', async (original) => ({
  ...(await original<typeof import('../api/client.js')>()),
  api: {
    get: (path: string) => get(path),
    post: (path: string, body?: unknown) => post(path, body),
    put: (path: string, body?: unknown) => put(path, body),
  },
}));

const { IntegrationsPage } = await import('./IntegrationsPage.js');
const { ApiError } = await import('../api/client.js');

const status = (overrides: Partial<KairogenStatus> = {}): { status: KairogenStatus } => ({
  status: {
    state: 'disconnected',
    detail: null,
    connectedAt: null,
    connectedByName: null,
    scopes: [],
    pending: null,
    credits: null,
    plan: 'free',
    protocolVersion: null,
    tools: [],
    ...overrides,
  },
});

const pendingDevice = status({
  state: 'pending',
  pending: {
    flow: 'device',
    userCode: 'WING-5678',
    verificationUri: 'https://app.kairogen.ai/device',
    verificationUriComplete: 'https://app.kairogen.ai/device?user_code=WING-5678',
    authorizationUrl: null,
    expiresAt: '2026-09-21T19:00:00.000Z',
    intervalSeconds: 5,
  },
});

function renderPage(path = '/administracao/integracoes') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <IntegrationsPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  get.mockReset();
  post.mockReset();
  put.mockReset();
});
afterEach(cleanup);

describe('Configurações → Integrações → Kairogen', () => {
  it('connects by code: shows the code to type and the way to Kairogen, and nothing secret', async () => {
    get.mockResolvedValue(status());
    post.mockResolvedValue(pendingDevice);
    renderPage();

    fireEvent.click(await screen.findByRole('button', { name: 'Conectar' }));
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith('/integrations/kairogen/connect', { flow: 'device' }),
    );

    expect(await screen.findByLabelText('Código de autorização')).toHaveProperty(
      'textContent',
      'WING-5678',
    );
    expect(screen.getByRole('link', { name: 'Abrir o Kairogen' }).getAttribute('href')).toBe(
      'https://app.kairogen.ai/device?user_code=WING-5678',
    );
    expect(screen.getByRole('status', { name: '' })).toBeTruthy();
    expect(screen.getByText('Aguardando autorização no Kairogen')).toBeTruthy();
  });

  it('checks on request and shows the balance once connected', async () => {
    get.mockResolvedValue(pendingDevice);
    post.mockResolvedValue(
      status({
        state: 'connected',
        connectedByName: 'Eric',
        connectedAt: '2026-09-21T18:30:00.000Z',
        scopes: ['kairogen:read', 'kairogen:generate'],
        credits: { balance: 1250, raw: null, checkedAt: '2026-09-21T18:30:00.000Z' },
        protocolVersion: '2025-06-18',
        tools: [{ name: 'get_credits', description: 'Saldo', inputSchema: { type: 'object' } }],
      }),
    );
    renderPage();

    fireEvent.click(await screen.findByRole('button', { name: 'Já autorizei' }));
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith('/integrations/kairogen/poll', undefined),
    );
    expect(await screen.findByText('1.250 créditos')).toBeTruthy();
    expect(screen.getByText('Conectado')).toBeTruthy();
    expect(screen.getByText(/Ferramentas oferecidas pelo Kairogen \(1\)/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Conectar' })).toBeNull();
  });

  it('asks before disconnecting', async () => {
    get.mockResolvedValue(status({ state: 'connected', scopes: ['kairogen:read'] }));
    post.mockResolvedValue(status());
    renderPage();

    fireEvent.click(await screen.findByRole('button', { name: 'Desconectar' }));
    expect(post).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Desconectar agora' }));
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith('/integrations/kairogen/disconnect', undefined),
    );
    expect(await screen.findByText('Desconectado')).toBeTruthy();
  });

  it('offers the browser road when Kairogen refuses the code road', async () => {
    get.mockResolvedValue(status());
    post.mockRejectedValueOnce(
      new ApiError(502, {
        error: 'device_flow_refused',
        message: 'O Kairogen recusou o fluxo por código (400).',
      }),
    );
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Conectar' }));

    expect(await screen.findByText(/recusou o fluxo por código/)).toBeTruthy();
    post.mockResolvedValueOnce(status({ state: 'pending' }));
    fireEvent.click(screen.getByRole('button', { name: 'Conectar pelo navegador' }));
    await waitFor(() =>
      expect(post).toHaveBeenLastCalledWith('/integrations/kairogen/connect', { flow: 'code' }),
    );
  });

  it('states the plan the estimates are made against, and saves it on request', async () => {
    get.mockResolvedValue(status({ state: 'connected' }));
    put.mockResolvedValue(status({ state: 'connected', plan: 'pro' }));
    renderPage();

    const field = (await screen.findByLabelText('Plano contratado')) as HTMLSelectElement;
    expect(field.value).toBe('free');
    expect(screen.getByRole('button', { name: 'Salvar plano' })).toHaveProperty('disabled', true);

    fireEvent.change(field, { target: { value: 'pro' } });
    expect(put).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Salvar plano' }));
    await waitFor(() =>
      expect(put).toHaveBeenCalledWith('/integrations/kairogen/plan', { plan: 'pro' }),
    );
    expect(await screen.findByText('Plano salvo.')).toBeTruthy();
  });

  it('says so when the environment has no key, and offers nothing to click', async () => {
    get.mockResolvedValue(
      status({
        state: 'not_configured',
        detail: 'Falta a chave INTEGRATIONS_ENCRYPTION_KEY neste ambiente.',
      }),
    );
    renderPage();
    expect(await screen.findByText('Indisponível neste ambiente')).toBeTruthy();
    expect(screen.getByText(/INTEGRATIONS_ENCRYPTION_KEY/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Conectar' })).toBeNull();
  });

  it('reports how the browser road ended when Kairogen sends the person back', async () => {
    get.mockResolvedValue(status({ state: 'connected' }));
    renderPage('/administracao/integracoes?kairogen=ok');
    expect(await screen.findByText(/Conta do Kairogen conectada/)).toBeTruthy();
  });
});
