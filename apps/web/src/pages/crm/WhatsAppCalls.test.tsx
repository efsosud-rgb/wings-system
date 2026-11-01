import type { DealWhatsApp, WaCall, WaCallPermissionLive } from '@wings/shared';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../api/client.js';
import {
  WhatsAppCallProvider,
  WhatsAppCallSection,
  useWhatsAppCallCenter,
} from './WhatsAppCalls.js';

/**
 * The call center: a ringing call offered to pick up (pickup → the browser's
 * answer → accept), a call placed from a deal (the browser's offer out),
 * hanging up; and the deal panel's WhatsApp part: off, asking permission,
 * calling. The audio and the API are simulated.
 */

const { state, calls, media } = vi.hoisted(() => ({
  state: {
    ringing: { calling: true, calls: [] as WaCall[] },
    thread: null as DealWhatsApp | null,
    threadQuery: {} as Record<string, unknown>,
    permission: null as WaCallPermissionLive | null,
    askMutate: (() => undefined) as (...args: unknown[]) => void,
    callRequestPreview: {} as Record<string, unknown>,
    previewEnabled: [] as boolean[],
  },
  calls: {
    start: vi.fn(),
    get: vi.fn(),
    connected: vi.fn(),
    pickup: vi.fn(),
    accept: vi.fn(),
    reject: vi.fn(),
    hangup: vi.fn(),
  },
  media: { order: [] as string[] },
}));

vi.mock('../../api/auth.js', async () => {
  const actual = await vi.importActual<typeof import('../../api/auth.js')>('../../api/auth.js');
  return {
    ...actual,
    useSession: () => ({
      data: {
        id: 'e1',
        fullName: 'Eric',
        role: 'vendedor_formatacao',
        permissions: { 'leads.whatsapp': 'own' },
      },
    }),
  };
});

vi.mock('../../api/whatsapp.js', () => ({
  useRingingCalls: () => ({ data: state.ringing }),
  useWhatsAppThread: () => ({ data: state.thread, ...state.threadQuery }),
  useCallPermission: () => ({ data: state.permission, error: null }),
  useRequestCallPermission: () => ({
    mutate: state.askMutate,
    reset: () => undefined,
    isPending: false,
    isSuccess: false,
    error: null,
  }),
  useCallRequestPreview: (_leadId: string, enabled: boolean) => {
    state.previewEnabled.push(enabled);
    return enabled ? state.callRequestPreview : { data: undefined, error: null };
  },
  whatsappCalls: calls,
}));

vi.mock('../../lib/whatsapp-call.js', () => ({
  MicrophoneError: class extends Error {},
  openCallMedia: async () => {
    media.order.push('media');
    return {
      pc: { connectionState: 'new' },
      setMuted: vi.fn(),
      close: () => media.order.push('close'),
    };
  },
  makeOffer: async () => {
    media.order.push('offer');
    return 'v=0 offer';
  },
  answerOffer: async (_m: unknown, offer: string) => {
    media.order.push(`answer:${offer}`);
    return 'v=0 answer';
  },
  applyAnswer: async () => undefined,
}));

const ringingCall: WaCall = {
  id: 'c1',
  direction: 'in',
  status: 'ringing',
  leadId: 'l1',
  name: 'Elena Prado',
  phone: '5521999990001',
  answerSdp: null,
  error: null,
  startedAt: new Date().toISOString(),
  connectedAt: null,
  endedAt: null,
  durationSeconds: null,
};

const thread = (over: Partial<DealWhatsApp> = {}): DealWhatsApp => ({
  conversationId: null,
  leadId: 'l1',
  profileName: 'Elena',
  configured: true,
  calling: true,
  phone: '5521999990001',
  window: { open: true, expiresAt: new Date(Date.now() + 3_600_000).toISOString() },
  optedOut: false,
  contactBlock: { blocked: false, reason: null, origin: null },
  callBlock: { blocked: false, reason: null, origin: null },
  callPermission: { status: null, expiresAt: null, requestedAt: null },
  attendance: null,
  speaksFor: null,
  number: null,
  numberChats: [],
  messages: [],
  ...over,
});

beforeEach(() => {
  media.order.length = 0;
  Object.values(calls).forEach((fn) => fn.mockReset());
  calls.get.mockResolvedValue({ call: { ...ringingCall, status: 'accepted' } });
  calls.hangup.mockResolvedValue({
    call: { ...ringingCall, status: 'completed', endedAt: new Date().toISOString() },
  });
  calls.reject.mockResolvedValue({ call: ringingCall });
  state.ringing = { calling: true, calls: [] };
  state.thread = thread();
  state.threadQuery = {};
  state.permission = null;
});
afterEach(cleanup);

function Section() {
  const center = useWhatsAppCallCenter();
  return center ? (
    <WhatsAppCallSection
      center={center}
      leadId="l1"
      name="Elena Prado"
      phone="5521999990001"
      onCalling={() => undefined}
    />
  ) : null;
}

describe('the call center', () => {
  it('offers a ringing call and picks it up: offer from the server, the browser answers, then accept', async () => {
    state.ringing = { calling: true, calls: [ringingCall] };
    calls.pickup.mockResolvedValue({ offerSdp: 'v=0 offer-from-phone', call: ringingCall });
    calls.accept.mockResolvedValue({ call: { ...ringingCall, status: 'accepted' } });
    render(
      <WhatsAppCallProvider>
        <div />
      </WhatsAppCallProvider>,
    );
    expect(screen.getByRole('alert').textContent).toContain('Elena Prado');
    fireEvent.click(screen.getByRole('button', { name: 'Atender' }));
    await waitFor(() => expect(calls.accept).toHaveBeenCalledWith('c1', 'v=0 answer'));
    expect(calls.pickup).toHaveBeenCalledWith('c1');
    expect(media.order).toEqual(['media', 'answer:v=0 offer-from-phone']);
    expect(screen.getByText(/Recebida pelo WhatsApp/)).toBeTruthy();
  });

  it('declines a ringing call', () => {
    state.ringing = { calling: true, calls: [ringingCall] };
    render(
      <WhatsAppCallProvider>
        <div />
      </WhatsAppCallProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Recusar' }));
    expect(calls.reject).toHaveBeenCalledWith('c1');
  });

  it('places a call with the browser offer and hangs it up', async () => {
    state.permission = {
      status: 'temporary',
      expiresAt: null,
      requestedAt: null,
      canCall: true,
      canRequest: false,
    };
    calls.start.mockResolvedValue({
      call: { ...ringingCall, id: 'c2', direction: 'out', status: 'dialing' },
    });
    render(
      <WhatsAppCallProvider>
        <Section />
      </WhatsAppCallProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: /Ligar pelo WhatsApp/ }));
    await waitFor(() => expect(calls.start).toHaveBeenCalledWith('l1', 'v=0 offer'));
    expect(screen.getByText(/Feita pelo WhatsApp/)).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Desligar' }));
    });
    expect(calls.hangup).toHaveBeenCalledWith('c2');
    await waitFor(() => expect(media.order).toContain('close'));
  });
});

describe('the WhatsApp part of the call panel', () => {
  it('says when calling is off for the number', () => {
    state.thread = thread({ calling: false });
    render(
      <WhatsAppCallProvider>
        <Section />
      </WhatsAppCallProvider>,
    );
    expect(
      screen.getByText('As ligações ainda não estão ligadas neste número do WhatsApp.'),
    ).toBeTruthy();
    expect(
      (screen.getByRole('button', { name: /Ligar pelo WhatsApp/ }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it('without permission, keeps calling off and asks for it inside the window', () => {
    const ask = vi.fn();
    state.askMutate = ask;
    state.permission = {
      status: 'no_permission',
      expiresAt: null,
      requestedAt: null,
      canCall: false,
      canRequest: true,
    };
    render(
      <WhatsAppCallProvider>
        <Section />
      </WhatsAppCallProvider>,
    );
    expect(screen.getByText('Sem permissão para ligar')).toBeTruthy();
    expect(
      (screen.getByRole('button', { name: /Ligar pelo WhatsApp/ }) as HTMLButtonElement).disabled,
    ).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Pedir permissão para ligar' }));
    expect(ask).toHaveBeenCalled();
  });

  it('outside the window sends by the template, after its preview', () => {
    const ask = vi.fn();
    state.askMutate = ask;
    state.thread = thread({ window: { open: false, expiresAt: null } });
    state.permission = {
      status: 'no_permission',
      expiresAt: null,
      requestedAt: null,
      canCall: false,
      canRequest: true,
    };
    state.previewEnabled = [];
    state.callRequestPreview = {
      data: {
        preview: {
          family: 'wings_formatacao_pedir_ligacao',
          version: 'wings_formatacao_pedir_ligacao',
          language: 'pt_BR',
          category: 'MARKETING',
          sendAs: 'template',
          charged: true,
          reason: null,
          windowExpiresAt: null,
          text: 'Olá, Elena! Aqui é Eric, da Wings Company. Posso te ligar por aqui?',
          footer: null,
          buttons: [],
          withArt: false,
          notices: [],
          fields: [
            { index: 1, role: 'lead', label: 'Nome do lead', value: 'Elena', locked: false },
            { index: 2, role: 'seller', label: 'Seu nome', value: 'Eric', locked: false },
          ],
          usesCompanyArticle: false,
          ready: true,
        },
      },
      error: null,
    };
    render(
      <WhatsAppCallProvider>
        <Section />
      </WhatsAppCallProvider>,
    );
    expect(screen.queryByRole('button', { name: 'Pedir permissão para ligar' })).toBeNull();
    // Nothing is asked of the server before the click.
    expect(state.previewEnabled.every((enabled) => !enabled)).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Pedir pelo modelo' }));
    expect(screen.getByLabelText('Prévia da mensagem').textContent).toContain('da Wings Company');
    expect(screen.getByText(/cobrado pela Meta/)).toBeTruthy();
    expect(ask).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Enviar pedido' }));
    expect(ask).toHaveBeenCalledWith(
      {
        template: {
          params: ['Elena', 'Eric'],
          expect: { sendAs: 'template', charged: true },
        },
      },
      expect.anything(),
    );
  });

  it('outside the window, says why when the template cannot go (not approved yet)', () => {
    state.thread = thread({ window: { open: false, expiresAt: null } });
    state.permission = null;
    state.callRequestPreview = {
      data: undefined,
      error: new ApiError(422, {
        error: 'template_unknown',
        message:
          'O modelo de pedido de ligação ainda não foi aprovado pela Meta. Nada foi enviado.',
      }),
    };
    render(
      <WhatsAppCallProvider>
        <Section />
      </WhatsAppCallProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Pedir pelo modelo' }));
    expect(screen.getByText(/ainda não foi aprovado pela Meta/)).toBeTruthy();
    expect(
      (screen.getByRole('button', { name: 'Enviar pedido' }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it('says why, and does not stay on "Carregando…", when the conversation did not load', () => {
    state.thread = null;
    state.threadQuery = {
      isError: true,
      error: new ApiError(500, {}),
      refetch: vi.fn(),
    };
    render(
      <WhatsAppCallProvider>
        <Section />
      </WhatsAppCallProvider>,
    );
    expect(screen.getByRole('alert').textContent).toContain(
      'Não foi possível carregar as ligações pelo WhatsApp',
    );
    expect(screen.getByRole('alert').textContent).toContain('erro 500');
    expect(screen.queryByText('Carregando…')).toBeNull();
    expect(
      (screen.getByRole('button', { name: /Ligar pelo WhatsApp/ }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });
});
