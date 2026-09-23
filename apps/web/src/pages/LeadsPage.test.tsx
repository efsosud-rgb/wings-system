import type { Lead, LeadListItem, SessionUser } from '@wings/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const get = vi.fn();
const post = vi.fn();
vi.mock('../api/client.js', async (original) => ({
  ...(await original<typeof import('../api/client.js')>()),
  api: {
    get: (path: string) => get(path),
    post: (path: string, body?: unknown) => post(path, body),
  },
}));

const { LeadsPage } = await import('./LeadsPage.js');
const { LeadPage } = await import('./LeadPage.js');
const { ApiError } = await import('../api/client.js');

const manager: SessionUser = {
  employeeId: 'e1',
  fullName: 'Gerente',
  email: 'g@wingscompany.com.br',
  cargo: 'Gerente',
  role: 'gerente_comercial',
  sector: 'comercial',
  isSectorManager: false,
  tracksTime: false,
  permissions: { 'leads.read': 'all', 'leads.write': 'all' },
  lastLoginAt: null,
  sessionExpiresAt: '2026-09-23T23:00:00Z',
};

const item: LeadListItem = {
  id: 'lead-1',
  name: 'Ana Souza',
  email: 'ana@example.com',
  phone: '5519999998888',
  clientName: 'Burger Prime',
  clientMapped: true,
  source: 'rd_station',
  channel: 'landing_page',
  score: 72,
  researchState: 'done',
  createdAt: '2026-09-23T14:00:00Z',
};

const lead: Lead = {
  id: 'lead-1',
  name: 'Ana Souza',
  email: 'ana@example.com',
  phone: '5519999998888',
  status: 'new',
  ownerEmployeeId: null,
  firstMessage: null,
  whatsapp: { profileName: 'Ana S.', photoUrl: null },
  origin: {
    clientId: 'c1',
    clientName: 'Burger Prime',
    clientMapped: true,
    source: 'rd_station',
    channel: 'landing_page',
    landingPage: 'https://franquia.wingscompany.com.br/burger-prime',
    campaignId: null,
    campaignName: null,
    formId: null,
    trackingCode: null,
    externalId: 'rd-1',
  },
  consent: {
    legalBasis: 'consent',
    consentedAt: '2026-09-23T13:59:00Z',
    source: 'rd_station:lp-burger-prime',
    text: 'Formulário da landing page (RD Station), com aceite dos termos na conversão.',
  },
  research: {
    state: 'done',
    summary: 'Linha 1\nLinha 2\nLinha 3\nLinha 4\nPerfil de franqueado: 72/100',
    score: 72,
    criteria: [
      { key: 'capital', label: 'Capital provável', points: 25, max: 40, evaluated: true, reasons: ['E-mail em domínio próprio (aurora.com.br).'] },
      { key: 'management', label: 'Experiência em gestão', points: 20, max: 30, evaluated: true, reasons: ['Perfil público no LinkedIn encontrado.'] },
      { key: 'location', label: 'Cidade na área de expansão', points: 0, max: 30, evaluated: false, reasons: ['O cliente não tem área de expansão cadastrada: região não avaliada.'] },
    ],
    links: [{ kind: 'linkedin', url: 'https://www.linkedin.com/in/ana', title: 'Ana Souza - Diretora', snippet: 'Diretora comercial.' }],
    facts: null,
    error: null,
    updatedAt: '2026-09-23T14:05:00Z',
    costUsd: 0.01,
  },
  createdAt: '2026-09-23T14:00:00Z',
  updatedAt: '2026-09-23T14:05:00Z',
};

function renderAt(path: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/crm-vendas/funil" element={<LeadsPage />} />
          <Route path="/crm-vendas/funil/:id" element={<LeadPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  get.mockReset().mockImplementation(async (path: string) => {
    if (path === '/auth/me') return { user: manager };
    if (path === '/clients') return { clients: [] };
    if (path.startsWith('/leads/lead-1')) return { lead, events: [{ id: 'ev1', at: '2026-09-23T14:00:00Z', kind: 'lead.received.rd_station', detail: {} }] };
    if (path.startsWith('/leads')) return { leads: [item, { ...item, id: 'lead-2', name: null, clientMapped: false, score: null, researchState: 'pending', source: 'whatsapp_link', channel: 'instagram' }] };
    throw new Error(`unexpected GET ${path}`);
  });
  post.mockReset();
});
afterEach(cleanup);

describe('CRM Vendas → Funil', () => {
  it('lists the leads with client, origin and the profile score, and flags an unmapped one', async () => {
    renderAt('/crm-vendas/funil');
    const ana = (await screen.findByRole('link', { name: 'Ana Souza' })).closest('tr') as HTMLElement;
    expect(within(ana).getByText('(19) 99999-8888')).toBeTruthy();
    expect(within(ana).getByText('Burger Prime')).toBeTruthy();
    expect(within(ana).getByText('Landing page (RD Station)')).toBeTruthy();
    expect(within(ana).getByText('72/100')).toBeTruthy();

    const nameless = screen.getByRole('link', { name: 'Sem nome' }).closest('tr') as HTMLElement;
    expect(within(nameless).getByText('sem regra')).toBeTruthy();
    expect(within(nameless).getByText('Na fila')).toBeTruthy();
    expect(within(nameless).getByText('Instagram')).toBeTruthy();
  });

  it('registers a lead by hand with its legal basis and goes to its page', async () => {
    post.mockResolvedValue({ lead: { ...lead, id: 'lead-1' }, created: true });
    renderAt('/crm-vendas/funil');
    fireEvent.click(await screen.findByRole('button', { name: 'Novo lead' }));
    const submit = screen.getByRole('button', { name: 'Cadastrar e pesquisar' });
    expect(submit).toHaveProperty('disabled', true);
    fireEvent.change(screen.getByLabelText(/^Nome/), { target: { value: 'Carlos Dias' } });
    fireEvent.change(screen.getByLabelText(/Telefone/), { target: { value: '11 98888-7777' } });
    fireEvent.change(screen.getByLabelText(/Base legal/), { target: { value: 'pre_contract' } });
    fireEvent.change(screen.getByLabelText(/Onde e quando/), { target: { value: 'Feira de franquias, 20/09' } });
    fireEvent.click(submit);
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith('/leads', {
        name: 'Carlos Dias',
        email: undefined,
        phone: '11 98888-7777',
        clientId: undefined,
        channel: undefined,
        legalBasis: 'pre_contract',
        consentText: 'Feira de franquias, 20/09',
      }),
    );
    // Landed on the lead's page.
    expect(await screen.findByRole('heading', { name: 'Ana Souza' })).toBeTruthy();
  });

  it('shows the Origem, LGPD and Pesquisa blocks with the score reasons, and asks the research again', async () => {
    post.mockResolvedValue({ lead: { ...lead, research: { ...lead.research, state: 'pending' } }, events: [] });
    renderAt('/crm-vendas/funil/lead-1');
    expect(await screen.findByRole('heading', { name: 'Ana Souza' })).toBeTruthy();

    // Origem
    expect(screen.getByText('Burger Prime')).toBeTruthy();
    expect(screen.getByText('https://franquia.wingscompany.com.br/burger-prime')).toBeTruthy();
    // LGPD
    expect(screen.getByText('Consentimento do titular (art. 7º, I)')).toBeTruthy();
    expect(screen.getByText('Formulário da landing page (RD Station), com aceite dos termos na conversão.')).toBeTruthy();
    // Pesquisa: five lines, the score, each criterion with its reasons, the link found.
    expect(screen.getByLabelText('Resumo da pesquisa').querySelectorAll('p')).toHaveLength(5);
    expect(screen.getByText('72')).toBeTruthy();
    expect(screen.getByText('25/40')).toBeTruthy();
    expect(screen.getByText('não avaliado')).toBeTruthy();
    expect(screen.getByText('E-mail em domínio próprio (aurora.com.br).')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'LinkedIn: Ana Souza - Diretora' })).toBeTruthy();
    expect(screen.getByText('Conversão recebida do RD Station')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Refazer pesquisa' }));
    await waitFor(() => expect(post).toHaveBeenCalledWith('/leads/lead-1/research', undefined));
  });

  it('says so when the research is already queued', async () => {
    post.mockRejectedValue(new ApiError(409, { error: 'research_in_progress', message: 'A pesquisa deste lead já está na fila. Aguarde ela terminar.' }));
    renderAt('/crm-vendas/funil/lead-1');
    fireEvent.click(await screen.findByRole('button', { name: 'Refazer pesquisa' }));
    expect(await screen.findByText('A pesquisa deste lead já está na fila. Aguarde ela terminar.')).toBeTruthy();
  });
});
