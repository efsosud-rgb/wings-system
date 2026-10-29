import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../api/client.js';
import type { LeadEmails } from '../../api/lead-email.js';

const state = {
  // What the query answers instead of its default (a failed request).
  query: {} as Record<string, unknown>,
  emails: {
    to: 'paula@exemplo.com.br',
    hidden: false,
    blocked: null,
    mode: 'gmail',
    from: 'daniele@wingscompany.com.br',
    templates: [{ id: 't1', name: 'Boas-vindas' }],
    sent: [],
  } as LeadEmails,
};

vi.mock('../../api/lead-email.js', () => ({
  useLeadEmails: () => ({ data: state.emails, isPending: false, isError: false, ...state.query }),
  useEmailPreview: () => ({ mutate: vi.fn(), data: null, isPending: false, reset: vi.fn() }),
  useSendEmail: () => ({ mutate: vi.fn(), isPending: false, isSuccess: false, isError: false }),
}));

const { LeadEmailTab } = await import('./LeadEmailTab.js');

afterEach(() => {
  cleanup();
  state.query = {};
});

/** The E-mail tab tells where a message leaves from, and sends nothing on a brand-hidden deal. */
describe('LeadEmailTab', () => {
  it('names the sender’s own Gmail address', () => {
    render(<LeadEmailTab leadId="l1" />);
    expect(screen.getByText('daniele@wingscompany.com.br')).toBeTruthy();
    expect(screen.getByText(/a sua conta Google/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Enviar e-mail' })).toBeTruthy();
  });

  it('a "não me contate" by e-mail disables the send and says why', () => {
    const before = state.emails;
    state.emails = {
      ...before,
      blocked: 'Pediu para não ser contatado (e-mail; registrado no CRM).',
    };
    render(<LeadEmailTab leadId="l1" />);
    const button = screen.getByRole<HTMLButtonElement>('button', { name: 'Enviar e-mail' });
    expect(button.disabled).toBe(true);
    expect(screen.getByText(/Não me contate: Pediu para não ser contatado \(e-mail/)).toBeTruthy();
    state.emails = before;
  });

  it('shows the brand rule instead of the form on an Expansão deal with a brand', () => {
    state.emails = { ...state.emails, hidden: true };
    render(<LeadEmailTab leadId="l1" />);
    const rule = screen.getByTestId('brand-rule');
    expect(rule.textContent).toContain('não recebe e-mail da Wings');
    expect(rule.querySelector('a')?.getAttribute('href')).toBe(
      '/crm-vendas/negociacoes/l1/whatsapp',
    );
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

  it('keeps the form and adds the reason when only a refresh failed', () => {
    state.emails = { ...state.emails, hidden: false };
    state.query = { isError: true, error: new TypeError('x'), refetch: vi.fn() };
    render(<LeadEmailTab leadId="l1" />);
    expect(screen.getByRole('alert').textContent).toContain('sem conexão com o servidor');
    expect(screen.getByRole('button', { name: 'Enviar e-mail' })).toBeTruthy();
  });
});
