import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CallPanel } from './CallPanel.js';

/**
 * The call panel: the number as text (no tel: link), "Ligar pelo WhatsApp"
 * off until the API is on, "Copiar número", the call registered on the deal,
 * closed by Fechar, Escape or the backdrop; its clicks never reach what is
 * under it.
 */

const { activityMutate, centerState, soonState } = vi.hoisted(() => ({
  activityMutate: vi.fn(),
  centerState: { value: null as null | { calling: boolean; active: null; placeCall: () => void } },
  // A seller before the official number is live (useWhatsAppSoon).
  soonState: { value: false },
}));

vi.mock('../../api/whatsapp.js', () => ({
  useWhatsAppSoon: () => soonState.value,
  WHATSAPP_SOON_TEXT: 'Em breve: texto do bloqueio do vendedor.',
}));

vi.mock('../../api/crm.js', () => ({
  useAddActivity: () => ({ mutate: activityMutate, isPending: false, error: null }),
}));

// The WhatsApp part has its own tests (WhatsAppCalls.test.tsx); here only where it goes.
vi.mock('./WhatsAppCalls.js', () => ({
  useWhatsAppCallCenter: () => centerState.value,
  WhatsAppCallSection: ({ onCalling }: { onCalling: () => void }) => (
    <button type="button" onClick={onCalling}>
      Ligar pelo WhatsApp
    </button>
  ),
}));

const onClose = vi.fn();
const parentClick = vi.fn();

const show = (over: Partial<Parameters<typeof CallPanel>[0]> = {}) =>
  render(
    <div onClick={parentClick}>
      <CallPanel
        leadId="l1"
        name="Elena Prado"
        phone="5521999990001"
        canWrite
        onClose={onClose}
        {...over}
      />
    </div>,
  );

beforeEach(() => {
  soonState.value = false;
  activityMutate.mockClear();
  onClose.mockClear();
  parentClick.mockClear();
});
afterEach(cleanup);

describe('the call panel', () => {
  it('shows who and the number as text, with WhatsApp calling off and why', () => {
    show();
    const dialog = screen.getByRole('dialog', { name: 'Ligação' });
    expect(dialog.textContent).toContain('Elena Prado');
    expect(screen.getByText('(21) 99999-0001')).toBeTruthy();
    expect(dialog.querySelector('a[href^="tel:"]')).toBeNull();
    const whatsapp = screen.getByRole('button', {
      name: /Ligar pelo WhatsApp/,
    }) as HTMLButtonElement;
    expect(whatsapp.disabled).toBe(true);
    expect(
      screen.getByText(/Fica ativo quando a API oficial do WhatsApp estiver ligada/),
    ).toBeTruthy();
  });

  it('hands the WhatsApp part to the call center when there is one, and closes when a call starts', () => {
    centerState.value = { calling: true, active: null, placeCall: vi.fn() };
    show();
    expect(screen.queryByText(/Fica ativo quando/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Ligar pelo WhatsApp/ }));
    expect(onClose).toHaveBeenCalledTimes(1);
    centerState.value = null;
  });

  it('before the official number is live says "em breve" instead of the WhatsApp call, and keeps the rest', () => {
    soonState.value = true;
    // Even with a call center ready, the seller's call is not offered.
    centerState.value = { calling: true, active: null, placeCall: vi.fn() };
    show();
    const whatsapp = screen.getByRole('button', {
      name: /Ligar pelo WhatsApp/,
    }) as HTMLButtonElement;
    expect(whatsapp.disabled).toBe(true);
    expect(whatsapp.textContent).toContain('em breve');
    expect(screen.getByText('Em breve: texto do bloqueio do vendedor.')).toBeTruthy();
    fireEvent.click(whatsapp);
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.queryByText(/Fica ativo quando/)).toBeNull();
    expect(screen.getByRole('button', { name: 'Copiar número' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Registrar ligação' })).toBeTruthy();
    centerState.value = null;
  });

  it('offers no copy without a phone', () => {
    show({ phone: null });
    expect(screen.getByText('Sem telefone')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Copiar número' })).toBeNull();
  });

  it('copies the number with the country code', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.assign(navigator, { clipboard: { writeText } });
    show();
    fireEvent.click(screen.getByRole('button', { name: 'Copiar número' }));
    expect(writeText).toHaveBeenCalledWith('+5521999990001');
    expect(await screen.findByRole('button', { name: 'Copiado' })).toBeTruthy();
  });

  it('registers the call on the deal with outcome, duration in seconds and note', async () => {
    show();
    fireEvent.change(screen.getByLabelText('Resultado'), { target: { value: 'no_answer' } });
    fireEvent.change(screen.getByLabelText('Duração em minutos'), { target: { value: '2' } });
    fireEvent.change(screen.getByLabelText('Observação'), {
      target: { value: 'Retornar à tarde' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Registrar ligação' }));
    expect(activityMutate).toHaveBeenCalledWith(
      { kind: 'call', outcome: 'no_answer', durationSeconds: 120, note: 'Retornar à tarde' },
      expect.anything(),
    );
    const options = activityMutate.mock.calls[0]![1] as { onSuccess: () => void };
    options.onSuccess();
    expect(await screen.findByText('Ligação registrada na negociação.')).toBeTruthy();
  });

  it('hides the register form from who cannot write', () => {
    show({ canWrite: false });
    expect(screen.queryByRole('button', { name: 'Registrar ligação' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Copiar número' })).toBeTruthy();
  });

  it('closes by Fechar, Escape and the backdrop, and no click reaches what is under it', () => {
    show();
    fireEvent.click(screen.getByRole('button', { name: 'Copiar número' }));
    fireEvent.click(screen.getByRole('dialog', { name: 'Ligação' }));
    expect(parentClick).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Fechar' }));
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(2);
    fireEvent.mouseDown(screen.getByRole('dialog', { name: 'Ligação' }).parentElement!);
    expect(onClose).toHaveBeenCalledTimes(3);
    expect(parentClick).not.toHaveBeenCalled();
  });
});
