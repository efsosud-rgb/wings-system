import { WINGS_CLIENT_ID, type Client, type ClientProject, type SessionUser } from '@wings/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const get = vi.fn();
const post = vi.fn();
const patch = vi.fn();
vi.mock('../api/client.js', async (original) => ({
  ...(await original<typeof import('../api/client.js')>()),
  api: {
    get: (path: string) => get(path),
    post: (path: string, body?: unknown) => post(path, body),
    patch: (path: string, body?: unknown) => patch(path, body),
  },
}));

const { ClientsPage } = await import('./ClientsPage.js');
const { ApiError } = await import('../api/client.js');

const AURORA: Client = {
  id: '11111111-1111-4111-8111-1111111111c2',
  name: 'Padaria Aurora',
  slug: 'padaria-aurora',
  active: true,
  expansionArea: [],
  number: 3,
};
const WINGS: Client = {
  id: WINGS_CLIENT_ID,
  name: 'Wings Company',
  slug: 'wings-company',
  active: true,
  expansionArea: [],
  number: null,
};

const AURORA_PROJECT: ClientProject = {
  id: 'p-1',
  hidden: false,
  clientId: AURORA.id,
  clientName: AURORA.name,
  clientNumber: 3,
  clientActive: true,
  status: 'em_andamento',
  currentStage: '04',
  updatedAt: '2026-09-24T12:00:00.000Z',
  updatedByName: null,
  stages: [],
  canManage: true,
};

const user = (role: SessionUser['role'], permissions: SessionUser['permissions']): SessionUser => ({
  employeeId: 'e1',
  fullName: 'Pessoa',
  email: 'p@wingscompany.com.br',
  cargo: 'Cargo',
  role,
  sector: 'marketing',
  isSectorManager: false,
  tracksTime: true,
  permissions,
  lastLoginAt: null,
  sessionExpiresAt: '2026-09-24T23:00:00Z',
});
const MARKETING = user('marketing', {
  'clients.manage': 'all',
  'clients.read': 'all',
  'clients.edit': 'all',
});
const LEGAL = user('formatacao_juridico', {
  'clients.read': 'all',
  'clients.edit': 'all',
  'clients.sensitive': 'all',
});
let me: SessionUser = MARKETING;

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <ClientsPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  me = MARKETING;
  get.mockReset().mockImplementation(async (path: string) => {
    if (path === '/auth/me') return { user: me };
    if (path === '/clients') return { clients: [WINGS, AURORA] };
    if (path === '/leads/source-rules') return { rules: [] };
    if (path.endsWith('/tracking-links')) return { links: [], phoneConfigured: true };
    if (path === '/projects?inactive=true') return { projects: [AURORA_PROJECT] };
    throw new Error(`unexpected GET ${path}`);
  });
  post.mockReset();
  patch.mockReset();
});
afterEach(cleanup);

describe('Formatação → Clientes', () => {
  it('lists Wings Company as the fixed default, with nothing to click on its row', async () => {
    renderPage();
    const wings = (await screen.findByRole('cell', { name: /Wings Company/ })).closest(
      'tr',
    ) as HTMLElement;
    expect(within(wings).getByText('padrão')).toBeTruthy();
    expect(within(wings).queryByRole('button')).toBeNull();

    const aurora = screen
      .getByRole('cell', { name: 'Padaria Aurora' })
      .closest('tr') as HTMLElement;
    expect(within(aurora).getByRole('button', { name: 'Editar' })).toBeTruthy();
    expect(within(aurora).getByRole('button', { name: 'Desativar' })).toBeTruthy();
  });

  it('keeps "Cadastrar cliente" off until the new register is complete, and shows the old ones as incomplete', async () => {
    get.mockImplementation(async (path: string) => {
      if (path === '/auth/me') return { user: me };
      if (path === '/clients')
        return {
          clients: [WINGS, { ...AURORA, registerMissing: ['CNPJ', 'Relação com a Wings'] }],
        };
      if (path === '/leads/source-rules') return { rules: [] };
      if (path.startsWith('/projects')) return { projects: [] };
      throw new Error(`unexpected GET ${path}`);
    });
    renderPage();
    const row = (await screen.findByRole('cell', { name: /Padaria Aurora/ })).closest(
      'tr',
    ) as HTMLElement;
    expect(within(row).getByText('Cadastro incompleto')).toBeTruthy();
    expect(within(row).getByText(/Falta: CNPJ, Relação com a Wings/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/Nome do cliente/), {
      target: { value: 'Padaria Nova' },
    });
    expect(screen.getByRole('button', { name: 'Cadastrar cliente' })).toHaveProperty(
      'disabled',
      true,
    );
  });

  it('registers with the Receita data from the CNPJ, the main contact, the relationship and the franchise profile', async () => {
    post.mockImplementation(async (path: string) => {
      if (path === '/clients/lookup/cnpj') {
        return {
          source: 'brasilapi',
          registrationStatus: 'ATIVA',
          company: {
            legalName: 'AURORA PAES LTDA',
            tradeName: 'Aurora Pães',
            cnaeMain: '1091-1/02 - Fabricação de produtos de padaria',
            openedOn: '2015-03-02',
            address: { city: 'Campinas', state: 'SP' },
          },
          partners: [],
        };
      }
      return { client: AURORA };
    });
    renderPage();
    await screen.findByRole('cell', { name: /Padaria Aurora/ });
    fireEvent.change(screen.getByLabelText(/^CNPJ/), { target: { value: '11.222.333/0001-80' } });
    expect(screen.getByText('CNPJ inválido')).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/^CNPJ/), { target: { value: '11.222.333/0001-81' } });
    fireEvent.click(screen.getByRole('button', { name: 'Buscar' }));
    await waitFor(() =>
      expect(screen.getByLabelText(/Nome do cliente/)).toHaveProperty('value', 'Aurora Pães'),
    );
    expect(screen.getByText('Receita (brasilapi): ATIVA')).toBeTruthy();
    expect(screen.getByLabelText(/Razão social/)).toHaveProperty('value', 'AURORA PAES LTDA');
    expect(screen.getByLabelText(/Segmento/)).toHaveProperty(
      'value',
      'Fabricação de produtos de padaria',
    );

    const change = (label: RegExp, value: string) =>
      fireEvent.change(screen.getByLabelText(label), { target: { value } });
    change(/^Contato principal/, 'Ana');
    change(/E-mail do contato/, 'ana@aurora.com.br');
    change(/WhatsApp do contato/, '(11) 98888-7777');
    change(/Relação com a Wings/, 'ambos');
    change(/^Unidades/, '3');
    change(/Faixa de faturamento/, 'nao_informado');
    change(/Franqueabilidade/, 'alta');
    change(/Fit Wings/, 'nao_avaliado');
    change(/Fonte do dado/, 'Reunião com a sócia');
    change(/Data do dado/, '2026-09-30');
    fireEvent.click(screen.getByRole('button', { name: 'Cadastrar cliente' }));
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith('/clients', {
        name: 'Aurora Pães',
        cnpj: '11222333000181',
        company: {
          legalName: 'AURORA PAES LTDA',
          tradeName: 'Aurora Pães',
          cnaeMain: '1091-1/02 - Fabricação de produtos de padaria',
          openedOn: '2015-03-02',
          city: 'Campinas',
          state: 'SP',
        },
        contact: { name: 'Ana', email: 'ana@aurora.com.br', whatsapp: '(11) 98888-7777' },
        relationship: 'ambos',
        business: {
          segment: 'Fabricação de produtos de padaria',
          ownUnits: 3,
          revenueBand: null,
          franchisability: 'alta',
          wingsFit: 'nao_avaliado',
          profileSource: 'Reunião com a sócia',
          profileDate: '2026-09-30',
        },
      }),
    );
  });

  it('gives Jurídico the record of each client, and nothing to register, rename or deactivate', async () => {
    me = LEGAL;
    renderPage();
    const aurora = (await screen.findByRole('cell', { name: 'Padaria Aurora' })).closest(
      'tr',
    ) as HTMLElement;
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Cadastrar cliente' })).toBeNull(),
    );
    expect(within(aurora).getByRole('link', { name: 'Ficha' }).getAttribute('href')).toBe(
      `/formatacao/clientes/${AURORA.id}`,
    );
    expect(within(aurora).queryByRole('button', { name: 'Editar' })).toBeNull();
    expect(screen.queryByText('Origens de leads')).toBeNull();
  });

  it('deactivates a client with one click', async () => {
    patch.mockResolvedValue({ client: { ...AURORA, active: false } });
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Desativar' }));
    await waitFor(() =>
      expect(patch).toHaveBeenCalledWith(`/clients/${AURORA.id}`, {
        name: undefined,
        active: false,
      }),
    );
  });
  it("opens the client's links and expansion area, generates a wa.me link and saves the area", async () => {
    get.mockImplementation(async (path: string) => {
      if (path === '/auth/me') return { user: me };
      if (path === '/clients') return { clients: [WINGS, AURORA] };
      if (path === '/leads/source-rules') return { rules: [] };
      if (path === `/clients/${AURORA.id}/tracking-links`) {
        return {
          links: [
            {
              id: 'l1',
              clientId: AURORA.id,
              channel: 'instagram',
              code: 'K7M2QX',
              phone: '5511999990000',
              url: 'https://wa.me/5511999990000?text=K7M2QX',
              hits: 3,
              lastHitAt: null,
              createdAt: '2026-09-23T12:00:00Z',
            },
          ],
          phoneConfigured: true,
        };
      }
      throw new Error(`unexpected GET ${path}`);
    });
    post.mockResolvedValue({ link: { id: 'l2', url: 'https://wa.me/5511999990000?text=ABCDEF' } });
    patch.mockResolvedValue({
      client: { ...AURORA, expansionArea: [{ uf: 'SP', city: 'Campinas' }] },
    });
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Links e expansão' }));

    // The existing link is on screen with its hits, and a new one is asked for the chosen channel.
    expect(await screen.findByText('https://wa.me/5511999990000?text=K7M2QX')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Canal do novo link de Padaria Aurora'), {
      target: { value: 'linktree' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Gerar link' }));
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith(`/clients/${AURORA.id}/tracking-links`, {
        channel: 'linktree',
      }),
    );

    fireEvent.change(screen.getByLabelText('Área de expansão de Padaria Aurora'), {
      target: { value: 'SP, Campinas/SP' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Salvar área' }));
    await waitFor(() =>
      expect(patch).toHaveBeenCalledWith(`/clients/${AURORA.id}/expansion-area`, {
        expansionArea: ['SP', 'Campinas/SP'],
      }),
    );
    expect(await screen.findByText('Área salva.')).toBeTruthy();
  });

  it('shows the Drive number and changes it, saying so when it is taken', async () => {
    patch.mockRejectedValueOnce(
      new ApiError(409, { error: 'number_taken', message: 'O número 5 já é de Sushi do Bairro.' }),
    );
    renderPage();
    const row = (await screen.findByRole('cell', { name: 'Padaria Aurora' })).closest(
      'tr',
    ) as HTMLElement;
    expect(within(row).getByText('03')).toBeTruthy();
    fireEvent.click(within(row).getByRole('button', { name: 'Editar' }));
    fireEvent.change(screen.getByLabelText('Número de Padaria Aurora'), { target: { value: '5' } });
    fireEvent.click(screen.getByRole('button', { name: 'Salvar' }));
    await waitFor(() =>
      expect(patch).toHaveBeenCalledWith(`/clients/${AURORA.id}`, {
        name: undefined,
        active: undefined,
        number: 5,
      }),
    );
    expect(await screen.findByText('O número 5 já é de Sushi do Bairro.')).toBeTruthy();
  });

  it("shows each client's project status and current stage, and opens the status dialog", async () => {
    patch.mockResolvedValueOnce({ project: { ...AURORA_PROJECT, status: 'finalizado' } });
    renderPage();
    const aurora = (await screen.findByRole('cell', { name: 'Padaria Aurora' })).closest(
      'tr',
    ) as HTMLElement;
    expect(within(aurora).getByText('Etapa atual: 04 Financeiro')).toBeTruthy();
    const wings = screen.getByRole('cell', { name: /Wings Company/ }).closest('tr') as HTMLElement;
    expect(within(wings).queryByText(/Etapa atual/)).toBeNull();

    fireEvent.click(
      within(aurora).getByRole('button', {
        name: 'Status do projeto de Padaria Aurora: Em Andamento',
      }),
    );
    const dialog = screen.getByRole('dialog', { name: 'Status de Padaria Aurora' });
    fireEvent.change(within(dialog).getByLabelText('Novo status'), {
      target: { value: 'finalizado' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Salvar status' }));
    await waitFor(() =>
      expect(patch).toHaveBeenCalledWith(`/projects/${AURORA.id}/status`, {
        status: 'finalizado',
        reason: undefined,
      }),
    );
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });
});
