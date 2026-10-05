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
    post: (path: string, body?: unknown) => post(path, body),
  },
}));

const { CampaignLeadsPage } = await import('./CampaignLeadsPage.js');

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
    expect(await screen.findByText('Você vê só os leads que o RD atribui a você.')).toBeTruthy();
  });
});
