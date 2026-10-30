import { WA_VOICE_MAX_SECONDS, type DealWhatsApp } from '@wings/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WhatsAppChat } from './WhatsAppChat.js';

/**
 * The voice note in the composer, with a fake microphone and a fake MediaRecorder: asked only on
 * the click, the time while it records, listen, delete or send (the recording goes as it is to
 * `…/voice`), the microphone off once done, the limit, and how to let a refused microphone.
 */

const state = vi.hoisted(() => ({
  permissions: { 'leads.whatsapp': 'own', 'leads.write': 'own' } as Record<string, string>,
}));

vi.mock('../../api/auth.js', async (original) => ({
  ...(await original<typeof import('../../api/auth.js')>()),
  useSession: () => ({
    data: { id: 'e1', role: 'vendedor_expansao', permissions: state.permissions },
  }),
}));

vi.mock('../../api/whatsapp.js', async (original) => ({
  ...(await original<typeof import('../../api/whatsapp.js')>()),
  useWhatsAppSoon: () => false,
}));

const thread = (over: Partial<DealWhatsApp> = {}): DealWhatsApp => ({
  conversationId: 'c1',
  leadId: 'l1',
  profileName: 'Elena',
  configured: true,
  calling: false,
  phone: '5521999990001',
  window: { open: true, expiresAt: '2026-10-22T14:00:00.000Z' },
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

const show = (
  data: DealWhatsApp = thread(),
  target: { leadId: string } | { conversationId: string } = { leadId: 'l1' },
) =>
  render(
    <QueryClientProvider client={new QueryClient()}>
      <WhatsAppChat thread={target} data={data} canSend />
    </QueryClientProvider>,
  );

/** The microphone's one track: the test checks it is turned off. */
const track = { stop: vi.fn() };
const getUserMedia = vi.fn();

class FakeRecorder {
  static isTypeSupported = (type: string) => type === 'audio/webm;codecs=opus';
  state: 'inactive' | 'recording' = 'inactive';
  mimeType: string;
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  constructor(_stream: unknown, options: { mimeType?: string }) {
    this.mimeType = options.mimeType ?? '';
  }
  start() {
    this.state = 'recording';
  }
  stop() {
    this.state = 'inactive';
    this.ondataavailable?.({ data: new Blob(['voz fictícia'], { type: this.mimeType }) });
    this.onstop?.();
  }
}

const fetchMock = vi.fn();
const voiceCalls = () => fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/voice'));

beforeEach(() => {
  state.permissions = { 'leads.whatsapp': 'own', 'leads.write': 'own' };
  track.stop.mockReset();
  getUserMedia.mockReset();
  getUserMedia.mockResolvedValue({ getTracks: () => [track] });
  vi.stubGlobal('navigator', { ...navigator, mediaDevices: { getUserMedia } });
  vi.stubGlobal('MediaRecorder', FakeRecorder);
  URL.createObjectURL = vi.fn(() => 'blob:gravacao');
  URL.revokeObjectURL = vi.fn();
  fetchMock.mockReset();
  fetchMock.mockImplementation(() =>
    Promise.resolve(
      new Response(JSON.stringify({ message: { id: 'm9' } }), {
        status: 201,
        headers: { 'content-type': 'application/json' },
      }),
    ),
  );
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const mic = () => screen.getByRole('button', { name: 'Gravar áudio' });

describe('recording a voice note', () => {
  it('asks for the microphone only on the click, records, lets listen, and sends', async () => {
    show();
    expect(getUserMedia).not.toHaveBeenCalled();
    fireEvent.click(mic());
    expect(getUserMedia).toHaveBeenCalledWith({ audio: true });
    expect(await screen.findByText(/Gravando/)).toBeTruthy();
    expect(screen.getByLabelText('Tempo gravado').textContent).toBe('0:00');
    // The field gives way to the recording while it lasts.
    expect(screen.queryByLabelText('Mensagem')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Parar' }));
    expect(track.stop).toHaveBeenCalled();
    expect(screen.getByLabelText('Ouvir a gravação').getAttribute('src')).toBe('blob:gravacao');
    fireEvent.click(screen.getByRole('button', { name: 'Enviar áudio' }));
    await waitFor(() => expect(voiceCalls()).toHaveLength(1));
    const [url, init] = voiceCalls()[0] as [string, RequestInit];
    expect(url).toBe('/api/leads/l1/whatsapp/voice');
    expect(init.method).toBe('POST');
    expect(init.body).toBeInstanceOf(Blob);
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('audio/webm;codecs=opus');
    // Sent: the tray goes, the field comes back, the recording is let go.
    await waitFor(() => expect(screen.queryByLabelText('Ouvir a gravação')).toBeNull());
    expect(screen.getByLabelText('Mensagem')).toBeTruthy();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:gravacao');
  });

  it("sends a work number's chat by the conversation", async () => {
    show(thread({ leadId: 'l1' }), { conversationId: 'c7' });
    fireEvent.click(mic());
    fireEvent.click(await screen.findByRole('button', { name: 'Parar' }));
    fireEvent.click(screen.getByRole('button', { name: 'Enviar áudio' }));
    await waitFor(() => expect(voiceCalls()).toHaveLength(1));
    expect(voiceCalls()[0]![0]).toBe('/api/whatsapp/conversations/c7/voice');
  });

  it('cancels while recording and deletes what was recorded, sending nothing', async () => {
    show();
    fireEvent.click(mic());
    fireEvent.click(await screen.findByRole('button', { name: 'Cancelar' }));
    expect(track.stop).toHaveBeenCalled();
    expect(screen.queryByText(/Gravando/)).toBeNull();
    expect(screen.queryByLabelText('Ouvir a gravação')).toBeNull();
    fireEvent.click(mic());
    fireEvent.click(await screen.findByRole('button', { name: 'Parar' }));
    fireEvent.click(screen.getByRole('button', { name: 'Apagar' }));
    expect(screen.queryByLabelText('Ouvir a gravação')).toBeNull();
    expect(screen.getByLabelText('Mensagem')).toBeTruthy();
    expect(voiceCalls()).toHaveLength(0);
  });

  it('stops on its own at the limit, keeping what was recorded', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    show();
    fireEvent.click(mic());
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByText(/Gravando/)).toBeTruthy();
    act(() => {
      vi.advanceTimersByTime(WA_VOICE_MAX_SECONDS * 1000 + 500);
    });
    expect(track.stop).toHaveBeenCalled();
    expect(screen.getByLabelText('Ouvir a gravação')).toBeTruthy();
    expect(screen.getByText(/^3:00 ·/)).toBeTruthy();
  });

  it('says how to let the microphone when the browser refuses it, and records nothing', async () => {
    getUserMedia.mockRejectedValue(new DOMException('denied', 'NotAllowedError'));
    show();
    fireEvent.click(mic());
    expect((await screen.findByRole('alert')).textContent).toMatch(/cadeado.*Permitir/);
    expect(screen.queryByText(/Gravando/)).toBeNull();
    expect(screen.getByLabelText('Mensagem')).toBeTruthy();
  });

  it('says so when there is no microphone, or the browser cannot record', async () => {
    getUserMedia.mockRejectedValue(new DOMException('none', 'NotFoundError'));
    show();
    fireEvent.click(mic());
    expect((await screen.findByRole('alert')).textContent).toMatch(/Nenhum microfone/);
    cleanup();
    vi.stubGlobal('MediaRecorder', undefined);
    show();
    fireEvent.click(mic());
    expect((await screen.findByRole('alert')).textContent).toMatch(/não grava áudio/);
  });

  it('is off, with the reason, with no deal, for who cannot edit it, and under "não me contate"', () => {
    show(thread({ leadId: null }), { conversationId: 'c1' });
    fireEvent.click(mic());
    expect(
      screen.getByText(/O áudio fica nos arquivos da negociação: esta conversa ainda não tem/),
    ).toBeTruthy();
    cleanup();
    state.permissions = { 'leads.whatsapp': 'all' };
    show();
    fireEvent.click(mic());
    expect(screen.getByText(/Para gravar áudio, é preciso poder editar/)).toBeTruthy();
    cleanup();
    state.permissions = { 'leads.whatsapp': 'own', 'leads.write': 'own' };
    show(
      thread({
        contactBlock: { blocked: true, reason: 'Pediu para não ser contatado', origin: 'crm' },
      }),
    );
    fireEvent.click(mic());
    expect(screen.getByText(/Áudio gravado não vai: Pediu para não ser contatado/)).toBeTruthy();
    expect(getUserMedia).not.toHaveBeenCalled();
  });
});
