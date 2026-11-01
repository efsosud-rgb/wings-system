import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { LeadContactOptOuts } from '@wings/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';

const open = { blocked: false, reason: null, origin: null };
const state = {
  data: {
    entries: [],
    blocks: { whatsapp: open, phone: open, email: open, instagram: open },
  } as LeadContactOptOuts,
};
const record = vi.fn();
const revoke = vi.fn();

vi.mock('../../api/contact-opt-outs.js', () => ({
  useContactOptOuts: () => ({ data: state.data, isError: false }),
  useRecordContactOptOut: () => ({ mutate: record, isPending: false, isError: false }),
  useRevokeContactOptOut: () => ({ mutate: revoke, isPending: false, isError: false }),
}));

const { ContactOptOutStrip } = await import('./ContactOptOutStrip.js');

afterEach(() => {
  cleanup();
  record.mockReset();
  revoke.mockReset();
});

const blocked: LeadContactOptOuts = {
  entries: [
    {
      id: 'r1',
      channel: 'whatsapp',
      origin: 'whatsapp_palavra',
      reason: null,
      since: '2026-10-29T13:00:00.000Z',
    },
    {
      id: null,
      channel: 'all',
      origin: 'prospeccao',
      reason: 'Pediu na ligação',
      since: '2026-10-28T13:00:00.000Z',
    },
  ],
  blocks: {
    whatsapp: { blocked: true, reason: 'x', origin: 'whatsapp_palavra' },
    phone: open,
    email: open,
    instagram: open,
  },
};

/** The deal's "Não me contate": badge, record with a confirmation on the strip, revoke for managers. */
describe('ContactOptOutStrip', () => {
  it('shows each one with its channel, since when and origin', () => {
    state.data = blocked;
    render(<ContactOptOutStrip leadId="l1" canWrite={false} canRevoke={false} />);
    expect(
      screen.getByText('WhatsApp, desde 29/10/2026 (pediu para sair pelo WhatsApp)'),
    ).toBeTruthy();
    expect(
      screen.getByText('todos os canais, desde 28/10/2026 (prospecção): Pediu na ligação'),
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Revogar/ })).toBeNull();
  });

  it('records only after the confirmation on the strip, never a browser dialog', () => {
    const dialog = vi.spyOn(window, 'confirm');
    state.data = { ...blocked, entries: [] };
    render(<ContactOptOutStrip leadId="l1" canWrite canRevoke={false} />);
    fireEvent.click(screen.getByRole('button', { name: 'Não me contate' }));
    const confirm = screen.getByRole<HTMLButtonElement>('button', {
      name: 'Confirmar não me contate',
    });
    expect(confirm.disabled).toBe(true); // no reason yet
    fireEvent.change(screen.getByLabelText(/Motivo/), { target: { value: 'Pediu por telefone' } });
    fireEvent.click(screen.getByLabelText('e-mail'));
    fireEvent.click(confirm);
    expect(record).toHaveBeenCalledWith(
      { channels: ['all', 'email'], reason: 'Pediu por telefone' },
      expect.anything(),
    );
    expect(dialog).not.toHaveBeenCalled();
    dialog.mockRestore();
  });

  it('a manager revokes the register’s own channel, with a reason', () => {
    state.data = blocked;
    render(<ContactOptOutStrip leadId="l1" canWrite canRevoke />);
    // The prospect's "não contatar" has no row here: it is changed in Prospecção.
    expect(screen.queryByRole('button', { name: 'Revogar (todos os canais)' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Revogar (WhatsApp)' }));
    fireEvent.change(screen.getByLabelText(/Motivo/), { target: { value: 'Voltou a falar' } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirmar revogação' }));
    expect(revoke).toHaveBeenCalledWith(
      { channel: 'whatsapp', reason: 'Voltou a falar' },
      expect.anything(),
    );
  });
});
