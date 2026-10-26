import type {
  ProspectingUsage,
  ProspectSearchItem,
  ProspectSearchResponse,
  SessionUser,
} from '@wings/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../api/client.js';

const get = vi.fn();
const post = vi.fn();
vi.mock('../../api/client.js', async (original) => ({
  ...(await original<typeof import('../../api/client.js')>()),
  api: {
    get: (path: string) => get(path),
    post: (path: string, body?: unknown) => post(path, body),
    patch: vi.fn(),
    put: vi.fn(),
  },
}));

const { ProspectingPage, hiddenLine, placesOf } = await import('./ProspectingPage.js');

const user = (role: SessionUser['role'], permissions: SessionUser['permissions']): SessionUser => ({
  employeeId: 'e1',
  fullName: 'Vendedora Teste',
  email: 'vendedora@example.com',
  cargo: 'Vendedora',
  role,
  sector: 'comercial',
  isSectorManager: false,
  tracksTime: false,
  permissions,
  lastLoginAt: null,
  sessionExpiresAt: '2026-10-26T23:00:00Z',
});
const SELLER = user('vendedor_formatacao', { 'prospecting.use': 'own', 'leads.write': 'own' });
const MANAGER = user('gerente_comercial', {
  'prospecting.use': 'all',
  'prospecting.configure': 'all',
});

const usage: ProspectingUsage = {
  today: { used: 3, limit: 40 },
  month: { searches: 120, searchLimit: 950, details: 7, detailsLimit: 950 },
};

// Made-up places: no real company.
const item = (over: Partial<ProspectSearchItem>): ProspectSearchItem => ({
  placeId: 'ChIJ_fake_place_0001',
  name: 'Hamburgueria Exemplo',
  address: 'Rua Fictícia, 100 - Icaraí, Niterói - RJ',
  phone: '(21) 90000-0001',
  website: 'https://exemplo.invalid/',
  rating: 4.6,
  reviews: 320,
  businessStatus: 'OPERATIONAL',
  mapsUri: 'https://maps.google.com/?cid=1',
  types: ['restaurant'],
  icp: { score: 5, reasons: ['Nota ≥ 4,5 (+2)', 'Avaliações ≥ 200 (+2)', 'Tem site (+1)'] },
  tags: [],
  prospect: null,
  leadId: null,
  ...over,
});

const answer = (over: Partial<ProspectSearchResponse> = {}): ProspectSearchResponse => ({
  items: [
    item({}),
    item({
      placeId: 'ChIJ_fake_place_0002',
      name: 'Burger Teste',
      tags: [{ kind: 'lead', text: 'já é lead: dono Ana' }],
      leadId: 'l9',
    }),
  ],
  nextPageToken: null,
  page: 1,
  callsSpent: 1,
  hidden: { excluded: 5, filtered: 4, heldByOthers: 3, repeated: 0 },
  usage,
  ...over,
});

let session = SELLER;
let status = { configured: true, aiConfigured: true };
let prospects: unknown = [];

beforeEach(() => {
  session = SELLER;
  status = { configured: true, aiConfigured: true };
  prospects = [];
  get.mockReset().mockImplementation(async (path: string) => {
    if (path === '/auth/me') return { user: session };
    if (path === '/prospecting/status') return status;
    if (path === '/prospecting/usage') return usage;
    if (path === '/prospecting/settings')
      return {
        icp: { weights: {}, excludedNames: [] },
        quota: { perUserDaily: 40, monthlySearches: 950, monthlyDetails: 950 },
        updatedAt: null,
      };
    if (path === '/prospecting/prospects') return prospects;
    if (path === '/crm/stages?pipeline=formatacao')
      return { stages: [{ id: 's1', name: 'Sem contato', active: true }] };
    throw new Error(`unexpected GET ${path}`);
  });
  post.mockReset();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <ProspectingPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const fill = (label: string, value: string) =>
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
const searchPosts = () => post.mock.calls.filter(([path]) => path === '/prospecting/search');

describe('Prospecção', () => {
  it('shows a seller Busca and Meus prospects, no Ajustes, and the usage of the day and month', async () => {
    renderPage();
    expect(await screen.findByRole('tab', { name: 'Busca' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Meus prospects' })).toBeTruthy();
    expect(screen.queryByRole('tab', { name: 'Ajustes' })).toBeNull();
    expect(await screen.findByText('Uso do mês: 120 de 950 buscas · 7 de 950 fichas')).toBeTruthy();
    expect(screen.getByText('Hoje: 3 de 40')).toBeTruthy();
  });

  it('shows Ajustes and "Prospects" to a manager who configures', async () => {
    session = MANAGER;
    renderPage();
    expect(await screen.findByRole('tab', { name: 'Ajustes' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Prospects' })).toBeTruthy();
  });

  it('without the key says so before any search and keeps Buscar disabled', async () => {
    status = { configured: false, aiConfigured: true };
    renderPage();
    expect(await screen.findAllByText('— Chave do Google não configurada.')).not.toHaveLength(0);
    const button = screen.getByRole('button', { name: 'Buscar' }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.title).toBe('Chave do Google não configurada.');
  });

  it('lists results with the Google Maps attribution, the Maps link, tags, ICP and hidden counts', async () => {
    post.mockResolvedValue(answer());
    renderPage();
    await waitFor(() =>
      expect((screen.getByRole('button', { name: 'Buscar' }) as HTMLButtonElement).disabled).toBe(
        false,
      ),
    );
    fill('Segmento', 'hamburgueria');
    fill('Cidade ou bairros', 'Niterói');
    fireEvent.click(screen.getByRole('button', { name: 'Buscar' }));

    const results = await screen.findByRole('region', { name: 'Resultados' });
    expect(within(results).getByText('Resultados do Google Maps')).toBeTruthy();
    const maps = within(results).getAllByRole('link', { name: 'Abrir no Google Maps' });
    expect(maps[0]!.getAttribute('href')).toBe('https://maps.google.com/?cid=1');
    expect(maps[0]!.getAttribute('target')).toBe('_blank');
    expect(maps[0]!.getAttribute('rel')).toContain('noopener');
    expect(within(results).getByText('já é lead: dono Ana')).toBeTruthy();
    const icp = within(results).getAllByTitle(/Nota ≥ 4,5 \(\+2\)/)[0]!;
    expect(icp.textContent).toBe('5');
    expect(
      within(results).getByText(
        '12 ocultos: 5 pela lista de exclusão, 4 pelos filtros, 3 reservados por outros vendedores',
      ),
    ).toBeTruthy();
    expect(searchPosts()[0]![1]).toEqual({
      segment: 'hamburgueria',
      places: ['Niterói'],
      minRating: null,
      minReviews: null,
      requireWebsite: false,
      onlyOperational: true,
    });
  });

  it('says "Nenhuma empresa…" only after a search that answered empty', async () => {
    post.mockResolvedValue(answer({ items: [] }));
    renderPage();
    expect(screen.queryByText('Nenhuma empresa encontrada com esses filtros.')).toBeNull();
    await waitFor(() =>
      expect((screen.getByRole('button', { name: 'Buscar' }) as HTMLButtonElement).disabled).toBe(
        false,
      ),
    );
    fill('Segmento', 'pizzaria');
    fill('Cidade ou bairros', 'Niterói');
    fireEvent.click(screen.getByRole('button', { name: 'Buscar' }));
    expect(await screen.findByText('Nenhuma empresa encontrada com esses filtros.')).toBeTruthy();
  });

  it('shows the quota refusal in the API words, with "—", and no list', async () => {
    post.mockRejectedValue(
      new ApiError(429, {
        error: 'prospecting_quota',
        message: 'Você já usou as 40 chamadas ao Google de hoje. A cota volta amanhã.',
      }),
    );
    renderPage();
    await waitFor(() =>
      expect((screen.getByRole('button', { name: 'Buscar' }) as HTMLButtonElement).disabled).toBe(
        false,
      ),
    );
    fill('Segmento', 'pizzaria');
    fill('Cidade ou bairros', 'Niterói');
    fireEvent.click(screen.getByRole('button', { name: 'Buscar' }));
    expect((await screen.findByRole('alert')).textContent).toBe(
      '— Você já usou as 40 chamadas ao Google de hoje. A cota volta amanhã.',
    );
    expect(screen.queryByText('Nenhuma empresa encontrada com esses filtros.')).toBeNull();
  });

  it('a new search that fails takes the last answer away, empty text included', async () => {
    post.mockResolvedValueOnce(answer({ items: [] })).mockRejectedValueOnce(
      new ApiError(429, {
        error: 'prospecting_quota',
        message: 'Você já usou as 40 chamadas ao Google de hoje. A cota volta amanhã.',
      }),
    );
    renderPage();
    await waitFor(() =>
      expect((screen.getByRole('button', { name: 'Buscar' }) as HTMLButtonElement).disabled).toBe(
        false,
      ),
    );
    fill('Segmento', 'pizzaria');
    fill('Cidade ou bairros', 'Niterói');
    fireEvent.click(screen.getByRole('button', { name: 'Buscar' }));
    expect(await screen.findByText('Nenhuma empresa encontrada com esses filtros.')).toBeTruthy();
    fill('Segmento', 'hamburgueria');
    fireEvent.click(screen.getByRole('button', { name: 'Buscar' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/^— Você já usou/);
    expect(screen.queryByText('Nenhuma empresa encontrada com esses filtros.')).toBeNull();
    expect(screen.queryByRole('region', { name: 'Resultados' })).toBeNull();
  });

  it('asks before a sweep with the number of calls, and sends confirmCalls only when confirmed', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    post.mockResolvedValue(answer({ callsSpent: 3 }));
    renderPage();
    await screen.findByText('Hoje: 3 de 40');
    await waitFor(() =>
      expect((screen.getByRole('button', { name: 'Buscar' }) as HTMLButtonElement).disabled).toBe(
        false,
      ),
    );
    fill('Segmento', 'hamburgueria');
    fill('Cidade ou bairros', 'Icaraí\nSanta Rosa, Ingá');
    fireEvent.click(screen.getByRole('button', { name: 'Buscar' }));
    expect(confirm).toHaveBeenCalledWith(
      'A varredura vai gastar 3 chamadas ao Google (uma por local). Hoje: 3 de 40 · Mês: 120 de 950 buscas. Continuar?',
    );
    expect(searchPosts()).toHaveLength(0);

    confirm.mockReturnValue(true);
    fireEvent.click(screen.getByRole('button', { name: 'Buscar' }));
    await screen.findByRole('region', { name: 'Resultados' });
    expect(searchPosts()[0]![1]).toMatchObject({
      places: ['Icaraí', 'Santa Rosa', 'Ingá'],
      confirmCalls: 3,
    });
  });

  it('fills the form from the AI only on "Usar no formulário", and never searches by itself', async () => {
    post.mockImplementation(async (path: string) => {
      if (path === '/prospecting/parse')
        return {
          segmento: 'hamburgueria',
          locais: ['Icaraí', 'Santa Rosa'],
          nota_min: 4.5,
          avaliacoes_min: 100,
          exige_site: true,
        };
      throw new Error(`unexpected POST ${path}`);
    });
    renderPage();
    fireEvent.change(await screen.findByLabelText('Pedido'), {
      target: { value: 'hamburguerias em Icaraí e Santa Rosa com nota 4,5' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Enviar' }));
    const use = await screen.findByRole('button', { name: 'Usar no formulário' });
    expect((screen.getByLabelText('Segmento') as HTMLInputElement).value).toBe('');

    fireEvent.click(use);
    expect((screen.getByLabelText('Segmento') as HTMLInputElement).value).toBe('hamburgueria');
    expect((screen.getByLabelText('Cidade ou bairros') as HTMLTextAreaElement).value).toBe(
      'Icaraí\nSanta Rosa',
    );
    expect((screen.getByLabelText('Nota mínima') as HTMLInputElement).value).toBe('4.5');
    expect((screen.getByLabelText('Só com site') as HTMLInputElement).checked).toBe(true);
    expect(post.mock.calls.map(([path]) => path)).toEqual(['/prospecting/parse']);
  });

  it('says the AI is off, and keeps the form, when it is not configured', async () => {
    status = { configured: true, aiConfigured: false };
    renderPage();
    expect(
      await screen.findByText(
        '— A IA não está configurada neste ambiente. O formulário ao lado funciona sem ela.',
      ),
    ).toBeTruthy();
    expect(screen.queryByLabelText('Pedido')).toBeNull();
    expect(screen.getByLabelText('Segmento')).toBeTruthy();
  });
});

describe('Prospecção: reservar, criar lead e Meus prospects', () => {
  const searchOnce = async () => {
    renderPage();
    await waitFor(() =>
      expect((screen.getByRole('button', { name: 'Buscar' }) as HTMLButtonElement).disabled).toBe(
        false,
      ),
    );
    fill('Segmento', 'hamburgueria');
    fill('Cidade ou bairros', 'Niterói');
    fireEvent.click(screen.getByRole('button', { name: 'Buscar' }));
    return screen.findByRole('region', { name: 'Resultados' });
  };

  it('reserves a result, then creates the lead only with the WhatsApp answer given', async () => {
    post.mockImplementation(async (path: string) => {
      if (path === '/prospecting/search') return answer({ items: [item({})] });
      if (path === '/prospecting/prospects')
        return {
          id: 'p1',
          placeId: 'ChIJ_fake_place_0001',
          status: 'reservado',
          ownerEmployeeId: 'e1',
          ownerName: 'Vendedora Teste',
          mine: true,
          reason: null,
          notes: null,
          enrichment: {},
          leadId: null,
          createdAt: '2026-10-26T12:00:00Z',
          updatedAt: '2026-10-26T12:00:00Z',
        };
      if (path === '/prospecting/prospects/p1/lead') return { leadId: 'l7' };
      throw new Error(`unexpected POST ${path}`);
    });
    const results = await searchOnce();
    fireEvent.click(within(results).getByRole('button', { name: 'Reservar' }));
    fireEvent.click(await within(results).findByRole('button', { name: 'Criar lead' }));
    expect(post).toHaveBeenCalledWith('/prospecting/prospects', {
      placeId: 'ChIJ_fake_place_0001',
      action: 'reserve',
      reason: undefined,
    });

    const dialog = screen.getByRole('dialog', { name: 'Criar lead no funil Formatação' });
    fireEvent.change(within(dialog).getByLabelText('Empresa'), {
      target: { value: 'Hamburgueria Exemplo' },
    });
    fireEvent.change(within(dialog).getByLabelText('Contato'), { target: { value: 'Ana Teste' } });
    fireEvent.change(within(dialog).getByLabelText('Telefone'), {
      target: { value: '(21) 90000-0001' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Criar lead' }));
    expect(within(dialog).getByRole('alert').textContent).toBe('Diga se aceitou receber WhatsApp');
    expect(post.mock.calls.some(([path]) => String(path).endsWith('/lead'))).toBe(false);

    fireEvent.click(within(dialog).getByLabelText('Não'));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Criar lead' }));
    expect(await within(results).findByRole('link', { name: 'Abrir negociação' })).toBeTruthy();
    expect(post).toHaveBeenCalledWith(
      '/prospecting/prospects/p1/lead',
      expect.objectContaining({ contactName: 'Ana Teste', whatsappOptIn: false, stageId: '' }),
    );
  });

  it('keeps the results when the seller looks at Meus prospects and comes back', async () => {
    post.mockResolvedValue(answer());
    await searchOnce();
    fireEvent.click(screen.getByRole('tab', { name: 'Meus prospects' }));
    expect(await screen.findByText('Nenhum prospect salvo com esse filtro.')).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: 'Busca' }));
    expect(screen.getByText('Hamburgueria Exemplo')).toBeTruthy();
    expect(searchPosts()).toHaveLength(1);
  });

  it('says "—" and why when Meus prospects did not load, not "Nenhum prospect"', async () => {
    renderPage();
    get.mockImplementation(async (path: string) => {
      if (path === '/prospecting/prospects') throw new ApiError(500, {});
      if (path === '/auth/me') return { user: session };
      if (path === '/prospecting/status') return status;
      return usage;
    });
    fireEvent.click(await screen.findByRole('tab', { name: 'Meus prospects' }));
    expect((await screen.findByRole('alert')).textContent).toContain(
      'Não foi possível carregar os prospects',
    );
    expect(screen.queryByText('Nenhum prospect salvo com esse filtro.')).toBeNull();
  });
});

describe('helpers', () => {
  it('splits places by line or comma, each once', () => {
    expect(placesOf(' Icaraí \n\nSanta Rosa, Ingá ,Icaraí')).toEqual([
      'Icaraí',
      'Santa Rosa',
      'Ingá',
    ]);
  });

  it('says nothing when nothing was hidden', () => {
    expect(hiddenLine({ excluded: 0, filtered: 0, heldByOthers: 0, repeated: 0 })).toBeNull();
    expect(hiddenLine({ excluded: 0, filtered: 0, heldByOthers: 0, repeated: 2 })).toBe(
      '2 ocultos: 2 repetidos entre os locais',
    );
  });
});
