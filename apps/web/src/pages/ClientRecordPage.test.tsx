import {
  EMPTY_ADDRESS,
  clientCompanySchema,
  clientCompleteness,
  type ClientPartner,
  type ClientRecord,
} from '@wings/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const get = vi.fn();
const post = vi.fn();
const put = vi.fn();
vi.mock('../api/client.js', async (original) => ({
  ...(await original<typeof import('../api/client.js')>()),
  api: {
    get: (path: string) => get(path),
    post: (path: string, body?: unknown) => post(path, body),
    put: (path: string, body?: unknown) => put(path, body),
    delete: vi.fn(),
  },
}));

const { ClientRecordPage } = await import('./ClientRecordPage.js');
const { ApiError } = await import('../api/client.js');

const CLIENT_ID = '11111111-1111-4111-8111-1111111111c2';

const partner: ClientPartner = {
  id: '22222222-2222-4222-8222-222222222222',
  position: 1,
  name: 'João Sócio',
  cpfMasked: null,
  cpfOnFile: true,
  rg: null,
  rgIssuer: null,
  nationality: 'brasileira',
  profession: 'Empresário',
  maritalStatus: null,
  propertyRegime: null,
  address: EMPTY_ADDRESS,
  email: null,
  mobile: null,
  sharePercent: 100,
  signsForCompany: true,
  restricted: true,
};

function recordFor(canSeeSensitive: boolean): ClientRecord {
  const base = {
    company: clientCompanySchema.parse({ tradeName: 'Aurora Pães', cnpj: '11222333000181' }),
    partners: canSeeSensitive
      ? [
          {
            ...partner,
            cpfMasked: '***.456.789-**',
            maritalStatus: 'casado' as const,
            restricted: false,
          },
        ]
      : [partner],
    contacts: [],
    business: {
      segment: null,
      description: null,
      operatingYears: null,
      ownUnits: null,
      revenueBand: null,
      averageTicketCents: null,
      employeesCount: null,
      inpiProcess: null,
      inpiClass: null,
      inpiStatus: null,
      franchisability: null,
      wingsFit: null,
      profileSource: null,
      profileDate: null,
    },
    contracts: [],
    franchise: {
      franchiseFeeCents: null,
      royaltiesPercent: null,
      adFundPercent: null,
      initialInvestmentCents: null,
      franchiseeProfile: null,
      unitModels: [],
    },
    signature: {
      signerPartnerId: null,
      signingEmail: null,
      signingMobile: null,
      signatureType: null,
      forum: null,
      witnesses: [],
    },
  };
  return {
    ...base,
    client: {
      id: CLIENT_ID,
      name: 'Padaria Aurora',
      slug: 'padaria-aurora',
      active: true,
      expansionArea: [],
      number: 3,
    },
    completeness: clientCompleteness({
      ...base,
      partners: base.partners.map((p) => ({ ...p, maritalStatus: 'casado', propertyRegime: null })),
      expansionArea: [],
    }),
    documentsFolderId: 'folder-1',
    access: { canEdit: true, canSeeSensitive },
    consultantOptions: {
      'formatacao-juridico': [],
      'formatacao-financeiro': [],
      'formatacao-processos-projetos': [],
      'formatacao-contabil-tributario': [],
      'formatacao-logistica': [],
      'formatacao-ti': [],
    },
    leadOptions: null,
  };
}

let current: ClientRecord;

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[`/formatacao/clientes/${CLIENT_ID}`]}>
        <Routes>
          <Route path="/formatacao/clientes/:id" element={<ClientRecordPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  current = recordFor(false);
  get.mockReset().mockImplementation(async (path: string) => {
    if (path === `/clients/${CLIENT_ID}/record`) return current;
    throw new Error(`unexpected GET ${path}`);
  });
  post.mockReset();
  put.mockReset().mockImplementation(async () => current);
});
afterEach(cleanup);

describe('Formatação → Clientes → ficha', () => {
  it('shows how much is filled, block by block, and links the Drive folder', async () => {
    renderPage();
    const percent = current.completeness.percent;
    expect(await screen.findByText(`${percent}% preenchido`)).toBeTruthy();
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe(String(percent));
    expect(screen.getByRole('tab', { name: /Empresa/ }).textContent).toMatch(/\d+\/11/);
    expect(screen.getByText(/Falta:/).closest('p')?.textContent).toContain('Razão social');
    expect(screen.getByRole('link', { name: 'Documentos Enviados' }).getAttribute('href')).toBe(
      '/drive/arquivos?pasta=folder-1',
    );
  });

  it('fills the company from the Receita and saves the block', async () => {
    post.mockResolvedValue({
      source: 'brasilapi',
      registrationStatus: 'ATIVA',
      company: {
        legalName: 'AURORA PAES LTDA',
        shareCapitalCents: 1_000_000,
        address: { ...EMPTY_ADDRESS, cep: '01310100', city: 'SAO PAULO', state: 'SP' },
      },
      partners: [{ name: 'MARIA NOVA', role: 'Sócio-Administrador' }],
    });
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Buscar na Receita' }));
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith('/clients/lookup/cnpj', { cnpj: '11222333000181' }),
    );
    await waitFor(() =>
      expect(screen.getByLabelText('Razão social')).toHaveProperty('value', 'AURORA PAES LTDA'),
    );
    expect(screen.getByLabelText('Cidade')).toHaveProperty('value', 'SAO PAULO');
    expect(screen.getByText(/MARIA NOVA/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Salvar' }));
    await waitFor(() => expect(put).toHaveBeenCalled());
    const [path, body] = put.mock.calls[0] as [string, Record<string, unknown>];
    expect(path).toBe(`/clients/${CLIENT_ID}/company`);
    expect(body).toMatchObject({
      legalName: 'AURORA PAES LTDA',
      tradeName: 'Aurora Pães',
      shareCapitalCents: 1_000_000,
      address: expect.objectContaining({ cep: '01310100', state: 'SP' }),
    });

    // "adicionar como sócio" opens a new partner already named.
    fireEvent.click(screen.getByRole('button', { name: 'adicionar como sócio' }));
    expect(await screen.findByDisplayValue('MARIA NOVA')).toBeTruthy();
  });

  it('keeps the partner’s CPF and marital status away from who may not see them', async () => {
    renderPage();
    fireEvent.click(await screen.findByRole('tab', { name: /Sócios/ }));
    expect(screen.getByDisplayValue('Informado')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Revelar' })).toBeNull();
    expect(screen.queryByLabelText('Estado civil')).toBeNull();

    fireEvent.click(screen.getAllByRole('button', { name: 'Salvar' })[0] as HTMLElement);
    await waitFor(() => expect(put).toHaveBeenCalled());
    const [, body] = put.mock.calls[0] as [string, Record<string, unknown>];
    expect(body).not.toHaveProperty('cpf');
    expect(body).not.toHaveProperty('maritalStatus');
    expect(body).not.toHaveProperty('propertyRegime');
  });

  it('lets Jurídico reveal the CPF and asks the property regime of a married partner', async () => {
    current = recordFor(true);
    post.mockResolvedValue({ cpf: '52998224725' });
    renderPage();
    fireEvent.click(await screen.findByRole('tab', { name: /Sócios/ }));
    expect(screen.getByPlaceholderText('***.456.789-**')).toBeTruthy();
    expect(screen.getByLabelText('Regime de bens')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Revelar' }));
    expect(await screen.findByText('529.982.247-25')).toBeTruthy();
    expect(post).toHaveBeenCalledWith(`/clients/${CLIENT_ID}/reveal-cpf`, {
      kind: 'partner',
      id: partner.id,
    });
  });
});

describe('Formatação → Clientes → ficha: WhatsApp da marca', () => {
  it('a brand without art says so, and the article is saved on its own', async () => {
    current = {
      ...recordFor(false),
      client: { ...recordFor(false).client, relationship: 'expansao', name: 'Malkuth' },
    };
    get.mockImplementation(async (path: string) => {
      if (path === `/clients/${CLIENT_ID}/record`) return current;
      if (path === `/clients/${CLIENT_ID}/whatsapp`)
        return { clientId: CLIENT_ID, article: null, art: null };
      throw new Error(`unexpected GET ${path}`);
    });
    put.mockImplementation(async (path: string, body: unknown) =>
      path.endsWith('/whatsapp/article')
        ? { clientId: CLIENT_ID, article: (body as { article: string }).article, art: null }
        : current,
    );
    renderPage();
    expect(await screen.findByText(/Cadastre a arte do WhatsApp desta marca/)).toBeTruthy();
    expect(screen.getByText(/PNG ou JPEG, 1125 × 600 pixels, até 2 MB/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Enviar a arte' })).toBeTruthy();
    expect(screen.getByText(/Não informado: os modelos usam "da"/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/Artigo do nome nos modelos/), {
      target: { value: 'o' },
    });
    await waitFor(() =>
      expect(put).toHaveBeenCalledWith(`/clients/${CLIENT_ID}/whatsapp/article`, { article: 'o' }),
    );
  });

  it('shows the art of a brand that has one, and nothing of it for a Formatação client', async () => {
    current = {
      ...recordFor(false),
      client: { ...recordFor(false).client, relationship: 'expansao', name: 'Malkuth' },
    };
    get.mockImplementation(async (path: string) => {
      if (path === `/clients/${CLIENT_ID}/record`) return current;
      if (path === `/clients/${CLIENT_ID}/whatsapp`)
        return {
          clientId: CLIENT_ID,
          article: 'a',
          art: { fileId: 'f1', url: 'https://r2.example/a?sig=1', expiresAt: '', setAt: null },
        };
      throw new Error(`unexpected GET ${path}`);
    });
    renderPage();
    const image = await screen.findByRole('img', { name: 'Arte do WhatsApp de Malkuth' });
    expect(image.getAttribute('src')).toBe('https://r2.example/a?sig=1');
    expect(screen.getByRole('button', { name: 'Trocar a arte' })).toBeTruthy();
    cleanup();

    current = recordFor(false);
    get.mockImplementation(async (path: string) => {
      if (path === `/clients/${CLIENT_ID}/record`) return current;
      throw new Error(`unexpected GET ${path}`);
    });
    renderPage();
    expect(await screen.findByText(/% preenchido/)).toBeTruthy();
    expect(screen.queryByText('WhatsApp da marca')).toBeNull();
  });
});

describe('when the record cannot be opened', () => {
  it('says "—" and why, with no form that could be saved over the real record', async () => {
    get.mockRejectedValue(new ApiError(500, {}));
    renderPage();
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(
      /Não foi possível carregar a ficha: o servidor teve um problema \(erro 500\)/,
    );
    expect(screen.queryByRole('tab')).toBeNull();
    expect(screen.queryByRole('button', { name: /Salvar/ })).toBeNull();

    get.mockReset().mockImplementation(async () => current);
    fireEvent.click(screen.getByRole('button', { name: 'Tentar de novo' }));
    expect(await screen.findByText(/% preenchido/)).toBeTruthy();
  });

  it('tells a record that is not there from a network that is down', async () => {
    get.mockRejectedValue(new TypeError('Failed to fetch'));
    renderPage();
    expect((await screen.findByRole('alert')).textContent).toMatch(/sem conexão com o servidor/);
  });
});
