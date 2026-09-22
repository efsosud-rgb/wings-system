import type { DashboardSettings } from '@wings/shared';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = { settings: {} as DashboardSettings, canConfirm: true };
const setTarget = vi.fn();

vi.mock('../../api/auth.js', () => ({
  useSession: () => ({ data: { permissions: state.canConfirm ? { 'ads.request': 'all' } : {} } }),
  hasPermission: (user: { permissions: Record<string, string> } | null, key: string) => Boolean(user?.permissions[key]),
}));

vi.mock('../../api/dashboard.js', () => ({
  useDashboardSettings: () => ({ data: state.settings, isError: false }),
  useSetCplTarget: () => ({ mutate: setTarget, isPending: false, isError: false, error: null }),
}));

const { SettingsTab } = await import('./SettingsTab.js');

beforeEach(() => {
  state.canConfirm = true;
  state.settings = {
    targets: [
      {
        objectiveKind: 'leads',
        targetCents: null,
        confirmedAt: null,
        confirmedByName: null,
        proposedCents: 4500,
        proposedBasis: 'CPL médio dos últimos 90 dias: R$ 44,10 em 3 campanha(s) de leads, 27 leads por R$ 1.190,70. Arredondado para cima.',
      },
      {
        objectiveKind: 'traffic',
        targetCents: 180,
        confirmedAt: '2026-09-20T13:00:00.000Z',
        confirmedByName: 'Ana',
        proposedCents: null,
        proposedBasis: null,
      },
    ],
  };
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const text = (element: Element | null | undefined) =>
  element?.textContent?.replace(new RegExp(String.fromCharCode(160), 'g'), ' ') ?? '';

describe('Configurações do Dashboard', () => {
  it('shows the proposal with its basis, fills the input from it and confirms in cents', () => {
    render(<SettingsTab />);
    const leads = screen.getByRole('region', { name: /^Leads e conversão/ });
    expect(text(leads)).toContain('Sem meta confirmada');
    expect(text(leads)).toContain('R$ 45,00');
    expect(text(leads)).toContain('27 leads por R$ 1.190,70');
    fireEvent.click(within(leads).getByRole('button', { name: 'Usar proposta' }));
    const input = within(leads).getByLabelText('Meta em reais') as HTMLInputElement;
    expect(input.value).toBe('45,00');
    fireEvent.change(input, { target: { value: '42,50' } });
    fireEvent.click(within(leads).getByRole('button', { name: 'Confirmar meta' }));
    expect(setTarget).toHaveBeenCalledWith({ objectiveKind: 'leads', targetCents: 4250 });
  });

  it('refuses a value that is not money before calling the API', () => {
    render(<SettingsTab />);
    const leads = screen.getByRole('region', { name: /^Leads e conversão/ });
    fireEvent.change(within(leads).getByLabelText('Meta em reais'), { target: { value: 'abc' } });
    fireEvent.click(within(leads).getByRole('button', { name: 'Confirmar meta' }));
    expect(within(leads).getByRole('alert').textContent).toContain('Informe um valor em reais');
    expect(setTarget).not.toHaveBeenCalled();
  });

  it('shows a confirmed target with who and when, and removes it with null', () => {
    render(<SettingsTab />);
    const traffic = screen.getByRole('region', { name: /^Tráfego/ });
    expect(text(traffic)).toContain('R$ 1,80');
    expect(text(traffic)).toContain('confirmada por Ana em 20/09, 10:00');
    expect(text(traffic)).toContain('Histórico curto demais');
    fireEvent.click(within(traffic).getByRole('button', { name: 'Remover meta' }));
    expect(setTarget).toHaveBeenCalledWith({ objectiveKind: 'traffic', targetCents: null });
  });

  it('keeps the form read-only without the permission, and explains the rule', () => {
    state.canConfirm = false;
    render(<SettingsTab />);
    expect(screen.queryByRole('button', { name: 'Confirmar meta' })).toBeNull();
    expect(screen.getAllByText(/Só quem pode pedir alterações de tráfego confirma uma meta/).length).toBe(2);
    expect(screen.getByRole('heading', { name: 'Como o veredito é calculado' })).toBeTruthy();
    expect(screen.getByText(/Bom até 10% abaixo da meta, atenção até 15% acima/)).toBeTruthy();
  });
});
