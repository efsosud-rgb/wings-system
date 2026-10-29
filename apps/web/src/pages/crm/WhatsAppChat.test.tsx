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

describe('what the balloon shows', () => {
  it('a reply shows the quoted message at the top, and "—" with the reason when it is not here', () => {
    show([
      message({
        id: 'r1',
        text: 'Pode ser na terça',
        replyTo: {
          found: true,
          id: 'q1',
          direction: 'out',
          kind: 'text',
          text: 'Qual dia fica bom?',
        },
      }),
      message({
        id: 'r2',
        text: 'Gostei desta',
        replyTo: { found: true, id: 'q2', direction: 'in', kind: 'image', text: null },
      }),
      message({ id: 'r3', text: 'Isso', replyTo: { found: false } }),
    ]);

    const [first, second, third] = screen.getAllByRole('listitem');
    expect(within(first!).getByText('Equipe')).toBeTruthy();
    expect(within(first!).getByText('Qual dia fica bom?')).toBeTruthy();
    expect(within(first!).getByText('Pode ser na terça')).toBeTruthy();
    // A quoted file with no caption is named by its kind.
    expect(within(second!).getByText('Cliente')).toBeTruthy();
    expect(within(second!).getByText('Imagem')).toBeTruthy();
    expect(
      within(third!).getByText(
        '— A mensagem respondida não está aqui: é de antes de o número entrar no sistema, está em outra negociação desta pessoa, ou ficou só no celular.',
      ),
    ).toBeTruthy();
    expect(within(third!).getByText('Isso')).toBeTruthy();
  });
});

describe('reactions', () => {
  it('shows on its balloon; one whose message is not on the list stays a line, "—" when not here', () => {
    show([
      message({
        id: 't1',
        direction: 'out',
        text: 'Mandei o contrato',
        reactions: [{ emoji: '❤️', direction: 'in' }],
      }),
      message({
        id: 'x1',
        kind: 'reaction',
        text: '❤️',
        reactionTo: { found: true, id: 't1', direction: 'out', kind: 'text', text: 'Mandei' },
      }),
      message({
        id: 'x2',
        kind: 'reaction',
        text: '👍',
        reactionTo: { found: true, id: 'older', direction: 'out', kind: 'document', text: null },
      }),
      message({
        id: 'x3',
        kind: 'reaction',
        text: null,
        reactionTo: { found: true, id: 'older2', direction: 'out', kind: 'text', text: 'Proposta' },
      }),
      message({ id: 'x4', kind: 'reaction', text: '🙏', reactionTo: { found: false } }),
    ]);

    expect(screen.getByRole('img', { name: 'Reação do cliente: ❤️' })).toBeTruthy();
    // x1 is on the balloon of t1, both on this list: no line of its own.
    const items = screen.getAllByRole('listitem');
    expect(items).toHaveLength(4);
    expect(items[1]?.textContent).toMatch(/^Cliente reagiu com 👍 a: Documento/);
    expect(items[2]?.textContent).toMatch(/^Cliente tirou a reação de: Proposta/);
    expect(items[3]?.textContent).toMatch(
      /^Cliente reagiu com 🙏\. — A mensagem da reação não está aqui: é de antes/,
    );
  });
});

describe('contact cards', () => {
  it('shows each name and number, and "—" with the reason for what is missing', () => {
    show([
      message({
        id: 'c1',
        kind: 'contacts',
        text: 'Contador Fictício',
        contacts: [
          { name: 'Contador Fictício', phones: ['+55 21 98888-0001', '5521988880002'] },
          { name: null, phones: [] },
        ],
      }),
      message({ id: 'c2', kind: 'contacts', text: 'Cartão antigo', contacts: null }),
      message({ id: 'c3', kind: 'contacts', text: null, contacts: [] }),
    ]);

    const [card, old, empty] = screen.getAllByRole('listitem');
    // The name shows once, in the card, not again as the text.
    expect(within(card!).getAllByText('Contador Fictício')).toHaveLength(1);
    expect(within(card!).getByText('+55 21 98888-0001')).toBeTruthy();
    expect(within(card!).getByText('(21) 98888-0002')).toBeTruthy();
    expect(within(card!).getByText('— Sem nome no cartão')).toBeTruthy();
    expect(within(card!).getByText('— Sem número no cartão.')).toBeTruthy();
    expect(within(old!).getByText('Cartão antigo')).toBeTruthy();
    expect(
      within(old!).getByText(/^— Cartão de contato sem o número: chegou antes de o sistema/),
    ).toBeTruthy();
    expect(within(empty!).getByText(/^— Cartão de contato vazio/)).toBeTruthy();
  });

  it('leaves a card from the phone export to its "Do celular" tag', () => {
    show([
      message({
        kind: 'contacts',
        text: null,
        imported: { file: 'Contador.vcf', omitted: false },
      }),
    ]);

    expect(
      screen.getByText('Do celular · Contato Contador.vcf, dentro do arquivo exportado'),
    ).toBeTruthy();
    expect(screen.queryByText(/Cartão de contato/)).toBeNull();
  });
});

describe('locations', () => {
  it('shows the place with a map link, and "—" with the reason when there is no point', () => {
    show([
      message({
        id: 'p1',
        kind: 'location',
        text: 'Loja Fictícia',
        location: {
          latitude: -22.9068,
          longitude: -43.1729,
          name: 'Loja Fictícia',
          address: 'Rua Exemplo, 100',
        },
      }),
      message({
        id: 'p2',
        kind: 'location',
        text: 'Sem ponto',
        location: { latitude: null, longitude: null, name: null, address: 'Sem ponto' },
      }),
    ]);

    const [shop, nowhere] = screen.getAllByRole('listitem');
    expect(within(shop!).getAllByText('Loja Fictícia')).toHaveLength(1);
    expect(within(shop!).getByText('Rua Exemplo, 100')).toBeTruthy();
    const link = within(shop!).getByRole('link', { name: 'Abrir no mapa' });
    expect(link.getAttribute('href')).toBe(
      'https://www.google.com/maps/search/?api=1&query=-22.9068,-43.1729',
    );
    expect(link.getAttribute('rel')).toBe('noreferrer');
    expect(within(nowhere!).getByText('Localização')).toBeTruthy();
    expect(within(nowhere!).getByText('Sem ponto')).toBeTruthy();
    expect(within(nowhere!).queryByRole('link')).toBeNull();
    expect(
      within(nowhere!).getByText('— Sem o ponto no mapa: o WhatsApp não mandou as coordenadas.'),
    ).toBeTruthy();
  });
});

describe('the day marks', () => {
  it('puts the day over the first message of each day, across an older page too', async () => {
    const day = (d: number, h: number) => new Date(2026, 8, d, h, 0).toISOString();
    const shown = [
      ...run('new', WA_MESSAGES_PAGE - 1, Date.parse(day(10, 10))),
      message({ id: 'late', text: 'outro dia', at: day(11, 9) }),
    ];
    const older = [message({ id: 'old', text: 'bem antes', at: day(9, 8) })];
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ messages: older }), { status: 200 }));
    show(shown);
    const marks = () => screen.getAllByRole('separator').map((li) => li.textContent);
    expect(marks()).toEqual(['10/09/2026', '11/09/2026']);

    fireEvent.click(screen.getByRole('button', { name: 'Mostrar mensagens anteriores' }));
    await screen.findByText('bem antes');
    expect(marks()).toEqual(['09/09/2026', '10/09/2026', '11/09/2026']);
    // A mark is not a message: the balloons are counted as before.
    expect(
      screen.getAllByRole('listitem').filter((li) => li.className.includes('crm-wa-bubble')),
    ).toHaveLength(WA_MESSAGES_PAGE + 1);
  });
});

describe('a message stored late', () => {
  it('brings its day back where it sits, with no key repeated', () => {
    const day = (d: number, h: number) => new Date(2025, 9, d, h, 0).toISOString();
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    show([
      message({ id: 'a', text: 'segunda', at: day(19, 9) }),
      // Meta delivered it late (the server was down): stored after, sent the day before.
      message({ id: 'b', text: 'domingo', at: day(18, 22) }),
      message({ id: 'c', text: 'segunda de novo', at: day(19, 10) }),
    ]);
    expect(screen.getAllByRole('separator').map((li) => li.textContent)).toEqual([
      '19/10/2025',
      '18/10/2025',
      '19/10/2025',
    ]);
    expect(errors.mock.calls.some((call) => String(call[0]).includes('same key'))).toBe(false);
    errors.mockRestore();
  });
});
