import type { CampaignLeadsResponse } from '@wings/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

const get = vi.fn();
const post = vi.fn();
vi.mock('../api/client.js', async (original) => ({
  ...(await original<typeof import('../api/client.js')>()),
  api: {
    get: (path: string) => get(path),
    // The list refreshes itself as a passive read; the test answers it like any read.
    poll: (path: string) => get(path),
    post: (path: string, body?: unknown) => post(path, body),
  },
}));

const { CampaignLeadsPage } = await import('./CampaignLeadsPage.js');
const { ApiError } = await import('../api/client.js');

const response = (overrides: Partial<CampaignLeadsResponse> = {}): CampaignLeadsResponse => ({
  scope: 'all',
  summary: {
    since: '2026-09-28T00:00:00-03:00',
    fetchedAt: '2026-09-28T20:00:00.000Z',
    today: 1,
    week: 1,
    total: 1,
    contactedPercent: 100,
    averageFirstContactMinutes: 3,
    stages: [{ stage: 'Tentando contato', count: 1 }],
    lost: [],
    unattributed: [{ reason: 'not_paid', count: 1 }],
    unattributedPercent: 50,
    outOfAccount: 0,
    tests: 2,
    smallSample: true,
  },
  leads: [
    {
      id: 'l1',
      enteredAt: '2026-09-28T17:00:00.000Z',
      name: 'Lead Um',
      company: 'Padaria Um',
      segment: null,
      city: null,
      platform: 'meta',
      campaignName: 'META | Formatação | 28Set',
      adSetName: 'Conjunto Jimmy',
      adName: 'Vídeo Jimmy',
      attribution: 'utm',
      utmCampaign: 'formatacao_jimmyogro_set26',
      utmContent: 'ad-1',
      pipeline: 'Formatação',
      stage: 'Tentando contato',
      owner: 'Vendedora A',
      firstContactMinutes: 3,
      firstContactSource: 'activity',
      temperature: 'quente',
      lastActivityAt: null,
      phoneMasked: '(21) ••••-••32',
      emailMasked: 'l•••@e•••.com',
      win: null,
      lostReason: null,
    },
  ],
  ...overrides,
});

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <CampaignLeadsPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  get.mockReset();
  post.mockReset();
});

describe('Leads das Campanhas', () => {
  it('lists the lead with its campaign and ad, the tests left out and the small-sample flag', async () => {
    get.mockResolvedValue(response());
    renderPage();
    const row = (await screen.findByText('Lead Um')).closest('tr')!;
    expect(within(row).getByText('META | Formatação | 28Set')).toBeTruthy();
    expect(within(row).getByText(/Vídeo Jimmy/)).toBeTruthy();
    expect(within(row).getByText(/conjunto Conjunto Jimmy/)).toBeTruthy();
    expect(within(row).getByText('3 min').className).toContain('status-active');
    expect(within(row).getByText('Quente')).toBeTruthy();
    expect(screen.getByText('Amostra pequena')).toBeTruthy();
    expect(screen.getByText(/2 negócio\(s\) de teste ignorado/)).toBeTruthy();
    expect(screen.getByText(/A origem no RD não é mídia paga/)).toBeTruthy();
  });

  it('draws stages, losses and the deals left out, each with its table', async () => {
    get.mockResolvedValue(response());
    renderPage();
    const stages = await screen.findByRole('region', { name: 'Por etapa' });
    expect(within(stages).getByRole('cell', { name: 'Tentando contato' })).toBeTruthy();
    expect(
      within(screen.getByRole('region', { name: 'Perdidos, com motivo' })).getByText(
        'nenhum perdido no período',
      ),
    ).toBeTruthy();
    const left = screen.getByRole('region', { name: 'Sem atribuição, por motivo' });
    expect(
      within(left).getByRole('cell', { name: /A origem no RD não é mídia paga/ }),
    ).toBeTruthy();
  });

  it('says how many deals arrived before 28/09 and stay out of every number', async () => {
    const base = response();
    get.mockResolvedValue({
      ...base,
      summary: {
        ...base.summary,
        outOfAccount: 18,
        unattributed: [
          { reason: 'arrived_before_cutoff', count: 18 },
          { reason: 'not_paid', count: 2 },
        ],
      },
    });
    renderPage();
    expect(
      await screen.findByText(/18 negócio\(s\) de lead que chegou antes de 28\/09 ficam fora/),
    ).toBeTruthy();
    const left = screen.getByRole('region', { name: 'Sem atribuição, por motivo' });
    expect(within(left).getByRole('cell', { name: /Chegou antes de 28\/09/ })).toBeTruthy();
  });

  it('shows the phone masked until "revelar", which asks the server', async () => {
    get.mockResolvedValue(response());
    post.mockResolvedValue({ value: '+55 21 99876-5432' });
    renderPage();
    const row = (await screen.findByText('Lead Um')).closest('tr')!;
    expect(within(row).queryByText('+55 21 99876-5432')).toBeNull();
    fireEvent.click(within(row).getAllByRole('button', { name: 'revelar' })[0]!);
    await waitFor(() => expect(within(row).getByText('+55 21 99876-5432')).toBeTruthy());
    expect(post).toHaveBeenCalledWith('/campaign-leads/l1/reveal', { field: 'phone' });
  });

  it('tells a salesperson they see only their own leads', async () => {
    get.mockResolvedValue(response({ scope: 'own' }));
    renderPage();
    expect(await screen.findByText('Você vê só os leads que estão com você.')).toBeTruthy();
  });

  it('says why the leads did not load, with no summary and no "Nenhum lead" line', async () => {
    get.mockRejectedValue(new ApiError(500, {}));
    renderPage();
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Não foi possível carregar os leads');
    expect(alert.textContent).toContain('erro 500');
    expect(screen.queryByText(/Nenhum lead das campanhas/)).toBeNull();
    expect(screen.queryByRole('region', { name: 'Resumo' })).toBeNull();
  });

  it('still says "Nenhum lead das campanhas" when the answer came back with none', async () => {
    get.mockResolvedValue(response({ leads: [] }));
    renderPage();
    expect(await screen.findByText(/Nenhum lead das campanhas desde 28\/09/)).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
