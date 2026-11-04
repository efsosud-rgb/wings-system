import {
  INSTAGRAM_FROM_GOOGLE_SITE,
  PROSPECT_ENRICHMENT_SOURCE,
  type ProspectingUsage,
  type ProspectSearchItem,
  type ProspectSearchResponse,
  type SessionUser,
} from '@wings/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../api/client.js';

const get = vi.fn();
const SEM_CONTATO = '7b1d6f0e-3c53-4c9a-9b1e-0a5d2f4c8e11';
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

const { ProspectingPage, expiryLine, failedPlacesLine, hiddenLine, placesOf } =
  await import('./ProspectingPage.js');

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
  icp: {
    score: 56,
    earned: 5,
    possible: 9,
    reasons: ['Nota ≥ 4,5 (+2)', 'Avaliações ≥ 200 (+2)', 'Tem site (+1)'],
    noData: [],
  },
  instagram: null,
  missing: [],
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
  failedPlaces: [],
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
        retention: { reservedDays: 30, contactedDays: 90, enrichmentDays: 180 },
        updatedAt: null,
      };
    if (path === '/prospecting/prospects') return prospects;
    if (path === '/crm/stages?pipeline=formatacao')
      return { stages: [{ id: SEM_CONTATO, name: 'Sem contato', active: true }] };
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
    const pending = 'Conexão com o Google pendente: a chave ainda não foi configurada no servidor.';
    expect(await screen.findAllByText(`— ${pending}`)).not.toHaveLength(0);
    const button = screen.getByRole('button', { name: 'Buscar' }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.title).toBe(pending);
    expect(post).not.toHaveBeenCalled();
  });

  it('lists results with the Google Maps attribution, the Maps link, tags, ICP and hidden counts', async () => {
    post.mockResolvedValue(answer());
    renderPage();
    await waitFor(() =>
      expect((screen.getByRole('button', { name: 'Buscar' }) as HTMLButtonElement).disabled).toBe(
        false,
      ),
    );
    fill('Segmento ou nome da empresa', 'hamburgueria');
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
    expect(icp.textContent).toBe('56');
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
      requirePhone: false,
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
    fill('Segmento ou nome da empresa', 'pizzaria');
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
    fill('Segmento ou nome da empresa', 'pizzaria');
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
    fill('Segmento ou nome da empresa', 'pizzaria');
    fill('Cidade ou bairros', 'Niterói');
    fireEvent.click(screen.getByRole('button', { name: 'Buscar' }));
    expect(await screen.findByText('Nenhuma empresa encontrada com esses filtros.')).toBeTruthy();
    fill('Segmento ou nome da empresa', 'hamburgueria');
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
    fill('Segmento ou nome da empresa', 'hamburgueria');
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
    expect((screen.getByLabelText('Segmento ou nome da empresa') as HTMLInputElement).value).toBe(
      '',
    );

    fireEvent.click(use);
    expect((screen.getByLabelText('Segmento ou nome da empresa') as HTMLInputElement).value).toBe(
      'hamburgueria',
    );
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
    expect(screen.getByLabelText('Segmento ou nome da empresa')).toBeTruthy();
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
    fill('Segmento ou nome da empresa', 'hamburgueria');
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
    await waitFor(() =>
      expect((within(dialog).getByLabelText('Etapa') as HTMLSelectElement).value).toBe(SEM_CONTATO),
    );
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
    fireEvent.change(within(dialog).getByLabelText('Retorno combinado (opcional)'), {
      target: { value: '2027-03-10T10:00' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Criar lead' }));
    expect(await within(results).findByRole('link', { name: 'Abrir negociação' })).toBeTruthy();
    expect(post).toHaveBeenCalledWith(
      '/prospecting/prospects/p1/lead',
      expect.objectContaining({
        contactName: 'Ana Teste',
        whatsappOptIn: false,
        stageId: SEM_CONTATO,
        followUpAt: new Date('2027-03-10T10:00').toISOString(),
      }),
    );
  });

  it('opens Criar lead without Google\'s name, phone or site, only as a reference, in "Sem contato"', async () => {
    const reservedProspect = {
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
    post.mockImplementation(async (path: string) => {
      if (path === '/prospecting/search')
        return answer({
          items: [
            item({
              name: 'Hamburgueria Exemplo',
              phone: '(21) 90000-0001',
              website: 'https://hamburgueria-exemplo.com.br/',
              instagram: {
                username: 'hamburgueriaexemplo',
                source: PROSPECT_ENRICHMENT_SOURCE,
                at: null,
                ticket: 't',
              },
            }),
          ],
        });
      if (path === '/prospecting/prospects') return reservedProspect;
      if (path === '/prospecting/prospects/p1/lead') return { leadId: 'l7' };
      throw new Error(`unexpected POST ${path}`);
    });
    const results = await searchOnce();
    fireEvent.click(within(results).getByRole('button', { name: 'Reservar' }));
    fireEvent.click(await within(results).findByRole('button', { name: 'Criar lead' }));

    const dialog = screen.getByRole('dialog', { name: 'Criar lead no funil Formatação' });
    const value = (label: string) =>
      (within(dialog).getByLabelText(label) as HTMLInputElement | HTMLSelectElement).value;
    // Google's row is not in the form (the "only the place_id" rule): only our own data is.
    expect(value('Empresa')).toBe('');
    expect(value('Telefone')).toBe('');
    expect(value('Site')).toBe('');
    expect(value('Instagram')).toBe('@hamburgueriaexemplo');
    expect(value('E-mail')).toBe('');
    expect(value('Contato')).toBe('');
    // It is shown beside the form as a reference, for the seller to read and type.
    expect(within(dialog).getByLabelText('Referência do Google Maps').textContent).toContain(
      'Empresa: Hamburgueria Exemplo · Telefone: (21) 90000-0001 · Site: https://hamburgueria-exemplo.com.br/',
    );
    // The stage is "Sem contato" (never the old "Primeira etapa do funil").
    const stage = within(dialog).getByLabelText('Etapa') as HTMLSelectElement;
    await waitFor(() => expect(stage.value).toBe(SEM_CONTATO));
    expect(stage.options[stage.selectedIndex]?.textContent).toBe('Sem contato');
    expect(within(dialog).queryByText('Primeira etapa do funil')).toBeNull();

    // Saving without typing the company is refused: Google's name is not sent in its place.
    fireEvent.change(within(dialog).getByLabelText('Contato'), { target: { value: 'Ana Teste' } });
    fireEvent.click(within(dialog).getByLabelText('Não'));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Criar lead' }));
    expect(within(dialog).getByRole('alert')).toBeTruthy();
    expect(post.mock.calls.some(([path]) => String(path).endsWith('/lead'))).toBe(false);

    // What the seller types is what is sent, and nothing else from Google goes with it.
    fireEvent.change(within(dialog).getByLabelText('Empresa'), {
      target: { value: 'Empresa Confirmada' },
    });
    fireEvent.change(within(dialog).getByLabelText('Telefone'), {
      target: { value: '(21) 90000-0009' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Criar lead' }));
    expect(await within(results).findByRole('link', { name: 'Abrir negociação' })).toBeTruthy();
    const sent = post.mock.calls.find(([path]) => String(path).endsWith('/lead'))?.[1];
    expect(sent).toEqual(
      expect.objectContaining({
        companyName: 'Empresa Confirmada',
        phone: '(21) 90000-0009',
        instagram: '@hamburgueriaexemplo',
        stageId: SEM_CONTATO,
      }),
    );
    const body = JSON.stringify(sent);
    for (const google of ['Hamburgueria Exemplo', '90000-0001', 'hamburgueria-exemplo.com.br'])
      expect(body).not.toContain(google);
  });

  it("does not start Criar lead with the @ that Google's site field showed", async () => {
    const reservedProspect = {
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
    post.mockImplementation(async (path: string) => {
      if (path === '/prospecting/search')
        return answer({
          items: [
            item({
              website: 'https://www.instagram.com/perfilgoogle/',
              instagram: {
                username: 'perfilgoogle',
                source: INSTAGRAM_FROM_GOOGLE_SITE,
                at: null,
                ticket: 't',
              },
            }),
          ],
        });
      if (path === '/prospecting/prospects') return reservedProspect;
      if (path === '/prospecting/prospects/p1/lead') return { leadId: 'l7' };
      throw new Error(`unexpected POST ${path}`);
    });
    const results = await searchOnce();
    fireEvent.click(within(results).getByRole('button', { name: 'Reservar' }));
    fireEvent.click(await within(results).findByRole('button', { name: 'Criar lead' }));

    const dialog = screen.getByRole('dialog', { name: 'Criar lead no funil Formatação' });
    expect((within(dialog).getByLabelText('Instagram') as HTMLInputElement).value).toBe('');

    // Saving without typing the @ sends no Instagram at all: nothing of Google's goes to the lead.
    fireEvent.change(within(dialog).getByLabelText('Empresa'), { target: { value: 'Empresa X' } });
    fireEvent.change(within(dialog).getByLabelText('Telefone'), {
      target: { value: '(21) 90000-0009' },
    });
    fireEvent.change(within(dialog).getByLabelText('Contato'), { target: { value: 'Ana Teste' } });
    fireEvent.click(within(dialog).getByLabelText('Não'));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Criar lead' }));
    expect(await within(results).findByRole('link', { name: 'Abrir negociação' })).toBeTruthy();
    const sent = post.mock.calls.find(([path]) => String(path).endsWith('/lead'))?.[1];
    expect(sent).toEqual(expect.objectContaining({ companyName: 'Empresa X', instagram: '' }));
    expect(JSON.stringify(sent)).not.toContain('perfilgoogle');
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

const savedProspect = {
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

describe('Wings Maps Prospecting', () => {
  const searchNow = async () => {
    renderPage();
    await waitFor(() =>
      expect((screen.getByRole('button', { name: 'Buscar' }) as HTMLButtonElement).disabled).toBe(
        false,
      ),
    );
    fill('Segmento ou nome da empresa', 'padaria');
    fill('Cidade ou bairros', 'Ingá');
    fireEvent.click(screen.getByLabelText('Só com telefone'));
    fireEvent.click(screen.getByRole('button', { name: 'Buscar' }));
    return screen.findByRole('region', { name: 'Resultados' });
  };

  it('reserves the ticked results after a review, and says which did not go and why', async () => {
    post.mockImplementation(async (path: string, body?: unknown) => {
      if (path === '/prospecting/search')
        return answer({
          items: [
            item({}),
            item({
              placeId: 'ChIJ_fake_place_0002',
              name: 'Padaria Incompleta',
              phone: null,
              missing: ['phone'],
            }),
            item({
              placeId: 'ChIJ_fake_place_0003',
              name: 'Padaria Segura',
              prospect: {
                id: 'px',
                status: 'reservado',
                ownerEmployeeId: 'e9',
                ownerName: 'Outra Pessoa',
                mine: false,
              },
            }),
          ],
        });
      if (path === '/prospecting/prospects/batch') {
        expect(body).toEqual({ placeIds: ['ChIJ_fake_place_0001', 'ChIJ_fake_place_0002'] });
        return {
          reserved: 1,
          refused: 1,
          results: [
            { placeId: 'ChIJ_fake_place_0001', ok: true, prospect: savedProspect },
            {
              placeId: 'ChIJ_fake_place_0002',
              ok: false,
              error: 'prospect_taken',
              message: 'Já reservado por Bia.',
            },
          ],
        };
      }
      throw new Error(`unexpected POST ${path}`);
    });
    const results = await searchNow();
    expect(searchPosts()[0]![1]).toMatchObject({ requirePhone: true });
    expect(within(results).getByText('incompleto: sem telefone')).toBeTruthy();
    // Held by someone else: no box to tick.
    expect(within(results).queryByLabelText('Selecionar Padaria Segura')).toBeNull();
    fireEvent.click(within(results).getByRole('button', { name: 'Selecionar todas livres' }));
    fireEvent.click(within(results).getByRole('button', { name: 'Revisar 2 selecionadas' }));
    const review = within(results).getByRole('region', { name: 'Revisão do lote' });
    expect(review.textContent).toContain('Padaria Incompleta · ICP 56 · incompleto: sem telefone');
    expect(post.mock.calls.some(([path]) => path === '/prospecting/prospects/batch')).toBe(false);
    fireEvent.click(within(review).getByRole('button', { name: 'Reservar 2' }));
    const outcome = await within(results).findByRole('status');
    expect(outcome.textContent).toContain('1 reservada · 1 não reservada:');
    expect(outcome.textContent).toContain('Padaria Incompleta — Já reservado por Bia.');
    expect(within(results).getByText('Reservado por você')).toBeTruthy();
  });

  it('puts a past search back in the form without searching', async () => {
    get.mockImplementation(async (path: string) => {
      if (path === '/auth/me') return { user: session };
      if (path === '/prospecting/status') return status;
      if (path === '/prospecting/history')
        return [
          {
            id: 'h1',
            at: '2026-10-26T12:00:00Z',
            employeeName: 'Vendedora Teste',
            mine: true,
            segment: 'confeitarias',
            places: ['Ingá', 'Icaraí'],
            calls: 2,
          },
        ];
      return usage;
    });
    renderPage();
    fireEvent.click(await screen.findByRole('tab', { name: 'Histórico' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Usar no formulário' }));
    expect((screen.getByLabelText('Segmento ou nome da empresa') as HTMLInputElement).value).toBe(
      'confeitarias',
    );
    expect((screen.getByLabelText('Cidade ou bairros') as HTMLTextAreaElement).value).toBe(
      'Ingá\nIcaraí',
    );
    expect(post).not.toHaveBeenCalled();
  });

  it('shows the numbers, and "—" with the reason when they did not load', async () => {
    let fail = false;
    get.mockImplementation(async (path: string) => {
      if (path === '/auth/me') return { user: session };
      if (path === '/prospecting/status') return status;
      if (path === '/prospecting/metrics') {
        if (fail) throw new ApiError(500, {});
        return {
          owners: [
            {
              employeeId: 'e1',
              name: 'Vendedora Teste',
              byStatus: { reservado: 3, virou_lead: 1 },
              total: 4,
              callsThisMonth: 9,
            },
          ],
          byStatus: { reservado: 3, virou_lead: 1 },
          total: 4,
          conversionRate: 0.25,
          callsThisMonth: 9,
        };
      }
      return usage;
    });
    renderPage();
    fireEvent.click(await screen.findByRole('tab', { name: 'Números' }));
    expect(
      await screen.findByText('4 prospects · 25,0% viraram lead · 9 chamadas ao Google no mês'),
    ).toBeTruthy();
    cleanup();
    fail = true;
    renderPage();
    fireEvent.click(await screen.findByRole('tab', { name: 'Números' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Não foi possível carregar');
  });

  it('offers the export only to who holds prospecting.export', async () => {
    renderPage();
    fireEvent.click(await screen.findByRole('tab', { name: 'Meus prospects' }));
    await screen.findByText('Nenhum prospect salvo com esse filtro.');
    expect(screen.queryByRole('button', { name: 'Exportar planilha' })).toBeNull();
    cleanup();
    session = user('gerente_comercial', { 'prospecting.use': 'all', 'prospecting.export': 'all' });
    get.mockImplementation(async (path: string) => {
      if (path === '/auth/me') return { user: session };
      if (path === '/prospecting/status') return status;
      if (path === '/prospecting/prospects') return [];
      if (path === '/prospecting/owners') return [];
      return usage;
    });
    renderPage();
    fireEvent.click(await screen.findByRole('tab', { name: 'Prospects' }));
    expect(await screen.findByRole('button', { name: 'Exportar planilha' })).toBeTruthy();
  });

  it("drafts an approach marked as the AI's, never by WhatsApp, and sends nothing", async () => {
    prospects = [savedProspect];
    post.mockImplementation(async (path: string) => {
      if (path === '/prospecting/prospects/p1/approach')
        return {
          origin: 'ia',
          channel: 'email',
          opening: 'Olá, aqui é da Wings Company.',
          points: ['Como funciona a formatação'],
          nextStep: 'Uma conversa de 20 minutos',
        };
      throw new Error(`unexpected POST ${path}`);
    });
    renderPage();
    fireEvent.click(await screen.findByRole('tab', { name: 'Meus prospects' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Sugerir abordagem (IA)' }));
    const panel = screen.getByRole('region', { name: 'Sugestão de abordagem' });
    const channels = within(panel)
      .getAllByRole('option')
      .map((option) => option.textContent);
    expect(channels).toEqual(['Ligação', 'E-mail', 'Visita']);
    fireEvent.change(within(panel).getByLabelText('Canal'), { target: { value: 'email' } });
    fireEvent.click(within(panel).getByRole('button', { name: 'Sugerir' }));
    expect(await within(panel).findByText('Sugestão da IA — revise antes de usar.')).toBeTruthy();
    expect(within(panel).getByText('Olá, aqui é da Wings Company.')).toBeTruthy();
    expect(post).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledWith('/prospecting/prospects/p1/approach', {
      channel: 'email',
      segment: '',
      context: '',
    });
  });

  it('keeps the approach button off when the AI is not configured', async () => {
    status = { configured: true, aiConfigured: false };
    prospects = [savedProspect];
    renderPage();
    fireEvent.click(await screen.findByRole('tab', { name: 'Meus prospects' }));
    const button = (await screen.findByRole('button', {
      name: 'Sugerir abordagem (IA)',
    })) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
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

describe('correções de 29/10: atribuição, falha parcial, prazos', () => {
  const RETENTION = { reservedDays: 30, contactedDays: 90, enrichmentDays: 180 };

  it('says which places of a sweep did not answer, and why', () => {
    expect(failedPlacesLine([], 3)).toBeNull();
    expect(
      failedPlacesLine(
        [
          { place: 'Ingá', code: 'timeout' },
          { place: 'Centro', code: 'unavailable' },
        ],
        5,
      ),
    ).toBe(
      '2 de 5 locais não responderam: Ingá (o Google demorou demais), Centro (o Google não respondeu). As chamadas contaram na cota.',
    );
  });

  it('counts the days left on a reservation, from the deadline of its status', () => {
    const now = new Date('2026-10-29T12:00:00Z');
    const at = (daysAgo: number) => new Date(now.getTime() - daysAgo * 86_400_000).toISOString();
    expect(expiryLine({ status: 'reservado', updatedAt: at(5) }, RETENTION, now)).toBe(
      'a reserva expira em 25 dias',
    );
    expect(expiryLine({ status: 'contatado', updatedAt: at(89) }, RETENTION, now)).toBe(
      'a reserva expira em 1 dia',
    );
    expect(expiryLine({ status: 'reservado', updatedAt: at(31) }, RETENTION, now)).toBe(
      'a reserva expira hoje',
    );
    expect(expiryLine({ status: 'descartado', updatedAt: at(1) }, RETENTION, now)).toBeNull();
    expect(expiryLine({ status: 'virou_lead', updatedAt: at(1) }, RETENTION, now)).toBeNull();
  });

  it("shows Google's logo in the results and the places that failed", async () => {
    post.mockResolvedValue(
      answer({ callsSpent: 2, failedPlaces: [{ place: 'Ingá', code: 'timeout' }] }),
    );
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderPage();
    await waitFor(() =>
      expect((screen.getByRole('button', { name: 'Buscar' }) as HTMLButtonElement).disabled).toBe(
        false,
      ),
    );
    fill('Segmento ou nome da empresa', 'hamburgueria');
    fill('Cidade ou bairros', 'Icaraí, Ingá');
    fireEvent.click(screen.getByRole('button', { name: 'Buscar' }));
    const results = await screen.findByRole('region', { name: 'Resultados' });
    const logo = within(results).getByRole('img', { name: 'Google Maps' });
    expect(logo.getAttribute('src')).toBe('/google/GoogleMaps_Logo_Gray.svg');
    expect(logo.getAttribute('height')).toBe('18');
    expect(within(results).getByRole('alert').textContent).toBe(
      '— 1 de 2 locais não responderam: Ingá (o Google demorou demais). As chamadas contaram na cota.',
    );
    // The results of the place that answered are still there.
    expect(within(results).getAllByRole('link', { name: 'Abrir no Google Maps' })).toHaveLength(2);
  });

  it('no failure line when every place answered', async () => {
    post.mockResolvedValue(answer());
    renderPage();
    await waitFor(() =>
      expect((screen.getByRole('button', { name: 'Buscar' }) as HTMLButtonElement).disabled).toBe(
        false,
      ),
    );
    fill('Segmento ou nome da empresa', 'hamburgueria');
    fill('Cidade ou bairros', 'Niterói');
    fireEvent.click(screen.getByRole('button', { name: 'Buscar' }));
    const results = await screen.findByRole('region', { name: 'Resultados' });
    expect(within(results).queryByText(/locais não responderam/)).toBeNull();
  });

  it('the card of a reserved prospect says when the reservation expires', async () => {
    prospects = [
      { ...savedProspect, updatedAt: new Date(Date.now() - 10 * 86_400_000).toISOString() },
    ];
    renderPage();
    fireEvent.click(await screen.findByRole('tab', { name: 'Meus prospects' }));
    expect(await screen.findByText(/a reserva expira em 20 dias/)).toBeTruthy();
  });

  it('Ajustes has the deadlines for whoever configures, the 180 days marked for the lawyer', async () => {
    session = MANAGER;
    renderPage();
    fireEvent.click(await screen.findByRole('tab', { name: 'Ajustes' }));
    const form = await screen.findByRole('form', { name: 'Prazos' });
    expect(
      (within(form).getByLabelText('Reserva sem atualização (dias)') as HTMLInputElement).value,
    ).toBe('30');
    expect(
      (
        within(form).getByLabelText(
          'Dados do site guardados sem atualização (dias)',
        ) as HTMLInputElement
      ).value,
    ).toBe('180');
    expect(within(form).getByText(/a validar com o advogado/)).toBeTruthy();
  });
});
