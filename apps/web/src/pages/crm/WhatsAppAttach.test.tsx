import type { DealWhatsApp, LeadFile } from '@wings/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../api/client.js';
import { WhatsAppChat } from './WhatsAppChat.js';

/**
 * The composer's file and emoji (b3): the file goes up to the deal's Arquivos (`sendLeadFile`,
 * stubbed here) and then by its id to `/whatsapp/media` (a stubbed `fetch`); what it goes as is
 * shown before it goes; a name the deal already has offers the file there or another name; a
 * send that fails after the upload does not upload again; the 📎 is off, with the reason, for a
 * conversation with no deal and for who cannot edit the deal.
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

const sendLeadFile = vi.fn();
vi.mock('../../api/crm.js', async (original) => ({
  ...(await original<typeof import('../../api/crm.js')>()),
  sendLeadFile: (input: unknown) => sendLeadFile(input) as Promise<LeadFile>,
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

const fileOf = (name: string, type: string, size?: number) => {
  const file = new File(['bytes'], name, { type });
  if (size !== undefined) Object.defineProperty(file, 'size', { value: size });
  return file;
};

const choose = (file: File) =>
  fireEvent.change(screen.getByLabelText('Escolher o arquivo'), { target: { files: [file] } });

const leadFile = (fileId: string): LeadFile => ({
  id: `lf-${fileId}`,
  fileId,
  name: 'x',
  mimeType: 'application/pdf',
  byteSize: 5,
  version: 1,
  addedByName: null,
  createdAt: '2026-10-21T15:00:00.000Z',
});

const fetchMock = vi.fn();
const sentBodies = () =>
  fetchMock.mock.calls
    .filter(([url]) => String(url).endsWith('/media'))
    .map(([url, init]) => ({
      url: String(url),
      body: JSON.parse(String((init as RequestInit).body)) as Record<string, unknown>,
    }));
const answer = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

beforeEach(() => {
  state.permissions = { 'leads.whatsapp': 'own', 'leads.write': 'own' };
  sendLeadFile.mockReset();
  fetchMock.mockReset();
  fetchMock.mockImplementation(() => Promise.resolve(answer(201, { message: { id: 'm9' } })));
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('a file in the composer', () => {
  it('a photo goes up to the deal, then by its id with the caption', async () => {
    sendLeadFile.mockResolvedValue(leadFile('f1'));
    show();
    choose(fileOf('fachada.jpg', 'image/jpeg', 40_000));
    expect(screen.getByText('fachada.jpg')).toBeTruthy();
    expect(screen.getByText(/vai como foto/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Legenda'), { target: { value: ' Olha a fachada ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Enviar arquivo' }));

    await waitFor(() => expect(sentBodies()).toHaveLength(1));
    expect(sendLeadFile).toHaveBeenCalledWith(
      expect.objectContaining({ leadId: 'l1', file: expect.any(File) }),
    );
    expect(sentBodies()[0]).toEqual({
      url: '/api/leads/l1/whatsapp/media',
      body: { fileId: 'f1', caption: 'Olha a fachada' },
    });
    await waitFor(() => expect(screen.queryByText('fachada.jpg')).toBeNull());
    expect((screen.getByLabelText('Mensagem') as HTMLTextAreaElement).value).toBe('');
  });

  it('says a photo over 5 MB or another format goes as a document', () => {
    show();
    choose(fileOf('obra.jpg', 'image/jpeg', 6_000_000));
    expect(screen.getByText(/vai como documento: foto acima de 5 MB/)).toBeTruthy();
    choose(fileOf('foto.heic', 'image/heic', 1_000));
    expect(
      screen.getByText(/vai como documento: o WhatsApp só mostra JPG e PNG como foto/),
    ).toBeTruthy();
    choose(fileOf('proposta.pdf', 'application/pdf', 1_000));
    expect(screen.getByText(/vai como documento$/)).toBeTruthy();
  });

  it('a file over 100 MB is refused before anything goes up', () => {
    show();
    choose(fileOf('filme.mp4', 'video/mp4', 150_000_000));
    expect(screen.getByText('filme.mp4: O WhatsApp aceita arquivos de até 100 MB.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Enviar arquivo' })).toBeNull();
    expect(sendLeadFile).not.toHaveBeenCalled();
  });

  it('an audio goes without the caption, and the text stays for the next message', async () => {
    sendLeadFile.mockResolvedValue(leadFile('f2'));
    show();
    fireEvent.change(screen.getByLabelText('Mensagem'), { target: { value: 'Ouça' } });
    choose(fileOf('recado.m4a', 'audio/x-m4a', 1_000));
    expect(screen.getByText(/vai como áudio, sem legenda/)).toBeTruthy();
    expect((screen.getByLabelText('Legenda') as HTMLTextAreaElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Enviar arquivo' }));

    await waitFor(() => expect(sentBodies()).toHaveLength(1));
    expect(sentBodies()[0]!.body).toEqual({ fileId: 'f2' });
    await waitFor(() => expect(screen.queryByText('recado.m4a')).toBeNull());
    expect((screen.getByLabelText('Mensagem') as HTMLTextAreaElement).value).toBe('Ouça');
  });

  it('a name the deal already has: send the file that is there, without going up again', async () => {
    sendLeadFile.mockRejectedValue(
      new ApiError(409, {
        error: 'name_taken',
        message: 'Já existe um arquivo com este nome nesta negociação.',
        existingFileId: 'f9',
      } as never),
    );
    show();
    choose(fileOf('proposta.pdf', 'application/pdf', 1_000));
    fireEvent.click(screen.getByRole('button', { name: 'Enviar arquivo' }));
    await screen.findByText('Já existe um arquivo com este nome nos arquivos da negociação.');
    expect(
      (screen.getByRole('button', { name: 'Enviar arquivo' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    // The refusal is a choice to make, not an error line.
    expect(screen.queryByText('Já existe um arquivo com este nome nesta negociação.')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Enviar o que já está lá' }));
    await waitFor(() => expect(sentBodies()).toHaveLength(1));
    expect(sentBodies()[0]!.body).toEqual({ fileId: 'f9' });
    expect(sendLeadFile).toHaveBeenCalledTimes(1);
  });

  it('a name the deal already has: or send this one with another name', async () => {
    sendLeadFile
      .mockRejectedValueOnce(
        new ApiError(409, { error: 'name_taken', message: 'x', existingFileId: 'f9' } as never),
      )
      .mockResolvedValueOnce(leadFile('f3'));
    show();
    choose(fileOf('proposta.pdf', 'application/pdf', 1_000));
    fireEvent.click(screen.getByRole('button', { name: 'Enviar arquivo' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Enviar com outro nome' }));
    expect((screen.getByLabelText('Novo nome do arquivo') as HTMLInputElement).value).toBe(
      'proposta (2).pdf',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Enviar com este nome' }));

    await waitFor(() => expect(sentBodies()).toHaveLength(1));
    const second = sendLeadFile.mock.calls[1]![0] as { file: File };
    expect(second.file.name).toBe('proposta (2).pdf');
    expect(second.file.type).toBe('application/pdf');
    expect(sentBodies()[0]!.body).toEqual({ fileId: 'f3' });
  });

  it('a send refused after the upload tries again by the id, without going up again', async () => {
    sendLeadFile.mockResolvedValue(leadFile('f4'));
    fetchMock.mockImplementationOnce(() =>
      Promise.resolve(
        answer(409, {
          error: 'window_closed',
          message: 'Fora das 24 horas desde a última mensagem.',
        }),
      ),
    );
    show();
    choose(fileOf('proposta.pdf', 'application/pdf', 1_000));
    fireEvent.click(screen.getByRole('button', { name: 'Enviar arquivo' }));
    await screen.findByText('Fora das 24 horas desde a última mensagem.');
    fireEvent.click(screen.getByRole('button', { name: 'Enviar arquivo' }));

    await waitFor(() => expect(sentBodies()).toHaveLength(2));
    expect(sentBodies()[1]!.body).toEqual({ fileId: 'f4' });
    expect(sendLeadFile).toHaveBeenCalledTimes(1);
  });

  it('by the conversation of a deal, the file still goes to the deal and the send by the conversation', async () => {
    sendLeadFile.mockResolvedValue(leadFile('f5'));
    show(thread(), { conversationId: 'c1' });
    choose(fileOf('proposta.pdf', 'application/pdf', 1_000));
    fireEvent.click(screen.getByRole('button', { name: 'Enviar arquivo' }));
    await waitFor(() => expect(sentBodies()).toHaveLength(1));
    expect(sendLeadFile).toHaveBeenCalledWith(expect.objectContaining({ leadId: 'l1' }));
    expect(sentBodies()[0]!.url).toBe('/api/whatsapp/conversations/c1/media');
  });

  it('a file chosen in one conversation is not there when the next one opens', () => {
    const client = new QueryClient();
    const view = render(
      <QueryClientProvider client={client}>
        <WhatsAppChat thread={{ conversationId: 'c1' }} data={thread()} canSend />
      </QueryClientProvider>,
    );
    choose(fileOf('proposta.pdf', 'application/pdf', 1_000));
    fireEvent.change(screen.getByLabelText('Legenda'), { target: { value: 'Segue' } });
    view.rerender(
      <QueryClientProvider client={client}>
        <WhatsAppChat
          thread={{ conversationId: 'c2' }}
          data={thread({ conversationId: 'c2', leadId: 'l2' })}
          canSend
        />
      </QueryClientProvider>,
    );
    expect(screen.queryByText('proposta.pdf')).toBeNull();
    expect((screen.getByLabelText('Mensagem') as HTMLTextAreaElement).value).toBe('');
  });

  it('a name the deal had but no longer lists: asks for another name, never offers it again', async () => {
    sendLeadFile
      .mockRejectedValueOnce(
        new ApiError(409, { error: 'name_taken', message: 'x', existingFileId: 'f9' } as never),
      )
      .mockResolvedValueOnce(leadFile('f3'));
    fetchMock.mockImplementationOnce(() =>
      Promise.resolve(answer(404, { error: 'file_not_found', message: 'Arquivo não encontrado.' })),
    );
    show();
    choose(fileOf('proposta.pdf', 'application/pdf', 1_000));
    fireEvent.click(screen.getByRole('button', { name: 'Enviar arquivo' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Enviar o que já está lá' }));
    await screen.findByText(/não está mais nos arquivos da negociação/);
    expect(screen.queryByRole('button', { name: 'Enviar o que já está lá' })).toBeNull();
    expect(screen.queryByText('Arquivo não encontrado.')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Enviar com este nome' }));

    await waitFor(() => expect(sentBodies()).toHaveLength(2));
    expect((sendLeadFile.mock.calls[1]![0] as { file: File }).file.name).toBe('proposta (2).pdf');
    expect(sentBodies()[1]!.body).toEqual({ fileId: 'f3' });
  });

  it("a name citing the Wings to a brand's lead: another name, and Enter sends with it", async () => {
    sendLeadFile.mockResolvedValueOnce(leadFile('f1')).mockResolvedValueOnce(leadFile('f2'));
    const refusal =
      'Nesta conversa você fala pelo time de expansão da Marca: o nome do arquivo cita a Wings; envie com outro nome.';
    fetchMock.mockImplementationOnce(() =>
      Promise.resolve(answer(422, { error: 'brand_voice', message: refusal })),
    );
    show(thread({ speaksFor: 'Marca' }));
    choose(fileOf('Apresentacao Wings.pdf', 'application/pdf', 1_000));
    fireEvent.click(screen.getByRole('button', { name: 'Enviar arquivo' }));
    const name = (await screen.findByLabelText('Novo nome do arquivo')) as HTMLInputElement;
    expect(screen.getByText(refusal)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Enviar o que já está lá' })).toBeNull();
    fireEvent.change(name, { target: { value: 'Apresentacao.pdf' } });
    fireEvent.keyDown(name, { key: 'Enter' });

    await waitFor(() => expect(sentBodies()).toHaveLength(2));
    expect((sendLeadFile.mock.calls[1]![0] as { file: File }).file.name).toBe('Apresentacao.pdf');
    expect(sentBodies()[1]!.body).toEqual({ fileId: 'f2' });
  });

  it('a caption over the limit is refused before the file goes up', () => {
    show();
    fireEvent.change(screen.getByLabelText('Mensagem'), { target: { value: 'a'.repeat(1_100) } });
    choose(fileOf('fachada.jpg', 'image/jpeg', 40_000));
    fireEvent.click(screen.getByRole('button', { name: 'Enviar arquivo' }));
    expect(screen.getByText(/Legenda de até 1024 caracteres/)).toBeTruthy();
    expect(sendLeadFile).not.toHaveBeenCalled();
  });

  it('no answer from the server says so in Portuguese, without claiming either way', async () => {
    sendLeadFile.mockResolvedValue(leadFile('f1'));
    fetchMock.mockImplementationOnce(() => Promise.reject(new TypeError('Failed to fetch')));
    show();
    choose(fileOf('proposta.pdf', 'application/pdf', 1_000));
    fireEvent.click(screen.getByRole('button', { name: 'Enviar arquivo' }));
    await screen.findByText(/Sem resposta do servidor/);
    expect(screen.queryByText('Failed to fetch')).toBeNull();
  });

  it('the 📎 is off, with the reason, for a conversation with no deal', () => {
    show(thread({ leadId: null }), { conversationId: 'c1' });
    const attach = screen.getByRole('button', { name: 'Anexar arquivo' });
    expect(attach.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(attach);
    expect(
      screen.getByText(
        'O arquivo fica nos arquivos da negociação: esta conversa ainda não tem negociação.',
      ),
    ).toBeTruthy();
  });

  it('the 📎 is off, with the reason, for who cannot edit the deal', () => {
    state.permissions = { 'leads.whatsapp': 'all' };
    show();
    fireEvent.click(screen.getByRole('button', { name: 'Anexar arquivo' }));
    expect(screen.getByText(/Para anexar, é preciso poder editar a negociação/)).toBeTruthy();
  });
});

describe('emoji in the composer', () => {
  it('puts the emoji where the cursor is; Esc closes the grid', () => {
    show();
    const field = screen.getByLabelText('Mensagem') as HTMLTextAreaElement;
    fireEvent.change(field, { target: { value: 'Oi tudo bem' } });
    field.setSelectionRange(2, 2);
    fireEvent.click(screen.getByRole('button', { name: 'Emojis' }));
    fireEvent.click(screen.getByRole('button', { name: '👋' }));
    expect(field.value).toBe('Oi👋 tudo bem');
    const grid = screen.getByRole('group', { name: 'Escolha um emoji' });
    fireEvent.keyDown(grid, { key: 'Escape' });
    expect(screen.queryByRole('group', { name: 'Escolha um emoji' })).toBeNull();
  });

  it('Esc closes the grid with the focus outside it (on 😊, or on the field)', () => {
    show();
    const button = screen.getByRole('button', { name: 'Emojis' });
    fireEvent.click(button);
    fireEvent.keyDown(button, { key: 'Escape' });
    expect(screen.queryByRole('group', { name: 'Escolha um emoji' })).toBeNull();
    fireEvent.click(button);
    fireEvent.keyDown(screen.getByLabelText('Mensagem'), { key: 'Escape' });
    expect(screen.queryByRole('group', { name: 'Escolha um emoji' })).toBeNull();
  });
});

describe('a work number’s chat (docs/whatsapp/central.md)', () => {
  const number = {
    id: 'n1',
    label: 'Comercial Teste',
    phone: '5521911110000',
    ownerName: 'Fernando',
  };

  it('writes free text and files inside its 24 h, and offers its own templates', () => {
    show(thread({ number }), { conversationId: 'c1' });
    expect(screen.getByRole('button', { name: 'Enviar' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Usar modelo' })).toBeTruthy();
  });

  it("outside its 24 h, picks among that number's own templates (its WABA), never the official ones", async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve(answer(200, { templates: [], configured: true, syncError: null })),
    );
    show(thread({ number, window: { open: false, expiresAt: null } }), { conversationId: 'c1' });
    expect(screen.queryByRole('button', { name: 'Enviar' })).toBeNull();
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(([url]) =>
          String(url).endsWith('/whatsapp/templates?numberId=n1'),
        ),
      ).toBe(true),
    );
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('/whatsapp/templates'))).toBe(
      false,
    );
  });
});
