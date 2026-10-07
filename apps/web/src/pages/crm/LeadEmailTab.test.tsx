import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LeadEmails } from '../../api/lead-email.js';

const state = {
  emails: {
    to: 'paula@exemplo.com.br',
    hidden: false,
    mode: 'gmail',
    from: 'daniele@wingscompany.com.br',
    templates: [{ id: 't1', name: 'Boas-vindas' }],
    sent: [],
  } as LeadEmails,
};

vi.mock('../../api/lead-email.js', () => ({
  useLeadEmails: () => ({ data: state.emails, isPending: false, isError: false }),
  useEmailPreview: () => ({ mutate: vi.fn(), data: null, isPending: false, reset: vi.fn() }),
  useSendEmail: () => ({ mutate: vi.fn(), isPending: false, isSuccess: false, isError: false }),
}));

const { LeadEmailTab } = await import('./LeadEmailTab.js');

afterEach(() => cleanup());

/** The E-mail tab tells where a message leaves from, and sends nothing on a brand-hidden deal. */
describe('LeadEmailTab', () => {
  it('names the sender’s own Gmail address', () => {
    render(<LeadEmailTab leadId="l1" />);
    expect(screen.getByText('daniele@wingscompany.com.br')).toBeTruthy();
    expect(screen.getByText(/a sua conta Google/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Enviar e-mail' })).toBeTruthy();
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
});
