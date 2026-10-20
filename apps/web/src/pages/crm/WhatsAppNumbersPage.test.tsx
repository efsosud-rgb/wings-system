import type { WaNumber, WaNumbersView } from '@wings/shared';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WhatsAppNumbersPage } from './WhatsAppNumbersPage.js';

const fb = { init: vi.fn(), login: vi.fn() };
const runEmbeddedSignup = vi.fn();
vi.mock('../../lib/embedded-signup.js', () => ({
  loadFacebookSdk: () => Promise.resolve(fb),
  runEmbeddedSignup: (...args: unknown[]) => runEmbeddedSignup(...args) as unknown,
}));

let view: WaNumbersView;
const connect = vi.fn();
const retry = vi.fn();
vi.mock('../../api/whatsapp-numbers.js', () => ({
  useWhatsAppNumbers: () => ({ isLoading: false, isError: false, isSuccess: true, data: view }),
  useConnectWhatsAppNumber: () => ({ mutateAsync: connect }),
  useRetryWhatsAppNumber: () => ({ mutate: retry, isPending: false, isError: false }),
}));
vi.mock('../../api/leads.js', () => ({
  useSellers: () => ({
    data: {
      sellers: [
        { id: 'u1', name: 'Fernando Teste', role: 'vendedor_expansao', active: true },
        { id: 'u2', name: 'Saiu Teste', role: 'vendedor_expansao', active: false },
      ],
    },
  }),
}));

const number = (extra: Partial<WaNumber> = {}): WaNumber => ({
  id: 'n1',
  phoneNumberId: '4200000000000001',
  wabaId: '3100000000000001',
  businessId: '5300000000000001',
  displayPhone: '+55 21 99999-0000',
  verifiedName: 'Vendedor Teste',
  ownerEmployeeId: 'u1',
  ownerName: 'Fernando Teste',
  status: 'connected',
  connectedAt: new Date().toISOString(),
  connectedByName: 'Admin Teste',
  disconnectReason: null,
  disconnectedAt: null,
  webhooksSubscribed: true,
  contactsSync: 'requested',
  historySync: 'requested',
  historyProgress: 40,
  syncDeadline: new Date(Date.now() + 3_600_000).toISOString(),
  ...extra,
});

const signup = { appId: '1579023596665415', configId: '987654321', graphVersion: 'v23.0' };

beforeEach(() => {
  view = { signup, missing: [], numbers: [] };
  connect.mockReset();
  retry.mockReset();
  runEmbeddedSignup.mockReset();
});
afterEach(cleanup);

describe('Números dos vendedores', () => {
  it('says which variables are missing instead of offering the button', () => {
    view = { signup: null, missing: ['WHATSAPP_ES_CONFIG_ID'], numbers: [] };
    render(<WhatsAppNumbersPage />);
    expect(screen.getByText(/Falta: WHATSAPP_ES_CONFIG_ID/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Conectar pela Meta' })).toBeNull();
    expect(screen.getByText('Nenhum número conectado ainda.')).toBeTruthy();
  });

  it('lists the numbers with the history progress, and "Tentar de novo" only where a step is left', () => {
    view = {
      signup,
      missing: [],
      numbers: [
        number(),
        number({ id: 'n2', contactsSync: 'failed', historySync: null, historyProgress: null }),
        number({
          id: 'n3',
          status: 'disconnected',
          disconnectReason: 'PARTNER_REMOVED: PRIMARY_INACTIVITY',
          contactsSync: null,
          historyProgress: 100,
        }),
      ],
    };
    render(<WhatsAppNumbersPage />);
    expect(screen.getByText('40%')).toBeTruthy();
    expect(screen.getByText('Completo')).toBeTruthy();
    expect(screen.getByText('PARTNER_REMOVED: PRIMARY_INACTIVITY')).toBeTruthy();
    const buttons = screen.getAllByRole('button', { name: 'Tentar de novo' });
    expect(buttons).toHaveLength(1);
    fireEvent.click(buttons[0]!);
    expect(retry).toHaveBeenCalledWith('n2');
  });

  it('connects: the owner first, Meta’s window, then the code goes to the API', async () => {
    runEmbeddedSignup.mockResolvedValue({
      ok: true,
      code: 'the-code',
      wabaId: '3100000000000001',
      phoneNumberId: null,
    });
    connect.mockResolvedValue({
      number: number(),
      steps: { webhooks: 'ok', contacts: 'requested', history: 'requested' },
    });
    render(<WhatsAppNumbersPage />);
    const button = screen.getByRole('button', { name: 'Conectar pela Meta' });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByRole('option', { name: 'Saiu Teste' })).toBeNull();
    fireEvent.change(screen.getByLabelText('Dono do número'), { target: { value: 'u1' } });
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(button);
    expect(runEmbeddedSignup).toHaveBeenCalledWith(fb, '987654321');
    await waitFor(() =>
      expect(connect).toHaveBeenCalledWith({
        code: 'the-code',
        wabaId: '3100000000000001',
        ownerEmployeeId: 'u1',
      }),
    );
    expect(await screen.findByText(/Contatos e histórico pedidos à Meta/)).toBeTruthy();
  });

  it('a closed window says nothing was connected', async () => {
    runEmbeddedSignup.mockResolvedValue({ ok: false, reason: 'cancelled', detail: null });
    render(<WhatsAppNumbersPage />);
    fireEvent.change(screen.getByLabelText('Dono do número'), { target: { value: 'u1' } });
    const button = screen.getByRole('button', { name: 'Conectar pela Meta' });
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(button);
    expect(await screen.findByText(/Nada foi conectado/)).toBeTruthy();
    expect(connect).not.toHaveBeenCalled();
  });
});
