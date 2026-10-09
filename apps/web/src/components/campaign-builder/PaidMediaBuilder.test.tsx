import {
  agentCampaignProposalSchema,
  type AudienceProfile,
  type CampaignDraftInput,
  type CustomLocation,
  type MediaAsset,
  type MediaBridgeResponse,
  type MetaIdentities,
  type ActiveCampaignBudget,
  type PacingSummary,
  type PlatformAccountReading,
  type SessionUser,
  META_URL_TAGS,
} from '@wings/shared';
import {
  act,
  cleanup,
  fireEvent,
  render as renderBare,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import type { ReactElement } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../api/client.js';

/**
 * The builder is approved by what it shows, so these tests pin what the
 * operator sees: blocked copy is explained on screen, the real cost and the
 * real ceiling sit next to the budget, and launching only ever asks.
 */

const pacing: { current: PacingSummary | null } = { current: buildPacing() };
/** Every call the builder made to `useCockpit`, in order — what days/platform it asked for. */
const cockpitCalls: { days: number; platform?: string }[] = [];
/** The active budgets the cockpit reports, for the spending-limit projection. */
const activeBudgets: { current: ActiveCampaignBudget[] } = { current: [] };
const platformRefresh = vi.fn();

const requestCampaign = vi.fn();
const launchState: { current: { isSuccess: boolean; data?: { approvalId: string } } } = {
  current: { isSuccess: false },
};

const uploadSize = { current: { width: 1080, height: 1080 } };
let uploads = 0;

const savedAudience: { current: AudienceProfile | null } = { current: null };
const saveAudience = vi.fn();
const session: { current: SessionUser | null } = { current: null };
const reconcileNow = vi.fn();

const PAGE = '104567890123456';
const OTHER_PAGE = '209876543210987';
const INSTAGRAM = '17841400000000000';
function buildIdentities(): MetaIdentities {
  return {
    pages: [
      {
        id: PAGE,
        name: 'Wings Company',
        instagramAccounts: [{ id: INSTAGRAM, username: 'wingscompany' }],
      },
      { id: OTHER_PAGE, name: 'Wings Franquias', instagramAccounts: [] },
    ],
    default: { pageId: PAGE, instagramActorId: INSTAGRAM },
  };
}
/** What GET /ads/meta/identities answers: the lists, or the failure. */
const identities: { current: MetaIdentities | ApiError } = { current: buildIdentities() };
const refetchIdentities = vi.fn();
const saveIdentityDefault = vi.fn();
const uploadVideo = vi.fn();
const videoFailure: { current: ApiError | null } = { current: null };

const savedDrafts: {
  current: {
    id: string;
    name: string;
    platform: string;
    updatedAt: string;
    createdByName: string | null;
  }[];
} = { current: [] };
const savedDraftPayload: { current: Record<string, unknown> | null } = { current: null };
const saveDraft = vi.fn();
const deleteSavedDraft = vi.fn();

/** What "Pedir aprovação dos anúncios" sent, in order. */
const requestAddAds = vi.fn();
vi.mock('../../api/dashboard.js', () => ({
  useDashboardCampaigns: () => ({
    data: {
      campaigns: {
        campaigns: [
          {
            platform: 'meta',
            externalId: '120252260012720076',
            name: 'META | 28Set',
            status: 'ACTIVE',
            launchDefaults: {
              utms: {
                utm_source: 'facebook',
                utm_medium: 'paid_social',
                utm_campaign: 'formatacao_jimmyogro_set26',
              },
              destinationUrl: 'https://wingscompany.com.br/contato/',
              identity: { pageId: '111543418672527', instagramActorId: '17841460839979368' },
            },
          },
          {
            platform: 'google',
            externalId: '24289782134',
            name: 'SEARCH | Formatação',
            status: 'ACTIVE',
          },
        ],
      },
    },
  }),
}));

vi.mock('../../api/ads.js', () => ({
  useDemandGenOptions: () => ({ data: demandGenOptions.current, isLoading: false, error: null }),
  useCheckYoutubeVideos: () => ({
    isPending: false,
    error: null,
    mutate: (
      videos: string[],
      options?: { onSuccess?: (answer: { videos: Record<string, unknown>[] }) => void },
    ) => {
      checkVideos(videos);
      options?.onSuccess?.({
        videos: videos.map((video) => {
          const videoId = video.slice(-11);
          return privateVideos.has(videoId)
            ? { videoId, status: 'private' }
            : { videoId, status: 'ok', title: 'Vídeo' };
        }),
      });
    },
  }),
  useRequestAddAds: () => ({
    mutate: (input: unknown) => requestAddAds(input),
    isPending: false,
    isSuccess: false,
    data: undefined,
  }),
  useSavedDrafts: () => ({ data: { drafts: savedDrafts.current } }),
  loadSavedDraft: (id: string) =>
    Promise.resolve({ id, name: 'Rascunho real', draft: savedDraftPayload.current }),
  useSaveDraft: () => ({
    mutate: saveDraft,
    reset: vi.fn(),
    isPending: false,
    isSuccess: false,
    isError: false,
    error: null,
  }),
  useDeleteSavedDraft: () => ({ mutate: deleteSavedDraft }),
  useAudienceProfile: () => ({ data: { profile: savedAudience.current } }),
  useSaveAudienceProfile: () => ({
    mutate: saveAudience,
    isPending: false,
    isError: false,
    isSuccess: false,
    error: null,
  }),
  useUploadCreative: () => ({
    isPending: false,
    mutate: (
      _file: File,
      options: { onSuccess: (result: { creative: Record<string, unknown> }) => void },
    ) => {
      uploads += 1;
      options.onSuccess({
        creative: {
          id: `0000000${uploads}-0000-4000-8000-000000000000`,
          mimeType: 'image/png',
          byteSize: 1,
          ...uploadSize.current,
        },
      });
    },
  }),
  useMetaIdentities: (enabled: boolean) => {
    const failed = identities.current instanceof ApiError;
    return {
      data: enabled && !failed ? { identities: identities.current } : undefined,
      isLoading: false,
      isError: enabled && failed,
      error: failed ? identities.current : null,
      refetch: refetchIdentities,
    };
  },
  useSaveMetaIdentityDefault: () => ({
    mutate: saveIdentityDefault,
    isError: false,
    isSuccess: false,
    error: null,
  }),
  useUploadVideo: () => ({
    isPending: false,
    mutate: (
      file: File,
      options: {
        onSuccess: (result: { video: Record<string, unknown> }) => void;
        onError: (failure: Error) => void;
      },
    ) => {
      uploadVideo(file);
      if (videoFailure.current) return options.onError(videoFailure.current);
      options.onSuccess({
        video: {
          id: '33333333-3333-4333-8333-333333333333',
          mimeType: 'video/mp4',
          byteSize: 5_242_880,
        },
      });
    },
  }),
  useCockpit: (args: { days: number; platform?: string }) => {
    cockpitCalls.push(args);
    return {
      data: {
        cockpit: {
          account: { id: 'acc-1', name: 'Wings Matriz', platform: 'meta', externalId: 'act_1' },
          pacing: pacing.current,
          wingsTotal: null,
          activeBudgets: activeBudgets.current,
        },
      },
      isLoading: false,
    };
  },
  useRequestCampaign: () => ({
    mutate: requestCampaign,
    reset: vi.fn(),
    isPending: false,
    isError: false,
    error: null,
    ...launchState.current,
  }),
  useReconcileNow: () => ({ mutate: reconcileNow, isPending: false, error: null }),
  usePlatformRefresh: () => ({ mutate: platformRefresh }),
  useSetSpendCapReset: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock('../../api/auth.js', () => ({
  useSession: () => ({ data: session.current, isLoading: false }),
  hasPermission: (user: SessionUser | null, permission: string) =>
    Boolean(user?.permissions[permission as keyof SessionUser['permissions']]),
}));

// Leaflet needs a real layout engine; the builder only cares what the map
// reports, so a stand-in reports a click and a radius change.
vi.mock('./RadiusMap.js', () => ({
  RadiusMap: ({
    value,
    onChange,
    disabled,
  }: {
    value: CustomLocation[];
    onChange: (next: CustomLocation[]) => void;
    disabled?: boolean;
  }) => (
    <div data-testid="radius-map" data-disabled={disabled ? 'yes' : 'no'}>
      <button
        type="button"
        disabled={disabled}
        onClick={() =>
          onChange([
            ...value,
            { latitude: -22.9056, longitude: -47.0608, radiusKm: 15, label: 'Campinas' },
          ])
        }
      >
        clicar no mapa
      </button>
      <button
        type="button"
        onClick={() => onChange(value.map((item) => ({ ...item, radiusKm: 40 })))}
      >
        raio 40
      </button>
    </div>
  ),
}));

/** The media library, scripted: what it lists and what the bridge answers. */
const libraryAssets: { current: MediaAsset[] } = { current: [] };
/** What the Google Ads account offers a YouTube campaign, as the builder reads it. */
const demandGenOptions = {
  current: {
    conversionActions: [
      { id: '7804997444', name: 'RD form conversion', category: 'SUBMIT_LEAD_FORM', primary: true },
      { id: '12', name: 'form_submit', category: 'SUBMIT_LEAD_FORM', primary: false },
    ],
    audienceSegments: [
      { kind: 'custom_audience' as const, id: '1019547251', name: 'Concorrentes' },
    ],
  },
};
/** YouTube's answer per video id: public unless listed here. */
const privateVideos = new Set<string>();
const checkVideos = vi.fn();
const useInBuilder = vi.fn();
const bridgeAnswer: { current: MediaBridgeResponse | null } = { current: null };
// The library picker's "Cliente" filter reads the register; the builder tests need no clients.
vi.mock('../../api/clients.js', () => ({
  useClients: () => ({
    data: {
      clients: [
        { id: '00000000-0000-4000-8000-0000000000c1', name: 'Wings Company', active: true },
        { id: '00000000-0000-4000-8000-0000000000c2', name: 'Cenoritas', active: true },
      ],
    },
  }),
}));

// The standard lead form's reads: the Page's readiness and the site pages.
const leadFormReadiness: {
  current: import('../../api/lead-forms.js').MetaLeadFormReadiness | null;
} = { current: null };
const siteFormPages: { current: import('../../api/lead-forms.js').SiteFormPage[] } = {
  current: [],
};
const proposeSiteForm = vi.fn();
const approveSiteForm = vi.fn();
vi.mock('../../api/lead-forms.js', () => ({
  useMetaLeadFormReadiness: () => ({
    data: leadFormReadiness.current ?? undefined,
    isError: false,
  }),
  useSiteFormPages: () => ({ data: { pages: siteFormPages.current } }),
  useProposeSiteForm: () => ({ mutate: proposeSiteForm, isPending: false, isSuccess: false }),
  useApproveSiteForm: () => ({ mutate: approveSiteForm, isPending: false, isError: false }),
  useRejectSiteForm: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock('../../api/media.js', async (original) => ({
  ...(await original<typeof import('../../api/media.js')>()),
  useMediaAssets: (filters: { kind?: string }) => ({
    data: {
      assets: libraryAssets.current.filter((item) => !filters.kind || item.kind === filters.kind),
      storageAvailable: true,
    },
    isLoading: false,
  }),
  useMediaInBuilder: () => ({
    isPending: false,
    error: null,
    mutate: (assetId: string, options?: { onSuccess?: (picked: MediaBridgeResponse) => void }) => {
      useInBuilder(assetId);
      if (bridgeAnswer.current) options?.onSuccess?.(bridgeAnswer.current);
    },
  }),
}));

const render = (ui: ReactElement) => renderBare(<MemoryRouter>{ui}</MemoryRouter>);

const { PaidMediaBuilder } = await import('./PaidMediaBuilder.js');
type BuilderBridge = import('./PaidMediaBuilder.js').BuilderBridge;

function buildPacing(overrides: Partial<PacingSummary> = {}): PacingSummary {
  return {
    periodMonth: '2026-09-01',
    capCents: 400_000,
    usableCents: 280_000,
    committedCents: 100_000,
    spentCents: 50_000,
    availableCents: 180_000,
    expectedCents: 0,
    deviationPercent: null,
    elapsedDays: 18,
    totalDays: 30,
    killSwitchEngaged: false,
    platformRemainingCents: null,
    platformLimitSource: null,
    platformLimitSyncedAtIso: null,
    platformLimitNote: null,
    lastReconciledAt: null,
    platformReading: buildReading(),
    ...overrides,
  };
}

function buildReading(overrides: Partial<PlatformAccountReading> = {}): PlatformAccountReading {
  return {
    status: 'ok',
    reason: null,
    readAtIso: '2026-09-30T16:34:00.000Z',
    attemptedAtIso: '2026-09-30T16:34:00.000Z',
    spendCapCents: null,
    amountSpentCents: null,
    spendCapRemainingCents: null,
    amountDueCents: null,
    prepaidBalanceCents: null,
    fundingKind: null,
    spendCapReset: null,
    spendCapResetsOn: null,
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  pacing.current = buildPacing();
  cockpitCalls.length = 0;
  activeBudgets.current = [];
  platformRefresh.mockReset();
  vi.useRealTimers();
  launchState.current = { isSuccess: false };
  requestCampaign.mockReset();
  uploadSize.current = { width: 1080, height: 1080 };
  uploads = 0;
  savedAudience.current = null;
  saveAudience.mockReset();
  identities.current = buildIdentities();
  refetchIdentities.mockReset();
  saveIdentityDefault.mockReset();
  uploadVideo.mockReset();
  videoFailure.current = null;
  session.current = null;
  reconcileNow.mockReset();
  leadFormReadiness.current = null;
  siteFormPages.current = [];
  proposeSiteForm.mockReset();
  approveSiteForm.mockReset();
});

function chooseImage(input: Element, type = 'image/png') {
  fireEvent.change(input, { target: { files: [new File(['x'], 'criativo.png', { type })] } });
}

function fillValidCampaign() {
  type(screen.getByLabelText(/^Nome da campanha/), 'Sacrifício — teste de escrita');
  type(screen.getByLabelText(/Página de destino/), 'https://wingscompany.com.br/franquia');
  const titles = screen.getAllByLabelText(/^Título/);
  const texts = screen.getAllByLabelText(/^Texto/);
  type(titles[0] as Element, 'Leve a Wings para sua cidade');
  type(texts[0] as Element, 'Fale com a gente.');
  type(titles[1] as Element, 'Seja um franqueado Wings');
  type(texts[1] as Element, 'Suporte completo.');
  type(screen.getByLabelText(/Verba por dia/), '6,00');
  type(
    screen.getByLabelText(/^Quem é o cliente ideal/),
    'Empreendedor de 30 a 50 anos, com experiência em gestão.',
  );
  fireEvent.click(screen.getByRole('checkbox', { name: 'SP' }));
  for (const input of screen.getAllByLabelText(/^Imagem — Criativo/)) chooseImage(input);
}

const type = (element: Element, value: string) => fireEvent.change(element, { target: { value } });

/** A Field's label holds the hint too ("Título 10/30"), so find the control by the label text alone. */
function byField(text: string): HTMLElement {
  const label = Array.from(document.querySelectorAll('label.field')).find(
    (element) => element.querySelector('.field-label')?.textContent?.trim() === text,
  );
  const control = label?.querySelector('input, textarea, select');
  if (!control) throw new Error(`no field labelled "${text}"`);
  return control as HTMLElement;
}

describe('the paid-media builder', () => {
  it('offers Meta, Google Pesquisa and YouTube, and says why the others are off', () => {
    render(<PaidMediaBuilder canRequest />);
    for (const name of [/^Meta/, /Google Pesquisa/, /YouTube/]) {
      expect((screen.getByRole('radio', { name }) as HTMLInputElement).disabled).toBe(false);
    }
    for (const name of [
      /TikTok/,
      /LinkedIn/,
      /X \(Twitter\)/,
      /Microsoft Ads/,
      /Kwai Ads/,
      /Pinterest Ads/,
      /Reddit Ads/,
    ]) {
      expect((screen.getByRole('radio', { name }) as HTMLInputElement).disabled).toBe(true);
    }
    expect(screen.getByText(/Perfil de desenvolvedor em análise pelo TikTok/)).toBeTruthy();
    expect(screen.getByText(/Acesso à Advertising API e Lead Sync em análise/)).toBeTruthy();
    expect(screen.getByText(/Acesso à Ads API em análise/)).toBeTruthy();
    expect(screen.getAllByText(/— Em breve/).length).toBe(4);
  });

  it('explains blocked copy on screen instead of only refusing it', () => {
    render(<PaidMediaBuilder canRequest />);
    type(screen.getAllByLabelText(/^Título/)[0] as Element, 'Retorno garantido em 12 meses');

    const warning = screen.getByText(/Este texto não pode ir ao ar/).closest('div');
    expect(warning?.textContent).toContain('Retorno garantido');
    expect(warning?.textContent).toContain('Nenhum resultado pode ser apresentado como garantido');
    expect(screen.getByText(/Há texto bloqueado pelo compliance/)).toBeTruthy();
  });

  it('shows the real cost next to the real ceiling', () => {
    render(<PaidMediaBuilder canRequest />);
    type(screen.getByLabelText(/^Início/), '2026-09-20');
    type(screen.getByLabelText(/^Fim/), '2026-09-29');
    type(screen.getByLabelText(/Verba por dia/), '20,00');

    // R$ 20 × 10 days × 1.25 overdelivery.
    expect(screen.getAllByText('R$ 250,00').length).toBeGreaterThan(0);
    expect(screen.getByText('R$ 1.800,00')).toBeTruthy();
    expect(screen.queryByText(/passa do que a conta ainda permite/)).toBeNull();
  });

  it('opens every section with what the choice changes in practice', () => {
    render(<PaidMediaBuilder canRequest />);
    const sections = screen.getAllByRole('region').filter((el) => el.matches('.builder-section'));
    // No "Variações" block: every creative, whole, sits in block 7. Block 10 is
    // the lead form (2026-10-06).
    expect(sections).toHaveLength(15);
    expect(sections[9]?.querySelector('h2')?.textContent).toBe('10Formulário');
    expect(sections[6]?.querySelector('h2')?.textContent).toBe('7Criativo');
    expect(screen.queryByText('Variações', { selector: 'h2' })).toBeNull();
    for (const section of sections) {
      expect(section.querySelector('.builder-why')?.textContent?.length).toBeGreaterThan(40);
    }
    expect(screen.getByText(/Define como a Meta cobra e para quem mostra/)).toBeTruthy();
    expect(screen.getByText(/o lead chega no CRM com a origem certa/)).toBeTruthy();
    // The how-to hints under the fields are still there.
    expect(screen.getByText('A Meta pode gastar até 25% acima disto num dia.')).toBeTruthy();
  });

  it('says which field the estimate is waiting for, never a bare dash', () => {
    render(<PaidMediaBuilder canRequest />);
    const cost = () => screen.getByText('Custo total estimado', { selector: 'span' }).parentElement;
    expect(cost()?.textContent).toContain('Falta a verba por dia.');

    type(screen.getByLabelText(/Verba por dia/), '20 reais');
    expect(cost()?.textContent).toContain('Não entendi “20 reais”');

    type(screen.getByLabelText(/Verba por dia/), '0,50');
    expect(cost()?.textContent).toMatch(/pelo menos R\$\s5,17/);

    type(screen.getByLabelText(/Verba por dia/), '20');
    type(screen.getByLabelText(/^Fim/), '');
    expect(cost()?.textContent).toContain('Falta escolher o início e o fim');

    type(screen.getByLabelText(/^Início/), '2026-09-20');
    type(screen.getByLabelText(/^Fim/), '2026-09-19');
    expect(cost()?.textContent).toContain('O fim da campanha está antes do início.');

    type(screen.getByLabelText(/^Fim/), '2026-09-26');
    // toLocaleString puts a non-breaking space after R$.
    expect(cost()?.textContent).toMatch(/R\$\s175,00/);
    expect(cost()?.textContent).not.toContain('—');
  });

  it('reads a dot as a decimal mark, not as a hundred times the budget', () => {
    render(<PaidMediaBuilder canRequest />);
    type(screen.getByLabelText(/^Início/), '2026-09-20');
    type(screen.getByLabelText(/^Fim/), '2026-09-26');
    type(screen.getByLabelText(/Verba por dia/), '20.00');
    expect(screen.getAllByText('R$ 175,00').length).toBeGreaterThan(0);
  });

  it('warns when the campaign would not fit under the ceiling', () => {
    // Only the campaign days inside the current month count: pin "today" to
    // that month, or the test only passes in September 2026.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-20T15:00:00.000Z'));
    pacing.current = buildPacing({ availableCents: 10_000 });
    render(<PaidMediaBuilder canRequest />);
    type(screen.getByLabelText(/^Início/), '2026-09-20');
    type(screen.getByLabelText(/^Fim/), '2026-09-29');
    type(screen.getByLabelText(/Verba por dia/), '20,00');
    expect(screen.getByText(/passa do que a conta ainda permite/)).toBeTruthy();
  });

  it("shows Meta's own figures line by line, each with when it was read", () => {
    pacing.current = buildPacing({
      availableCents: 82_916,
      platformRemainingCents: 97_916,
      lastReconciledAt: '2026-09-30T16:30:00.000Z',
      platformReading: buildReading({
        spendCapCents: 250_000,
        amountSpentCents: 152_084,
        spendCapRemainingCents: 97_916,
        amountDueCents: 6_008,
        fundingKind: 'credit_card',
        spendCapReset: 'monthly',
        spendCapResetsOn: '2026-10-01',
      }),
    });
    render(<PaidMediaBuilder canRequest />);
    expect(screen.getByText('R$ 829,16')).toBeTruthy();
    expect(screen.getByText('resta R$ 979,16 de R$ 2.500,00')).toBeTruthy();
    expect(screen.getByText('limite volta a R$ 2.500,00 em 01/10')).toBeTruthy();
    expect(screen.getByText('R$ 60,08')).toBeTruthy();
    expect(
      screen.getByText(/não informa saldo para esta conta \(pagamento por cartão\)/),
    ).toBeTruthy();
    expect(screen.getAllByText('lido em 30/09 13:34')).toHaveLength(3);
    expect(platformRefresh).toHaveBeenCalled();
  });

  it('shows "—" and the reason when the last read failed, never the old figure', () => {
    pacing.current = buildPacing({
      availableCents: 82_916,
      platformRemainingCents: 97_916,
      platformReading: buildReading({
        status: 'failed',
        reason: 'a última leitura falhou: MetaApiError: (#190) token expirado',
        attemptedAtIso: '2026-09-30T16:45:00.000Z',
      }),
    });
    render(<PaidMediaBuilder canRequest />);
    expect(screen.queryByText('R$ 829,16')).toBeNull();
    expect(screen.queryByText(/R\$ 979,16/)).toBeNull();
    expect(screen.getAllByText('—').length).toBeGreaterThanOrEqual(4);
    expect(screen.getAllByText(/token expirado/).length).toBeGreaterThan(0);
    expect(
      screen.getAllByText(/última tentativa em 30\/09 13:45 · última leitura boa em 30\/09 13:34/)
        .length,
    ).toBe(3);
  });

  it('warns in red when Meta would pause the account before the plan ends', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-20T15:00:00.000Z'));
    activeBudgets.current = [
      {
        campaignExternalId: '1',
        name: '28Set',
        dailyBudgetCents: 12_000,
        startDate: null,
        endDate: '2026-10-05',
      },
    ];
    pacing.current = buildPacing({
      platformReading: buildReading({
        spendCapCents: 250_000,
        amountSpentCents: 200_000,
        spendCapRemainingCents: 50_000,
        spendCapReset: 'monthly',
        spendCapResetsOn: '2026-10-01',
      }),
    });
    render(<PaidMediaBuilder canRequest />);
    type(screen.getByLabelText(/^Início/), '2026-09-20');
    type(screen.getByLabelText(/^Fim/), '2026-09-29');
    type(screen.getByLabelText(/Verba por dia/), '80,00');
    // 200/day from the 20th against R$ 500: the 22nd breaks it.
    expect(
      screen.getByText(/A Meta vai pausar a conta por volta de 22\/09, aumente o limite de gastos/),
    ).toBeTruthy();
  });

  it('shows the Meta standard instead of UTM fields, and a destination without UTMs', () => {
    render(<PaidMediaBuilder canRequest />);
    type(screen.getByLabelText('Nome da campanha'), 'Expansão SP');
    expect(screen.queryByLabelText('utm_campaign')).toBeNull();
    expect(screen.getByText(META_URL_TAGS)).toBeTruthy();
    expect(screen.getByText(/A Meta preenche a origem e os ids/i)).toBeTruthy();
  });

  it('takes one image per variation and says when it will be cropped', () => {
    render(<PaidMediaBuilder canRequest />);
    const [first, second] = screen.getAllByLabelText(/^Imagem — Criativo/);
    chooseImage(first as Element);
    expect(screen.getByText(/1080 × 1080 px · proporção 1:1 certa/)).toBeTruthy();

    uploadSize.current = { width: 1200, height: 628 };
    chooseImage(second as Element);
    expect(screen.getByText(/proporção diferente de 1:1/)).toBeTruthy();

    // The preview shows each uploaded image next to its copy.
    expect(screen.getAllByAltText(/^Criativo — Criativo 1/).length).toBeGreaterThan(0);
    expect(screen.getByText(/Não é a prévia oficial da Meta/)).toBeTruthy();
  });

  it('previews in the placement of the chosen format, and lets the operator see the other cut', () => {
    render(<PaidMediaBuilder canRequest />);
    const media = () => document.querySelector<HTMLElement>('.ad-preview-media')?.style.aspectRatio;
    const pressed = (name: string) =>
      screen.getByRole('button', { name }).getAttribute('aria-pressed');

    // Feed quadrado is the default format.
    expect(pressed('Feed')).toBe('true');
    expect(media()).toBe('1080 / 1080');

    fireEvent.click(screen.getByRole('button', { name: 'Stories' }));
    expect(media()).toBe('9 / 16');
    expect(screen.getByText(/É assim que a mesma imagem seria cortada em Stories/)).toBeTruthy();

    // Back on the chosen side, the preview follows section 6 again.
    fireEvent.click(screen.getByRole('button', { name: 'Feed' }));
    type(screen.getByLabelText(/^Formato/), 'stories_reels');
    expect(pressed('Stories')).toBe('true');
    expect(media()).toBe('9 / 16');

    fireEvent.click(screen.getByRole('button', { name: 'Feed' }));
    expect(media()).toBe('4 / 5');
  });

  it('refuses a file type before sending it anywhere', () => {
    render(<PaidMediaBuilder canRequest />);
    chooseImage(screen.getAllByLabelText(/^Imagem — Criativo/)[0] as Element, 'image/webp');
    expect(screen.getByText('Use uma imagem PNG ou JPEG.')).toBeTruthy();
    expect(uploads).toBe(0);
  });

  it('starts from the audience Wings saved, and leaves it editable', () => {
    savedAudience.current = {
      idealCustomerProfile: 'Empreendedor com capital próprio e perfil de gestão.',
      reach: {
        states: ['SP', 'PR'],
        cities: [{ name: 'Goiânia', state: 'GO' }],
        customLocations: [],
      },
      updatedAt: '2026-09-18T12:00:00.000Z',
      updatedByName: 'Eric',
    };
    render(<PaidMediaBuilder canRequest />);

    const icp = screen.getByLabelText(/^Quem é o cliente ideal/) as HTMLTextAreaElement;
    expect(icp.value).toContain('capital próprio');
    expect((screen.getByRole('checkbox', { name: 'PR' }) as HTMLInputElement).checked).toBe(true);
    expect(screen.getByText(/Padrão atual salvo por Eric/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Remover Goiânia' }));
    expect(screen.getByText('Nenhuma cidade adicionada.')).toBeTruthy();
  });

  it('takes a radius on the map into the summary and into the request', async () => {
    render(<PaidMediaBuilder canRequest />);
    fillValidCampaign();
    // The map alone is a valid reach: no state, no city.
    fireEvent.click(screen.getByRole('checkbox', { name: 'SP' }));
    fireEvent.click(screen.getByRole('button', { name: 'clicar no mapa' }));
    fireEvent.click(screen.getByRole('button', { name: 'raio 40' }));
    expect(screen.getByText('40 km ao redor de Campinas')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Lançar campanha' }));
    await waitFor(() => expect(requestCampaign).toHaveBeenCalledTimes(1));
    expect(requestCampaign.mock.calls[0]?.[0].reach).toEqual({
      states: [],
      cities: [],
      customLocations: [
        { latitude: -22.9056, longitude: -47.0608, radiusKm: 40, label: 'Campinas' },
      ],
    });
  });

  it('adds cities, and saves profile and reach as the Wings default', () => {
    render(<PaidMediaBuilder canRequest />);
    fireEvent.click(screen.getByRole('button', { name: /Salvar perfil e alcance/ }));
    expect(screen.getByText(/Descreva o cliente ideal/)).toBeTruthy();
    expect(saveAudience).not.toHaveBeenCalled();

    type(screen.getByLabelText(/^Quem é o cliente ideal/), 'Empreendedor com perfil de gestão.');
    type(screen.getByLabelText('Cidade'), 'Curitiba');
    type(screen.getByLabelText('UF da cidade'), 'PR');
    fireEvent.click(screen.getByRole('button', { name: 'Adicionar cidade' }));
    expect(screen.getAllByText(/Curitiba\/PR/).length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole('button', { name: /Salvar perfil e alcance/ }));
    expect(saveAudience).toHaveBeenCalledWith({
      idealCustomerProfile: 'Empreendedor com perfil de gestão.',
      reach: { states: [], cities: [{ name: 'Curitiba', state: 'PR' }], customLocations: [] },
    });
  });

  it('opens with two creatives, goes down to one and up to five, and no more', () => {
    render(<PaidMediaBuilder canRequest />);
    expect(screen.getAllByLabelText(/^Título/)).toHaveLength(2);
    // Every card can go, as long as one stays.
    expect(screen.getAllByRole('button', { name: 'Remover' })).toHaveLength(2);
    fireEvent.click(screen.getAllByRole('button', { name: 'Remover' })[0] as Element);
    expect(screen.getAllByLabelText(/^Título/)).toHaveLength(1);
    expect(screen.queryByRole('button', { name: 'Remover' })).toBeNull();
    for (let count = 2; count <= 5; count += 1) {
      fireEvent.click(screen.getByRole('button', { name: /Adicionar criativo/ }));
      expect(screen.getAllByLabelText(/^Título/)).toHaveLength(count);
    }
    expect(screen.queryByRole('button', { name: /Adicionar criativo/ })).toBeNull();
  });

  it('copies one text into all creatives on request', () => {
    render(<PaidMediaBuilder canRequest />);
    type(screen.getAllByLabelText(/^Título/)[0] as Element, 'Sua marca pronta para franquear');
    fireEvent.click(screen.getByLabelText(/Usar o mesmo texto/));
    // One copy block left on screen, written into every creative.
    expect(screen.getAllByLabelText(/^Título/)).toHaveLength(1);
    expect(screen.getByText('Texto de todos os criativos')).toBeTruthy();
    fireEvent.click(screen.getByLabelText(/Usar o mesmo texto/));
    const titles = screen.getAllByLabelText(/^Título/) as HTMLInputElement[];
    expect(titles.map((input) => input.value)).toEqual([
      'Sua marca pronta para franquear',
      'Sua marca pronta para franquear',
    ]);
  });

  it('checks the draft on demand without sending anything', async () => {
    render(<PaidMediaBuilder canRequest />);
    fireEvent.click(screen.getByRole('button', { name: 'Conferir campanha' }));
    await waitFor(() => expect(screen.getByText(/Há campos para corrigir/)).toBeTruthy());
    expect(screen.getByText('Dê um nome à campanha')).toBeTruthy();

    fillValidCampaign();
    fireEvent.click(screen.getByRole('button', { name: 'Conferir campanha' }));
    await waitFor(() => expect(screen.getByText(/Tudo conferido/)).toBeTruthy());
    expect(requestCampaign).not.toHaveBeenCalled();
  });

  it('launches a request — paused by default — and never with blocked copy', async () => {
    render(<PaidMediaBuilder canRequest />);
    fillValidCampaign();
    type(screen.getAllByLabelText(/^Título/)[1] as Element, 'Retorno garantido');
    fireEvent.click(screen.getByRole('button', { name: 'Lançar campanha' }));
    await waitFor(() => expect(screen.getByText(/Há texto bloqueado/)).toBeTruthy());
    expect(requestCampaign).not.toHaveBeenCalled();

    type(screen.getAllByLabelText(/^Título/)[1] as Element, 'Seja um franqueado Wings');
    fireEvent.click(screen.getByRole('button', { name: 'Lançar campanha' }));
    await waitFor(() => expect(requestCampaign).toHaveBeenCalledTimes(1));
    expect(requestCampaign.mock.calls[0]?.[0]).toMatchObject({
      name: 'Sacrifício — teste de escrita',
      dailyBudgetCents: 600,
      startPaused: true,
      reach: { states: ['SP'], cities: [], customLocations: [] },
      variations: [
        { creativeId: '00000001-0000-4000-8000-000000000000' },
        { creativeId: '00000002-0000-4000-8000-000000000000' },
      ],
    });
  });

  it('points at the approval once asked, and says nothing was published', () => {
    launchState.current = { isSuccess: true, data: { approvalId: 'ap-9' } };
    render(<PaidMediaBuilder canRequest />);
    expect(screen.getByText(/Nada foi publicado/)).toBeTruthy();
    expect(screen.getByRole('link', { name: /Abrir o pedido/ }).getAttribute('href')).toBe(
      '/marketing/trafego-pago-wings/aprovacoes/ap-9',
    );
  });

  it('keeps the launch button off for someone who may not ask', () => {
    render(<PaidMediaBuilder canRequest={false} />);
    expect(
      (screen.getByRole('button', { name: 'Lançar campanha' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(screen.getByText(/mas não enviar o pedido/)).toBeTruthy();
  });
});

describe('the builder on Google', () => {
  const choose = (name: RegExp) => fireEvent.click(screen.getByRole('radio', { name }));

  function fillCommon() {
    type(screen.getByLabelText(/^Nome da campanha/), 'Pesquisa — franquia SP');
    type(screen.getByLabelText(/Página de destino/), 'https://wingscompany.com.br/franquia');
    type(screen.getByLabelText(/Verba por dia/), '30,00');
    type(
      screen.getByLabelText(/^Quem é o cliente ideal/),
      'Empreendedor de 30 a 50 anos, com experiência em gestão.',
    );
    fireEvent.click(screen.getByRole('checkbox', { name: 'SP' }));
  }

  /** A square PNG logo in the Drive, as the media library lists it. */
  const LOGO_FILE = '55555555-5555-4555-8555-555555555555';
  const logoAsset = (): MediaAsset => ({
    id: '66666666-6666-4666-8666-666666666666',
    kind: 'image',
    origin: 'upload',
    mimeType: 'image/png',
    byteSize: 40_000,
    width: 512,
    height: 512,
    aspect: '1:1',
    durationSeconds: null,
    prompt: null,
    model: null,
    credits: null,
    clientId: '00000000-0000-4000-8000-0000000000c1',
    client: 'Wings Company',
    folder: null,
    tags: [],
    ownerName: 'Marketing',
    createdAt: '2026-10-01T12:00:00.000Z',
    downloadPath: '/media/assets/66666666-6666-4666-8666-666666666666/file',
    driveFileId: LOGO_FILE,
  });

  function pickLogo() {
    libraryAssets.current = [logoAsset()];
    fireEvent.click(screen.getByRole('button', { name: 'Escolher a logo no Drive' }));
    const dialog = screen.getByRole('dialog', { name: 'Escolher a logo do anúncio' });
    fireEvent.click(within(dialog).getByRole('button', { name: /^Imagem, 512 × 512/ }));
  }

  function fillYoutube() {
    fillCommon();
    type(byField('Vídeo 1'), 'https://youtu.be/dQw4w9WgXcQ');
    type(byField('Título 1'), 'Conheça a Wings');
    type(byField('Título longo 1'), 'Sua empresa pode virar uma rede de franquias');
    type(byField('Descrição 1'), 'Diagnóstico com quem já formatou centenas de marcas.');
    pickLogo();
    fireEvent.change(byField('Ação de conversão (lance: Maximizar conversões)'), {
      target: { value: '7804997444' },
    });
  }

  function fillSearch() {
    fillCommon();
    type(
      screen.getByLabelText(/^Palavras-chave(?! negativas)/),
      'franquia de alimentação\n\n  abrir franquia  ',
    );
    type(screen.getByLabelText(/^Palavras-chave negativas/), 'grátis');
    type(byField('Título 1'), 'Franquia Wings');
    type(byField('Título 2'), 'Expanda sua marca');
    type(byField('Título 3'), 'Fale com a Wings');
    type(byField('Descrição 1'), 'Conheça o modelo de negócio e o suporte.');
    type(byField('Descrição 2'), 'Suporte do início ao fim.');
  }

  it('asks the cockpit for the Meta account by default, and the Google one once the platform changes', () => {
    render(<PaidMediaBuilder canRequest />);
    expect(cockpitCalls.at(-1)).toEqual({ days: 7, platform: 'meta' });

    choose(/Google Pesquisa/);
    expect(cockpitCalls.at(-1)).toEqual({ days: 7, platform: 'google_search' });

    choose(/YouTube/);
    expect(cockpitCalls.at(-1)).toEqual({ days: 7, platform: 'youtube' });
  });

  it('shows the search fields only on Google Pesquisa, and hides what is Meta only', () => {
    render(<PaidMediaBuilder canRequest />);
    expect(screen.queryByLabelText(/^Palavras-chave(?! negativas)/)).toBeNull();
    expect(screen.queryByLabelText(/Link do vídeo/)).toBeNull();

    choose(/Google Pesquisa/);
    expect(screen.getByLabelText(/^Palavras-chave(?! negativas)/)).toBeTruthy();
    expect(screen.getByLabelText(/^Palavras-chave negativas/)).toBeTruthy();
    expect(screen.queryByLabelText(/Link do vídeo/)).toBeNull();
    // Meta's image, format and variations are gone; the map stays.
    expect(screen.queryByLabelText(/^Imagem — Criativo/)).toBeNull();
    expect(screen.queryByLabelText(/^Formato/)).toBeNull();
    expect(screen.queryByRole('button', { name: '+ Adicionar variação' })).toBeNull();
    expect(screen.getByRole('button', { name: 'clicar no mapa' })).toBeTruthy();
    expect(screen.queryByText(/ainda não vale para o Google/)).toBeNull();

    const sections = screen.getAllByRole('region').filter((el) => el.matches('.builder-section'));
    expect(sections.map((el) => el.querySelector('.builder-step')?.textContent)).toEqual(
      Array.from({ length: 12 }, (_, index) => String(index + 1)),
    );

    choose(/^Meta/);
    expect(screen.queryByLabelText(/^Palavras-chave(?! negativas)/)).toBeNull();
    expect(screen.getAllByLabelText(/^Imagem — Criativo/)).toHaveLength(2);
  });

  it('shows the video fields only on YouTube, and says what kind of campaign it is', () => {
    render(<PaidMediaBuilder canRequest />);
    choose(/YouTube/);
    expect(byField('Vídeo 1')).toBeTruthy();
    expect(byField('Título longo 1')).toBeTruthy();
    expect(byField('Nome da empresa')).toBeTruthy();
    expect(screen.getByText('Discover, Gmail e Display ficam sempre desligados.')).toBeTruthy();
    expect(screen.queryByLabelText(/^Palavras-chave(?! negativas)/)).toBeNull();
    expect(screen.queryByLabelText(/^Imagem — Criativo/)).toBeNull();
    expect(screen.getByText(/Criada como campanha Demand Gen restrita ao YouTube/)).toBeTruthy();
  });

  it('locks every campaign on paused, and says why on each platform', () => {
    render(<PaidMediaBuilder canRequest />);
    const paused = () =>
      screen.getByRole('checkbox', { name: /Criar a campanha/ }) as HTMLInputElement;
    expect(paused().checked).toBe(true);
    expect(paused().disabled).toBe(true);
    expect(screen.getByText(/Tudo nasce pausado: campanha, conjunto e anúncios/)).toBeTruthy();

    choose(/Google Pesquisa/);
    expect(paused().checked).toBe(true);
    expect(paused().disabled).toBe(true);
    expect(screen.getByText('Campanhas do Google nascem sempre pausadas.')).toBeTruthy();
  });

  it('launches a search request carrying only what belongs to it', async () => {
    render(<PaidMediaBuilder canRequest />);
    choose(/Google Pesquisa/);
    fillSearch();
    fireEvent.click(screen.getByRole('button', { name: 'Lançar campanha' }));

    await waitFor(() => expect(requestCampaign).toHaveBeenCalledTimes(1));
    const sent = requestCampaign.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(sent).toMatchObject({
      platform: 'google_search',
      name: 'Pesquisa — franquia SP',
      dailyBudgetCents: 3000,
      startPaused: true,
      variations: [],
      reach: { states: ['SP'], cities: [], customLocations: [] },
      search: {
        // Network, place and bid: the builder's defaults, in the payload.
        network: 'google_search_only',
        locationMode: 'presence',
        bidding: 'maximize_clicks',
        maxCpcCents: 600,
        // Bare lines take the default match: exact.
        keywords: ['[franquia de alimentação]', '[abrir franquia]'],
        negativeKeywords: ['grátis'],
        headlines: ['Franquia Wings', 'Expanda sua marca', 'Fale com a Wings'],
        descriptions: ['Conheça o modelo de negócio e o suporte.', 'Suporte do início ao fim.'],
      },
      utms: { utm_source: 'google', utm_medium: 'cpc' },
    });
    expect(sent).not.toHaveProperty('formatKey');
    expect(sent).not.toHaveProperty('youtube');
    expect((sent.search as Record<string, unknown>).adGroupName).toBeUndefined();
  });

  it('keeps a marked match, applies the chosen default to bare lines, and never sends broad', async () => {
    render(<PaidMediaBuilder canRequest />);
    choose(/Google Pesquisa/);
    fillSearch();
    fireEvent.click(screen.getByRole('radio', { name: /Frase/ }));
    type(
      screen.getByLabelText(/^Palavras-chave(?! negativas)/),
      '[franquia de alimentação]\nabrir franquia',
    );
    type(screen.getByLabelText(/Nome do grupo de anúncios/), 'Grupo SP');
    fireEvent.click(screen.getByRole('button', { name: 'Lançar campanha' }));

    await waitFor(() => expect(requestCampaign).toHaveBeenCalledTimes(1));
    expect(requestCampaign.mock.calls[0]?.[0]).toMatchObject({
      search: {
        adGroupName: 'Grupo SP',
        keywords: ['[franquia de alimentação]', '"abrir franquia"'],
      },
    });
  });

  it('launches a YouTube request carrying only what belongs to it', async () => {
    render(<PaidMediaBuilder canRequest canPickMedia />);
    choose(/YouTube/);
    fillYoutube();
    fireEvent.click(screen.getByRole('button', { name: 'Lançar campanha' }));

    await waitFor(() => expect(requestCampaign).toHaveBeenCalledTimes(1));
    const sent = requestCampaign.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(sent).toMatchObject({
      platform: 'youtube',
      startPaused: true,
      variations: [],
      youtube: {
        // Boxes left empty are not sent.
        videos: ['https://youtu.be/dQw4w9WgXcQ'],
        headlines: ['Conheça a Wings'],
        longHeadlines: ['Sua empresa pode virar uma rede de franquias'],
        descriptions: ['Diagnóstico com quem já formatou centenas de marcas.'],
        businessName: 'Wings Company',
        logoFileId: '55555555-5555-4555-8555-555555555555',
        conversionAction: { id: '7804997444', name: 'RD form conversion' },
        ageMin: 25,
        ageMax: 65,
        includeUnknownAge: false,
        channels: ['youtube_in_stream', 'youtube_in_feed', 'youtube_shorts'],
        audienceSegments: [],
      },
    });
    expect(sent).not.toHaveProperty('formatKey');
    expect(sent).not.toHaveProperty('search');
    expect((sent.youtube as Record<string, unknown>).targetCpaCents).toBeUndefined();
  });

  it('fills the Out26 template, matches the conversion by name and waits for the logo', async () => {
    render(<PaidMediaBuilder canRequest canPickMedia />);
    choose(/YouTube/);
    fireEvent.click(
      screen.getByRole('button', { name: 'Usar modelo YouTube · Formatação · Out26' }),
    );

    expect((screen.getByLabelText(/^Nome da campanha/) as HTMLInputElement).value).toBe(
      'YouTube · Formatação · Out26',
    );
    expect((byField('Vídeo 1') as HTMLInputElement).value).toContain('34zzJBPHlYg');
    expect(
      (byField('Ação de conversão (lance: Maximizar conversões)') as HTMLSelectElement).value,
    ).toBe('7804997444');
    expect(screen.getByText(/Modelo “YouTube · Formatação · Out26” carregado/)).toBeTruthy();

    // Without the logo, nothing is asked for.
    fireEvent.click(screen.getByRole('button', { name: 'Lançar campanha' }));
    await waitFor(() => expect(screen.getByText('Escolha a logo no Drive')).toBeTruthy());
    expect(requestCampaign).not.toHaveBeenCalled();

    pickLogo();
    fireEvent.click(screen.getByRole('button', { name: 'Lançar campanha' }));
    await waitFor(() => expect(requestCampaign).toHaveBeenCalledTimes(1));
    expect(requestCampaign.mock.calls[0]?.[0]).toMatchObject({
      name: 'YouTube · Formatação · Out26',
      dailyBudgetCents: 5000,
      destinationUrl: 'https://wingssystem.online/lp/formatacao',
      reach: { states: ['DF', 'GO', 'RJ', 'SC'], cities: [], customLocations: [] },
      youtube: {
        videos: ['https://www.youtube.com/watch?v=34zzJBPHlYg'],
        conversionAction: { id: '7804997444', name: 'RD form conversion' },
        logoFileId: '55555555-5555-4555-8555-555555555555',
        ageMin: 25,
        ageMax: 65,
      },
    });
  });

  it('takes a target CPA, other ages, fewer channels and a signal from the account', async () => {
    render(<PaidMediaBuilder canRequest canPickMedia />);
    choose(/YouTube/);
    fillYoutube();
    type(byField('CPA alvo (opcional)'), '90,00');
    fireEvent.change(byField('Idade mínima'), { target: { value: '35' } });
    fireEvent.change(byField('Idade máxima'), { target: { value: '54' } });
    fireEvent.click(screen.getByRole('checkbox', { name: 'YouTube Shorts' }));
    fireEvent.click(screen.getByRole('checkbox', { name: /Concorrentes/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Lançar campanha' }));

    await waitFor(() => expect(requestCampaign).toHaveBeenCalledTimes(1));
    expect(requestCampaign.mock.calls[0]?.[0]).toMatchObject({
      youtube: {
        targetCpaCents: 9000,
        ageMin: 35,
        ageMax: 54,
        channels: ['youtube_in_stream', 'youtube_in_feed'],
        audienceSegments: [{ kind: 'custom_audience', id: '1019547251', name: 'Concorrentes' }],
      },
    });
  });

  it('reads the target CPA the Brazilian way, and refuses what it cannot read', async () => {
    render(<PaidMediaBuilder canRequest canPickMedia />);
    choose(/YouTube/);
    fillYoutube();
    type(byField('CPA alvo (opcional)'), '1.234,56');
    fireEvent.click(screen.getByRole('button', { name: 'Lançar campanha' }));
    await waitFor(() => expect(requestCampaign).toHaveBeenCalledTimes(1));
    expect(requestCampaign.mock.calls[0]?.[0]).toMatchObject({
      youtube: { targetCpaCents: 123456 },
    });

    requestCampaign.mockClear();
    type(byField('CPA alvo (opcional)'), '90.50');
    fireEvent.click(screen.getByRole('button', { name: 'Lançar campanha' }));
    await waitFor(() => expect(requestCampaign).toHaveBeenCalledTimes(1));
    expect(requestCampaign.mock.calls[0]?.[0]).toMatchObject({ youtube: { targetCpaCents: 9050 } });

    requestCampaign.mockClear();
    type(byField('CPA alvo (opcional)'), 'noventa');
    fireEvent.click(screen.getByRole('button', { name: 'Lançar campanha' }));
    await waitFor(() => expect(screen.getByText('Informe o CPA alvo')).toBeTruthy());
    expect(requestCampaign).not.toHaveBeenCalled();
  });

  it('checks the videos on YouTube and says which one Google would not take', () => {
    privateVideos.add('M0v5U4AaTvo');
    render(<PaidMediaBuilder canRequest />);
    choose(/YouTube/);
    type(byField('Vídeo 1'), 'https://youtu.be/dQw4w9WgXcQ');
    type(byField('Vídeo 2 (opcional)'), 'M0v5U4AaTvo');
    fireEvent.click(screen.getByRole('button', { name: 'Conferir vídeos no YouTube' }));

    expect(checkVideos).toHaveBeenCalledWith(['https://youtu.be/dQw4w9WgXcQ', 'M0v5U4AaTvo']);
    expect(screen.getByText('Publicado (público ou não listado)')).toBeTruthy();
    expect(screen.getByText('Privado ou sem incorporação: o Google não aceita')).toBeTruthy();
    privateVideos.clear();
  });

  it('refuses a logo the ad cannot carry, in the picker itself', () => {
    render(<PaidMediaBuilder canRequest canPickMedia />);
    choose(/YouTube/);
    libraryAssets.current = [
      { ...logoAsset(), width: 1125, height: 600, aspect: '16:9' },
      { ...logoAsset(), id: '77777777-7777-4777-8777-777777777777', driveFileId: null },
    ];
    fireEvent.click(screen.getByRole('button', { name: 'Escolher a logo no Drive' }));
    const dialog = screen.getByRole('dialog', { name: 'Escolher a logo do anúncio' });
    expect(within(dialog).getByText('Não é quadrada')).toBeTruthy();
    expect(within(dialog).getByText('Ainda não está no Drive')).toBeTruthy();
  });

  it('loads a saved Google draft whole, and saving validates like a launch without sending', async () => {
    savedDrafts.current = [
      {
        id: 'd1',
        name: 'SEARCH | Formatação',
        platform: 'google_search',
        updatedAt: '2026-09-25T15:00:00Z',
        createdByName: null,
      },
    ];
    savedDraftPayload.current = {
      platform: 'google_search',
      name: 'SEARCH | Formatação | Alta Intenção | Set26',
      objective: 'lead',
      idealCustomerProfile: 'Empresário com negócio validado que quer crescer por franquias.',
      reach: { states: ['SP'], cities: [{ name: 'Campinas', state: 'SP' }], customLocations: [] },
      destinationUrl: 'https://wingscompany.com.br/formatar/franquia',
      startDate: '2026-09-25',
      endDate: '2026-10-25',
      dailyBudgetCents: 10000,
      utms: {
        utm_source: 'google',
        utm_medium: 'cpc',
        utm_campaign: 'search-formatacao',
        utm_content: 'lead',
      },
      startPaused: true,
      variations: [],
      search: {
        adGroupName: 'Formatação | Alta Intenção',
        network: 'google_search_only',
        locationMode: 'presence',
        bidding: 'maximize_clicks',
        maxCpcCents: 450,
        keywords: ['"formatação de franquia"', '[wings company]'],
        negativeKeywords: ['emprego', 'vaga'],
        headlines: ['Formate Sua Franquia', 'Consultoria de Franquias', 'Fale com um Especialista'],
        descriptions: [
          'Formatamos sua empresa para virar franqueadora.',
          'Fale com um especialista da Wings.',
        ],
      },
    };
    try {
      render(<PaidMediaBuilder canRequest />);
      fireEvent.click(screen.getByRole('button', { name: 'Carregar' }));
      await screen.findByText(/Rascunho “Rascunho real” carregado/);

      expect((screen.getByLabelText(/^Nome da campanha/) as HTMLInputElement).value).toBe(
        'SEARCH | Formatação | Alta Intenção | Set26',
      );
      expect((byField('Nome do grupo de anúncios') as HTMLInputElement).value).toBe(
        'Formatação | Alta Intenção',
      );
      expect(
        (screen.getByLabelText(/^Palavras-chave(?! negativas)/) as HTMLTextAreaElement).value,
      ).toBe('"formatação de franquia"\n[wings company]');
      expect((byField('Título 1') as HTMLInputElement).value).toBe('Formate Sua Franquia');
      expect((screen.getByLabelText(/Verba por dia/) as HTMLInputElement).value).toBe('100,00');
      // Shown as reais at once, never as the raw cents the form holds.
      expect((byField('CPC máximo (R$)') as HTMLInputElement).value).toBe('4,50');
      expect(screen.getAllByText(/Campinas/).length).toBeGreaterThan(0);
      expect(requestCampaign).not.toHaveBeenCalled();

      fireEvent.click(screen.getByRole('button', { name: 'Salvar rascunho' }));
      await waitFor(() => expect(saveDraft).toHaveBeenCalledTimes(1));
      expect(saveDraft.mock.calls[0]?.[0]).toMatchObject({
        draft: { platform: 'google_search', search: { adGroupName: 'Formatação | Alta Intenção' } },
      });
      expect(requestCampaign).not.toHaveBeenCalled();
    } finally {
      savedDrafts.current = [];
      savedDraftPayload.current = null;
    }
  });

  it('keeps a radius chosen on Meta when the platform becomes Google, and sends it', async () => {
    render(<PaidMediaBuilder canRequest />);
    fireEvent.click(screen.getByRole('button', { name: 'clicar no mapa' }));
    choose(/Google Pesquisa/);
    fillSearch();
    // The summary reads the states and the radius together.
    expect(screen.getAllByText(/15 km ao redor de Campinas/).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('button', { name: 'Lançar campanha' }));

    await waitFor(() => expect(requestCampaign).toHaveBeenCalledTimes(1));
    expect(requestCampaign.mock.calls[0]?.[0]).toMatchObject({
      platform: 'google_search',
      reach: {
        customLocations: [
          { latitude: -22.9056, longitude: -47.0608, radiusKm: 15, label: 'Campinas' },
        ],
      },
    });
  });

  it('shows the same reach block on every platform, the map off where no radius is taken', () => {
    render(<PaidMediaBuilder canRequest />);
    for (const name of [/^Meta/, /Google Pesquisa/, /YouTube/]) {
      choose(name);
      const reach = screen.getByRole('region', { name: /Área de alcance/ });
      expect(reach.querySelector('.builder-states')).toBeTruthy();
      expect(reach.textContent).toContain('Cidades');
      // Demand Gen places the ad group, which takes states and cities, no radius.
      const radius = name.source === 'YouTube' ? 'yes' : 'no';
      expect(reach.querySelector('[data-testid="radius-map"]')?.getAttribute('data-disabled')).toBe(
        radius,
      );
    }
  });

  it('refuses a link that is not a YouTube video, and sends nothing', async () => {
    render(<PaidMediaBuilder canRequest canPickMedia />);
    choose(/YouTube/);
    fillYoutube();
    type(byField('Vídeo 1'), 'https://vimeo.com/123456');
    fireEvent.click(screen.getByRole('button', { name: 'Lançar campanha' }));

    await waitFor(() =>
      expect(screen.getByText('Informe um link https:// do YouTube ou o id do vídeo')).toBeTruthy(),
    );
    expect(requestCampaign).not.toHaveBeenCalled();
  });

  it('refuses more than 40 keywords', async () => {
    render(<PaidMediaBuilder canRequest />);
    choose(/Google Pesquisa/);
    fillSearch();
    type(
      screen.getByLabelText(/^Palavras-chave(?! negativas)/),
      Array.from({ length: 41 }, (_, index) => `franquia termo ${index}`).join('\n'),
    );
    expect(screen.getByText(/41\/40/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Lançar campanha' }));

    await waitFor(() => expect(screen.getByText('No máximo 40 palavras-chave')).toBeTruthy());
    expect(requestCampaign).not.toHaveBeenCalled();
  });

  it('holds search copy to the compliance rules, on screen and on launch', async () => {
    render(<PaidMediaBuilder canRequest />);
    choose(/Google Pesquisa/);
    fillSearch();
    type(byField('Título 2'), 'Retorno garantido');

    expect(screen.getByText(/Este texto não pode ir ao ar/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Lançar campanha' }));
    await waitFor(() => expect(screen.getByText(/Há texto bloqueado/)).toBeTruthy());
    expect(requestCampaign).not.toHaveBeenCalled();
  });

  it('previews the video by its YouTube still, with the typed title', () => {
    render(<PaidMediaBuilder canRequest />);
    choose(/YouTube/);
    expect(screen.getByText('Cole um link do YouTube para ver a prévia')).toBeTruthy();

    type(byField('Vídeo 1'), 'https://www.youtube.com/watch?v=dQw4w9WgXcQ');
    type(byField('Título 1'), 'Conheça a Wings');
    type(byField('Nome da empresa'), '');
    type(screen.getByLabelText(/Página de destino/), 'https://www.wingscompany.com.br/franquia');

    const still = screen.getByAltText('Miniatura do vídeo no YouTube') as HTMLImageElement;
    expect(still.src).toBe('https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg');
    const preview = still.closest('figure');
    expect(preview?.textContent).toContain('Conheça a Wings');
    expect(preview?.textContent).toContain('wingscompany.com.br');
    expect(screen.getByText(/Não é a prévia oficial do Google/)).toBeTruthy();
  });

  it('previews the search ad the way Google lays it out', () => {
    render(<PaidMediaBuilder canRequest />);
    choose(/Google Pesquisa/);
    fillSearch();
    type(byField('Título 2'), 'Leve para sua cidade');

    const preview = screen.getByText('Anúncio na Pesquisa do Google').closest('figure');
    expect(preview?.textContent).toContain('Patrocinado');
    expect(preview?.textContent).toContain('wingscompany.com.br › franquia');
    expect(preview?.textContent).toContain('Franquia Wings | Leve para sua cidade');
    expect(preview?.textContent).toContain('Conheça o modelo de negócio e o suporte.');
  });

  it('estimates Google at the budget itself over the period, and says so', () => {
    render(<PaidMediaBuilder canRequest />);
    type(screen.getByLabelText(/^Início/), '2026-09-20');
    type(screen.getByLabelText(/^Fim/), '2026-09-29');
    type(screen.getByLabelText(/Verba por dia/), '20,00');
    expect(screen.getAllByText('R$ 250,00').length).toBeGreaterThan(0);

    choose(/Google Pesquisa/);
    // R$ 20 × 10 days × 1: Google's 2× is a promise about one day only.
    expect(screen.getAllByText('R$ 200,00').length).toBeGreaterThan(0);
    expect(screen.queryByText('R$ 250,00')).toBeNull();
    expect(screen.queryByText('R$ 400,00')).toBeNull();
    expect(
      screen.getByText(
        'O Google pode gastar até o dobro da verba diária num dia, mas no período não cobra além da verba.',
      ),
    ).toBeTruthy();

    // A single day has no period to even it out: the worst day decides.
    type(screen.getByLabelText(/^Fim/), '2026-09-20');
    expect(screen.getAllByText('R$ 40,00').length).toBeGreaterThan(0);
    expect(screen.getByText(/o pior caso de um único dia/)).toBeTruthy();
    expect(screen.queryByText('A Meta pode gastar até 25% acima disto num dia.')).toBeNull();
  });
});

describe('the builder on Meta: ad set and ads', () => {
  const choose = (name: RegExp) => fireEvent.click(screen.getByRole('radio', { name }));
  const launch = async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Lançar campanha' }));
    await waitFor(() => expect(requestCampaign).toHaveBeenCalledTimes(1));
    return requestCampaign.mock.calls[0]?.[0] as Record<string, unknown>;
  };
  const typeOf = (variation: number, name: string) =>
    fireEvent.click(
      screen
        .getAllByRole('group', { name: `Tipo de criativo — Criativo ${variation}` })
        .flatMap((group) => Array.from(group.querySelectorAll('button')))
        .find((button) => button.textContent === name) as Element,
    );
  const video = (size?: number) => {
    const file = new File(['x'], 'anuncio.mp4', { type: 'video/mp4' });
    if (size !== undefined) Object.defineProperty(file, 'size', { value: size });
    return file;
  };

  it('starts at 25–65, automatic placements and the page Wings saved', () => {
    render(<PaidMediaBuilder canRequest />);
    expect((screen.getByLabelText(/^Idade mínima/) as HTMLInputElement).value).toBe('25');
    expect((screen.getByLabelText(/^Idade máxima/) as HTMLInputElement).value).toBe('65');
    expect(
      (screen.getByRole('radio', { name: /Automático \(Advantage\+\)/ }) as HTMLInputElement)
        .checked,
    ).toBe(true);
    expect(screen.queryByRole('checkbox', { name: 'Facebook Feed' })).toBeNull();
    expect((screen.getByLabelText(/^Página do Facebook/) as HTMLSelectElement).value).toBe(PAGE);
    expect((screen.getByLabelText(/^Conta do Instagram/) as HTMLSelectElement).value).toBe(
      INSTAGRAM,
    );
    // The "em breve" Drive button is gone: the Drive picker is real now, per variation,
    // and only for who may read the library.
    expect(screen.queryByRole('button', { name: /Escolher do Drive/ })).toBeNull();
  });

  it('shows none of it on Google, and sends none of it', async () => {
    render(<PaidMediaBuilder canRequest />);
    choose(/Google Pesquisa/);
    expect(screen.queryByLabelText(/^Idade mínima/)).toBeNull();
    expect(screen.queryByRole('radio', { name: /Automático/ })).toBeNull();
    expect(screen.queryByLabelText(/^Página do Facebook/)).toBeNull();

    type(screen.getByLabelText(/^Nome da campanha/), 'Pesquisa — franquia SP');
    type(screen.getByLabelText(/Página de destino/), 'https://wingscompany.com.br/franquia');
    type(screen.getByLabelText(/Verba por dia/), '30,00');
    type(
      screen.getByLabelText(/^Quem é o cliente ideal/),
      'Empreendedor de 30 a 50 anos, com experiência.',
    );
    fireEvent.click(screen.getByRole('checkbox', { name: 'SP' }));
    type(screen.getByLabelText(/^Palavras-chave(?! negativas)/), 'abrir franquia');
    type(byField('Título 1'), 'Franquia Wings');
    type(byField('Título 2'), 'Expanda sua marca');
    type(byField('Título 3'), 'Fale com a Wings');
    type(byField('Descrição 1'), 'Conheça o modelo de negócio e o suporte.');
    type(byField('Descrição 2'), 'Suporte do início ao fim.');
    const payload = await launch();
    for (const field of ['ageMin', 'ageMax', 'placements', 'identity']) {
      expect(payload).not.toHaveProperty(field);
    }
  });

  it('sends the defaults as the ad set will be created', async () => {
    render(<PaidMediaBuilder canRequest />);
    fillValidCampaign();
    expect(await launch()).toMatchObject({
      ageMin: 25,
      ageMax: 65,
      placements: { mode: 'automatic', facebook: [], instagram: [] },
      identity: { pageId: PAGE, instagramActorId: INSTAGRAM },
      startPaused: true,
      variations: [{ creativeType: 'image' }, { creativeType: 'image' }],
    });
    expect(saveIdentityDefault).not.toHaveBeenCalled();
  });

  it('refuses an age outside 18–65 and a range upside down, in Portuguese', async () => {
    render(<PaidMediaBuilder canRequest />);
    fillValidCampaign();
    type(screen.getByLabelText(/^Idade mínima/), '17');
    fireEvent.click(screen.getByRole('button', { name: 'Conferir campanha' }));
    await waitFor(() => expect(screen.getByText('A idade vai de 18 a 65 anos.')).toBeTruthy());

    type(screen.getByLabelText(/^Idade mínima/), '50');
    type(screen.getByLabelText(/^Idade máxima/), '30');
    fireEvent.click(screen.getByRole('button', { name: 'Conferir campanha' }));
    await waitFor(() =>
      expect(screen.getByText('A idade máxima não pode ser menor que a mínima')).toBeTruthy(),
    );
    expect(requestCampaign).not.toHaveBeenCalled();
  });

  it('takes manual placements, and needs an Instagram account to advertise there', async () => {
    render(<PaidMediaBuilder canRequest />);
    fillValidCampaign();
    choose(/^Manual/);
    fireEvent.click(screen.getByRole('button', { name: 'Conferir campanha' }));
    await waitFor(() =>
      expect(screen.getByText('Escolha ao menos um posicionamento')).toBeTruthy(),
    );

    fireEvent.click(screen.getByRole('checkbox', { name: 'Facebook Feed' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Instagram Reels' }));
    type(screen.getByLabelText(/^Conta do Instagram/), '');
    fireEvent.click(screen.getByRole('button', { name: 'Conferir campanha' }));
    await waitFor(() =>
      expect(
        screen.getByText('Escolha a conta do Instagram para anunciar no Instagram'),
      ).toBeTruthy(),
    );

    type(screen.getByLabelText(/^Conta do Instagram/), INSTAGRAM);
    expect(await launch()).toMatchObject({
      placements: { mode: 'manual', facebook: ['feed'], instagram: ['reels'] },
      identity: { pageId: PAGE, instagramActorId: INSTAGRAM },
    });
  });

  it('warns about the 9:16 cut only with Stories or Reels, and never blocks', async () => {
    render(<PaidMediaBuilder canRequest />);
    fillValidCampaign();
    expect(screen.queryByText(/Stories e Reels são verticais/)).toBeNull();
    expect(screen.queryByText(/Esta imagem não é 9:16/)).toBeNull();

    choose(/^Manual/);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Facebook Feed' }));
    expect(screen.queryByText(/Stories e Reels são verticais/)).toBeNull();

    fireEvent.click(screen.getByRole('checkbox', { name: 'Facebook Stories' }));
    expect(screen.getByText(/Stories e Reels são verticais \(9:16\)/)).toBeTruthy();
    // Both uploaded images are 1080 × 1080.
    expect(
      screen.getAllByText(/Esta imagem não é 9:16: será cortada em Stories e Reels/),
    ).toHaveLength(2);

    uploadSize.current = { width: 1080, height: 1920 };
    chooseImage(screen.getAllByLabelText(/^Imagem — Criativo/)[0] as Element);
    expect(screen.getAllByText(/Esta imagem não é 9:16/)).toHaveLength(1);

    await launch();
  });

  it('saves the page as the Wings default only when asked, and only when it changed', async () => {
    render(<PaidMediaBuilder canRequest />);
    fillValidCampaign();
    fireEvent.click(screen.getByRole('checkbox', { name: /Guardar como padrão da Wings/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Conferir campanha' }));
    await waitFor(() => expect(screen.getByText(/Tudo conferido/)).toBeTruthy());
    // Ticked, but it is already the default.
    expect(saveIdentityDefault).not.toHaveBeenCalled();

    type(screen.getByLabelText(/^Página do Facebook/), OTHER_PAGE);
    expect((screen.getByLabelText(/^Conta do Instagram/) as HTMLSelectElement).value).toBe('');
    fireEvent.click(screen.getByRole('button', { name: 'Conferir campanha' }));
    await waitFor(() => expect(saveIdentityDefault).toHaveBeenCalledTimes(1));
    expect(saveIdentityDefault).toHaveBeenCalledWith({
      pageId: OTHER_PAGE,
      instagramActorId: null,
    });
  });

  it('cannot launch where Meta is not configured, and says so', () => {
    identities.current = new ApiError(503, { error: 'meta_not_configured', message: 'x' });
    render(<PaidMediaBuilder canRequest />);
    expect(
      screen.getByText(
        /A Meta não está configurada neste ambiente — não é possível escolher a página/,
      ),
    ).toBeTruthy();
    expect(
      (screen.getByRole('button', { name: 'Lançar campanha' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    // Google does not depend on Meta.
    choose(/Google Pesquisa/);
    expect(
      (screen.getByRole('button', { name: 'Lançar campanha' }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it('offers to ask Meta again when Meta failed', () => {
    identities.current = new ApiError(502, {
      error: 'meta_unavailable',
      message: 'A Meta não respondeu.',
    });
    render(<PaidMediaBuilder canRequest />);
    expect(screen.getByText(/A Meta não respondeu\./)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Tentar de novo' }));
    expect(refetchIdentities).toHaveBeenCalledTimes(1);
  });

  it('uploads a video variation and sends its id, with no image and no cards', async () => {
    render(<PaidMediaBuilder canRequest />);
    fillValidCampaign();
    typeOf(2, 'Vídeo');
    expect(screen.getAllByLabelText(/^Imagem — Criativo/)).toHaveLength(1);
    fireEvent.change(screen.getByLabelText(/^Vídeo — Criativo 2(?!,)/), {
      target: { files: [video()] },
    });
    expect(uploadVideo).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/5 MB/)).toBeTruthy();
    // The approximate preview plays the uploaded file.
    expect(
      document.querySelector('video[src="/api/ads/videos/33333333-3333-4333-8333-333333333333"]'),
    ).toBeTruthy();

    const payload = await launch();
    const second = (payload.variations as Record<string, unknown>[])[1];
    expect(second).toMatchObject({
      creativeType: 'video',
      videoId: '33333333-3333-4333-8333-333333333333',
    });
    expect(second?.creativeId).toBeUndefined();
    expect(second?.cards).toBeUndefined();
  });

  it('refuses a video over 4 GB before sending anything', () => {
    render(<PaidMediaBuilder canRequest />);
    typeOf(1, 'Vídeo');
    fireEvent.change(screen.getByLabelText(/^Vídeo — Criativo 1(?!,)/), {
      target: { files: [video(4 * 1024 * 1024 * 1024 + 1)] },
    });
    expect(screen.getByText('O vídeo passa de 4 GB.')).toBeTruthy();
    expect(uploadVideo).not.toHaveBeenCalled();
  });

  it('says so when the server has nowhere to keep videos', () => {
    videoFailure.current = new ApiError(503, {
      error: 'video_storage_not_configured',
      message: 'O armazenamento de vídeos não está configurado neste ambiente.',
    });
    render(<PaidMediaBuilder canRequest />);
    typeOf(1, 'Vídeo');
    fireEvent.change(screen.getByLabelText(/^Vídeo — Criativo 1(?!,)/), {
      target: { files: [video()] },
    });
    expect(screen.getByText(/O armazenamento de vídeos não está configurado/)).toBeTruthy();
  });

  it('builds a carousel of two cards and sends exactly that', async () => {
    render(<PaidMediaBuilder canRequest />);
    fillValidCampaign();
    typeOf(2, 'Carrossel');
    expect(screen.getAllByText(/^Cartão \d$/)).toHaveLength(2);

    const titles = screen.getAllByLabelText(/^Título do cartão/);
    const texts = screen.getAllByLabelText(/^Texto do cartão/);
    const links = screen.getAllByLabelText(/^Link do cartão/);
    type(titles[0] as Element, 'Suporte completo');
    type(texts[0] as Element, 'Do ponto à inauguração.');
    type(links[0] as Element, 'https://wingscompany.com.br/suporte');
    type(titles[1] as Element, 'Modelo enxuto');
    type(texts[1] as Element, 'Operação simples.');
    type(links[1] as Element, 'https://wingscompany.com.br/modelo');
    // A card takes an image or a video: the file says which.
    chooseImage(screen.getByLabelText(/^Arquivo — Criativo 2, cartão 1/));
    fireEvent.change(screen.getByLabelText(/^Arquivo — Criativo 2, cartão 2/), {
      target: { files: [video()] },
    });

    expect(screen.getByText(/Carrossel \(2 cartões\)/)).toBeTruthy();
    const payload = await launch();
    const second = (payload.variations as Record<string, unknown>[])[1];
    expect(second).toMatchObject({ creativeType: 'carousel' });
    expect(second?.creativeId).toBeUndefined();
    expect(second?.cards).toEqual([
      {
        mediaType: 'image',
        creativeId: '00000003-0000-4000-8000-000000000000',
        headline: 'Suporte completo',
        description: 'Do ponto à inauguração.',
        link: 'https://wingscompany.com.br/suporte',
      },
      {
        mediaType: 'video',
        videoId: '33333333-3333-4333-8333-333333333333',
        headline: 'Modelo enxuto',
        description: 'Operação simples.',
        link: 'https://wingscompany.com.br/modelo',
      },
    ]);
  });

  it('keeps a carousel at two cards or more, and blocks copy on a card', async () => {
    render(<PaidMediaBuilder canRequest />);
    fillValidCampaign();
    typeOf(2, 'Carrossel');
    type(screen.getAllByLabelText(/^Título do cartão/)[0] as Element, 'Retorno garantido');
    expect(screen.getByText(/Há texto bloqueado pelo compliance/)).toBeTruthy();
    type(screen.getAllByLabelText(/^Título do cartão/)[0] as Element, 'Suporte completo');

    // Two cards is the floor: nothing to remove until there is a third.
    expect(screen.queryByRole('button', { name: 'Remover cartão' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Adicionar cartão/ }));
    expect(screen.getAllByText(/^Cartão \d$/)).toHaveLength(3);
    fireEvent.click(screen.getAllByRole('button', { name: 'Remover cartão' })[2] as Element);
    expect(screen.getAllByText(/^Cartão \d$/)).toHaveLength(2);
    expect(screen.queryByRole('button', { name: 'Remover cartão' })).toBeNull();

    // Cards without a file are still refused on check, and nothing is sent.
    fireEvent.click(screen.getByRole('button', { name: 'Conferir campanha' }));
    await waitFor(() => expect(screen.getAllByText('Envie a imagem do cartão').length).toBe(2));
    expect(requestCampaign).not.toHaveBeenCalled();
  });

  it('says where the official preview will be', () => {
    render(<PaidMediaBuilder canRequest />);
    expect(
      screen.getByText(
        /A prévia oficial da Meta fica disponível na tela da aprovação depois que os anúncios forem criados/,
      ),
    ).toBeTruthy();
  });
});

describe('applying a proposal from the agent', () => {
  const common = {
    objective: 'lead',
    idealCustomerProfile: 'Empreendedor de 30 a 50 anos, com experiência em gestão.',
    reach: { states: ['SP'], cities: [{ name: 'Curitiba', state: 'PR' }] },
    destinationUrl: 'https://wingscompany.com.br/franquia',
    startDate: '2026-09-20',
    endDate: '2026-09-29',
    assumptions: ['Assumi que a página de destino já tem o formulário.'],
  };
  const because = (...fields: string[]) =>
    fields.map((field) => ({ field, reason: `Motivo de ${field}.` }));

  const googleProposal = agentCampaignProposalSchema.parse({
    ...common,
    platform: 'google_search',
    name: 'Pesquisa — franquia SP',
    dailyBudgetCents: 2000,
    utms: {
      utm_source: 'google',
      utm_medium: 'cpc',
      utm_campaign: 'agente-pesquisa-sp',
      utm_content: 'lead',
    },
    search: {
      keywords: [
        { text: 'franquia de alimentação', match: 'phrase' },
        { text: 'abrir franquia', match: 'exact' },
        { text: 'como franquear meu negócio', match: 'broad' },
      ],
      negativeKeywords: ['grátis', 'vaga', 'emprego', 'curso', 'currículo'],
      headlines: ['Franquia Wings', 'Expanda sua marca', 'Fale com a Wings'],
      descriptions: ['Conheça o modelo de negócio e o suporte.', 'Suporte do início ao fim.'],
    },
    explanations: [
      ...because('objective', 'idealCustomerProfile', 'reach', 'dates'),
      { field: 'dailyBudgetCents', reason: 'R$ 20 por dia cabem no disponível da conta Google.' },
      { field: 'search', reason: 'Termos de quem já procura uma franquia.' },
    ],
    summary: 'Pesquisa para leads em SP e Curitiba.',
  });

  const metaProposal = agentCampaignProposalSchema.parse({
    ...common,
    platform: 'meta',
    name: 'Leads — formatação SP',
    dailyBudgetCents: 3500,
    endDate: '2026-09-26',
    utms: {
      utm_source: 'meta',
      utm_medium: 'paid_social',
      utm_campaign: 'agente-leads-sp',
      utm_content: 'instagram',
    },
    ageMin: 30,
    ageMax: 55,
    formatKey: 'stories_reels',
    placements: { mode: 'manual', facebook: [], instagram: ['stories', 'reels'] },
    copy: [
      {
        headline: 'Leve a Wings para sua cidade',
        primaryText: 'Fale com a gente.',
        callToAction: 'LEARN_MORE',
        mediaBrief: 'Dono de negócio na porta da loja, fachada ao fundo, luz do dia.',
      },
      {
        headline: 'Seja um franqueado Wings',
        primaryText: 'Suporte completo.',
        callToAction: 'CONTACT_US',
        mediaBrief: 'Equipe reunida em volta dos manuais da franquia.',
      },
      {
        headline: 'Conheça o modelo Wings',
        primaryText: 'Treinamento e suporte.',
        callToAction: 'LEARN_MORE',
        mediaBrief: 'Mapa do Brasil com as cidades onde a marca já está.',
      },
    ],
    explanations: [
      ...because('objective', 'idealCustomerProfile', 'reach', 'dailyBudgetCents', 'dates'),
      ...because('placements', 'format', 'copy'),
      { field: 'age', reason: 'Os leads qualificados têm de 30 a 55 anos.' },
    ],
    summary: 'Campanha de leads na Meta.',
  });

  function renderWithBridge() {
    const bridge: { current: BuilderBridge | null } = { current: null };
    const view = render(<PaidMediaBuilder canRequest applyRef={bridge} />);
    return { bridge, view };
  }

  it('fills a Google Pesquisa campaign, explains each choice and sends nothing', () => {
    const { bridge } = renderWithBridge();
    expect(screen.queryByRole('region', { name: 'Proposta do agente aplicada' })).toBeNull();

    act(() => bridge.current?.applyProposal(googleProposal));

    expect(
      (screen.getByRole('radio', { name: /Google Pesquisa/ }) as HTMLInputElement).checked,
    ).toBe(true);
    expect((screen.getByLabelText(/^Nome da campanha/) as HTMLInputElement).value).toBe(
      'Pesquisa — franquia SP',
    );
    expect((screen.getByLabelText(/Verba por dia/) as HTMLInputElement).value).toBe('20,00');
    // R$ 20 × 10 days × 1 on Google: the estimate follows the applied budget.
    expect(screen.getAllByText('R$ 200,00').length).toBeGreaterThan(0);
    expect(
      (screen.getByLabelText(/^Palavras-chave(?! negativas)/) as HTMLTextAreaElement).value,
      // Google's notation for the match type: "phrase", [exact] — and a broad
      // proposal is tightened to exact: the form never sends broad.
    ).toBe('"franquia de alimentação"\n[abrir franquia]\n[como franquear meu negócio]');
    expect((screen.getByLabelText(/^Palavras-chave negativas/) as HTMLTextAreaElement).value).toBe(
      'grátis\nvaga\nemprego\ncurso\ncurrículo',
    );
    expect((byField('Título 1') as HTMLInputElement).value).toBe('Franquia Wings');
    expect((screen.getByRole('checkbox', { name: 'SP' }) as HTMLInputElement).checked).toBe(true);
    expect(screen.getByRole('button', { name: 'Remover Curitiba' })).toBeTruthy();

    const panel = screen.getByRole('region', { name: 'Proposta do agente aplicada' });
    expect(panel.textContent).toContain('Verba diária');
    expect(panel.textContent).toContain('R$ 20 por dia cabem no disponível da conta Google.');
    expect(panel.textContent).toContain('Termos de quem já procura uma franquia.');
    expect(panel.textContent).toContain('Assumi que a página de destino já tem o formulário.');
    expect(requestCampaign).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Dispensar' }));
    expect(screen.queryByRole('region', { name: 'Proposta do agente aplicada' })).toBeNull();
  });

  it('what was applied is what gets launched, by the person', async () => {
    const { bridge } = renderWithBridge();
    act(() => bridge.current?.applyProposal(googleProposal));
    fireEvent.click(screen.getByRole('button', { name: 'Lançar campanha' }));

    await waitFor(() => expect(requestCampaign).toHaveBeenCalledTimes(1));
    expect(requestCampaign.mock.calls[0]?.[0]).toMatchObject({
      platform: 'google_search',
      name: 'Pesquisa — franquia SP',
      dailyBudgetCents: 2000,
      startPaused: true,
      reach: { states: ['SP'], cities: [{ name: 'Curitiba', state: 'PR' }] },
      search: {
        // The builder's own validation takes Google's match notation.
        keywords: ['"franquia de alimentação"', '[abrir franquia]', '[como franquear meu negócio]'],
        negativeKeywords: ['grátis', 'vaga', 'emprego', 'curso', 'currículo'],
        headlines: ['Franquia Wings', 'Expanda sua marca', 'Fale com a Wings'],
      },
      // The proposal's UTMs, not the ones the builder would have generated.
      utms: { utm_source: 'google', utm_medium: 'cpc', utm_campaign: 'agente-pesquisa-sp' },
    });
  });

  it('fills the words of a Meta campaign and leaves the images the person chose', () => {
    const { bridge } = renderWithBridge();
    chooseImage(screen.getAllByLabelText(/^Imagem — Criativo/)[0] as Element);
    const imagesBefore = screen.getAllByAltText(/^Criativo/).length;
    expect(imagesBefore).toBeGreaterThan(0);

    act(() =>
      bridge.current?.applyProposal(metaProposal, [
        'Imagens ou vídeo de cada variação',
        'Página do Facebook e conta do Instagram',
      ]),
    );

    const titles = screen.getAllByLabelText(/^Título/) as HTMLInputElement[];
    expect(titles.map((input) => input.value)).toEqual([
      'Leve a Wings para sua cidade',
      'Seja um franqueado Wings',
      'Conheça o modelo Wings',
    ]);
    expect((screen.getByLabelText('Idade mínima') as HTMLInputElement).value).toBe('30');
    expect((screen.getByLabelText('Idade máxima') as HTMLInputElement).value).toBe('55');
    expect((screen.getByLabelText(/Verba por dia/) as HTMLInputElement).value).toBe('35,00');
    // The image uploaded before the proposal is still the first variation's.
    expect(screen.getAllByAltText(/^Criativo/)).toHaveLength(imagesBefore);
    // Placements, format and UTMs come from the proposal too.
    expect((screen.getByLabelText(/^Formato/) as HTMLSelectElement).value).toBe('stories_reels');
    expect((screen.getByRole('radio', { name: 'Manual' }) as HTMLInputElement).checked).toBe(true);
    expect(
      (screen.getByRole('checkbox', { name: 'Instagram Stories' }) as HTMLInputElement).checked,
    ).toBe(true);
    expect(
      (screen.getByRole('checkbox', { name: 'Facebook Feed' }) as HTMLInputElement).checked,
    ).toBe(false);
    expect(bridge.current?.getDraft()).toMatchObject({
      platform: 'meta',
      formatKey: 'stories_reels',
      placements: { mode: 'manual', facebook: [], instagram: ['stories', 'reels'] },
      utms: {
        utm_source: 'meta',
        utm_medium: 'paid_social',
        utm_campaign: 'agente-leads-sp',
        utm_content: 'instagram',
      },
      variations: [
        {
          creativeId: '00000001-0000-4000-8000-000000000000',
          headline: 'Leve a Wings para sua cidade',
        },
        { creativeId: '', headline: 'Seja um franqueado Wings' },
        { creativeId: '', headline: 'Conheça o modelo Wings' },
      ],
    });

    const panel = screen.getByRole('region', { name: 'Proposta do agente aplicada' });
    expect(panel.textContent).toContain('Faixa de idade');
    expect(panel.textContent).toContain('Falta escolher as imagens e a Página.');
    // What Design has to produce stays in view after the card is gone.
    expect(panel.textContent).toContain('Briefing para o Design — Criativo 1');
    expect(panel.textContent).toContain('Dono de negócio na porta da loja');
    expect(panel.textContent).toContain('Briefing para o Design — Criativo 3');
    expect(panel.textContent).toContain('Pendente');
    expect(panel.textContent).toContain('Página do Facebook e conta do Instagram');
    expect(requestCampaign).not.toHaveBeenCalled();

    // Renaming the campaign does not rewrite the UTMs the proposal brought.
    type(screen.getByLabelText(/^Nome da campanha/), 'Outro nome');
    expect(bridge.current?.getDraft()).toMatchObject({
      utms: { utm_campaign: 'agente-leads-sp' },
    });
  });

  it('on YouTube, says the video link is still missing', () => {
    const { bridge } = renderWithBridge();
    act(() =>
      bridge.current?.applyProposal(
        agentCampaignProposalSchema.parse({
          ...common,
          platform: 'youtube',
          name: 'YouTube — institucional',
          objective: 'traffic',
          dailyBudgetCents: 1500,
          utms: { utm_source: 'youtube', utm_medium: 'paid_video', utm_campaign: 'agente-video' },
          youtube: {
            headline: 'Conheça a Wings',
            mediaBrief: 'Fundador conta em 30 segundos como a marca virou franquia.',
          },
          explanations: [
            ...because('objective', 'idealCustomerProfile', 'reach', 'dailyBudgetCents', 'dates'),
            { field: 'youtube', reason: 'Título curto para o vídeo institucional.' },
          ],
          summary: 'Vídeo institucional.',
        }),
      ),
    );
    expect((byField('Título 1') as HTMLInputElement).value).toBe('Conheça a Wings');
    expect(screen.getByText('Falta o link do vídeo.')).toBeTruthy();
    const panel = screen.getByRole('region', { name: 'Proposta do agente aplicada' });
    expect(panel.textContent).toContain('Briefing para o Design — Vídeo');
    expect(panel.textContent).toContain('Fundador conta em 30 segundos');
  });

  it('hands the agent the form as it stands, and nothing once it leaves the screen', () => {
    const { bridge, view } = renderWithBridge();
    type(screen.getByLabelText(/^Nome da campanha/), 'Rascunho em andamento');
    expect(bridge.current?.getDraft()).toMatchObject({
      platform: 'meta',
      name: 'Rascunho em andamento',
    });
    view.unmount();
    expect(bridge.current).toBeNull();
  });
});

describe('media from the library', () => {
  const libraryAsset = (overrides: Partial<MediaAsset> = {}): MediaAsset => ({
    id: '33333333-3333-4333-8333-333333333333',
    kind: 'image',
    origin: 'kairogen',
    mimeType: 'image/png',
    byteSize: 1_400_000,
    width: 1080,
    height: 1080,
    aspect: '1:1',
    durationSeconds: null,
    prompt: 'Storefront at golden hour',
    model: 'seedream-v4',
    credits: 4,
    clientId: '00000000-0000-4000-8000-0000000000c1',
    client: 'Wings Company',
    folder: null,
    tags: [],
    ownerName: 'Marketing',
    createdAt: '2026-09-21T12:00:00.000Z',
    downloadPath: '/media/assets/33333333-3333-4333-8333-333333333333/file',
    driveFileId: null,
    ...overrides,
  });
  const CREATIVE = '44444444-4444-4444-8444-444444444444';

  afterEach(() => {
    libraryAssets.current = [];
    bridgeAnswer.current = null;
    useInBuilder.mockReset();
    sessionStorage.clear();
  });

  it('offers the library only to somebody who may read it', () => {
    render(<PaidMediaBuilder canRequest />);
    expect(screen.queryByRole('button', { name: /Escolher do Drive/ })).toBeNull();
    cleanup();
    render(<PaidMediaBuilder canRequest canPickMedia />);
    expect(screen.getAllByRole('button', { name: /Escolher do Drive — Criativo/ })).toHaveLength(2);
  });

  it('puts a picked image in the variation, with the asset it came from, and sends both', async () => {
    libraryAssets.current = [libraryAsset()];
    bridgeAnswer.current = {
      mediaAssetId: libraryAsset().id,
      creative: {
        id: CREATIVE,
        mimeType: 'image/png',
        width: 1080,
        height: 1080,
        byteSize: 1_400_000,
      },
      video: null,
    };
    render(<PaidMediaBuilder canRequest canPickMedia />);
    fillValidCampaign();

    fireEvent.click(screen.getByRole('button', { name: 'Escolher do Drive — Criativo 1' }));
    const dialog = screen.getByRole('dialog', { name: 'Escolher uma imagem da biblioteca' });
    fireEvent.click(within(dialog).getByRole('button', { name: /^Imagem, 1080 × 1080/ }));
    expect(useInBuilder).toHaveBeenCalledWith(libraryAsset().id);
    expect(screen.queryByRole('dialog')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Lançar campanha' }));
    await waitFor(() => expect(requestCampaign).toHaveBeenCalledTimes(1));
    const sent = requestCampaign.mock.calls[0]?.[0] as CampaignDraftInput;
    expect(sent.variations?.[0]).toMatchObject({
      creativeId: CREATIVE,
      mediaAssetId: libraryAsset().id,
    });
    // The other variation came from the computer: it names no library asset.
    expect(sent.variations?.[1]).not.toHaveProperty('mediaAssetId', expect.anything());
  });

  it('forgets the library asset when a file from the computer replaces it', async () => {
    libraryAssets.current = [libraryAsset()];
    bridgeAnswer.current = {
      mediaAssetId: libraryAsset().id,
      creative: { id: CREATIVE, mimeType: 'image/png', width: 1080, height: 1080, byteSize: 1 },
      video: null,
    };
    render(<PaidMediaBuilder canRequest canPickMedia />);
    fillValidCampaign();
    fireEvent.click(screen.getByRole('button', { name: 'Escolher do Drive — Criativo 1' }));
    fireEvent.click(screen.getByRole('button', { name: /^Imagem, 1080 × 1080/ }));
    chooseImage(screen.getAllByLabelText(/^Imagem — Criativo/)[0] as Element);

    fireEvent.click(screen.getByRole('button', { name: 'Lançar campanha' }));
    await waitFor(() => expect(requestCampaign).toHaveBeenCalledTimes(1));
    const sent = requestCampaign.mock.calls[0]?.[0] as CampaignDraftInput;
    expect(sent.variations?.[0]?.creativeId).not.toBe(CREATIVE);
    expect(sent.variations?.[0]?.mediaAssetId).toBeUndefined();
  });

  it('shows a WebP but does not let it be picked: ads take PNG and JPEG', () => {
    libraryAssets.current = [libraryAsset({ mimeType: 'image/webp' })];
    render(<PaidMediaBuilder canRequest canPickMedia />);
    fireEvent.click(screen.getByRole('button', { name: 'Escolher do Drive — Criativo 1' }));
    const tile = screen.getByRole('button', { name: /^Imagem, 1080 × 1080/ });
    expect(tile).toHaveProperty('disabled', true);
    expect(within(tile).getByText('WebP não vale para anúncio')).toBeTruthy();
    fireEvent.click(tile);
    expect(useInBuilder).not.toHaveBeenCalled();
  });

  it('receives what "Usar no construtor" handed over, once', async () => {
    sessionStorage.setItem(
      'wings.builder.pickedMedia',
      JSON.stringify({
        mediaAssetId: libraryAsset().id,
        creative: { id: CREATIVE, mimeType: 'image/png', width: 1080, height: 1080, byteSize: 1 },
        video: null,
      }),
    );
    render(<PaidMediaBuilder canRequest canPickMedia />);
    // Handed over once: the key is gone, and the first variation shows the picture.
    expect(sessionStorage.getItem('wings.builder.pickedMedia')).toBeNull();
    // The slot's thumbnail and the ad preview both show it.
    const [thumb] = await screen.findAllByAltText('Criativo — Criativo 1');
    expect(thumb?.getAttribute('src')).toContain(CREATIVE);
    expect(screen.queryByAltText('Criativo — Criativo 2')).toBeNull();
  });

  it('leaves its draft where the editing agent can read it, without media ids of its own making', async () => {
    render(<PaidMediaBuilder canRequest />);
    type(screen.getByLabelText(/^Nome da campanha/), 'Leads RJ');
    await waitFor(
      () => expect(sessionStorage.getItem('wings.builder.draft') ?? '').toContain('Leads RJ'),
      { timeout: 2000 },
    );
    expect(sessionStorage.getItem('wings.builder.draft')).not.toMatch(/token|password/i);
  });
});

describe('adding creatives to a campaign that exists', () => {
  it('shows only what the new ads need, lists the Meta campaigns and asks for approval', async () => {
    requestAddAds.mockClear();
    render(<PaidMediaBuilder canRequest />);
    fireEvent.click(screen.getByLabelText(/Adicionar criativos a uma campanha existente/));
    // No budget, dates, audience or objective: the campaign keeps its own.
    expect(screen.queryByRole('heading', { name: /Verba diária/ })).toBeNull();
    expect(screen.queryByRole('heading', { name: /Duração/ })).toBeNull();
    expect(screen.queryByRole('heading', { name: /Área de alcance/ })).toBeNull();
    expect(screen.getByRole('heading', { name: /Criativo/ })).toBeTruthy();
    const select = screen.getByLabelText('Campanha') as HTMLSelectElement;
    expect(Array.from(select.options).map((option) => option.textContent)).toEqual([
      'Escolha a campanha',
      'META | 28Set (ativa)',
    ]);

    // Nothing chosen: said on screen, nothing sent.
    fireEvent.click(screen.getByRole('button', { name: 'Pedir aprovação dos anúncios' }));
    expect(
      await screen.findByText('Escolha a campanha', { selector: '.alert *, .alert' }),
    ).toBeTruthy();
    expect(requestAddAds).not.toHaveBeenCalled();
  });

  it('sends the campaign, page, destination, UTMs and each creative with its own copy', async () => {
    requestAddAds.mockClear();
    render(<PaidMediaBuilder canRequest />);
    fillValidCampaign();
    fireEvent.click(screen.getByLabelText(/Adicionar criativos a uma campanha existente/));
    fireEvent.change(screen.getByLabelText('Campanha'), {
      target: { value: '120252260012720076' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Pedir aprovação dos anúncios' }));
    await waitFor(() => expect(requestAddAds).toHaveBeenCalledTimes(1));
    const sent = requestAddAds.mock.calls[0]?.[0] as {
      campaignExternalId: string;
      variations: { headline: string }[];
    };
    expect(sent.campaignExternalId).toBe('120252260012720076');
    expect(sent.variations.length).toBeGreaterThanOrEqual(1);
    expect(sent).not.toHaveProperty('dailyBudgetCents');
  });
});

describe('choosing the campaign to add creatives to', () => {
  it("takes the campaign's destination", () => {
    render(<PaidMediaBuilder canRequest />);
    fireEvent.click(screen.getByLabelText(/Adicionar criativos a uma campanha existente/));
    fireEvent.change(screen.getByLabelText('Campanha'), {
      target: { value: '120252260012720076' },
    });
    const byName = (name: string) =>
      document.querySelector<HTMLInputElement>(`[name="${name}"]`)?.value;
    expect(byName('destinationUrl')).toBe('https://wingscompany.com.br/contato/');
  });
});

describe('the standard lead form in the ad', () => {
  const sitePage = (): import('../../api/lead-forms.js').SiteFormPage => ({
    id: '6f1b2c3d-0000-4000-8000-000000000001',
    slug: 'cenoritas',
    path: '/lp/cenoritas',
    brand: 'Cenoritas',
    pipeline: 'expansao',
    clientId: '00000000-0000-4000-8000-0000000000c2',
    form: null,
    pending: null,
    approvedAt: null,
  });

  it('is only for lead campaigns, and on Meta asks where the lead is captured', () => {
    render(<PaidMediaBuilder canRequest />);
    expect(screen.getByRole('radio', { name: /Na página para onde o botão leva/ })).toBeTruthy();
    expect(
      screen.getByRole('radio', { name: /No anúncio \(formulário instantâneo\)/ }),
    ).toBeTruthy();
    // The five questions and the form's fields appear only with the form on the ad.
    expect(screen.queryByText('Perguntas obrigatórias')).toBeNull();

    fireEvent.click(screen.getByRole('radio', { name: /Tráfego/ }));
    expect(screen.getByText('Só para campanhas de geração de leads.')).toBeTruthy();
  });

  it('with the form on the ad: fixed questions, optional multiple choice off, policy from the Page, preview rising over the ad', async () => {
    leadFormReadiness.current = {
      access: { pageId: PAGE, canManage: true, reason: null },
      forms: [],
      privacyPolicyUrl: 'https://wingscompany.com.br/politica/',
    };
    render(<PaidMediaBuilder canRequest />);
    fireEvent.click(screen.getByRole('radio', { name: /No anúncio \(formulário instantâneo\)/ }));

    const questions = screen.getByText('Perguntas obrigatórias').parentElement;
    expect(questions?.textContent).toContain('Nome');
    expect(questions?.textContent).toContain('WhatsApp');
    expect(questions?.textContent).toContain('Nome da empresa');
    expect(questions?.textContent).toContain('Instagram da empresa');
    expect(questions?.textContent).toContain('Site da empresa');
    const qualifier = screen.getByRole('checkbox', {
      name: /Abrir com uma pergunta de múltipla escolha/,
    }) as HTMLInputElement;
    expect(qualifier.checked).toBe(false);
    await waitFor(() =>
      expect((byField('Política de privacidade') as HTMLInputElement).value).toBe(
        'https://wingscompany.com.br/politica/',
      ),
    );

    // The drawn preview: the three Instagram placements and the sheet.
    expect(screen.getByText('Instagram Feed')).toBeTruthy();
    expect(screen.getByText('Instagram Stories')).toBeTruthy();
    expect(screen.getByText('Instagram Reels')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Perguntas' }));
    expect(screen.getAllByText('Ana Exemplo').length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Não é a prévia oficial da Meta/).length).toBeGreaterThan(0);

    // Switching the multiple choice on puts the suggestion first.
    fireEvent.click(qualifier);
    expect((byField('Pergunta') as HTMLInputElement).value).toBe('Quantas unidades você tem hoje?');
    expect(screen.getAllByText('2 a 5').length).toBeGreaterThan(0);
  });

  it('sends the form with the draft only when it is on the ad, funnel included, thank-you button to the destination', async () => {
    leadFormReadiness.current = {
      access: { pageId: PAGE, canManage: true, reason: null },
      forms: [],
      privacyPolicyUrl: 'https://wingscompany.com.br/politica/',
    };
    render(<PaidMediaBuilder canRequest />);
    fillValidCampaign();
    fireEvent.click(screen.getByRole('radio', { name: /No anúncio \(formulário instantâneo\)/ }));
    await waitFor(() =>
      expect((byField('Política de privacidade') as HTMLInputElement).value).toContain('politica'),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Lançar campanha' }));
    await waitFor(() => expect(requestCampaign).toHaveBeenCalled());
    const draft = requestCampaign.mock.calls[0]?.[0] as CampaignDraftInput;
    expect(draft.leadCapture).toBe('instant_form');
    expect(draft.leadForm).toMatchObject({
      qualifier: null,
      privacyPolicyUrl: 'https://wingscompany.com.br/politica/',
      thankYou: { buttonUrl: 'https://wingscompany.com.br/franquia' },
      funnel: { pipeline: 'formatacao', brand: null, clientId: null },
    });
    expect(screen.getByText(/Formulário no anúncio · 5 perguntas · formatacao/)).toBeTruthy();
  });

  it('warns when this environment\u2019s token cannot act for the Page, and keeps the preview', () => {
    leadFormReadiness.current = {
      access: { pageId: PAGE, canManage: false, reason: 'no_page_token' },
      forms: [],
      privacyPolicyUrl: null,
    };
    render(<PaidMediaBuilder canRequest />);
    fireEvent.click(screen.getByRole('radio', { name: /No anúncio \(formulário instantâneo\)/ }));
    expect(screen.getByText(/o token não administra a Página \(no_page_token\)/)).toBeTruthy();
    expect(screen.getByText('Instagram Reels')).toBeTruthy();
  });

  it('a lead campaign without the form sends the draft as before', async () => {
    render(<PaidMediaBuilder canRequest />);
    fillValidCampaign();
    fireEvent.click(screen.getByRole('button', { name: 'Lançar campanha' }));
    await waitFor(() => expect(requestCampaign).toHaveBeenCalled());
    const draft = requestCampaign.mock.calls[0]?.[0] as CampaignDraftInput;
    expect(draft.leadCapture).toBe('page');
    expect(draft.leadForm).toBeUndefined();
  });

  it('on YouTube the ad leads to a site page with the standard form, proposed for Diretoria', () => {
    siteFormPages.current = [sitePage()];
    render(<PaidMediaBuilder canRequest canApprove={false} />);
    fireEvent.click(screen.getByRole('radio', { name: /YouTube/ }));
    expect(
      screen.getByText(/O Google não aceita formulário de lead em campanhas Demand Gen/),
    ).toBeTruthy();
    fireEvent.change(byField('Página do site'), {
      target: { value: '6f1b2c3d-0000-4000-8000-000000000001' },
    });
    expect((screen.getByLabelText(/Página de destino/) as HTMLInputElement).value).toMatch(
      /\/lp\/cenoritas$/,
    );
    // The page's funnel, not an editable one.
    expect((byField('Funil dos leads') as HTMLSelectElement).disabled).toBe(true);
    expect((byField('Funil dos leads') as HTMLSelectElement).value).toBe('expansao');
    expect(screen.getByText(/Página do site ·/).textContent).toContain('/lp/cenoritas');
    expect(screen.getByText('Seja um franqueado Cenoritas')).toBeTruthy();
    expect(
      screen.getByText(/Mudança no site só vai ao ar com prévia e aprovação da Diretoria/),
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Aprovar e publicar na página/ })).toBeNull();

    type(byField('Política de privacidade'), 'https://wingscompany.com.br/politica/');
    fireEvent.click(screen.getByRole('button', { name: /Propor este formulário para a página/ }));
    expect(proposeSiteForm).toHaveBeenCalledWith({
      id: '6f1b2c3d-0000-4000-8000-000000000001',
      form: expect.objectContaining({
        qualifier: null,
        privacyPolicyUrl: 'https://wingscompany.com.br/politica/',
      }),
    });
  });

  it('shows Diretoria the pending change with the approve button; Marketing sees only that it waits', () => {
    siteFormPages.current = [
      {
        ...sitePage(),
        pending: {
          form: {
            qualifier: null,
            privacyPolicyUrl: 'https://wingscompany.com.br/politica/',
            thankYou: {
              title: 'Obrigado!',
              body: 'Falamos em breve.',
              buttonText: 'Site',
              buttonUrl: 'https://wingscompany.com.br/',
            },
          },
          by: 'Marketing Teste',
          at: '2026-10-06T12:00:00.000Z',
        },
      },
    ];
    render(<PaidMediaBuilder canRequest canApprove />);
    fireEvent.click(screen.getByRole('radio', { name: /YouTube/ }));
    fireEvent.change(byField('Página do site'), {
      target: { value: '6f1b2c3d-0000-4000-8000-000000000001' },
    });
    expect(
      screen.getByText(/Há uma alteração aguardando aprovação \(Marketing Teste\)/),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Aprovar e publicar na página/ }));
    expect(approveSiteForm).toHaveBeenCalledWith({ id: '6f1b2c3d-0000-4000-8000-000000000001' });
  });
});
