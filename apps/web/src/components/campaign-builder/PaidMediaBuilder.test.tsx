import type { PacingSummary } from '@wings/shared';
import { cleanup, fireEvent, render as renderBare, screen, waitFor } from '@testing-library/react';
import type { ReactElement } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * The builder is approved by what it shows, so these tests pin what the
 * operator sees: blocked copy is explained on screen, the real cost and the
 * real ceiling sit next to the budget, and launching only ever asks.
 */

const pacing: { current: PacingSummary | null } = { current: buildPacing() };

const requestCampaign = vi.fn();
const launchState: { current: { isSuccess: boolean; data?: { approvalId: string } } } = {
  current: { isSuccess: false },
};

vi.mock('../../api/ads.js', () => ({
  useCockpit: () => ({ data: { cockpit: { pacing: pacing.current } }, isLoading: false }),
  useRequestCampaign: () => ({
    mutate: requestCampaign,
    reset: vi.fn(),
    isPending: false,
    isError: false,
    error: null,
    ...launchState.current,
  }),
}));

const render = (ui: ReactElement) => renderBare(<MemoryRouter>{ui}</MemoryRouter>);

const { PaidMediaBuilder } = await import('./PaidMediaBuilder.js');

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
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  pacing.current = buildPacing();
  launchState.current = { isSuccess: false };
  requestCampaign.mockReset();
});

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
}

const type = (element: Element, value: string) => fireEvent.change(element, { target: { value } });

describe('the paid-media builder', () => {
  it('offers only Meta, and says why the others are off', () => {
    render(<PaidMediaBuilder canRequest />);
    expect((screen.getByRole('radio', { name: /Meta/ }) as HTMLInputElement).disabled).toBe(false);
    for (const name of [/TikTok/, /YouTube/, /LinkedIn/]) {
      expect((screen.getByRole('radio', { name }) as HTMLInputElement).disabled).toBe(true);
    }
    expect(screen.getByText(/Sem conta de anúncios conectada/)).toBeTruthy();
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

  it('warns when the campaign would not fit under the ceiling', () => {
    pacing.current = buildPacing({ availableCents: 10_000 });
    render(<PaidMediaBuilder canRequest />);
    type(screen.getByLabelText(/^Início/), '2026-09-20');
    type(screen.getByLabelText(/^Fim/), '2026-09-29');
    type(screen.getByLabelText(/Verba por dia/), '20,00');
    expect(screen.getByText(/passa do que a conta ainda permite/)).toBeTruthy();
  });

  it('generates UTMs from the name and keeps an edited one', () => {
    render(<PaidMediaBuilder canRequest />);
    type(screen.getByLabelText('Nome da campanha'), 'Expansão SP');
    expect((screen.getByLabelText('utm_campaign') as HTMLInputElement).value).toBe('expansao-sp');

    type(screen.getByLabelText('utm_campaign'), 'minha-tag');
    type(screen.getByLabelText('Nome da campanha'), 'Expansão RJ');
    expect((screen.getByLabelText('utm_campaign') as HTMLInputElement).value).toBe('minha-tag');
  });

  it('allows a third variation and no more', () => {
    render(<PaidMediaBuilder canRequest />);
    expect(screen.getAllByLabelText(/^Título/)).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: /Adicionar variação/ }));
    expect(screen.getAllByLabelText(/^Título/)).toHaveLength(3);
    expect(screen.queryByRole('button', { name: /Adicionar variação/ })).toBeNull();
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
