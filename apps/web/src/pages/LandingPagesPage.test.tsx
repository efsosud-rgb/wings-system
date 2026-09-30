import type { LandingPageItem, SessionUser } from '@wings/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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

const { LandingPagesPage } = await import('./LandingPagesPage.js');

const admin: SessionUser = {
  employeeId: 'e1',
  fullName: 'Gerente',
  email: 'g@wingscompany.com.br',
  cargo: 'Gerente',
  role: 'admin_master',
  sector: 'comercial',
  isSectorManager: false,
  tracksTime: false,
  permissions: { 'leads.read': 'all', 'clients.manage': 'all' },
  lastLoginAt: null,
  sessionExpiresAt: '2026-09-23T23:00:00Z',
};

const page = (overrides: Partial<LandingPageItem>): LandingPageItem => ({
  id: 'p1',
  pattern: 'casal-do-churros',
  url: null,
  clientId: 'c1',
  clientName: 'Casal do Churros',
  brand: 'Casal dos Churros',
  pipeline: 'expansao',
  active: true,
  archivedAt: null,
  createdAt: '2026-09-28T12:00:00Z',
  leads: 3,
  performance: {
    visits: null,
    visitsSource: null,
    visitsReason: 'Sem fonte de visitas por página: GA4 não conectado.',
    conversions: 12,
    conversionsSource: 'RD Marketing',
    conversionsSince: '2026-09-28T12:00:00Z',
    conversionsReason: null,
    rate: null,
  },
  ...overrides,
});

beforeEach(() => {
  get.mockReset().mockImplementation(async (path: string) => {
    if (path === '/auth/me') return { user: admin };
    if (path === '/clients')
      return {
        clients: [
          {
            id: 'c9',
            name: 'Cenoritas',
            slug: 'cenoritas',
            active: true,
            expansionArea: [],
            number: 12,
          },
        ],
      };
    if (path === '/leads/source-rules') return { rules: [] };
    if (path === '/crm/landing-pages')
      return {
        baseUrl: 'https://franquia.wingscompany.com.br',
        pages: [
          page({}),
          page({
            id: 'p2',
            pattern: 'cenoritas',
            url: 'https://franquia.wingscompany.com.br/cenoritas',
            clientName: 'Cenoritas',
            brand: null,
            leads: 0,
            performance: { ...page({}).performance, conversions: 0 },
          }),
          page({ id: 'p3', pattern: 'antiga', active: false, archivedAt: '2026-09-29T12:00:00Z' }),
        ],
      };
    throw new Error(`unexpected GET ${path}`);
  });
  post.mockReset().mockResolvedValue({ ok: true });
  del.mockReset().mockResolvedValue(undefined);
});
afterEach(cleanup);

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <LandingPagesPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('CRM Vendas → Landing pages', () => {
  it('lists active pages with client, funnel, leads, conversions with their date and "—" for visits and rate', async () => {
    renderPage();
    const row = (await screen.findByText('casal-do-churros')).closest('tr') as HTMLElement;
    expect(within(row).getByText('Casal do Churros')).toBeTruthy();
    expect(within(row).getByText('12')).toBeTruthy();
    expect(within(row).getAllByText('—')).toHaveLength(2);
    expect(screen.queryByText('antiga')).toBeNull();
    fireEvent.click(screen.getByLabelText('Mostrar arquivadas'));
    expect(await screen.findByText('antiga')).toBeTruthy();
  });

  it('generates UTM links per channel for a page', async () => {
    renderPage();
    const row = (await screen.findByText('cenoritas')).closest('tr') as HTMLElement;
    fireEvent.click(within(row).getByRole('button', { name: 'Links com UTM' }));
    fireEvent.change(screen.getAllByLabelText('Campanha')[0]!, {
      target: { value: 'Expansão Out26' },
    });
    expect(
      await screen.findByText(
        'https://franquia.wingscompany.com.br/cenoritas?utm_source=instagram&utm_medium=cpc&utm_campaign=expansao_out26',
      ),
    ).toBeTruthy();
  });

  it('archives with the main button, and deletes for good only a page with no history, after typing its address', async () => {
    renderPage();
    const withHistory = (await screen.findByText('casal-do-churros')).closest('tr') as HTMLElement;
    expect(within(withHistory).queryByRole('button', { name: 'Excluir de vez' })).toBeNull();
    fireEvent.click(within(withHistory).getByRole('button', { name: 'Arquivar' }));
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith('/crm/landing-pages/p1/archive', undefined),
    );

    const empty = screen.getByText('cenoritas').closest('tr') as HTMLElement;
    fireEvent.click(within(empty).getByRole('button', { name: 'Excluir de vez' }));
    const confirm = screen.getByRole('button', { name: 'Confirmar exclusão' });
    expect(confirm).toHaveProperty('disabled', true);
    fireEvent.change(screen.getByLabelText(/Digite/), { target: { value: 'cenoritas' } });
    fireEvent.click(confirm);
    await waitFor(() =>
      expect(del).toHaveBeenCalledWith('/crm/landing-pages/p2?confirm=cenoritas'),
    );
  });

  it('makes a new page for a client and funnel', async () => {
    post.mockResolvedValue({
      page: page({
        id: 'p9',
        pattern: 'cenoritas-2',
        url: 'https://franquia.wingscompany.com.br/cenoritas-2',
      }),
    });
    renderPage();
    const select = await screen.findByLabelText('Cliente da página');
    await within(select).findByRole('option', { name: 'Cenoritas' });
    fireEvent.change(select, { target: { value: 'c9' } });
    fireEvent.click(screen.getByRole('button', { name: 'Criar endereço e regra' }));
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith('/crm/landing-pages', {
        clientId: 'c9',
        pipeline: 'expansao',
        slug: undefined,
      }),
    );
    expect(await screen.findByText('Links da página cenoritas-2')).toBeTruthy();
  });
});
