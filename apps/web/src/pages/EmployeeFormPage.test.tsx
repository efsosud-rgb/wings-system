import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { SessionUser } from '@wings/shared';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * These tests check what the form *offers*. The API enforces the same rules
 * again on submit, so a tampered form gains nothing — but a form that offers
 * an impossible option is a bug in its own right.
 */

const session: { current: SessionUser | null } = { current: null };

vi.mock('../api/auth.js', () => ({
  useSession: () => ({ data: session.current, isLoading: false }),
  hasPermission: (user: SessionUser | null, permission: string) =>
    Boolean(user?.permissions[permission as keyof SessionUser['permissions']]),
}));

const employee = {
  id: 'emp-1',
  fullName: 'Ana Lima',
  cpfMasked: '***.982.247-**',
  birthDate: '1990-01-10',
  phone: '11999998888',
  email: 'ana@wingscompany.com.br',
  cargo: 'Analista',
  sector: 'marketing',
  role: 'marketing',
  admissionDate: '2026-01-05',
  status: 'active',
  isSectorManager: false,
  createdBy: 'emp-0',
  createdByName: 'Admin Master',
  createdAt: '2026-02-01T12:00:00.000Z',
  lastLoginAt: null,
};

vi.mock('../api/employees.js', () => ({
  useEmployee: (id?: string) => ({
    data: id ? { employee } : undefined,
    isLoading: false,
    isError: false,
  }),
  useCreateEmployee: () => ({ mutateAsync: vi.fn(), error: null }),
  useUpdateEmployee: () => ({ mutateAsync: vi.fn(), error: null }),
  useRevealCpf: () => ({ mutate: vi.fn(), isPending: false, data: undefined, isError: false }),
  useResendInvite: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

const { EmployeeFormPage } = await import('./EmployeeFormPage.js');

function makeUser(overrides: Partial<SessionUser>): SessionUser {
  return {
    employeeId: 'actor-1',
    fullName: 'Quem Edita',
    email: 'actor@wingscompany.com.br',
    cargo: 'Cargo',
    role: 'admin_master',
    sector: 'diretoria',
    isSectorManager: false,
    tracksTime: false,
    permissions: { 'employees.create': 'all', 'employees.read': 'all' },
    lastLoginAt: null,
    sessionExpiresAt: new Date(Date.now() + 3600_000).toISOString(),
    ...overrides,
  };
}

function renderForm(path: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/funcionarios/novo" element={<EmployeeFormPage />} />
          <Route path="/funcionarios/:id" element={<EmployeeFormPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  session.current = makeUser({});
});

afterEach(() => {
  // vitest runs with globals:false, so testing-library's auto-cleanup is not
  // registered; without this, renders pile up across tests.
  cleanup();
  session.current = null;
});

describe('role dropdown', () => {
  it('offers every role to Admin Master when creating', () => {
    renderForm('/funcionarios/novo');
    const select = screen.getByLabelText(/Nível de acesso/i);
    const values = Array.from(select.querySelectorAll('option')).map((o) => o.value);
    expect(values).toContain('diretoria');
    expect(values).toContain('vendedor_expansao');
  });

  it('never offers Admin Master or Diretoria to a sector manager', () => {
    session.current = makeUser({
      role: 'gerente_comercial',
      sector: 'comercial',
      isSectorManager: true,
      permissions: { 'employees.create': 'sector', 'employees.read': 'sector' },
    });
    renderForm('/funcionarios/novo');
    const values = Array.from(
      screen.getByLabelText(/Nível de acesso/i).querySelectorAll('option'),
    ).map((o) => o.value);

    expect(values).not.toContain('admin_master');
    expect(values).not.toContain('diretoria');
    // Nor their own rank.
    expect(values).not.toContain('gerente_comercial');
    expect(values).toContain('vendedor_expansao');
  });
});

describe('sector-manager checkbox', () => {
  it('is shown to Admin Master', () => {
    renderForm('/funcionarios/novo');
    expect(screen.getByText(/É gestor do setor/i)).toBeTruthy();
  });

  it('is hidden from everyone else', () => {
    session.current = makeUser({
      role: 'gerente_comercial',
      sector: 'comercial',
      isSectorManager: true,
      permissions: { 'employees.create': 'sector' },
    });
    renderForm('/funcionarios/novo');
    expect(screen.queryByText(/É gestor do setor/i)).toBeNull();
  });
});

describe('CPF reveal', () => {
  it('offers the reveal button when the viewer holds employees.pii.view', async () => {
    session.current = makeUser({ permissions: { 'employees.pii.view': 'all' } });
    renderForm('/funcionarios/emp-1');
    await waitFor(() => expect(screen.getByRole('button', { name: /Revelar/i })).toBeTruthy());
  });

  it('hides it without the permission, showing only the masked value', async () => {
    session.current = makeUser({ permissions: { 'employees.read': 'all' } });
    renderForm('/funcionarios/emp-1');
    await waitFor(() => expect(screen.getByText(/Dados pessoais/i)).toBeTruthy());
    expect(screen.queryByRole('button', { name: /Revelar/i })).toBeNull();
    // The masked CPF is still visible as the field placeholder.
    expect(screen.getByPlaceholderText('***.982.247-**')).toBeTruthy();
  });

  it('never shows the reveal button while creating (no record yet)', () => {
    session.current = makeUser({ permissions: { 'employees.pii.view': 'all' } });
    renderForm('/funcionarios/novo');
    expect(screen.queryByRole('button', { name: /Revelar/i })).toBeNull();
  });
});

describe('system block', () => {
  it('shows read-only creation data when editing', async () => {
    renderForm('/funcionarios/emp-1');
    await waitFor(() => expect(screen.getByText('Sistema')).toBeTruthy());
    // Scoped to the read-only paragraph: "Admin Master" is also a role option.
    expect(screen.getByText('Admin Master', { selector: 'p' })).toBeTruthy();
    // No password input anywhere: the employee sets their own via the invite.
    // (Matching on the word "senha" would hit the e-mail field's hint text.)
    expect(document.querySelector('input[type="password"]')).toBeNull();
  });

  it('is absent when creating', () => {
    renderForm('/funcionarios/novo');
    expect(screen.queryByText('Sistema')).toBeNull();
  });
});
