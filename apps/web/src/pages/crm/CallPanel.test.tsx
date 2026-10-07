import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CallPanel } from './CallPanel.js';

/**
 * The call panel: the number as text (no tel: link), "Ligar pelo WhatsApp"
 * off until the API is on, "Copiar número", the call registered on the deal,
 * closed by Fechar, Escape or the backdrop; its clicks never reach what is
 * under it.
 */

const { activityMutate } = vi.hoisted(() => ({ activityMutate: vi.fn() }));

vi.mock('../../api/crm.js', () => ({
  useAddActivity: () => ({ mutate: activityMutate, isPending: false, error: null }),
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

  it('turns "Ligar pelo WhatsApp" on when the server says calling is on', () => {
    show({ whatsappCalling: true });
    const whatsapp = screen.getByRole('button', {
      name: /Ligar pelo WhatsApp/,
    }) as HTMLButtonElement;
    expect(whatsapp.disabled).toBe(false);
    expect(screen.queryByText(/Fica ativo quando/)).toBeNull();
  });

  it('keeps WhatsApp calling off without a phone, and offers no copy', () => {
    show({ phone: null, whatsappCalling: true });
    expect(screen.getByText('Sem telefone')).toBeTruthy();
    expect(
      (screen.getByRole('button', { name: /Ligar pelo WhatsApp/ }) as HTMLButtonElement).disabled,
    ).toBe(true);
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
