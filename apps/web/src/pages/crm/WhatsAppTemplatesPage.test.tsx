import type { WaManagedTemplate } from '@wings/shared';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../api/client.js';
import { WhatsAppTemplatesPage } from './WhatsAppTemplatesPage.js';

/**
 * CRM Vendas → WhatsApp → Modelos: every template with Meta's status and the reason of a refusal,
 * a new one with each {{n}} said, "Editar texto" only where Meta lets it, and the fields saved
 * apart (they never go back to Meta).
 */

const { state, createMutate, editMutate, fieldsMutate } = vi.hoisted(() => ({
  state: {
    query: {} as Record<string, unknown>,
    createError: null as unknown,
  },
  createMutate: vi.fn(),
  editMutate: vi.fn(),
  fieldsMutate: vi.fn(),
}));

vi.mock('../../api/whatsapp.js', () => ({
  useManagedTemplates: () => state.query,
  useCreateTemplate: () => ({
    mutate: createMutate,
    isPending: false,
    isError: state.createError !== null,
    error: state.createError,
  }),
  useEditTemplate: () => ({ mutate: editMutate, isPending: false, isError: false, error: null }),
  useSaveTemplateFields: () => ({
    mutate: fieldsMutate,
    isPending: false,
    isError: false,
    error: null,
  }),
}));

const template = (over: Partial<WaManagedTemplate> = {}): WaManagedTemplate => ({
  id: 't1',
  name: 'boas_vindas',
  language: 'pt_BR',
  category: 'UTILITY',
  status: 'APPROVED',
  rejectedReason: null,
  body: 'Olá {{1}}, transformar {{2}} em franquia.',
  footer: 'Wings',
  buttons: ['Sim, pode perguntar'],
  header: null,
  callPermission: false,
  paramCount: 2,
  fields: [{ role: 'lead' }, { role: 'company' }],
  syncedAt: '2026-10-26T12:00:00.000Z',
  ...over,
});

const listed = (templates: WaManagedTemplate[], syncError: string | null = null) => {
  state.query = {
    isLoading: false,
    isError: false,
    isSuccess: true,
    data: { templates, syncError, configured: true },
  };
};

beforeEach(() => {
  listed([]);
  state.createError = null;
  createMutate.mockReset();
  editMutate.mockReset();
  fieldsMutate.mockReset();
});
afterEach(cleanup);

describe('WhatsAppTemplatesPage', () => {
  it("shows each status, Meta's reason for a refusal, and what fills each field", () => {
    listed([
      template({ header: 'IMAGE', callPermission: true }),
      template({
        id: 't2',
        name: 'retomar',
        status: 'REJECTED',
        rejectedReason: 'INVALID_FORMAT',
      }),
      template({ id: 't3', name: 'lembrete', status: 'PENDING' }),
    ]);
    render(<WhatsAppTemplatesPage />);
    const approved = screen.getByRole('article', { name: 'Modelo boas_vindas' });
    expect(within(approved).getByText('Aprovado')).toBeTruthy();
    expect(within(approved).getByText(/com arte · pede permissão para ligar/)).toBeTruthy();
    expect(within(approved).getByText(/Empresa do lead · se faltar: sua empresa/)).toBeTruthy();
    expect(within(approved).getByText('Sim, pode perguntar')).toBeTruthy();
    const rejected = screen.getByRole('article', { name: 'Modelo retomar' });
    expect(within(rejected).getByText('Recusado')).toBeTruthy();
    expect(within(rejected).getByText('Motivo da Meta: INVALID_FORMAT')).toBeTruthy();
    expect(within(rejected).getByRole('button', { name: 'Editar texto' })).toBeTruthy();
  });

  it('hides "Editar texto" while Meta reviews a template, but keeps Variáveis', () => {
    listed([template({ status: 'PENDING' })]);
    render(<WhatsAppTemplatesPage />);
    expect(screen.queryByRole('button', { name: 'Editar texto' })).toBeNull();
    expect(screen.getByText('Em análise na Meta: espere a resposta para editar.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Variáveis' })).toBeTruthy();
  });

  it('shows "—" and the reason when the list cannot load, never an empty list', () => {
    state.query = {
      isLoading: false,
      isError: true,
      isSuccess: false,
      error: new ApiError(500, { error: 'internal' }),
      refetch: vi.fn(),
    };
    render(<WhatsAppTemplatesPage />);
    expect(screen.getByRole('alert').textContent).toContain('Não foi possível carregar os modelos');
    expect(screen.queryByText('Nenhum modelo ainda.')).toBeNull();
  });

  it('shows why Meta was not read', () => {
    listed([template()], 'A Meta recusou (código 190).');
    render(<WhatsAppTemplatesPage />);
    expect(screen.getByRole('status').textContent).toBe(
      'A Meta recusou (código 190). A lista abaixo é a da última leitura.',
    );
  });

  it('finds the {{n}} of the text and posts the new template with examples, fields and the call request', () => {
    render(<WhatsAppTemplatesPage />);
    fireEvent.click(screen.getByRole('button', { name: 'Novo modelo' }));
    const form = screen.getByRole('form', { name: 'Novo modelo' });
    fireEvent.change(within(form).getByLabelText(/^Nome \(/), {
      target: { value: 'boas_vindas_2' },
    });
    fireEvent.change(within(form).getByLabelText('Categoria'), { target: { value: 'MARKETING' } });
    fireEvent.change(within(form).getByLabelText(/^Texto da mensagem/), {
      target: { value: 'Olá {{1}}, aqui é {{2}}. Vamos falar de {{3}}?' },
    });
    const examples = within(form).getAllByLabelText(/Exemplo/);
    expect(examples).toHaveLength(3);
    ['Maria', 'Eric', 'Padaria Sol'].forEach((value, i) =>
      fireEvent.change(examples[i]!, { target: { value } }),
    );
    const roles = within(form).getAllByLabelText('O que preenche');
    fireEvent.change(roles[0]!, { target: { value: 'lead' } });
    fireEvent.change(roles[1]!, { target: { value: 'seller' } });
    fireEvent.change(roles[2]!, { target: { value: 'company' } });
    expect((within(form).getAllByLabelText('Texto se faltar')[2] as HTMLInputElement).value).toBe(
      'sua empresa',
    );
    fireEvent.change(within(form).getByLabelText('Botão de resposta 1 (opcional)'), {
      target: { value: 'Prefiro uma ligação' },
    });
    fireEvent.click(within(form).getByLabelText(/Pedir permissão para ligar/));
    expect(within(form).getByLabelText('Prévia da mensagem').textContent).toContain(
      'Olá Maria, aqui é Eric. Vamos falar de Padaria Sol?',
    );
    fireEvent.submit(form);
    expect(createMutate).toHaveBeenCalledWith(
      {
        name: 'boas_vindas_2',
        language: 'pt_BR',
        category: 'MARKETING',
        body: 'Olá {{1}}, aqui é {{2}}. Vamos falar de {{3}}?',
        examples: ['Maria', 'Eric', 'Padaria Sol'],
        fields: [
          { role: 'lead' },
          { role: 'seller' },
          { role: 'company', fallback: 'sua empresa' },
        ],
        footer: '',
        buttons: ['Prefiro uma ligação'],
        callPermission: true,
      },
      expect.anything(),
    );
  });

  it("says the server's reason when the create is refused", () => {
    state.createError = new ApiError(502, {
      error: 'meta_refused',
      message: 'A Meta recusou: modelo com esse nome já existe',
    });
    render(<WhatsAppTemplatesPage />);
    fireEvent.click(screen.getByRole('button', { name: 'Novo modelo' }));
    expect(screen.getByRole('alert').textContent).toBe(
      'A Meta recusou: modelo com esse nome já existe',
    );
  });

  it('edits the words of an approved template, warning that they go back to review', () => {
    listed([template()]);
    render(<WhatsAppTemplatesPage />);
    fireEvent.click(screen.getByRole('button', { name: 'Editar texto' }));
    const form = screen.getByRole('form', { name: 'Editar texto de boas_vindas' });
    expect(within(form).getByText(/editar manda o modelo de volta para a análise/)).toBeTruthy();
    expect(within(form).queryByLabelText(/^Nome \(/)).toBeNull();
    const examples = within(form).getAllByLabelText(/Exemplo/);
    fireEvent.change(examples[0]!, { target: { value: 'Maria' } });
    fireEvent.change(examples[1]!, { target: { value: 'Padaria Sol' } });
    fireEvent.submit(form);
    expect(editMutate).toHaveBeenCalledWith(
      {
        id: 't1',
        body: 'Olá {{1}}, transformar {{2}} em franquia.',
        examples: ['Maria', 'Padaria Sol'],
        fields: [{ role: 'lead' }, { role: 'company', fallback: 'sua empresa' }],
        footer: 'Wings',
        buttons: ['Sim, pode perguntar'],
        callPermission: false,
      },
      expect.anything(),
    );
  });

  it('saves only the fields through their own route', () => {
    listed([template({ status: 'PENDING', fields: [{ role: 'lead' }, { role: 'free' }] })]);
    render(<WhatsAppTemplatesPage />);
    fireEvent.click(screen.getByRole('button', { name: 'Variáveis' }));
    const form = screen.getByRole('form', { name: 'Variáveis de boas_vindas' });
    expect(within(form).getByText('Fica só no sistema: não volta para a Meta.')).toBeTruthy();
    expect(within(form).queryByLabelText(/Exemplo/)).toBeNull();
    fireEvent.change(within(form).getAllByLabelText('Texto se faltar')[0]!, {
      target: { value: 'tudo bem' },
    });
    fireEvent.change(within(form).getByLabelText('Nome do campo'), { target: { value: 'Dia' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Salvar variáveis' }));
    expect(fieldsMutate).toHaveBeenCalledWith(
      {
        id: 't1',
        fields: [
          { role: 'lead', fallback: 'tudo bem' },
          { role: 'free', label: 'Dia' },
        ],
      },
      expect.anything(),
    );
    expect(editMutate).not.toHaveBeenCalled();
  });
});
