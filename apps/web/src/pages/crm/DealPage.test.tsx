import type { Lead } from '@wings/shared';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../api/client.js';
import { DealPage } from './DealPage.js';

/**
 * Previsão de fechamento on the deal's page: a date field next to the value
 * and the stage, clearable, with a "vencida" note in words when the day is
 * behind us and the deal is still open.
 */

const {
  dealMutate,
  correctMutate,
  summaryMutate,
  askMutate,
  askState,
  queryState,
  idle,
  mutation,
} = vi.hoisted(() => ({
  dealMutate: vi.fn(),
  correctMutate: vi.fn(),
  summaryMutate: vi.fn(),
  askMutate: vi.fn(),
  askState: {
    data: undefined as { answer: string; model: string } | undefined,
    error: null as unknown,
  },
  queryState: {
    lead: null as Lead | null,
    files: [] as unknown[],
    // Overrides for what the queries answer (a failed request, a loading one); reset per test.
    leadQuery: {} as Record<string, unknown>,
    filesQuery: {} as Record<string, unknown>,
    stagesQuery: {} as Record<string, unknown>,
    sellersQuery: {} as Record<string, unknown>,
    brandsQuery: {} as Record<string, unknown>,
  },
  idle: () => ({ data: undefined, isLoading: false, isError: false }),
  mutation: (mutate = vi.fn()) => ({ mutate, isPending: false, error: null }),
}));

const lead = (over: Omit<Partial<Lead>, 'work'> & { work?: Partial<Lead['work']> }): Lead => ({
  id: 'l1',
  name: 'Elena',
  email: null,
  phone: null,
  fields: { instagram: null, website: null, companyName: null, cnpj: null },
  checks: {},
  city: null,
  formAnswers: null,
  status: 'new',
  ownerEmployeeId: 'e1',
  firstMessage: null,
  whatsapp: null,
  origin: {
    clientId: 'c1',
    clientName: 'Wings Company',
    clientMapped: false,
    source: 'site_form',
    channel: null,
    landingPage: null,
    campaignId: null,
    campaignName: null,
    formId: null,
    trackingCode: null,
    externalId: null,
    ad: null,
    utm: null,
    trafficSource: null,
    conversionIdentifier: null,
  },
  pipeline: 'expansao',
  brand: null,
  valueCents: 4500000,
  expectedCloseAt: null,
  company: null,
  contacts: [],
  crm: null,
  consent: { legalBasis: null, consentedAt: null, source: null, text: null },
  aiSummary: null,
  suspect: null,
  instagramCheck: null,
  research: {
    state: 'none',
    summary: null,
    score: null,
    criteria: [],
    links: [],
    facts: null,
    error: null,
    updatedAt: null,
    costUsd: 0,
  },
  enteredAt: '2026-10-01T11:30:00.000Z',
  enteredAtSource: 'meta_created_time',
  createdAt: '2026-10-01T12:00:00.000Z',
  updatedAt: '2026-10-01T12:00:00.000Z',
  ...over,
  work: {
    stageId: 's1',
    stage: 'Proposta',
    stageChangedAt: '2026-10-01T12:00:00.000Z',
    won: null,
    closedAt: null,
    lostReason: null,
    ownerName: 'Eric',
    managedBy: 'wings',
    ...over.work,
  },
});

vi.mock('../../api/auth.js', async () => {
  const actual = await vi.importActual<typeof import('../../api/auth.js')>('../../api/auth.js');
  return {
    ...actual,
    useSession: () => ({
      data: {
        id: 'e1',
        fullName: 'Eric Souza',
        role: 'vendedor_expansao',
        permissions: { 'leads.read': 'own', 'leads.write': 'own' },
      },
    }),
  };
});

vi.mock('../../api/leads.js', () => ({
  useLead: () => ({
    isLoading: false,
    isError: false,
    data: queryState.lead && {
      lead: queryState.lead,
      events: [],
      notes: [],
      tasks: [],
      history: [],
      activities: [],
    },
    ...queryState.leadQuery,
  }),
  useSellers: () => ({ ...idle(), ...queryState.sellersQuery }),
  useStages: () => ({ ...idle(), ...queryState.stagesQuery }),
  useCheckLead: idle,
  useCorrectInstagram: () => mutation(correctMutate),
  useClearSuspect: idle,
  useUpdateLead: () => mutation(),
  useUpdateTask: () => mutation(),
  useAddNote: () => mutation(),
  useCreateTask: () => mutation(),
}));

vi.mock('../../api/crm.js', () => ({
  useUpdateDeal: () => mutation(dealMutate),
  useAddActivity: () => mutation(),
  useBrands: () => ({ ...idle(), ...queryState.brandsQuery }),
  useLinkContact: () => mutation(),
  useUnlinkContact: () => mutation(),
  useContacts: idle,
  useCompanies: idle,
  useLeadFiles: () => ({
    data: queryState.files ?? [],
    isLoading: false,
    isError: false,
    isSuccess: true,
    ...queryState.filesQuery,
  }),
  useRemoveLeadFile: () => mutation(),
  useSendLeadFile: () => ({ ...mutation(), mutateAsync: vi.fn() }),
  useGenerateSummary: () => mutation(summaryMutate),
  useMeetings: () => ({ data: undefined, isLoading: false, isError: true, error: null }),
  useMeeting: () => ({ data: undefined, isLoading: false, isError: false, error: null }),
  useNextStepTask: () => mutation(),
  useAskDeal: () => ({ ...mutation(askMutate), data: askState.data, error: askState.error }),
}));

const show = () =>
  render(
    <MemoryRouter initialEntries={['/crm-vendas/negociacoes/l1']}>
      <Routes>
        <Route path="/crm-vendas/negociacoes/:id" element={<DealPage />} />
      </Routes>
    </MemoryRouter>,
  );

// The head and "Sobre a negociação" both edit the forecast; these tests read the head.
const head = () => within(screen.getByRole('banner'));
const field = () => head().getByLabelText('Previsão de fechamento') as HTMLInputElement;

beforeEach(() => {
  dealMutate.mockClear();
  queryState.leadQuery = {};
  queryState.filesQuery = {};
  queryState.stagesQuery = {};
  queryState.sellersQuery = {};
  queryState.brandsQuery = {};
});
afterEach(cleanup);

describe('Previsão de fechamento', () => {
  it('shows a date field next to the value, empty while nobody said, and saves the day picked', () => {
    queryState.lead = lead({});
    show();
    expect(field().type).toBe('date');
    expect(field().value).toBe('');
    expect(head().queryByText('vencida')).toBeNull();
    expect(head().queryByRole('button', { name: 'Limpar previsão de fechamento' })).toBeNull();
    fireEvent.change(field(), { target: { value: '2026-12-15' } });
    expect(dealMutate).toHaveBeenCalledWith({ expectedCloseAt: '2026-12-15' });
  });

  it('waits for a full year before saving while the person is still typing', () => {
    queryState.lead = lead({});
    show();
    fireEvent.change(field(), { target: { value: '0002-12-15' } });
    expect(dealMutate).not.toHaveBeenCalled();
  });

  it('can be cleared, by the button or by emptying the field', () => {
    queryState.lead = lead({ expectedCloseAt: '2099-01-10' });
    show();
    expect(field().value).toBe('2099-01-10');
    fireEvent.click(head().getByRole('button', { name: 'Limpar previsão de fechamento' }));
    expect(dealMutate).toHaveBeenCalledWith({ expectedCloseAt: null });
    dealMutate.mockClear();
    fireEvent.change(field(), { target: { value: '' } });
    expect(dealMutate).toHaveBeenCalledWith({ expectedCloseAt: null });
  });

  it('says "vencida" in words when the day passed and the deal is still open', () => {
    queryState.lead = lead({ expectedCloseAt: '2020-01-10' });
    show();
    expect(head().getByText('vencida')).toBeTruthy();
  });

  it('is not "vencida" for a deal already won, nor for a day still ahead', () => {
    queryState.lead = lead({ expectedCloseAt: '2020-01-10', work: { won: true } });
    show();
    expect(head().queryByText('vencida')).toBeNull();
    cleanup();
    queryState.lead = lead({ expectedCloseAt: '2099-01-10' });
    show();
    expect(head().queryByText('vencida')).toBeNull();
  });

  it('reads as plain text, in DD/MM/AAAA, for who cannot edit', async () => {
    const auth = await import('../../api/auth.js');
    vi.spyOn(auth, 'useSession').mockReturnValue({
      data: {
        id: 'e2',
        fullName: 'Leitor',
        role: 'marketing',
        permissions: { 'leads.read': 'all' },
      },
    } as unknown as ReturnType<typeof auth.useSession>);
    queryState.lead = lead({ expectedCloseAt: '2026-11-20' });
    show();
    expect(head().queryByLabelText('Previsão de fechamento')).toBeNull();
    expect(head().getByText('20/11/2026')).toBeTruthy();
  });
});

/** A request that fails must say so: never "not found", "0 files" or "no owner" in its place. */
describe('when a request fails', () => {
  const failed = (error: unknown) => ({
    data: undefined,
    isLoading: false,
    isError: true,
    isSuccess: false,
    error,
    refetch: vi.fn(),
  });
  const alerts = () => screen.getAllByRole('alert').map((node) => node.textContent ?? '');
  // The previous test left its session spy in place.
  beforeEach(() => vi.restoreAllMocks());

  it('the deal that did not load says why, not "não encontrada"', () => {
    queryState.leadQuery = failed(new ApiError(500, {}));
    show();
    expect(alerts().join(' ')).toContain('Não foi possível carregar a negociação');
    expect(alerts().join(' ')).toContain('o servidor teve um problema (erro 500)');
    expect(screen.queryByText(/não encontrada/)).toBeNull();
    expect(screen.getByRole('link', { name: 'Voltar às negociações' })).toBeTruthy();
  });

  it('a refresh that failed keeps the deal on screen and adds the reason', () => {
    queryState.lead = lead({});
    queryState.leadQuery = { isError: true, isSuccess: false, error: new TypeError('x') };
    show();
    expect(alerts().join(' ')).toContain('sem conexão com o servidor');
    expect(screen.getByRole('heading', { level: 1 })).toBeTruthy();
  });

  it('the files card shows "—" and why, not "0" or "Nenhum arquivo."', () => {
    queryState.lead = lead({});
    queryState.filesQuery = failed(new ApiError(403, {}));
    show();
    expect(screen.getByLabelText('Arquivos: —')).toBeTruthy();
    expect(alerts().join(' ')).toContain('Não foi possível carregar os arquivos');
    expect(screen.queryByText('Nenhum arquivo.')).toBeNull();
    expect(screen.queryByLabelText('Arquivos: 0')).toBeNull();
  });

  it('the files card still says "Nenhum arquivo." and 0 when the request succeeded empty', () => {
    queryState.lead = lead({});
    show();
    expect(screen.getByLabelText('Arquivos: 0')).toBeTruthy();
    expect(screen.getByText('Nenhum arquivo.')).toBeTruthy();
  });

  it('the stages that did not load are said, not left as a missing bar', () => {
    queryState.lead = lead({});
    queryState.stagesQuery = failed(new ApiError(500, {}));
    show();
    expect(alerts().join(' ')).toContain('Não foi possível carregar as etapas');
  });

  it('the brand select keeps showing the brand, and is locked, when the brands did not load', () => {
    queryState.lead = lead({
      brand: 'Casa do Churros',
      origin: { ...lead({}).origin, clientMapped: true, clientId: 'c9' },
    });
    queryState.brandsQuery = failed(new ApiError(500, {}));
    show();
    // Wherever the page edits the brand, it keeps showing the real one.
    const selects = screen.getAllByLabelText('Marca') as HTMLSelectElement[];
    expect(selects.length).toBeGreaterThan(0);
    for (const select of selects) {
      expect(select.selectedOptions[0]?.textContent).toBe('Casa do Churros');
      expect(select.disabled).toBe(true);
    }
  });

  it('the owner select keeps showing the owner, and is locked, when the sellers did not load', async () => {
    const auth = await import('../../api/auth.js');
    vi.spyOn(auth, 'useSession').mockReturnValue({
      data: {
        id: 'e1',
        fullName: 'Eric Souza',
        role: 'admin',
        permissions: { 'leads.read': 'all', 'leads.write': 'all', 'leads.assign': 'all' },
      },
    } as unknown as ReturnType<typeof auth.useSession>);
    queryState.lead = lead({ ownerEmployeeId: 'e9' });
    queryState.sellersQuery = failed(new ApiError(500, {}));
    show();
    const select = head().getByLabelText('Dono') as HTMLSelectElement;
    expect(select.selectedOptions[0]?.textContent).toBe('Eric');
    expect(select.disabled).toBe(true);
    vi.restoreAllMocks();
  });
});

describe('Lead suspeito', () => {
  it('shows the reasons and "Não é robô" on a marked lead, and nothing on the others', () => {
    queryState.lead = lead({
      suspect: { reasons: ['robot_email', 'capital_ddd', 'burst'], at: '2026-10-13T12:00:00Z' },
    });
    show();
    const strip = within(screen.getByRole('region', { name: 'Lead suspeito' }));
    expect(strip.getByText(/E-mail nome\.sobrenome/)).toBeTruthy();
    expect(strip.getByText('Telefone com DDD de capital')).toBeTruthy();
    expect(strip.getByText(/4 envios ou mais/)).toBeTruthy();
    expect(strip.getByText(/Nada foi apagado nem marcado como perdido/)).toBeTruthy();
    expect(strip.getByRole('button', { name: 'Não é robô' })).toBeTruthy();
    cleanup();
    queryState.lead = lead({});
    show();
    expect(screen.queryByRole('region', { name: 'Lead suspeito' })).toBeNull();
  });
});

describe('Origem', () => {
  it('shows the ad, its set and campaign, the UTMs, RD origin, the form and the answers', () => {
    const base = lead({});
    queryState.lead = lead({
      origin: {
        ...base.origin,
        source: 'meta_lead_ads',
        ad: {
          platform: 'meta',
          campaign: { externalId: '700', name: 'Campanha Exemplo' },
          adSet: { externalId: '701', name: null },
          ad: { externalId: '702', name: 'Anúncio Exemplo' },
        },
        utm: {
          source: 'instagram',
          medium: 'cpc',
          campaign: 'formatacao_out26',
          content: null,
          term: null,
        },
        trafficSource: 'Busca Paga | Facebook',
        conversionIdentifier: 'formatar-franquia',
      },
      formAnswers: { 'Investimento disponível': 'Sim' },
    });
    show();
    const card = within(screen.getByRole('region', { name: 'Origem' }));
    expect(card.getByText('Campanha Exemplo · id 700')).toBeTruthy();
    expect(card.getByText('nome ainda não lido da conta · id 701')).toBeTruthy();
    expect(card.getByText('Anúncio Exemplo · id 702')).toBeTruthy();
    expect(card.getByText('formatacao_out26')).toBeTruthy();
    expect(card.getByText('Busca Paga | Facebook')).toBeTruthy();
    expect(card.getByText('formatar-franquia')).toBeTruthy();
    expect(card.getByText('Sim')).toBeTruthy();
    expect(card.queryByText('utm_content')).toBeNull();
  });

  it('says so, with "—", when the arrival brought nothing', () => {
    queryState.lead = lead({});
    show();
    const card = within(screen.getByRole('region', { name: 'Origem' }));
    expect(card.getByText(/— A entrada não trouxe anúncio, UTM nem respostas/)).toBeTruthy();
  });
});

describe('Instagram do formulário', () => {
  const checked = (over: Record<string, unknown>) => ({
    status: 'nao_encontrado',
    source: 'nenhuma',
    checkedAt: '2026-10-15T14:00:00Z',
    reason: 'O perfil não apareceu na API da Meta; a busca na web não conferiu',
    steps: null,
    followers: null,
    posts: null,
    verdict: 'suspeito',
    manual: null,
    effectiveVerdict: 'suspeito',
    profileUrl: 'https://www.instagram.com/padaria.aurora/',
    ...over,
  });
  const panel = () => within(screen.getByRole('region', { name: 'Dados do formulário' }));
  const withInstagram = (instagramCheck: unknown) => {
    const base = lead({});
    queryState.lead = lead({
      fields: { ...base.fields, instagram: 'padaria.aurora' },
      instagramCheck,
    } as Partial<Lead>);
  };

  it('says suspect, the reason and the link, and lets a seller mark it confere or falso', () => {
    correctMutate.mockClear();
    withInstagram(checked({}));
    show();
    expect(panel().getByText('Não encontrado · suspeito')).toBeTruthy();
    expect(panel().getByText(/a busca na web não conferiu/)).toBeTruthy();
    expect(panel().getByRole('link', { name: '@padaria.aurora' }).getAttribute('href')).toBe(
      'https://www.instagram.com/padaria.aurora/',
    );
    fireEvent.click(panel().getByRole('button', { name: 'Marcar como falso' }));
    expect(correctMutate).toHaveBeenCalledWith({ id: expect.any(String), verdict: 'falso' });
    fireEvent.click(panel().getByRole('button', { name: 'Marcar como confere' }));
    expect(correctMutate).toHaveBeenLastCalledWith({ id: expect.any(String), verdict: 'confere' });
    expect(panel().queryByRole('button', { name: 'Desfazer correção' })).toBeNull();
  });

  it("shows source, time and Meta's numbers when it was found, and Falso when found nowhere", () => {
    withInstagram(
      checked({
        status: 'confere',
        source: 'meta',
        reason: null,
        verdict: null,
        effectiveVerdict: null,
        followers: 1200,
        posts: 80,
      }),
    );
    show();
    expect(panel().getByText('Confere')).toBeTruthy();
    expect(panel().getByText(/Fonte: API oficial da Meta/)).toBeTruthy();
    expect(panel().getByText(/1\.200 seguidores/)).toBeTruthy();
    cleanup();
    withInstagram(checked({ verdict: 'falso', effectiveVerdict: 'falso' }));
    show();
    expect(panel().getByText('Falso')).toBeTruthy();
  });

  it('keeps the old check while the worker has not looked, shows a correction and offers to undo it', () => {
    const base = lead({});
    queryState.lead = lead({
      fields: { ...base.fields, instagram: 'padaria.aurora' },
      instagramCheck: null,
    } as Partial<Lead>);
    show();
    // The old per-field line is shown (every unchecked field says so); the new row and its buttons are not.
    expect(panel().getAllByText('Não conferido ainda').length).toBeGreaterThan(0);
    expect(panel().queryByRole('button', { name: 'Marcar como falso' })).toBeNull();
    cleanup();
    correctMutate.mockClear();
    withInstagram(
      checked({
        manual: { verdict: 'falso', at: '2026-10-15T15:00:00Z' },
        effectiveVerdict: 'falso',
      }),
    );
    show();
    expect(panel().getByText('Falso (marcado por uma pessoa)')).toBeTruthy();
    expect(panel().getByText(/continua guardado/)).toBeTruthy();
    fireEvent.click(panel().getByRole('button', { name: 'Desfazer correção' }));
    expect(correctMutate).toHaveBeenCalledWith({ id: expect.any(String), verdict: null });
    cleanup();
    withInstagram(
      checked({
        status: 'pendente',
        verdict: null,
        effectiveVerdict: null,
        reason: null,
        checkedAt: null,
      }),
    );
    show();
    expect(panel().getByText('Conferindo…')).toBeTruthy();
    expect(panel().queryByRole('button', { name: 'Marcar como falso' })).toBeNull();
  });
});
