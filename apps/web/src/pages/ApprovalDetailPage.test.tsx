import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ApprovalDetail, SessionUser } from '@wings/shared';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The panel is what a person actually looks at before money moves, so these
 * tests check that the decision-critical facts are on screen and that the
 * actions respect who is looking.
 */

const session: { current: SessionUser | null } = { current: null };
const approval: { current: ApprovalDetail } = { current: buildApproval() };
const decide = vi.fn().mockResolvedValue({ ok: true, status: 'approved' });
const execute = vi.fn().mockResolvedValue({ ok: true, outcome: 'applied' });

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
  useApprovals: () => ({ data: { approvals: [] }, isLoading: false, isError: false }),
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
    // Budget context: cap, usable, spent, committed.
    expect(screen.getByText(/4\.000,00/)).toBeTruthy();
    expect(screen.getByText(/2\.800,00/)).toBeTruthy();
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
