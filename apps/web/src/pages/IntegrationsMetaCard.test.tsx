import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const get = vi.fn();
const post = vi.fn();
vi.mock('../api/client.js', async (original) => ({
  ...(await original<typeof import('../api/client.js')>()),
  api: {
    get: (path: string) => get(path),
    post: (path: string, body?: unknown) => post(path, body),
    put: vi.fn(),
  },
}));

const { IntegrationsPage } = await import('./IntegrationsPage.js');
const { ApiError } = await import('../api/client.js');

const META_STATUS = {
  pending: 0,
  failed: 0,
  done: 4,
  rdMissing: 0,
  lastReceivedAt: null,
  lastProcessedAt: null,
  webhookConfigured: false,
  tokenConfigured: true,
  polling: {
    enabled: true,
    everyMinutes: 5,
    lastRunAt: new Date().toISOString(),
    lastOkAt: new Date().toISOString(),
    lastError: null,
    forms: 3,
    formsWithError: 0,
  },
};

function answer(path: string) {
  if (path === '/auth/me')
    return {
      user: { id: 'u1', permissions: { 'integrations.manage': 'all', 'leads.read': 'all' } },
    };
  if (path === '/crm/meta-leads/status') return META_STATUS;
  if (path === '/crm/sources')
    return {
      sources: [
        {
          key: 'meta',
          name: 'Meta Lead Ads',
          state: 'on',
          note: 'Ligada, a cada 5 min.',
          lastAt: null,
          last30: 0,
        },
      ],
    };
  return {
    landingPages: [],
    users: [],
    employees: [],
    accounts: [],
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
    },
  };
}

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <IntegrationsPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  get.mockReset();
  post.mockReset();
  get.mockImplementation((path: string) => Promise.resolve(answer(path)));
});
afterEach(cleanup);

describe('Integrações → Fontes de negócios → Meta Lead Ads', () => {
  it('says it is on every 5 minutes and tests the connection with totals only', async () => {
    post.mockResolvedValue({ pages: 1, forms: 3, leads: 12, truncated: false, failed: {} });
    renderPage();
    expect(await screen.findByText(/ligada, a cada 5 min/)).toBeTruthy();
    expect(screen.getByText(/3 formulários/)).toBeTruthy();
    fireEvent.click(await screen.findByRole('button', { name: 'Testar conexão' }));
    expect(
      await screen.findByText(
        /A chave enxerga 1 página, 3 formulários e 12 leads dos últimos 90 dias/,
      ),
    ).toBeTruthy();
    expect(post).toHaveBeenCalledWith('/crm/meta-leads/test', undefined);
  });

  it('fetches now and reports the totals', async () => {
    post.mockResolvedValue({
      pages: 1,
      forms: 3,
      listed: 5,
      queued: 2,
      alreadyKnown: 3,
      failed: {},
    });
    renderPage();
    expect(await screen.findByText(/ligada, a cada 5 min/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Buscar agora' }));
    expect(await screen.findByText(/2 leads novos, 3 já conhecidos/)).toBeTruthy();
    expect(post).toHaveBeenCalledWith('/crm/meta-leads/poll', undefined);
  });

  it('shows no buttons to someone who cannot manage integrations', async () => {
    get.mockImplementation((path: string) =>
      Promise.resolve(
        path === '/auth/me'
          ? { user: { id: 'u2', permissions: { 'leads.read': 'all' } } }
          : answer(path),
      ),
    );
    renderPage();
    expect(await screen.findByText(/ligada, a cada 5 min/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Buscar agora' })).toBeNull();
  });
});

describe('Integrações → Fontes de negócios when a read fails', () => {
  it('says "—" and why for the sources, not an empty section', async () => {
    get.mockImplementation((path: string) =>
      path === '/crm/sources'
        ? Promise.reject(new ApiError(500, {}))
        : Promise.resolve(answer(path)),
    );
    renderPage();

    expect(
      await screen.findByText(
        /Não foi possível carregar as fontes de negócios: o servidor teve um problema \(erro 500\)/,
      ),
    ).toBeTruthy();
    expect(screen.queryByText(/ligada, a cada 5 min/)).toBeNull();
  });

  it('does not claim the Meta key is missing when the status never arrived', async () => {
    get.mockImplementation((path: string) =>
      path === '/crm/meta-leads/status'
        ? Promise.reject(new ApiError(403, {}))
        : Promise.resolve(answer(path)),
    );
    renderPage();

    expect(
      await screen.findByText(
        /Não foi possível carregar o estado da Meta Lead Ads: você não tem permissão/,
      ),
    ).toBeTruthy();
    expect(screen.queryByText(/desligada: falta a chave da Meta/)).toBeNull();
  });
});
