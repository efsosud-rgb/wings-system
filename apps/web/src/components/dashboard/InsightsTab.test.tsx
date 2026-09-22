import type {
  CampaignSuggestionCard,
  InsightCard,
  InsightRun,
  InsightsResponse,
  SuggestionsResponse,
} from '@wings/shared';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BUILDER_HANDOFF_KEY } from '../../lib/builder-handoff.js';

/**
 * A card on this screen does nothing by being there. These tests check that
 * every number reaches the screen, that "Criar pedido" only appears where the
 * system has a request to make and the person may make it, and that a
 * suggestion opens the builder without launching anything.
 */

const run: InsightRun = {
  id: 'run-1',
  kind: 'insights',
  trigger: 'schedule',
  status: 'done',
  startedAt: '2026-09-21T10:00:00.000Z',
  finishedAt: '2026-09-21T10:01:00.000Z',
  requestedByName: null,
  model: 'anthropic/claude-sonnet-5',
  costMicroUsd: 42_000,
  produced: 2,
  consulted: [
    { tool: 'desempenho_campanhas', label: 'Desempenho das campanhas', summary: '3 campanhas, 30 dias' },
    { tool: 'metas_de_cpl', label: 'Metas de CPL confirmadas', summary: 'CPL R$ 45,00' },
  ],
  error: null,
};

function insight(overrides: Partial<InsightCard>): InsightCard {
  return {
    id: 'ins-1',
    runId: 'run-1',
    kind: 'budget_curve',
    title: 'LEAD | FORMS satura acima de R$ 120 por dia',
    findings: 'Entre R$ 80 e R$ 120 por dia o CPL ficou em R$ 41,00; acima de R$ 120 subiu para R$ 63,00 com os mesmos 4 leads por dia.',
    evidence: [
      { label: 'CPL até R$ 120/dia', value: 'R$ 41,00' },
      { label: 'CPL acima', value: 'R$ 63,00' },
    ],
    suggestion: 'Voltar a verba para R$ 120 por dia.',
    impact: { text: 'Mesmos leads por menos', estimatedCentsPerMonth: 66_000, direction: 'save' },
    confidence: 'high',
    campaignExternalId: 'c1',
    campaignName: 'LEAD | FORMS',
    platform: 'meta',
    action: {
      payload: {
        kind: 'set_daily_budget',
        campaignExternalId: 'c1',
        toDailyBudgetCents: 12_000,
        justification: 'Saturação acima de R$ 120 por dia.',
        evidence: [{ label: 'CPL acima', value: 'R$ 63,00' }],
      },
      campaignName: 'LEAD | FORMS',
      platform: 'meta',
      currentDailyBudgetCents: 15_000,
      requestable: true,
      notRequestableReason: null,
    },
    status: 'open',
    createdAt: '2026-09-21T10:01:00.000Z',
    actedAt: null,
    actedByName: null,
    approvalId: null,
    consulted: run.consulted,
    ...overrides,
  };
}

const state = {
  insights: {} as InsightsResponse,
  suggestions: {} as SuggestionsResponse,
  canRequest: true,
};

const generateInsights = vi.fn();
const generateSuggestions = vi.fn();
const markSeen = vi.fn();
const requestFromInsight = vi.fn();
const applied = vi.fn();
const dismiss = vi.fn();
const navigate = vi.fn();
const mutation = (mutate: ReturnType<typeof vi.fn>) => ({ mutate, isPending: false, isError: false, error: null });

vi.mock('../../api/auth.js', () => ({
  useSession: () => ({ data: { permissions: state.canRequest ? { 'ads.request': 'all' } : {} } }),
  hasPermission: (user: { permissions: Record<string, string> } | null, key: string) => Boolean(user?.permissions[key]),
}));

vi.mock('../../api/dashboard.js', () => ({
  useInsights: () => ({ data: state.insights, isError: false, refetch: vi.fn() }),
  useInsightRun: () => ({ data: undefined }),
  useGenerateInsights: () => mutation(generateInsights),
  useMarkInsightSeen: () => mutation(markSeen),
  useRequestFromInsight: () => mutation(requestFromInsight),
  useSuggestions: () => ({ data: state.suggestions, isError: false, refetch: vi.fn() }),
  useGenerateSuggestions: () => mutation(generateSuggestions),
  useSuggestionApplied: () => mutation(applied),
  useDismissSuggestion: () => mutation(dismiss),
  useDashboardCampaigns: () => ({
    data: {
      campaigns: {
        campaigns: [
          { verdict: { verdict: 'positive' } },
          { verdict: { verdict: 'negative' } },
          { verdict: { verdict: 'no_target' } },
        ],
      },
    },
  }),
}));

vi.mock('react-router-dom', async (original) => ({
  ...(await original<typeof import('react-router-dom')>()),
  useNavigate: () => navigate,
}));

const { InsightsTab } = await import('./InsightsTab.js');

const suggestion: CampaignSuggestionCard = {
  id: 'sug-1',
  runId: 'run-2',
  proposal: {
    platform: 'google_search',
    name: 'Pesquisa | Franquia SP',
    objective: 'lead',
    idealCustomerProfile: 'Empresário dono de negócio que quer expandir por franquias.',
    reach: { states: ['SP'], cities: [], customLocations: [] },
    destinationUrl: 'https://wingscompany.com.br/franquia',
    utms: { utm_source: 'google', utm_medium: 'cpc', utm_campaign: 'pesquisa-franquia-sp', utm_content: '' },
    dailyBudgetCents: 4000,
    startDate: '2026-09-28',
    endDate: '2026-10-11',
    copy: [],
    search: {
      keywords: [
        { text: 'abrir franquia', match: 'exact' },
        { text: 'franquia de alimentação', match: 'phrase' },
        { text: 'como franquear meu negócio', match: 'broad' },
      ],
      negativeKeywords: ['grátis', 'vaga', 'emprego', 'curso', 'currículo'],
      headlines: ['Franquia Wings'],
      descriptions: ['Conheça o modelo.'],
    },
    explanations: [{ field: 'dailyBudgetCents', reason: 'Cabe no disponível de R$ 900,00.' }],
    assumptions: ['Assumi que a página de destino tem o formulário.'],
    summary: 'Pesquisa para leads em SP, onde o CPL foi menor.',
  },
  expectedCplCents: { min: 3500, max: 5000 },
  expectedLeads: { min: 11, max: 16 },
  motivation: [{ label: 'CPL em SP, 90 dias', value: 'R$ 38,00' }],
  pending: [],
  status: 'open',
  createdAt: '2026-09-21T10:02:00.000Z',
  actedAt: null,
  actedByName: null,
};

function renderTab() {
  return render(
    <MemoryRouter initialEntries={['/dashboard/marketing?aba=insights']}>
      <Routes>
        <Route path="/dashboard/marketing" element={<InsightsTab />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  state.canRequest = true;
  state.insights = {
    configured: true,
    usage: { spentMicroUsd: 42_000, limitMicroUsd: 1_000_000, exhausted: false },
    latestRun: run,
    runningRun: null,
    open: [insight({})],
    history: [
      insight({
        id: 'ins-2',
        title: 'Reels desgastado',
        kind: 'creative_fatigue',
        status: 'seen',
        actedAt: '2026-09-21T14:00:00.000Z',
        actedByName: 'Ana',
        action: null,
      }),
      insight({
        id: 'ins-3',
        title: 'Pausar Institucional',
        status: 'requested',
        actedAt: '2026-09-21T15:00:00.000Z',
        actedByName: 'Bruno',
        approvalId: 'appr-9',
      }),
    ],
    nextScheduledAt: '2026-09-28T10:00:00.000Z',
  };
  state.suggestions = {
    configured: true,
    usage: { spentMicroUsd: 42_000, limitMicroUsd: 1_000_000, exhausted: false },
    latestRun: { ...run, id: 'run-2', kind: 'campaign_suggestions', trigger: 'manual', requestedByName: 'Ana' },
    runningRun: null,
    suggestions: [suggestion],
    nextScheduledAt: '2026-09-28T10:00:00.000Z',
  };
  sessionStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const text = (element: Element | null | undefined) =>
  element?.textContent?.replace(new RegExp(String.fromCharCode(160), 'g'), ' ') ?? '';

describe('the run bar', () => {
  it('says who generated, what it cost and what it read, and counts the verdicts', () => {
    renderTab();
    expect(screen.getByText(/Gerados 21\/09, 07:00 pela agenda · custo US\$ 0,04 · consultou 2 fontes/)).toBeTruthy();
    expect(screen.getAllByText(/Hoje: US\$ 0,04 de US\$ 1,00/).length).toBe(2);
    const verdicts = screen.getByRole('region', { name: 'Vereditos das campanhas em 30 dias' });
    expect(text(verdicts)).toContain('Positiva 1');
    expect(text(verdicts)).toContain('Negativa 1');
    expect(text(verdicts)).toContain('Sem meta 1');
    expect(text(verdicts)).toContain('Atenção 0');
  });

  it('generates on the click, and says why the button is off', () => {
    renderTab();
    fireEvent.click(screen.getAllByRole('button', { name: 'Gerar agora' })[0]!);
    expect(generateInsights).toHaveBeenCalledTimes(1);

    cleanup();
    state.insights = { ...state.insights, runningRun: { ...run, status: 'running', finishedAt: null } };
    renderTab();
    const running = screen.getAllByRole('button', { name: 'Gerando…' })[0] as HTMLButtonElement;
    expect(running.disabled).toBe(true);
    expect(screen.getByText('Uma geração está em andamento.')).toBeTruthy();

    cleanup();
    state.insights = { ...state.insights, runningRun: null, usage: { spentMicroUsd: 1_000_000, limitMicroUsd: 1_000_000, exhausted: true } };
    renderTab();
    expect(screen.getByText(/O teto diário de IA dos insights foi atingido/)).toBeTruthy();

    cleanup();
    state.insights = { ...state.insights, configured: false };
    renderTab();
    expect(screen.getByText('O OpenRouter não está configurado neste ambiente.')).toBeTruthy();
  });
});

describe('an open insight', () => {
  it('shows the numbers, the suggestion, the impact in money and what was consulted', () => {
    renderTab();
    const card = screen.getByRole('article', { name: /Insight: LEAD \| FORMS satura/ });
    expect(text(card)).toContain('Verba ideal por campanha');
    expect(text(card)).toContain('Confiança alta');
    expect(text(card)).toContain('R$ 63,00');
    expect(text(card)).toContain('Voltar a verba para R$ 120 por dia.');
    expect(text(card)).toContain('economia de R$ 660,00 por mês');
    expect(within(card).getByText('O que consultei (2)')).toBeTruthy();
    expect(text(card)).toContain('3 campanhas, 30 dias');
  });

  it('offers "Criar pedido" only with a requestable action and the permission', () => {
    renderTab();
    fireEvent.click(screen.getByRole('button', { name: 'Criar pedido' }));
    expect(requestFromInsight).toHaveBeenCalledWith('ins-1');
    expect(screen.getByText(/marcado "sugerido pela IA"/)).toBeTruthy();

    cleanup();
    state.canRequest = false;
    renderTab();
    expect(screen.queryByRole('button', { name: 'Criar pedido' })).toBeNull();
    expect(screen.getAllByText(/Você não tem permissão para pedir alterações/).length).toBeGreaterThan(0);

    cleanup();
    state.canRequest = true;
    state.insights = {
      ...state.insights,
      open: [
        insight({
          action: { ...insight({}).action!, requestable: false, notRequestableReason: 'Esta campanha tem a verba nos conjuntos de anúncios. Ajuste no Gerenciador.' },
        }),
      ],
    };
    renderTab();
    expect(screen.queryByRole('button', { name: 'Criar pedido' })).toBeNull();
    expect(screen.getByText(/Ajuste no Gerenciador/)).toBeTruthy();
  });

  it('marks as seen', () => {
    renderTab();
    fireEvent.click(screen.getByRole('button', { name: 'Marcar como visto' }));
    expect(markSeen).toHaveBeenCalledWith('ins-1');
  });
});

describe('the history', () => {
  it('lists what was done, by whom and when, and links the request', () => {
    renderTab();
    const history = screen.getByRole('region', { name: 'Histórico' });
    expect(text(history)).toContain('Visto por Ana');
    expect(text(history)).toContain('21/09, 11:00');
    expect(text(history)).toContain('Pedido criado por Bruno');
    const link = within(history).getByRole('link', { name: 'Ver o pedido' });
    expect(link.getAttribute('href')).toBe('/marketing/trafego-pago-wings/aprovacoes/appr-9');
  });
});

describe('campaign suggestions', () => {
  it('shows the proposal with its expected range and the numbers behind it', () => {
    renderTab();
    const card = screen.getByRole('article', { name: 'Sugestão de campanha: Pesquisa | Franquia SP' });
    expect(text(card)).toContain('Google Pesquisa');
    expect(text(card)).toContain('R$ 40,00');
    expect(text(card)).toContain('SP (estado todo)');
    expect(text(card)).toContain('R$ 35,00 a R$ 50,00');
    expect(text(card)).toContain('11 a 16');
    expect(text(card)).toContain('CPL em SP, 90 dias');
    expect(screen.getByText(/Gerados 21\/09, 07:00 por Ana/)).toBeTruthy();
  });

  it('opens the builder with the proposal in session storage, and launches nothing', () => {
    renderTab();
    fireEvent.click(screen.getByRole('button', { name: 'Abrir no construtor' }));
    expect(applied).toHaveBeenCalledWith('sug-1');
    expect(navigate).toHaveBeenCalledWith('/marketing/trafego-pago-wings');
    const stored = JSON.parse(sessionStorage.getItem(BUILDER_HANDOFF_KEY) ?? '{}') as { proposal?: { name?: string }; pending?: string[] };
    expect(stored.proposal?.name).toBe('Pesquisa | Franquia SP');
    expect(stored.pending).toEqual([]);
    expect(requestFromInsight).not.toHaveBeenCalled();
  });

  it('dismisses', () => {
    renderTab();
    fireEvent.click(screen.getByRole('button', { name: 'Dispensar' }));
    expect(dismiss).toHaveBeenCalledWith('sug-1');
  });
});
