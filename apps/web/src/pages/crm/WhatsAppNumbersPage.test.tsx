import type { WaFailedEvent, WaNumber, WaNumbersView } from '@wings/shared';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WhatsAppNumbersPage } from './WhatsAppNumbersPage.js';

/**
 * CRM Vendas → WhatsApp → Números: the registry (owner, department, eligibility, the phone
 * checks), the token's end, the connection through Meta's window only for a confirmed number, and
 * the webhook bodies the queue gave up on. Made-up numbers only.
 */

const fb = { init: vi.fn(), login: vi.fn() };
const runEmbeddedSignup = vi.fn();
vi.mock('../../lib/embedded-signup.js', () => ({
  loadFacebookSdk: () => Promise.resolve(fb),
  runEmbeddedSignup: (...args: unknown[]) => runEmbeddedSignup(...args) as unknown,
}));

let view: WaNumbersView;
let failed: WaFailedEvent[] = [];
const connect = vi.fn();
const retry = vi.fn();
const register = vi.fn();
const update = vi.fn();
const retryEvent = vi.fn();
const renew = vi.fn();
vi.mock('../../api/whatsapp-numbers.js', () => ({
  useWhatsAppNumbers: () => ({ isLoading: false, isError: false, isSuccess: true, data: view }),
  useConnectWhatsAppNumber: () => ({ mutateAsync: connect }),
  useRetryWhatsAppNumber: () => ({ mutate: retry, isPending: false, isError: false }),
  useRenewWhatsAppNumber: () => ({ mutate: renew, isPending: false }),
  useRegisterWhatsAppNumber: () => ({ mutateAsync: register, isPending: false }),
  useUpdateWhatsAppNumber: () => ({ mutateAsync: update, isPending: false }),
  useFailedWebhookEvents: () => ({
    isLoading: false,
    isError: false,
    isSuccess: true,
    data: { events: failed },
  }),
  useRetryWebhookEvent: () => ({ mutate: retryEvent, isPending: false, isError: false }),
}));

const DAY = 86_400_000;
const number = (extra: Partial<WaNumber> = {}): WaNumber => ({
  id: 'n1',
  phone: '5521999990000',
  label: 'Comercial Teste',
  sector: 'comercial',
  eligibility: 'confirmado',
  eligibilityNotes: null,
  checks: ['app', 'work', 'phone', 'history'],
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
  tokenExpiresAt: new Date(Date.now() + 50 * DAY).toISOString(),
  tokenRenewTriedAt: null,
  tokenRenewError: null,
  disconnectReason: null,
  disconnectedAt: null,
  webhooksSubscribed: true,
  contactsSync: 'requested',
  historySync: 'requested',
  historyProgress: 40,
  syncDeadline: new Date(Date.now() + 3_600_000).toISOString(),
  ...extra,
});

const registered = (extra: Partial<WaNumber> = {}) =>
  number({
    status: 'registered',
    phoneNumberId: null,
    wabaId: null,
    businessId: null,
    displayPhone: null,
    verifiedName: null,
    connectedAt: null,
    tokenExpiresAt: null,
    contactsSync: null,
    historySync: null,
    historyProgress: null,
    syncDeadline: null,
    ...extra,
  });

const signup = { appId: '1579023596665415', configId: '987654321', graphVersion: 'v23.0' };
const people = [
  { id: 'u1', name: 'Fernando Teste' },
  { id: 'u2', name: 'Diretora Teste' },
];

beforeEach(() => {
  view = { signup, missing: [], numbers: [], people };
  failed = [];
  for (const fn of [connect, retry, register, update, retryEvent, renew, runEmbeddedSignup])
    fn.mockReset();
});
afterEach(cleanup);

describe('Números de WhatsApp', () => {
  it('registers a number with its owner, department, eligibility and the phone checks', async () => {
    register.mockResolvedValue({ number: registered() });
    render(<WhatsAppNumbersPage />);
    expect(screen.getByText('Nenhum número cadastrado ainda.')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Nome do número'), {
      target: { value: 'Comercial Teste' },
    });
    fireEvent.change(screen.getByLabelText('Número (DDD + número)'), {
      target: { value: '(21) 99999-0000' },
    });
    fireEvent.change(screen.getByLabelText('Dono do número'), { target: { value: 'u2' } });
    fireEvent.change(screen.getByLabelText('Departamento'), { target: { value: 'diretoria' } });
    fireEvent.click(screen.getByLabelText(/2\.24\.17 ou maior/));
    fireEvent.click(screen.getByLabelText(/Número de trabalho/));
    fireEvent.click(screen.getByRole('button', { name: 'Cadastrar' }));
    await waitFor(() =>
      expect(register).toHaveBeenCalledWith({
        label: 'Comercial Teste',
        phone: '(21) 99999-0000',
        ownerEmployeeId: 'u2',
        sector: 'diretoria',
        eligibility: 'a_confirmar',
        eligibilityNotes: null,
        checks: ['app', 'work'],
      }),
    );
    expect(await screen.findByText('Número cadastrado.')).toBeTruthy();
  });

  it('says which variables are missing, and still registers', () => {
    view = { signup: null, missing: ['WHATSAPP_ES_CONFIG_ID'], numbers: [registered()], people };
    render(<WhatsAppNumbersPage />);
    expect(screen.getByText(/Falta: WHATSAPP_ES_CONFIG_ID/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Conectar/ })).toBeNull();
    expect(screen.getByRole('button', { name: 'Cadastrar' })).toBeTruthy();
  });

  it('shows per number: owner, department, eligibility, checks left, connection and the token’s end', () => {
    view = {
      signup,
      missing: [],
      people,
      numbers: [
        number({ tokenExpiresAt: new Date(Date.now() + 5 * DAY + 3_600_000).toISOString() }),
        registered({
          id: 'n2',
          label: 'Diretoria Teste',
          eligibility: 'a_confirmar',
          eligibilityNotes: 'Número também é o pessoal: falta a autorização do Eric.',
          checks: ['app'],
        }),
        number({
          id: 'n3',
          label: 'Saiu Teste',
          status: 'disconnected',
          disconnectReason: 'PARTNER_REMOVED: PRIMARY_INACTIVITY',
          contactsSync: 'failed',
          historyProgress: 100,
          tokenExpiresAt: null,
        }),
      ],
    };
    render(<WhatsAppNumbersPage />);
    const rows = screen.getAllByRole('row');
    const first = within(rows[1]!);
    expect(first.getByText('Fernando Teste')).toBeTruthy();
    expect(first.getByText('Comercial')).toBeTruthy();
    expect(first.getByText(/vence em .* \(5 dias\)/)).toBeTruthy();
    expect(first.getByText('40%')).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toContain('Comercial Teste');
    const second = within(rows[2]!);
    expect(second.getByText('Cadastrado, não conectado')).toBeTruthy();
    expect(second.getByText(/falta a autorização do Eric/)).toBeTruthy();
    expect(second.getByLabelText('1 de 4 conferidos')).toBeTruthy();
    expect(second.getByText('Falta: celular na hora')).toBeTruthy();
    // A number not confirmed cannot be connected.
    expect(second.queryByRole('button', { name: /Conectar/ })).toBeNull();
    const third = within(rows[3]!);
    expect(third.getByText('PARTNER_REMOVED: PRIMARY_INACTIVITY')).toBeTruthy();
    expect(third.getByText('Completo')).toBeTruthy();
    expect(third.queryByRole('button', { name: 'Tentar de novo' })).toBeNull();
  });

  it('connects a confirmed number through Meta’s window, by its registry id', async () => {
    view = { signup, missing: [], people, numbers: [registered()] };
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
    const button = await screen.findByRole('button', { name: 'Conectar pela Meta' });
    fireEvent.click(button);
    expect(runEmbeddedSignup).toHaveBeenCalledWith(fb, '987654321');
    await waitFor(() =>
      expect(connect).toHaveBeenCalledWith({
        code: 'the-code',
        wabaId: '3100000000000001',
        numberId: 'n1',
      }),
    );
    expect(await screen.findByText(/Contatos e histórico pedidos à Meta/)).toBeTruthy();
  });

  it('a closed window says nothing was connected', async () => {
    view = { signup, missing: [], people, numbers: [registered()] };
    runEmbeddedSignup.mockResolvedValue({ ok: false, reason: 'cancelled', detail: null });
    render(<WhatsAppNumbersPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Conectar pela Meta' }));
    expect(await screen.findByText(/Nada foi conectado/)).toBeTruthy();
    expect(connect).not.toHaveBeenCalled();
  });

  it('"Editar" fills the form; the connected number itself cannot change', async () => {
    view = { signup, missing: [], people, numbers: [number()] };
    update.mockResolvedValue({ number: number() });
    render(<WhatsAppNumbersPage />);
    fireEvent.click(screen.getByRole('button', { name: 'Editar' }));
    const phone = screen.getByLabelText('Número (DDD + número)') as HTMLInputElement;
    expect(phone.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Anotações da checagem'), {
      target: { value: 'Conferido com o dono.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Salvar' }));
    await waitFor(() =>
      expect(update).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'n1', eligibilityNotes: 'Conferido com o dono.' }),
      ),
    );
    expect(update.mock.calls[0]![0]).not.toHaveProperty('phone');
  });

  it('lists the webhook bodies that failed, and sends one back', () => {
    failed = [
      {
        id: 'e1',
        receivedAt: new Date().toISOString(),
        attempts: 5,
        lastError: 'db_40P01',
        hasPayload: true,
      },
      {
        id: 'e2',
        receivedAt: new Date().toISOString(),
        attempts: 5,
        lastError: 'error',
        hasPayload: false,
      },
    ];
    render(<WhatsAppNumbersPage />);
    expect(screen.getByText('db_40P01')).toBeTruthy();
    expect(screen.getByText('Conteúdo já apagado (90 dias)')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Processar de novo' }));
    expect(retryEvent).toHaveBeenCalledWith('e1');
  });
});

describe('the 60-day access', () => {
  it('"Renovar acesso" on a connected number; a refused renewal says so and what to do', async () => {
    view = {
      signup: null,
      missing: [],
      people: [],
      numbers: [
        number({
          tokenExpiresAt: new Date(Date.now() + 5 * DAY).toISOString(),
          tokenRenewError: 'meta_190',
          tokenRenewTriedAt: new Date().toISOString(),
        }),
      ],
    };
    renew.mockImplementation(
      (_id: string, opts: { onSuccess: (answer: { renewed: boolean }) => void }) =>
        opts.onSuccess({ renewed: false }),
    );
    render(<WhatsAppNumbersPage />);
    expect(screen.getByText(/A Meta não renovou \(código 190/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Renovar acesso' }));
    expect(renew).toHaveBeenCalledWith('n1', expect.anything());
    expect(screen.getByRole('status').textContent).toContain('conecte de novo pela Meta');
  });
});
