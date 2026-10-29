import { WA_MESSAGES_PAGE, type DealWhatsApp, type WaMessage } from '@wings/shared';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WhatsAppChat } from './WhatsAppChat.js';

// The seller's lock (B1) reads the session; these tests are about the bubbles, so it stays open.
vi.mock('../../api/whatsapp.js', async (original) => ({
  ...(await original<typeof import('../../api/whatsapp.js')>()),
  useWhatsAppSoon: () => false,
}));

/**
 * The bubbles of a conversation brought in from the phone ("Do celular", the media that stayed
 * inside the exported file, no delivery status of ours) and the older pages of a long thread.
 * The real API module runs against a stubbed `fetch`.
 */

const message = (over: Partial<WaMessage> = {}): WaMessage => ({
  id: 'm1',
  direction: 'in',
  kind: 'text',
  text: 'Oi',
  media: null,
  template: null,
  fromTemplate: null,
  withArt: false,
  status: null,
  error: null,
  authorName: null,
  bySofia: false,
  imported: null,
  at: '2026-10-07T14:00:00.000Z',
  ...over,
});

const thread = (messages: WaMessage[]): DealWhatsApp => ({
  conversationId: null,
  leadId: 'l1',
  profileName: 'Elena',
  configured: true,
  calling: false,
  phone: '5521999990001',
  window: { open: false, expiresAt: null },
  optedOut: false,
  contactBlock: { blocked: false, reason: null, origin: null },
  callBlock: { blocked: false, reason: null, origin: null },
  callPermission: { status: null, expiresAt: null, requestedAt: null },
  attendance: null,
  speaksFor: null,
  messages,
});

const show = (
  messages: WaMessage[],
  target: { leadId: string } | { conversationId: string } = { leadId: 'l1' },
) => render(<WhatsAppChat thread={target} data={thread(messages)} canSend={false} />);

/** `count` text messages one minute apart, ids `<prefix>-0001`..., oldest first. */
const run = (prefix: string, count: number, start = Date.parse('2026-10-01T10:00:00.000Z')) =>
  Array.from({ length: count }, (_, i) =>
    message({
      id: `${prefix}-${String(i + 1).padStart(4, '0')}`,
      text: `${prefix} ${i + 1}`,
      at: new Date(start + i * 60_000).toISOString(),
    }),
  );

const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('a message imported from the phone', () => {
  it('tags an incoming photo line as "Do celular" with its file name inside the exported file', () => {
    show([
      message({
        kind: 'image',
        text: null,
        imported: { file: 'IMG-20261001-WA0004.jpg', omitted: false },
      }),
    ]);

    expect(
      screen.getByText('Do celular · Imagem IMG-20261001-WA0004.jpg, dentro do arquivo exportado'),
    ).toBeTruthy();
    // The file is inside the .zip kept in Arquivos: no link to open here, and no placeholder text.
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.queryByText('Imagem')).toBeNull();
  });

  it('says the media did not come in the export', () => {
    show([message({ kind: 'audio', text: null, imported: { file: null, omitted: true } })]);

    expect(screen.getByText('Do celular · mídia que não veio na exportação')).toBeTruthy();
    expect(screen.queryByText('Áudio')).toBeNull();
  });

  it('tags a plain text line with just "Do celular" and keeps its text', () => {
    show([message({ text: 'Quero saber da franquia', imported: { file: null, omitted: false } })]);

    expect(screen.getByText('Do celular')).toBeTruthy();
    expect(screen.getByText('Quero saber da franquia')).toBeTruthy();
  });

  it('shows no delivery status on an imported outgoing line, only on one we sent', () => {
    show([
      message({
        id: 'imp',
        direction: 'out',
        text: 'Segue o catálogo',
        status: null,
        authorName: null,
        imported: { file: null, omitted: false },
      }),
      message({
        id: 'sent',
        direction: 'out',
        text: 'Olá!',
        status: 'sent',
        authorName: 'Eric Souza',
        at: '2026-10-07T14:05:00.000Z',
      }),
    ]);

    const [imported, ours] = screen.getAllByRole('listitem');
    expect(imported?.textContent).toContain('Do celular');
    expect(imported?.textContent).not.toMatch(/Enviada|Enviando|Entregue|Lida|Não enviada/);
    expect(imported?.className).toContain('is-out');
    expect(ours?.textContent).toContain('Enviada');
  });
});

describe('older messages of a long thread', () => {
  it('offers nothing when the thread is shorter than a page', () => {
    show(run('m', WA_MESSAGES_PAGE - 1));

    expect(screen.queryByRole('button', { name: 'Mostrar mensagens anteriores' })).toBeNull();
  });

  it('offers nothing for a conversation no deal took yet', () => {
    show(run('m', WA_MESSAGES_PAGE), { conversationId: 'c1' });

    expect(screen.queryByRole('button', { name: 'Mostrar mensagens anteriores' })).toBeNull();
  });

  it('asks for the page before the first message on screen and shows it above', async () => {
    const shown = run('new', WA_MESSAGES_PAGE, Date.parse('2026-10-10T10:00:00.000Z'));
    const older = run('old', 3);
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ messages: older }), { status: 200 }));
    show(shown);

    fireEvent.click(screen.getByRole('button', { name: 'Mostrar mensagens anteriores' }));

    await screen.findByText('old 1');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/leads/l1/whatsapp/messages?before=new-0001');
    const bubbles = screen
      .getAllByRole('listitem')
      .filter((li) => li.className.includes('crm-wa-bubble'));
    expect(bubbles).toHaveLength(WA_MESSAGES_PAGE + 3);
    expect(bubbles.slice(0, 3).map((li) => li.textContent)).toEqual([
      expect.stringContaining('old 1'),
      expect.stringContaining('old 2'),
      expect.stringContaining('old 3'),
    ]);
    expect(within(bubbles[3]!).getByText('new 1')).toBeTruthy();
    // A short page was the start of the chat: the button is gone.
    expect(screen.queryByRole('button', { name: 'Mostrar mensagens anteriores' })).toBeNull();
  });

  it('keeps asking, from the oldest one loaded, while the pages come full', async () => {
    const shown = run('new', WA_MESSAGES_PAGE, Date.parse('2026-10-10T10:00:00.000Z'));
    const page1 = run('mid', WA_MESSAGES_PAGE, Date.parse('2026-10-05T10:00:00.000Z'));
    const page2 = run('old', 2);
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({ messages: page1 }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ messages: page2 }), { status: 200 }));
    show(shown);

    fireEvent.click(screen.getByRole('button', { name: 'Mostrar mensagens anteriores' }));
    await screen.findByText('mid 1');
    fireEvent.click(await screen.findByRole('button', { name: 'Mostrar mensagens anteriores' }));
    await screen.findByText('old 1');

    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
      '/api/leads/l1/whatsapp/messages?before=new-0001',
      '/api/leads/l1/whatsapp/messages?before=mid-0001',
    ]);
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Mostrar mensagens anteriores' })).toBeNull(),
    );
  });

  it('shows the reason when the older page cannot be read and lets the person try again', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: 'server_error', message: 'Falha no servidor.' }), {
        status: 500,
      }),
    );
    show(run('new', WA_MESSAGES_PAGE));

    fireEvent.click(screen.getByRole('button', { name: 'Mostrar mensagens anteriores' }));

    await screen.findByText('Falha no servidor.');
    expect(
      (screen.getByRole('button', { name: 'Mostrar mensagens anteriores' }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
  });
});
