import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { Lead, LeadContactChange } from '@wings/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mutate = vi.fn();
const state = { changes: [] as LeadContactChange[] };

vi.mock('../../api/lead-contact.js', () => ({
  useUpdateLeadContact: () => ({ mutate, isPending: false, error: null, reset: vi.fn() }),
  useLeadContactChanges: (_id: string, enabled: boolean) => ({
    isPending: false,
    isError: false,
    data: enabled ? { changes: state.changes } : undefined,
  }),
}));

const { LeadContactEditor } = await import('./LeadContactEditor.js');

afterEach(() => {
  cleanup();
  mutate.mockReset();
  state.changes = [];
});

const lead = {
  id: 'l1',
  name: 'Pessoa Teste',
  phone: '5521987650001',
  email: 'antigo@exemplo.test',
  fields: { instagram: null, website: null },
} as unknown as Lead;

const open = () => fireEvent.click(screen.getByRole('button', { name: 'Editar dados' }));

describe('LeadContactEditor', () => {
  it('sends only what changed, with the mask the person typed', () => {
    render(<LeadContactEditor lead={lead} />);
    open();
    fireEvent.change(screen.getByPlaceholderText('(11) 91234-5678'), {
      target: { value: '(11) 91234-5678' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Salvar' }));
    expect(mutate).toHaveBeenCalledTimes(1);
    expect(mutate.mock.calls[0]![0]).toEqual({ phone: '(11) 91234-5678' });
  });

  it('shows the validation message and sends nothing for an invalid phone or e-mail', () => {
    render(<LeadContactEditor lead={lead} />);
    open();
    fireEvent.change(screen.getByPlaceholderText('(11) 91234-5678'), { target: { value: '123' } });
    fireEvent.click(screen.getByRole('button', { name: 'Salvar' }));
    expect(screen.getByRole('alert').textContent).toMatch(/Telefone inválido/);
    fireEvent.change(screen.getByPlaceholderText('(11) 91234-5678'), {
      target: { value: '(21) 98765-0001' },
    });
    fireEvent.change(screen.getByPlaceholderText('nome@empresa.com.br'), {
      target: { value: 'sem-arroba' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Salvar' }));
    expect(screen.getByRole('alert').textContent).toMatch(/E-mail inválido/);
    expect(mutate).not.toHaveBeenCalled();
  });

  it('does not send when nothing changed', () => {
    render(<LeadContactEditor lead={lead} />);
    open();
    fireEvent.click(screen.getByRole('button', { name: 'Salvar' }));
    expect(screen.getByRole('alert').textContent).toMatch(/Nada para alterar/);
    expect(mutate).not.toHaveBeenCalled();
  });

  it('lists the history with who, when and the value before', () => {
    state.changes = [
      {
        id: 'c1',
        at: '2026-11-04T15:00:00.000Z',
        field: 'phone',
        from: '5521987650001',
        to: '5511912345678',
        actorName: 'Vendedora Teste',
      },
    ];
    render(<LeadContactEditor lead={lead} />);
    fireEvent.click(screen.getByRole('button', { name: 'Histórico dos dados' }));
    const line = screen.getByText(/Vendedora Teste alterou telefone/);
    expect(line.textContent).toContain('(21) 98765-0001');
    expect(line.textContent).toContain('(11) 91234-5678');
  });
});
