import type { LeadFile } from '@wings/shared';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../api/client.js';
import type { LeadEmails } from '../../api/lead-email.js';

const fileOf = (over: Partial<LeadFile> & Pick<LeadFile, 'fileId' | 'name'>): LeadFile => ({
  id: `lf-${over.fileId}`,
  mimeType: 'application/pdf',
  byteSize: 2048,
  version: 1,
  addedByName: null,
  createdAt: '2026-10-30T12:00:00.000Z',
  ...over,
});

const base: LeadEmails = {
  to: 'paula@exemplo.com.br',
  addresses: [
    { email: 'paula@exemplo.com.br', name: 'Paula', primary: true },
    { email: 'socio@exemplo.com.br', name: 'Sócio', primary: false },
  ],
  hidden: false,
  blocked: null,
  mode: 'gmail',
  from: 'daniele@wingscompany.com.br',
  templates: [{ id: 't1', name: 'Boas-vindas' }],
  sent: [],
  received: [],
  mailRead: 'on',
};

const state = {
  // What the query answers instead of its default (a failed request).
  query: {} as Record<string, unknown>,
  emails: base,
  files: [] as LeadFile[],
  send: vi.fn(),
  preview: vi.fn(),
  upload: vi.fn(),
};

vi.mock('../../api/lead-email.js', () => ({
  useLeadEmails: () => ({ data: state.emails, isPending: false, isError: false, ...state.query }),
  useEmailPreview: () => ({ mutate: state.preview, isError: false, reset: vi.fn() }),
  useSendEmail: () => ({
    mutate: state.send,
    reset: vi.fn(),
    isPending: false,
    isSuccess: false,
    isError: false,
  }),
}));
vi.mock('../../api/crm.js', () => ({
  useLeadFiles: () => ({ data: state.files, isError: false }),
  useSendLeadFile: () => ({ mutateAsync: state.upload }),
}));

const { LeadEmailTab } = await import('./LeadEmailTab.js');

beforeEach(() => {
  state.send = vi.fn();
  state.preview = vi.fn();
  state.upload = vi.fn();
});

afterEach(() => {
  cleanup();
  state.query = {};
  state.emails = base;
  state.files = [];
});

const form = () => within(screen.getByRole('form', { name: 'Escrever e-mail' }));
const type = (label: string, value: string) =>
  fireEvent.change(form().getByLabelText(label), { target: { value } });

/** "Escrever e-mail" on the deal: opens at once, attaches, sends; nothing on a brand-hidden deal. */
describe('LeadEmailTab', () => {
  it('opens on the writing, to the main contact, with the cursor in the subject', () => {
    render(<LeadEmailTab leadId="l1" />);
    expect(screen.getByText('daniele@wingscompany.com.br')).toBeTruthy();
    expect(screen.getByText(/a sua conta Google/)).toBeTruthy();
    const to = form().getByLabelText<HTMLSelectElement>('Para');
    expect(to.value).toBe('paula@exemplo.com.br');
    expect(within(to).getAllByRole('option')).toHaveLength(2);
    expect(document.activeElement).toBe(form().getByLabelText('Assunto'));
    const button = form().getByRole<HTMLButtonElement>('button', { name: 'Enviar e-mail' });
    expect(button.disabled).toBe(true);
  });

  it('attaches the deal’s files with name and size, takes one out, and sends the rest', () => {
    state.files = [
      fileOf({ fileId: 'f1', name: 'proposta.pdf' }),
      fileOf({ fileId: 'f2', name: 'tabela.pdf', byteSize: 1024 * 1024 }),
    ];
    render(<LeadEmailTab leadId="l1" />);
    const pick = form().getByLabelText('Anexar dos Arquivos da negociação');
    fireEvent.change(pick, { target: { value: 'f1' } });
    fireEvent.change(pick, { target: { value: 'f2' } });
    const list = form().getByRole('list', { name: 'Anexos' });
    expect(list.textContent).toContain('proposta.pdf · 2');
    expect(list.textContent).toContain('tabela.pdf · 1');
    fireEvent.click(form().getByRole('button', { name: 'Tirar proposta.pdf' }));
    expect(list.textContent).not.toContain('proposta.pdf');

    fireEvent.change(form().getByLabelText('Para'), { target: { value: 'socio@exemplo.com.br' } });
    type('Assunto', 'Proposta');
    type('Texto', 'Segue a tabela.');
    fireEvent.click(form().getByRole('button', { name: 'Enviar e-mail' }));
    expect(state.send).toHaveBeenCalledWith(
      {
        to: 'socio@exemplo.com.br',
        subject: 'Proposta',
        text: 'Segue a tabela.',
        templateId: null,
        fileIds: ['f2'],
        replyToId: null,
      },
      expect.anything(),
    );
  });

  it('attaches a file from the computer through the deal’s files', async () => {
    state.upload = vi.fn(async ({ file }: { file: File }) =>
      fileOf({ fileId: 'f9', name: file.name, byteSize: file.size }),
    );
    render(<LeadEmailTab leadId="l1" />);
    const file = new File(['%PDF-1.4'], 'contrato.pdf', { type: 'application/pdf' });
    fireEvent.change(form().getByLabelText('Anexar do computador'), {
      target: { files: [file] },
    });
    await waitFor(() =>
      expect(form().getByRole('list', { name: 'Anexos' }).textContent).toContain('contrato.pdf'),
    );
    expect(state.upload).toHaveBeenCalledTimes(1);
  });

  it('refuses a program from the computer before it is stored anywhere', () => {
    render(<LeadEmailTab leadId="l1" />);
    const file = new File(['MZ'], 'instalar.exe', { type: 'application/octet-stream' });
    fireEvent.change(form().getByLabelText('Anexar do computador'), {
      target: { files: [file] },
    });
    expect(screen.getByText(/instalar\.exe: Programas e scripts não vão como anexo/)).toBeTruthy();
    expect(state.upload).not.toHaveBeenCalled();
  });

  it('refuses a deal’s file that would pass 20 MB together', () => {
    state.files = [fileOf({ fileId: 'f1', name: 'video.pdf', byteSize: 21 * 1024 * 1024 })];
    render(<LeadEmailTab leadId="l1" />);
    fireEvent.change(form().getByLabelText('Anexar dos Arquivos da negociação'), {
      target: { value: 'f1' },
    });
    expect(screen.getByText(/video\.pdf não cabe/)).toBeTruthy();
    expect(form().queryByRole('list', { name: 'Anexos' })).toBeNull();
  });

  it('takes no 11th attachment, from the deal’s files or the computer, and says why', async () => {
    state.files = Array.from({ length: 11 }, (_, i) =>
      fileOf({ fileId: `f${i + 1}`, name: `doc${i + 1}.pdf`, byteSize: 1024 }),
    );
    render(<LeadEmailTab leadId="l1" />);
    const pick = form().getByLabelText('Anexar dos Arquivos da negociação');
    for (let i = 1; i <= 11; i++) fireEvent.change(pick, { target: { value: `f${i}` } });
    const list = form().getByRole('list', { name: 'Anexos' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(10);
    expect(list.textContent).not.toContain('doc11.pdf');
    expect(screen.getByText(/Um e-mail leva até 10 anexos/)).toBeTruthy();
    expect(screen.getByText(/10 de 10 anexos/)).toBeTruthy();
    // From the computer neither: refused before it is stored in the deal's files.
    fireEvent.change(form().getByLabelText('Anexar do computador'), {
      target: { files: [new File(['%PDF-1.4'], 'extra.pdf', { type: 'application/pdf' })] },
    });
    await waitFor(() => expect(screen.getByText(/Um e-mail leva até 10 anexos/)).toBeTruthy());
    expect(state.upload).not.toHaveBeenCalled();
    expect(within(list).getAllByRole('listitem')).toHaveLength(10);
  });

  it('starts from a template: its text fills the fields, which stay editable', () => {
    state.preview = vi.fn((_id: string, options: { onSuccess: (f: object) => void }) =>
      options.onSuccess({ subject: 'Olá, Paula', body: 'Oi Paula.' }),
    );
    render(<LeadEmailTab leadId="l1" />);
    fireEvent.change(form().getByLabelText('Começar de um modelo'), { target: { value: 't1' } });
    expect(form().getByLabelText<HTMLInputElement>('Assunto').value).toBe('Olá, Paula');
    type('Texto', 'Oi Paula, editado.');
    fireEvent.click(form().getByRole('button', { name: 'Enviar e-mail' }));
    expect(state.send).toHaveBeenCalledWith(
      expect.objectContaining({ templateId: 't1', text: 'Oi Paula, editado.' }),
      expect.anything(),
    );
  });

  it('shows what was sent, with who it went to and the attachments', () => {
    state.emails = {
      ...base,
      sent: [
        {
          id: 'o1',
          subject: 'Proposta',
          body: 'Segue.',
          mode: 'gmail',
          status: 'sent',
          at: '2026-10-30T12:00:00.000Z',
          templateName: null,
          sentByName: 'Daniele',
          fromEmail: 'daniele@wingscompany.com.br',
          toEmail: 'socio@exemplo.com.br',
          attachments: [{ fileId: 'f1', name: 'proposta.pdf', byteSize: 2048 }],
          conversation: 't:thr1',
        },
      ],
    };
    render(<LeadEmailTab leadId="l1" />);
    expect(screen.getByText(/Proposta · .* · Daniele · Enviado · 1 anexo/)).toBeTruthy();
    expect(screen.getByText('Para: socio@exemplo.com.br')).toBeTruthy();
    expect(screen.getByText(/Anexos: proposta\.pdf \(2/)).toBeTruthy();
  });

  it('shows the lead’s reply in the conversation of the e-mail sent, and answers it there', () => {
    state.emails = {
      ...base,
      sent: [
        {
          id: 'o1',
          subject: 'Proposta',
          body: 'Segue.',
          mode: 'gmail',
          status: 'sent',
          at: '2026-10-30T12:00:00.000Z',
          templateName: null,
          sentByName: 'Daniele',
          fromEmail: 'daniele@wingscompany.com.br',
          toEmail: 'paula@exemplo.com.br',
          attachments: [],
          conversation: 't:thr1',
        },
        {
          id: 'o2',
          subject: 'Outro assunto',
          body: 'Outro.',
          mode: 'gmail',
          status: 'sent',
          at: '2026-10-30T09:00:00.000Z',
          templateName: null,
          sentByName: 'Daniele',
          fromEmail: 'daniele@wingscompany.com.br',
          toEmail: 'paula@exemplo.com.br',
          attachments: [],
          conversation: 't:thr0',
        },
      ],
      received: [
        {
          id: 'r1',
          fromName: 'Paula',
          fromEmail: 'paula@exemplo.com.br',
          subject: 'Re: Proposta',
          body: 'Gostei, vamos conversar.',
          at: '2026-10-30T13:00:00.000Z',
          attachments: [
            { fileId: 'f9', name: 'contrato.pdf', byteSize: 2048, refused: null },
            { fileId: null, name: 'setup.exe', byteSize: 10, refused: 'file_type' },
          ],
          conversation: 't:thr1',
          mailboxName: 'Daniele',
        },
      ],
    };
    render(<LeadEmailTab leadId="l1" />);
    const conversations = within(screen.getByRole('list', { name: 'Conversas' }))
      .getAllByRole('listitem')
      .filter((li) => li.querySelector('strong'));
    // The conversation with the reply is on top, the reply under the e-mail it answers.
    expect(conversations[0]!.querySelector('strong')!.textContent).toBe('Conversa: Proposta');
    expect(
      within(conversations[0]!).getByText(/Re: Proposta · .* · Recebido de Paula/),
    ).toBeTruthy();
    expect(within(conversations[0]!).getByText('Gostei, vamos conversar.')).toBeTruthy();
    expect(
      within(conversations[0]!).getByText(
        /contrato\.pdf \(2.*setup\.exe .* não guardado: programa/,
      ),
    ).toBeTruthy();
    expect(conversations[1]!.querySelector('strong')!.textContent).toBe('Conversa: Outro assunto');

    fireEvent.click(screen.getByRole('button', { name: 'Responder' }));
    expect(screen.getByText(/Respondendo a “Re: Proposta”/)).toBeTruthy();
    type('Texto', 'Combinado.');
    fireEvent.submit(screen.getByRole('form', { name: 'Escrever e-mail' }));
    expect(state.send).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'paula@exemplo.com.br',
        subject: 'Re: Proposta',
        replyToId: 'r1',
      }),
      expect.anything(),
    );
  });

  it('asks a person connected before the reading to connect again', () => {
    state.emails = { ...base, mailRead: 'reconnect' };
    render(<LeadEmailTab leadId="l1" />);
    expect(
      screen.getByText(/Reconecte sua conta Google para receber os e-mails dos leads/),
    ).toBeTruthy();
  });

  it('a "não me contate" by e-mail disables the send and says why', () => {
    state.emails = {
      ...base,
      blocked: 'Pediu para não ser contatado (e-mail; registrado no CRM).',
    };
    render(<LeadEmailTab leadId="l1" />);
    type('Assunto', 'Oi');
    type('Texto', 'Texto');
    const button = screen.getByRole<HTMLButtonElement>('button', { name: 'Enviar e-mail' });
    expect(button.disabled).toBe(true);
    expect(screen.getByText(/Não me contate: Pediu para não ser contatado \(e-mail/)).toBeTruthy();
  });

  it('shows the brand rule instead of the writing on an Expansão deal with a brand', () => {
    state.emails = { ...base, hidden: true };
    render(<LeadEmailTab leadId="l1" />);
    const rule = screen.getByTestId('brand-rule');
    expect(rule.textContent).toContain('não recebe e-mail da Wings');
    expect(rule.querySelector('a')?.getAttribute('href')).toBe(
      '/crm-vendas/negociacoes/l1/whatsapp',
    );
    expect(screen.queryByRole('form', { name: 'Escrever e-mail' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Enviar e-mail|Registrar e-mail/ })).toBeNull();
  });

  it('says why the e-mails did not load, with no form and no "sem e-mail" claim', () => {
    state.query = {
      data: undefined,
      isError: true,
      error: new ApiError(500, {}),
      refetch: vi.fn(),
    };
    render(<LeadEmailTab leadId="l1" />);
    expect(screen.getByRole('alert').textContent).toContain('Não foi possível carregar os e-mails');
    expect(screen.getByRole('alert').textContent).toContain('erro 500');
    expect(screen.queryByRole('button', { name: /Enviar e-mail|Registrar e-mail/ })).toBeNull();
    expect(screen.queryByText(/não tem e-mail/)).toBeNull();
  });

  it('keeps the writing and adds the reason when only a refresh failed', () => {
    state.query = { isError: true, error: new TypeError('x'), refetch: vi.fn() };
    render(<LeadEmailTab leadId="l1" />);
    expect(screen.getByRole('alert').textContent).toContain('sem conexão com o servidor');
    expect(screen.getByRole('button', { name: 'Enviar e-mail' })).toBeTruthy();
  });
});
