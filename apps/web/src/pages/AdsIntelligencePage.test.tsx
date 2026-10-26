import type {
  AdCopyDraft,
  AuditFinding,
  AuditRunDetail,
  IntelligenceOverview,
} from '@wings/shared';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api/client.js';

/**
 * The screen acts only behind a click, and only where the person may: these
 * tests check "conexão pendente" instead of invented data, "—" and the reason
 * on a failed read, the request button only on a requestable finding for
 * someone with `ads.request`, and that an ad package reads as a preview.
 */

const overview: IntelligenceOverview = {
  credentials: { meta: false, google: false },
  accounts: [],
  pendingApprovals: 2,
  unknownExecutions: 0,
  openAlerts: { total: 3, critical: 1 },
  ingestFailures: [],
  lastIngestAt: null,
  operations: [],
  conversionsApi: {
    enabled: false,
    pixelId: '1116678872845520',
    last7Days: { sent: 0, skipped: 0, failed: 0, pending: 0 },
    lastSentAt: null,
    lastError: null,
  },
  aiConfigured: true,
  latestAudit: null,
};

const finding = (overrides: Partial<AuditFinding>): AuditFinding => ({
  id: 'f-1',
  check: 'campaign_performance',
  platform: 'meta',
  accountName: null,
  status: 'fail',
  impact: 'high',
  confidence: 'high',
  effort: 'low',
  priority: 18,
  title: 'Leads RJ: desempenho negativo',
  detail: 'R$ 300,00 em 14 dias, 0 resultado(s).',
  recommendation: 'Pausar até revisar criativo e público.',
  entity: { level: 'campaign', externalId: 'c1', name: 'Leads RJ' },
  action: {
    kind: 'pause_campaign',
    campaignExternalId: 'c1',
    justification: 'Auditoria: veredito negativo.',
    evidence: [{ label: 'Gasto', value: 'R$ 300,00' }],
  },
  requestable: true,
  notRequestableReason: null,
  state: 'open',
  changeRequestId: null,
  approvalId: null,
  ...overrides,
});

const detail: AuditRunDetail = {
  run: {
    id: 'run-1',
    scope: 'all',
    days: 14,
    status: 'completed',
    since: '2026-10-12',
    until: '2026-10-25',
    counts: { fail: 1, warn: 0, pass: 1, unknown: 0, not_applicable: 0 },
    comparison: [],
    requestedByName: null,
    createdAt: '2026-10-26T12:00:00.000Z',
    error: null,
  },
  findings: [
    finding({}),
    finding({
      id: 'f-2',
      status: 'pass',
      check: 'data_freshness',
      title: 'Conta: dados atualizados',
      action: null,
      requestable: false,
    }),
  ],
};

const draft: AdCopyDraft = {
  id: 'd-1',
  createdAt: '2026-10-26T12:00:00.000Z',
  request: {
    platform: 'meta',
    objective: 'leads',
    product: 'Formatação de franquias',
    variations: 2,
  },
  package: {
    variations: [
      {
        headline: 'Sua marca em outras cidades',
        primaryText: 'A Wings estrutura sua franquia.',
        callToAction: 'LEARN_MORE',
        angle: 'benefício',
      },
    ],
    creativeBrief: 'Dono de loja em frente ao negócio.',
    videoScript: [],
    audienceSuggestion: '',
    structureSuggestion: '',
    assumptions: [],
  },
  refused: [{ headline: 'Lucro garantido', problems: ['Promessa de ganho: "Lucro garantido"'] }],
  costMicroUsd: 4000,
  error: null,
};

const state = {
  canRequest: true,
  overviewError: null as unknown,
  overview,
};
const act = vi.fn();
const mutation = (mutate = vi.fn()) => ({ mutate, isPending: false, isError: false, error: null });

vi.mock('../api/auth.js', () => ({
  useSession: () => ({ data: { permissions: state.canRequest ? { 'ads.request': 'all' } : {} } }),
  hasPermission: (user: { permissions: Record<string, string> } | null, key: string) =>
    Boolean(user?.permissions[key]),
}));

vi.mock('../api/ads-intelligence.js', () => ({
  useIntelligenceOverview: () =>
    state.overviewError
      ? { data: undefined, isError: true, error: state.overviewError, refetch: vi.fn() }
      : { data: state.overview, isError: false, isLoading: false },
  useAuditRuns: () => ({ data: { runs: [detail.run] }, isError: false, isLoading: false }),
  useAuditRun: () => ({ data: detail, isError: false }),
  useRunAudit: () => mutation(),
  useFindingAction: () => mutation(act),
  useCopyDrafts: () => ({ data: { drafts: [draft] }, isError: false, isLoading: false }),
  useGenerateCopy: () => mutation(),
}));

const { AdsIntelligencePage } = await import('./AdsIntelligencePage.js');

const show = (tab: string) =>
  render(
    <MemoryRouter initialEntries={[`/marketing/ads-intelligence?aba=${tab}`]}>
      <AdsIntelligencePage />
    </MemoryRouter>,
  );

afterEach(() => {
  cleanup();
  act.mockReset();
  state.canRequest = true;
  state.overviewError = null;
  state.overview = overview;
});

describe('AdsIntelligencePage', () => {
  it('says "conexão pendente" and that the Conversions API is off, never invented numbers', () => {
    show('visao-geral');
    expect(screen.getAllByText(/conexão pendente/)).toHaveLength(2);
    expect(screen.getByText('Desligada')).toBeTruthy();
    expect(screen.getByText(/Nenhuma conta espelhada/)).toBeTruthy();
  });

  it('a failed read shows "—" and the reason', () => {
    state.overviewError = new ApiError(503, { error: 'x', message: 'Serviço indisponível' });
    show('visao-geral');
    expect(screen.getByRole('alert').textContent).toContain('—');
  });

  it('offers "Criar pedido" only on a requestable finding, and hides what is in order', () => {
    show('auditoria');
    expect(screen.queryByText('Conta: dados atualizados')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Criar pedido/ }));
    expect(act).toHaveBeenCalledWith({ id: 'f-1', action: 'request' });
    expect(screen.getByText(/Nada é executado por este botão/)).toBeTruthy();
  });

  it('without ads.request there is no button to act', () => {
    state.canRequest = false;
    show('auditoria');
    expect(screen.queryByRole('button', { name: /Criar pedido/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Descartar/ })).toBeNull();
  });

  it('an ad package reads as a preview, with what the rules refused', () => {
    show('anuncios-ia');
    expect(screen.getByText('Sua marca em outras cidades')).toBeTruthy();
    expect(screen.getByText(/nada foi publicado/)).toBeTruthy();
    expect(screen.getByText(/1 variação\(ões\) recusada/)).toBeTruthy();
  });

  it('without the model key the generate button is off', () => {
    state.overview = { ...overview, aiConfigured: false };
    show('anuncios-ia');
    expect(screen.getByText(/IA não configurada/)).toBeTruthy();
    expect(
      (screen.getByRole('button', { name: /Gerar pacote/ }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });
});
