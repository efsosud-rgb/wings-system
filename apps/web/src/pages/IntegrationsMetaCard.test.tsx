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

let META_FAILED: {
  total: number;
  items: Record<string, unknown>[];
} = { total: 0, items: [] };

function answer(path: string) {
  if (path === '/auth/me')
    return {
      user: { id: 'u1', permissions: { 'integrations.manage': 'all', 'leads.read': 'all' } },
    };
  if (path === '/crm/meta-leads/status') return META_STATUS;
  if (path === '/crm/meta-leads/failed') return META_FAILED;
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
  META_FAILED = { total: 0, items: [] };
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

describe('Integrações → Meta Lead Ads → eventos que falharam', () => {
  const lead = {
    leadgenId: '1082808061389189',
    leadAt: '2026-10-10T23:23:00.000Z',
    formId: 'form-1',
    formName: 'Formulário Exemplo',
    adId: 'ad-1',
    campaignName: 'Campanha Espelhada',
    attempts: 1,
    reason: { code: 'no_contact_data', label: 'Sem telefone nem e-mail', severity: 'warning' },
  };

  it('lists date, form, campaign and the reason, a missing contact as a warning', async () => {
    META_FAILED = {
      total: 2,
      items: [
        lead,
        {
          ...lead,
          leadgenId: '900002',
          formName: null,
          formId: 'form-2',
          adId: null,
          campaignName: null,
          reason: { code: 'graph_400', label: 'Erro da Meta (erro 400)', severity: 'error' },
        },
      ],
    };
    renderPage();

    expect(await screen.findByText('Eventos da Meta que falharam')).toBeTruthy();
    expect(screen.getByText('Formulário Exemplo')).toBeTruthy();
    expect(screen.getByText('Campanha Espelhada')).toBeTruthy();
    expect(screen.getByText('Sem telefone nem e-mail')).toBeTruthy();
    expect(screen.getByText('1082808061389189')).toBeTruthy();
    // Warning and error are told apart by the word, not only by colour.
    const warning = screen.getByText('Aviso');
    expect(warning.className).toContain('status-warning');
    const error = screen.getByText('Erro');
    expect(error.className).toContain('status-error');
    expect(screen.getByText('Erro da Meta (erro 400)')).toBeTruthy();
    // No form name: the id stands in. No ad: it says so instead of an empty cell.
    expect(screen.getByText('form-2')).toBeTruthy();
    expect(screen.getByText('— a Meta não informou o anúncio')).toBeTruthy();
  });

  it('says an ad it does not know is not in the system, and when the list is cut', async () => {
    META_FAILED = { total: 80, items: [{ ...lead, campaignName: null }] };
    renderPage();

    expect(await screen.findByText('— anúncio não encontrado no sistema')).toBeTruthy();
    expect(screen.getByText(/Os 1 mais recentes, de 80 eventos/)).toBeTruthy();
  });

  it('says none failed only after the read worked', async () => {
    renderPage();
    expect(await screen.findByText('Nenhum evento da Meta falhou.')).toBeTruthy();
  });

  it('says "—" and why when the list did not load, not "nenhum evento"', async () => {
    get.mockImplementation((path: string) =>
      path === '/crm/meta-leads/failed'
        ? Promise.reject(new ApiError(500, {}))
        : Promise.resolve(answer(path)),
    );
    renderPage();

    expect(
      await screen.findByText(
        /Não foi possível carregar os eventos da Meta que falharam: o servidor teve um problema \(erro 500\)/,
      ),
    ).toBeTruthy();
    expect(screen.queryByText('Nenhum evento da Meta falhou.')).toBeNull();
  });

  it('does not ask for the list, nor show it, to someone who cannot manage integrations', async () => {
    get.mockImplementation((path: string) =>
      Promise.resolve(
        path === '/auth/me'
          ? { user: { id: 'u2', permissions: { 'leads.read': 'all' } } }
          : answer(path),
      ),
    );
    renderPage();
    expect(await screen.findByText(/ligada, a cada 5 min/)).toBeTruthy();
    expect(screen.queryByText('Eventos da Meta que falharam')).toBeNull();
    expect(get).not.toHaveBeenCalledWith('/crm/meta-leads/failed');
  });
});
