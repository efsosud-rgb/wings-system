import {
  DEFAULT_ICP_WEIGHTS,
  icpScore,
  type InstagramDiscoveryResponse,
  type InstagramSnapshotView,
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

const { ProspectingPage } = await import('./ProspectingPage.js');

/** Prospecção → busca: the Instagram column and the 0-100 score with Meta's numbers (§1.3, §6). */

const SELLER: SessionUser = {
  employeeId: 'e1',
  fullName: 'Vendedora Teste',
  email: 'vendedora@example.com',
  cargo: 'Vendedora',
  role: 'vendedor_formatacao',
  sector: 'comercial',
  isSectorManager: false,
  tracksTime: false,
  permissions: { 'prospecting.use': 'own', 'leads.write': 'own' },
  lastLoginAt: null,
  sessionExpiresAt: '2026-10-26T23:00:00Z',
};

// Made-up companies and @: no real business.
const google = {
  rating: 4.3,
  reviews: 60,
  hasWebsite: true,
  hasInstagram: false,
  multiUnit: false,
};
const item = (n: number, username: string | null): ProspectSearchItem => ({
  placeId: `ChIJ_fake_place_000${n}`,
  name: `Empresa Exemplo ${n}`,
  address: 'Rua Fictícia, 100 - Icaraí, Niterói - RJ',
  phone: `(21) 90000-000${n}`,
  website: username ? `https://www.instagram.com/${username}/` : 'https://exemplo.invalid/',
  rating: 4.3,
  reviews: 60,
  businessStatus: 'OPERATIONAL',
  mapsUri: `https://maps.google.com/?cid=${n}`,
  types: ['restaurant'],
  icp: icpScore(google),
  instagram: username
    ? { username, source: 'site no Google', at: null, ticket: `ticket-${n}` }
    : null,
  missing: [],
  tags: [],
  prospect: null,
  leadId: null,
});
const ITEMS = [item(1, 'empresa.exemplo1'), item(2, 'empresa.exemplo2'), item(3, null)];
const answer: ProspectSearchResponse = {
  items: ITEMS,
  nextPageToken: null,
  page: 1,
  callsSpent: 1,
  hidden: { excluded: 0, filtered: 0, heldByOthers: 0, repeated: 0 },
  failedPlaces: [],
  usage: {
    today: { used: 1, limit: 40 },
    month: { searches: 1, searchLimit: 950, details: 0, detailsLimit: 950 },
  },
};
const snapshot = (username: string): InstagramSnapshotView => ({
  username,
  status: 'encontrada',
  followers: 12_000,
  posts: 340,
  recentMediaRead: 12,
  avgLikesMilli: 150_000,
  avgCommentsMilli: 8_000,
  postsLast30d: 6,
  lastPostAt: '2026-11-02T15:00:00.000Z',
  source: 'meta_business_discovery',
  fetchedAt: '2026-11-04T15:00:00.000Z',
});
const discovery: InstagramDiscoveryResponse = {
  items: [
    {
      username: 'empresa.exemplo1',
      snapshot: { ...snapshot('empresa.exemplo1'), status: 'nao_comercial' },
      reason: 'a Meta só mostra conta comercial; esta é pessoal, privada ou não existe',
    },
    { username: 'empresa.exemplo2', snapshot: snapshot('empresa.exemplo2'), reason: null },
  ],
  holdUntil: null,
  usage: { today: 2, limit: 500 },
};

let status = { configured: true, aiConfigured: true, instagramDiscovery: true };
let discover: () => Promise<InstagramDiscoveryResponse> = async () => discovery;

beforeEach(() => {
  status = { configured: true, aiConfigured: true, instagramDiscovery: true };
  discover = async () => discovery;
  get.mockReset().mockImplementation(async (path: string) => {
    if (path === '/auth/me') return { user: SELLER };
    if (path === '/prospecting/status') return status;
    if (path === '/prospecting/usage') return answer.usage;
    if (path === '/prospecting/settings')
      return {
        icp: { weights: DEFAULT_ICP_WEIGHTS, excludedNames: [] },
        quota: { perUserDaily: 40, monthlySearches: 950, monthlyDetails: 950 },
        retention: { reservedDays: 30, contactedDays: 90, enrichmentDays: 180 },
        updatedAt: null,
      };
    throw new Error(`unexpected GET ${path}`);
  });
  post.mockReset().mockImplementation(async (path: string) => {
    if (path === '/prospecting/search') return answer;
    if (path === '/prospecting/instagram/discovery') return discover();
    throw new Error(`unexpected POST ${path}`);
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

async function searchOnce() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <ProspectingPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  await waitFor(() =>
    expect((screen.getByRole('button', { name: 'Buscar' }) as HTMLButtonElement).disabled).toBe(
      false,
    ),
  );
  fireEvent.change(screen.getByLabelText('Segmento ou nome da empresa'), {
    target: { value: 'hamburgueria' },
  });
  fireEvent.change(screen.getByLabelText('Cidade ou bairros'), { target: { value: 'Niterói' } });
  fireEvent.click(screen.getByRole('button', { name: 'Buscar' }));
  return screen.findByRole('region', { name: 'Resultados' });
}
const discoveryPosts = () =>
  post.mock.calls.filter(([path]) => path === '/prospecting/instagram/discovery');
const rowOf = (results: HTMLElement, name: string) =>
  within(results).getByText(name).closest('tr') as HTMLElement;

describe('Instagram column and the 0-100 score', () => {
  it('asks Meta once for the companies with a known @, with their tickets', async () => {
    await searchOnce();
    await waitFor(() => expect(discoveryPosts()).toHaveLength(1));
    expect(discoveryPosts()[0]![1]).toEqual({
      items: [
        { username: 'empresa.exemplo1', ticket: 'ticket-1' },
        { username: 'empresa.exemplo2', ticket: 'ticket-2' },
      ],
    });
  });

  it('shows the numbers with the date and moves the business account up by its new score', async () => {
    const results = await searchOnce();
    expect(await within(results).findByText(/12\.000 seguidores/)).toBeTruthy();
    const row = rowOf(results, 'Empresa Exemplo 2');
    expect(within(row).getByText(/Meta, lido em 04\/11/)).toBeTruthy();
    expect(within(row).getByText(/150 curtidas · 8 comentários/)).toBeTruthy();
    // Google 3 of 9 (4.3 +1, 60 reviews +1, a site +1) plus Instagram 8 of 8: 11 of 17.
    const score = within(row).getByTitle(/11 de 17 pontos/);
    expect(score.textContent).toBe('65');
    expect(score.title).toContain('Instagram: Meta, lido em 04/11');
    const names = within(results)
      .getAllByRole('row')
      .slice(1)
      .map((tr) => tr.querySelector('b')?.textContent);
    expect(names[0]).toBe('Empresa Exemplo 2');
  });

  it('a personal account is "—" with the reason, and its score stays Google\'s', async () => {
    const results = await searchOnce();
    await within(results).findByText(/12\.000 seguidores/);
    const row = rowOf(results, 'Empresa Exemplo 1');
    expect(
      within(row).getByText(
        '— a Meta só mostra conta comercial; esta é pessoal, privada ou não existe',
      ),
    ).toBeTruthy();
    expect(within(row).getByTitle(/3 de 9 pontos/).textContent).toBe('33');
    expect(
      within(rowOf(results, 'Empresa Exemplo 3')).getByText('— sem Instagram conhecido'),
    ).toBeTruthy();
  });

  it('a criterion without data is listed as out of the count, not as zero', async () => {
    discover = async () => ({
      ...discovery,
      items: [
        discovery.items[0]!,
        {
          ...discovery.items[1]!,
          snapshot: { ...snapshot('empresa.exemplo2'), avgLikesMilli: null },
        },
      ],
    });
    const results = await searchOnce();
    await within(results).findByText(/— curtidas \(ocultas ou sem dado\)/);
    const score = within(rowOf(results, 'Empresa Exemplo 2')).getByTitle(/9 de 15 pontos/);
    expect(score.title).toContain('Instagram: engajamento ≥ 1%: — sem dado (fora da conta)');
  });

  it('off: no call to Meta, and the column says why', async () => {
    status = { ...status, instagramDiscovery: false };
    const results = await searchOnce();
    expect(
      within(rowOf(results, 'Empresa Exemplo 2')).getByText('— consulta ao Instagram desligada'),
    ).toBeTruthy();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(discoveryPosts()).toHaveLength(0);
  });

  it('a failed lookup shows "—" and the reason, never empty numbers', async () => {
    discover = async () => {
      throw new ApiError(503, {
        error: 'instagram_discovery_off',
        message: 'A consulta ao Instagram (Meta) está desligada neste ambiente.',
      });
    };
    const results = await searchOnce();
    const row = rowOf(results, 'Empresa Exemplo 2');
    expect(await within(row).findByText('— o servidor teve um problema (erro 503)')).toBeTruthy();
  });

  it('a hold from Meta is said with its hour', async () => {
    discover = async () => ({ ...discovery, holdUntil: '2026-11-04T16:30:00.000Z' });
    const results = await searchOnce();
    expect(
      await within(results).findByText('Instagram em espera até 13:30: a Meta pediu para esperar.'),
    ).toBeTruthy();
  });
});
