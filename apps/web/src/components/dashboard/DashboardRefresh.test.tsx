import type { DashboardOverview } from '@wings/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const state = { canReconcile: true };
const post = vi.fn();

vi.mock('../../api/auth.js', () => ({
  useSession: () => ({ data: {} }),
  hasPermission: (_user: unknown, key: string) =>
    key === 'ads.reconcile.manual' && state.canReconcile,
}));
vi.mock('../../api/client.js', async () => {
  class ApiError extends Error {
    constructor(
      readonly status: number,
      readonly body: { error?: string; message?: string; retryAfterSeconds?: number },
    ) {
      super(body.message ?? 'erro');
    }
    get code() {
      return this.body.error ?? 'unknown';
    }
    get retryAfterSeconds() {
      return this.body.retryAfterSeconds;
    }
  }
  return { api: { post: (...args: unknown[]) => post(...args) }, ApiError };
});

const { DashboardRefresh } = await import('./DashboardRefresh.js');
const { ApiError } = await import('../../api/client.js');

const overview = {
  ingestion: { dataUntil: '2026-09-28T17:02:00.000Z' },
  accounts: [
    { id: 'a1', platform: 'meta', name: 'Fly High' },
    { id: 'a2', platform: 'google', name: 'Google Ads' },
  ],
} as unknown as DashboardOverview;

function renderIt() {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <DashboardRefresh overview={overview} />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  state.canReconcile = true;
});

describe('Dados até e Atualizar agora', () => {
  it('says until when the data runs, and reconciles every account on one click', async () => {
    post.mockResolvedValue({ ok: true });
    renderIt();
    expect(screen.getByText(/Dados até 28\/09/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Atualizar agora' }));
    expect(await screen.findByText(/Gasto e status atualizados/)).toBeTruthy();
    expect(post.mock.calls.map((call) => call[0])).toEqual([
      '/ads/accounts/a1/reconcile-now',
      '/ads/accounts/a2/reconcile-now',
    ]);
  });

  it("keeps the server's cooldown and says how long to wait", async () => {
    post
      .mockResolvedValueOnce({ ok: true })
      .mockRejectedValueOnce(
        new ApiError(429, { error: 'reconcile_cooldown', retryAfterSeconds: 20 }),
      );
    renderIt();
    fireEvent.click(screen.getByRole('button', { name: 'Atualizar agora' }));
    expect(await screen.findByText(/Google Ads: aguarde 20s/)).toBeTruthy();
  });

  it('shows no button without the permission', () => {
    state.canReconcile = false;
    renderIt();
    expect(screen.queryByRole('button', { name: 'Atualizar agora' })).toBeNull();
    expect(screen.getByText(/Dados até/)).toBeTruthy();
  });
});
