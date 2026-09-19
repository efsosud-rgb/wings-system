import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type {
  ApprovalDetail,
  ChangeSimulation,
  ExecutionStepView,
  ExposureScenario,
  OfficialPreview,
  SessionUser,
} from '@wings/shared';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api/client.js';

/**
 * The panel is what a person actually looks at before money moves, so these
 * tests check that the decision-critical facts are on screen and that the
 * actions respect who is looking.
 */

const session: { current: SessionUser | null } = { current: null };
const approval: { current: ApprovalDetail } = { current: buildApproval() };
const simulation: { current: { simulation: ChangeSimulation; nextPending: null } } = {
  current: { simulation: buildSimulation(), nextPending: null },
};
const decide = vi.fn().mockResolvedValue({ ok: true, status: 'approved' });
const execute = vi.fn().mockResolvedValue({ ok: true, outcome: 'applied' });
/** What GET /ads/approvals/:id/previews answers, and for which placement it was asked. */
const previews: { current: OfficialPreview[] | ApiError } = { current: [] };
const previewsAskedFor = vi.fn();

vi.mock('../api/auth.js', () => ({
  useSession: () => ({ data: session.current, isLoading: false }),
  hasPermission: (user: SessionUser | null, permission: string) =>
    Boolean(user?.permissions[permission as keyof SessionUser['permissions']]),
}));

vi.mock('../api/ads.js', () => ({
  useApproval: () => ({ data: { approval: approval.current }, isLoading: false, isError: false }),
  useDecideApproval: () => ({ mutateAsync: decide, isPending: false, error: null }),
  useExecuteApproval: () => ({
    mutateAsync: execute,
    isPending: false,
    isError: false,
    isSuccess: false,
    error: null,
  }),
  useOfficialPreviews: (_id: string, placement: string) => {
    previewsAskedFor(placement);
    const failed = previews.current instanceof ApiError;
    return {
      data: failed ? undefined : { previews: previews.current },
      isLoading: false,
      isError: failed,
      error: failed ? previews.current : null,
    };
  },
  useApprovals: () => ({ data: { approvals: [] }, isLoading: false, isError: false }),
  // The simulator has its own test file; here it only needs to render.
  useSimulation: () => ({ data: simulation.current, isLoading: false, isError: false }),
  useApprovalGroups: () => ({ data: { groups: [] }, isLoading: false, isError: false }),
}));

const { ApprovalDetailPage } = await import('./ApprovalDetailPage.js');

function buildApproval(overrides: Partial<ApprovalDetail> = {}): ApprovalDetail {
  return {
    id: 'ap-1',
    status: 'pending',
    trigger: 'policy_always',
    amountCents: 37_500,
    accountName: 'Wings Matriz',
    platform: 'meta',
    campaignName: 'Institucional',
    changeKind: 'set_daily_budget',
    requestedAt: '2026-09-17T12:00:00.000Z',
    escalatedAt: null,
    decidedAt: null,
    requestedByName: null,
    requestedByAgent: true,
    accountExternalId: 'act_339488762500182',
    campaignExternalId: '23851234567890123',
    budgetLevel: 'ad_set',
    fromValueCents: 2000,
    toValueCents: 3000,
    exposureDeltaCents: 37_500,
    requestReason: 'CPL abaixo da meta',
    decisionReason: null,
    decidedByName: null,
    periodCapCents: 400_000,
    periodUsableCents: 280_000,
    periodCommittedCents: 37_500,
    periodSpentCents: 20_000,
    notifiedAt: '2026-09-17T12:00:05.000Z',
    notificationError: null,
    changeStatus: 'pending_approval',
    executedAt: null,
    lastExecutionOutcome: null,
    executionAvailable: true,
    executionSteps: [],
    draft: null,
    auditTrail: [
      {
        at: '2026-09-17T12:00:00.000Z',
        action: 'ads.approval_requested',
        actorName: null,
        metadata: {},
      },
    ],
    ...overrides,
  };
}

function buildScenario(
  label: ExposureScenario['label'],
  dailyBudgetCents: number,
  committedCents: number,
): ExposureScenario {
  return {
    label,
    dailyBudgetCents,
    campaignExposureCents: committedCents,
    committedCents,
    availableCents: 280_000 - committedCents,
    usedOfUsablePercent: Math.round((committedCents / 280_000) * 100),
    usedOfCapPercent: Math.round((committedCents / 400_000) * 100),
    withinUsable: committedCents <= 280_000,
    withinCap: committedCents <= 400_000,
    runwayDays: dailyBudgetCents > 0 ? 7 : null,
  };
}

function buildSimulation(overrides: Partial<ChangeSimulation> = {}): ChangeSimulation {
  return {
    changeRequestId: 'cr-1',
    kind: 'set_daily_budget',
    campaignName: 'Institucional',
    campaignExternalId: '23851234567890123',
    budgetLevel: 'campaign',
    daysLeftInPeriod: 15,
    overdeliveryFactorMilli: 1250,
    period: {
      periodMonth: '2026-09-01',
      capCents: 400_000,
      usableCents: 280_000,
      spentCents: 20_000,
      committedWithRequestCents: 37_500,
      committedWithoutRequestCents: 0,
    },
    current: buildScenario('current', 2000, 0),
    requested: buildScenario('requested', 3000, 37_500),
    simulated: null,
    simulationAvailable: true,
    drift: null,
    campaignSyncedAt: '2026-09-17T11:00:00.000Z',
    ...overrides,
  };
}

function makeUser(overrides: Partial<SessionUser>): SessionUser {
  return {
    employeeId: 'emp-1',
    fullName: 'Quem Decide',
    email: 'quem@wingscompany.com.br',
    cargo: 'Cargo',
    role: 'admin_master',
    sector: 'diretoria',
    isSectorManager: false,
    tracksTime: false,
    permissions: { 'ads.read': 'all', 'ads.approve': 'all' },
    lastLoginAt: null,
    sessionExpiresAt: new Date(Date.now() + 3600_000).toISOString(),
    ...overrides,
  };
}

function renderDetail() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/trafego-pago/aprovacoes/ap-1']}>
        <Routes>
          <Route path="/trafego-pago/aprovacoes/:id" element={<ApprovalDetailPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  session.current = makeUser({});
  approval.current = buildApproval();
  simulation.current = { simulation: buildSimulation(), nextPending: null };
  decide.mockClear();
  execute.mockClear();
});

afterEach(() => {
  cleanup();
  session.current = null;
});

describe('what the approver sees', () => {
  it('shows the change, the amount and the budget context', () => {
    renderDetail();
    expect(screen.getByText(/R\$\s?20,00 → R\$\s?30,00 por dia/)).toBeTruthy();
    expect(screen.getAllByText(/375,00/).length).toBeGreaterThan(0);
    expect(screen.getByText(/META — Wings Matriz/)).toBeTruthy();
    // Budget context: cap, usable, spent, committed. The simulator repeats some
    // of these figures in its scenarios, so more than one match is expected.
    expect(screen.getAllByText(/4\.000,00/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/2\.800,00/).length).toBeGreaterThan(0);
  });

  it('says where the budget lives, since ABO and CBO behave differently', () => {
    renderDetail();
    expect(screen.getByText(/conjunto de anúncios \(ABO\)/)).toBeTruthy();
  });

  it('shows who asked and why', () => {
    renderDetail();
    expect(screen.getByText('Agente de tráfego pago')).toBeTruthy();
    expect(screen.getByText(/CPL abaixo da meta/)).toBeTruthy();
  });

  it('shows the audit trail', () => {
    renderDetail();
    expect(screen.getByText('Solicitação registrada')).toBeTruthy();
  });

  it('warns when the WhatsApp notification failed', () => {
    approval.current = buildApproval({ notificationError: 'instance disconnected' });
    renderDetail();
    expect(screen.getByText(/notificação por WhatsApp falhou/i)).toBeTruthy();
    expect(screen.getByText(/continua\s+aguardando decisão/i)).toBeTruthy();
  });
});

describe('who may decide', () => {
  it('offers both actions to an approver', () => {
    renderDetail();
    expect(screen.getByRole('button', { name: 'Aprovar' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Recusar' })).toBeTruthy();
  });

  it('hides the actions from someone who may only read', () => {
    session.current = makeUser({ role: 'marketing', permissions: { 'ads.read': 'all' } });
    renderDetail();
    expect(screen.queryByRole('button', { name: 'Aprovar' })).toBeNull();
    expect(screen.getByText(/Apenas Admin Master ou Diretoria podem decidir/)).toBeTruthy();
  });

  it('shows no actions once decided, only the outcome', () => {
    approval.current = buildApproval({
      status: 'approved',
      decidedAt: '2026-09-17T13:00:00.000Z',
      decidedByName: 'Eric',
      decisionReason: 'dentro do plano',
    });
    renderDetail();
    expect(screen.queryByRole('button', { name: 'Aprovar' })).toBeNull();
    expect(screen.getByText(/Aprovada por Eric/)).toBeTruthy();
  });
});

describe('deciding', () => {
  it('approves without a reason', async () => {
    renderDetail();
    fireEvent.click(screen.getByRole('button', { name: 'Aprovar' }));
    expect(decide).toHaveBeenCalledWith({ decision: 'approved', reason: undefined });
  });

  it('refuses to reject without a reason, and does not call the API', () => {
    renderDetail();
    fireEvent.click(screen.getByRole('button', { name: 'Recusar' }));

    expect(decide).not.toHaveBeenCalled();
    expect(screen.getByText('Informe o motivo da recusa')).toBeTruthy();
  });

  it('rejects once a reason is given', () => {
    renderDetail();
    fireEvent.change(screen.getByPlaceholderText(/dentro do plano do mês/i), {
      target: { value: 'custo por lead muito alto' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Recusar' }));

    expect(decide).toHaveBeenCalledWith({
      decision: 'rejected',
      reason: 'custo por lead muito alto',
    });
  });
});

describe('the Executar button', () => {
  it('is absent while the request is still pending a decision', () => {
    renderDetail();
    expect(screen.queryByRole('button', { name: /Executar/ })).toBeNull();
  });

  it('appears once approved, and says plainly that it moves money', () => {
    approval.current = buildApproval({
      status: 'approved',
      changeStatus: 'approved',
      decidedAt: '2026-09-17T13:00:00.000Z',
      decidedByName: 'Eric',
    });
    renderDetail();

    expect(screen.getByRole('button', { name: 'Executar no Meta' })).toBeTruthy();
    expect(screen.getByText(/altera a campanha real e movimenta dinheiro/)).toBeTruthy();
  });

  it('calls the executor when pressed', () => {
    approval.current = buildApproval({ status: 'approved', changeStatus: 'approved' });
    renderDetail();
    fireEvent.click(screen.getByRole('button', { name: 'Executar no Meta' }));
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('is disabled when the server has writes switched off', () => {
    approval.current = buildApproval({
      status: 'approved',
      changeStatus: 'approved',
      executionAvailable: false,
    });
    renderDetail();

    expect(screen.getByRole('button', { name: 'Executar no Meta' })).toHaveProperty(
      'disabled',
      true,
    );
    expect(screen.getByText(/execução em contas reais está desligada/i)).toBeTruthy();
  });

  it('is hidden from someone who may only read', () => {
    session.current = makeUser({ role: 'marketing', permissions: { 'ads.read': 'all' } });
    approval.current = buildApproval({ status: 'approved', changeStatus: 'approved' });
    renderDetail();
    expect(screen.queryByRole('button', { name: /Executar/ })).toBeNull();
  });

  it('shows the change as already applied instead of offering it again', () => {
    approval.current = buildApproval({
      status: 'approved',
      changeStatus: 'executed',
      executedAt: '2026-09-17T13:05:00.000Z',
    });
    renderDetail();

    expect(screen.queryByRole('button', { name: /Executar/ })).toBeNull();
    expect(screen.getByText(/já aplicada na plataforma/i)).toBeTruthy();
  });

  it('warns and offers nothing when the last attempt ended unknown', () => {
    approval.current = buildApproval({
      status: 'approved',
      changeStatus: 'unknown',
      lastExecutionOutcome: 'unknown',
    });
    renderDetail();

    expect(screen.queryByRole('button', { name: /Executar/ })).toBeNull();
    expect(screen.getByText(/não confirmou o resultado/i)).toBeTruthy();
    expect(screen.getByText(/conta foi congelada/i)).toBeTruthy();
  });
});

describe('a request to create a campaign', () => {
  const draft: NonNullable<ApprovalDetail['draft']> = {
    platform: 'meta',
    name: 'Sacrifício — teste de escrita',
    objective: 'lead',
    idealCustomerProfile: 'Empreendedor de 30 a 50 anos, com experiência em gestão.',
    reach: {
      states: ['SP'],
      cities: [{ name: 'Curitiba', state: 'PR' }],
      customLocations: [
        { latitude: -22.9056, longitude: -47.0608, radiusKm: 25, label: 'Campinas' },
      ],
    },
    formatKey: 'feed_square',
    destinationUrl: 'https://wingscompany.com.br/franquia',
    variations: [
      {
        creativeType: 'image',
        creativeId: '11111111-1111-4111-8111-111111111111',
        headline: 'Leve a Wings',
        primaryText: 'Fale com a gente.',
        callToAction: 'LEARN_MORE',
      },
      {
        creativeType: 'image',
        creativeId: '22222222-2222-4222-8222-222222222222',
        headline: 'Seja franqueado',
        primaryText: 'Suporte completo.',
        callToAction: 'CONTACT_US',
      },
    ],
    startDate: '2026-09-20',
    endDate: '2026-09-29',
    dailyBudgetCents: 2_000,
    utms: { utm_source: 'meta', utm_medium: 'paid_social', utm_campaign: 'x', utm_content: 'lead' },
    startPaused: true,
  };

  it('shows the whole campaign, and that it is born paused and empty', () => {
    approval.current = buildApproval({
      changeKind: 'create_campaign',
      campaignName: draft.name,
      campaignExternalId: '',
      budgetLevel: 'campaign',
      fromValueCents: null,
      toValueCents: 2_000,
      amountCents: 0,
      draft,
    });
    renderDetail();

    expect(screen.getByText('Criar campanha')).toBeTruthy();
    expect(screen.getByText(/Não entrega e não gasta/)).toBeTruthy();
    expect(screen.getByText('Seja franqueado')).toBeTruthy();
    // R$ 20 × 10 days × 1.25.
    expect(screen.getByText(/custo total estimado R\$\s250,00/)).toBeTruthy();
    // There is no existing budget to explore alternatives of.
    expect(screen.queryByText(/Simul/)).toBeNull();
  });

  it('shows a Google search draft as what it is: no image, keywords, 2x, and the Google button', () => {
    approval.current = buildApproval({
      platform: 'google',
      changeKind: 'create_campaign',
      campaignName: draft.name,
      campaignExternalId: '',
      changeStatus: 'approved',
      status: 'approved',
      executionAvailable: false,
      draft: {
        ...draft,
        formatKey: undefined,
        platform: 'google_search',
        reach: { ...draft.reach, customLocations: [] },
        variations: [],
        search: {
          keywords: ['franquia de alimentação', 'abrir franquia'],
          negativeKeywords: ['grátis'],
          headlines: ['Franquia Wings'],
          descriptions: ['Conheça o modelo de negócio.'],
        },
      },
    });
    renderDetail();

    // R$ 20 × 10 days × 2.
    expect(screen.getByText(/custo total estimado\s+R\$\s400,00/)).toBeTruthy();
    expect(screen.getByText('franquia de alimentação · abrir franquia')).toBeTruthy();
    expect(screen.getByText('Anúncio na Pesquisa do Google')).toBeTruthy();
    expect(screen.queryByText('Formato')).toBeNull();
    expect(screen.queryByRole('group', { name: 'Posicionamento da prévia' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Executar no Google' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Executar no Meta' })).toBeNull();
  });

  it('shows a YouTube draft with its still and says it is Demand Gen', () => {
    approval.current = buildApproval({
      platform: 'google',
      changeKind: 'create_campaign',
      draft: {
        ...draft,
        formatKey: undefined,
        platform: 'youtube',
        reach: { ...draft.reach, customLocations: [] },
        variations: [],
        youtube: { videoUrl: 'https://youtu.be/dQw4w9WgXcQ', headline: 'Conheça a Wings' },
      },
    });
    renderDetail();

    expect(screen.getByText('Demand Gen, restrita ao YouTube')).toBeTruthy();
    expect(
      (screen.getByAltText('Miniatura do vídeo no YouTube') as HTMLImageElement).src,
    ).toContain('/vi/dQw4w9WgXcQ/');
    expect(screen.getByText(/moram no grupo de anúncios/)).toBeTruthy();
  });

  it('says so in red when the campaign would be born active', () => {
    approval.current = buildApproval({
      changeKind: 'create_campaign',
      draft: { ...draft, startPaused: false },
    });
    renderDetail();
    expect(screen.getByText(/já fica reservada no mês/)).toBeTruthy();
  });
});

describe('a Meta request that creates the ad set and the ads', () => {
  const tree: NonNullable<ApprovalDetail['draft']> = {
    platform: 'meta',
    name: 'Meta — conjunto e anúncios',
    objective: 'lead',
    idealCustomerProfile: 'Empreendedor de 30 a 50 anos, com experiência em gestão.',
    reach: { states: ['SP'], cities: [], customLocations: [] },
    formatKey: 'feed_square',
    destinationUrl: 'https://wingscompany.com.br/franquia',
    variations: [
      {
        creativeType: 'video',
        videoId: '33333333-3333-4333-8333-333333333333',
        headline: 'Veja a Wings por dentro',
        primaryText: 'Um minuto sobre o modelo.',
        callToAction: 'LEARN_MORE',
      },
      {
        creativeType: 'carousel',
        cards: [1, 2, 3].map((n) => ({
          mediaType: 'image' as const,
          creativeId: '11111111-1111-4111-8111-111111111111',
          headline: `Cartão ${n}`,
          description: 'Suporte completo.',
          link: 'https://wingscompany.com.br/franquia',
        })),
        headline: 'Conheça a Wings',
        primaryText: 'Deslize para ver.',
        callToAction: 'LEARN_MORE',
      },
    ],
    ageMin: 25,
    ageMax: 65,
    placements: { mode: 'manual', facebook: ['feed'], instagram: ['stories', 'reels'] },
    identity: { pageId: '104567890123456', instagramActorId: '17841400000000000' },
    startDate: '2026-09-20',
    endDate: '2026-09-29',
    dailyBudgetCents: 2_000,
    utms: { utm_source: 'meta', utm_medium: 'paid_social', utm_campaign: 'x', utm_content: 'lead' },
    startPaused: true,
  };
  const created = (overrides: Record<string, unknown> = {}) =>
    buildApproval({
      changeKind: 'create_campaign',
      campaignName: tree.name,
      status: 'approved',
      changeStatus: 'executed',
      draft: tree,
      ...overrides,
    });

  afterEach(() => {
    previews.current = [];
    previewsAskedFor.mockReset();
  });

  it('shows age range, placements, page, Instagram and each creative type', () => {
    approval.current = created({ status: 'pending', changeStatus: 'pending_approval' });
    renderDetail();

    expect(screen.getByText(/Tudo nasce/)).toBeTruthy();
    expect(screen.getByText('25 a 65 anos')).toBeTruthy();
    expect(screen.getByText('Facebook: Feed · Instagram: Stories, Reels')).toBeTruthy();
    expect(screen.getByText('Página 104567890123456')).toBeTruthy();
    expect(screen.getByText('Instagram 17841400000000000')).toBeTruthy();
    expect(screen.getByText('1. Vídeo')).toBeTruthy();
    expect(screen.getByText('2. Carrossel (3 cartões)')).toBeTruthy();
    // Nothing exists on Meta yet: no official preview is asked for.
    expect(screen.queryByText('Prévia oficial da Meta')).toBeNull();
    expect(previewsAskedFor).not.toHaveBeenCalled();
  });

  it('says an older draft creates the campaign alone, and asks for no official preview', () => {
    const old = {
      ...tree,
      identity: undefined,
      placements: undefined,
      ageMin: undefined,
      ageMax: undefined,
    };
    approval.current = created({ draft: old });
    renderDetail();

    expect(
      screen.getByText(/Pedido anterior aos conjuntos de anúncios: cria só a campanha\./),
    ).toBeTruthy();
    expect(screen.queryByText('Faixa etária')).toBeNull();
    expect(screen.queryByText('Prévia oficial da Meta')).toBeNull();
  });

  it('lists what was created on Meta, so a failure in the middle can be read', () => {
    const executionSteps: ExecutionStepView[] = [
      {
        seq: 2,
        kind: 'video',
        label: 'Vídeo da variação 1',
        status: 'created',
        externalId: '9001',
        message: null,
      },
      {
        seq: 1,
        kind: 'campaign',
        label: 'Campanha',
        status: 'created',
        externalId: '23850000000000001',
        message: null,
      },
      {
        seq: 3,
        kind: 'ad_set',
        label: 'Conjunto de anúncios',
        status: 'failed',
        externalId: null,
        message: 'Invalid parameter',
      },
      {
        seq: 4,
        kind: 'ad',
        label: 'Anúncio da variação 1',
        status: 'unknown',
        externalId: null,
        message: null,
      },
    ];
    approval.current = {
      ...created({ changeStatus: 'unknown' }),
      executionSteps,
    } as ApprovalDetail;
    renderDetail();

    const items = screen
      .getByText('O que foi criado na Meta')
      .parentElement?.querySelectorAll('li');
    expect(Array.from(items ?? []).map((item) => item.textContent)).toEqual([
      'Campanha — criado id 23850000000000001',
      'Vídeo da variação 1 — criado id 9001',
      'Conjunto de anúncios — falhou Invalid parameter',
      'Anúncio da variação 1 — desconhecido',
    ]);
  });

  it('renders the official preview only from Meta’s own hosts, per placement', () => {
    previews.current = [
      {
        adName: 'Variação 1',
        iframeSrc: 'https://www.facebook.com/ads/api/preview_iframe.php?d=1',
      },
      {
        adName: 'Variação 2',
        iframeSrc: 'https://business.facebook.com/ads/api/preview_iframe.php?d=2',
      },
      { adName: 'Intruso', iframeSrc: 'https://www.facebook.com.evil.example/preview' },
    ];
    approval.current = created();
    renderDetail();

    expect(screen.getByText('Prévia oficial da Meta')).toBeTruthy();
    expect(previewsAskedFor).toHaveBeenLastCalledWith('facebook_feed');
    const frames = Array.from(document.querySelectorAll('iframe'));
    expect(frames.map((frame) => frame.title)).toEqual(['Variação 1', 'Variação 2']);
    expect(frames[0]?.getAttribute('sandbox')).toBe('allow-scripts allow-same-origin');
    expect(frames[0]?.getAttribute('referrerpolicy')).toBe('no-referrer');
    expect(screen.getByText(/o endereço não é da Meta/)).toBeTruthy();

    fireEvent.change(screen.getByLabelText(/^Posicionamento$/), {
      target: { value: 'instagram_stories' },
    });
    expect(previewsAskedFor).toHaveBeenLastCalledWith('instagram_stories');
  });

  it('says the ads do not exist yet, and keeps the approximate preview on other failures', () => {
    approval.current = created();
    previews.current = new ApiError(409, { error: 'not_created_yet', message: 'x' });
    renderDetail();
    expect(screen.getByText('Os anúncios ainda não existem na Meta.')).toBeTruthy();
    cleanup();

    previews.current = new ApiError(502, {
      error: 'meta_unavailable',
      message: 'A Meta não respondeu.',
    });
    renderDetail();
    expect(
      screen.getByText(/A Meta não respondeu\. A prévia aproximada acima continua valendo\./),
    ).toBeTruthy();
    expect(screen.getByText(/Não é a prévia oficial da Meta/)).toBeTruthy();
    expect(document.querySelector('iframe')).toBeNull();
  });
});
