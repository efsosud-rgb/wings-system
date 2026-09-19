import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { SessionUser } from '@wings/shared';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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
  isLastActiveAdminMaster: false,
  createdBy: 'emp-0',
  createdByName: 'Admin Master',
  createdAt: '2026-02-01T12:00:00.000Z',
  lastLoginAt: null,
};

/** The record the edit form loads; tests override fields of it. */
const record: { current: typeof employee } = { current: employee };
const updateEmployee = vi.fn();

vi.mock('../api/employees.js', () => ({
  useEmployee: (id?: string) => ({
    data: id ? { employee: record.current } : undefined,
    isLoading: false,
    isError: false,
  }),
  useCreateEmployee: () => ({ mutateAsync: vi.fn(), error: null }),
  useUpdateEmployee: () => ({ mutateAsync: updateEmployee, error: null }),
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
  record.current = employee;
  updateEmployee.mockReset().mockResolvedValue({ employee });
});

afterEach(() => {
  // vitest runs with globals:false, so testing-library's auto-cleanup is not
  // registered; without this, renders pile up across tests.
  cleanup();
  session.current = null;
  vi.restoreAllMocks();
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

describe('access level on an existing record', () => {
  const roleSelect = () => screen.getByLabelText(/Nível de acesso/i) as HTMLSelectElement;
  const save = () => fireEvent.click(screen.getByRole('button', { name: /Salvar alterações/i }));
  const manager = () =>
    makeUser({
      employeeId: 'emp-1',
      role: 'gerente_comercial',
      sector: 'comercial',
      isSectorManager: true,
      permissions: { 'employees.read': 'sector', 'employees.update': 'sector' },
    });

  it('always selects the current level, even when the viewer cannot change it', async () => {
    // The original bug: editing your own record emptied the select, the form
    // failed validation on "role" and nothing could be saved.
    session.current = manager();
    record.current = { ...employee, role: 'gerente_comercial', sector: 'comercial' };
    renderForm('/funcionarios/emp-1');

    await waitFor(() => expect(roleSelect().value).toBe('gerente_comercial'));
    expect(roleSelect().disabled).toBe(true);
    expect(screen.getByText('Você não pode alterar o próprio nível de acesso.')).toBeTruthy();
  });

  it('saves without changing the level, and leaves the level out of the request', async () => {
    session.current = manager();
    record.current = { ...employee, role: 'gerente_comercial', sector: 'comercial' };
    renderForm('/funcionarios/emp-1');
    await waitFor(() => expect(roleSelect().value).toBe('gerente_comercial'));

    fireEvent.change(screen.getByLabelText('Cargo'), { target: { value: 'Gerente Regional' } });
    save();

    await waitFor(() => expect(updateEmployee).toHaveBeenCalledTimes(1));
    const payload = updateEmployee.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(payload.cargo).toBe('Gerente Regional');
    expect(payload).not.toHaveProperty('role');
  });

  it('locks the last Admin Master on Admin Master, with the reason', async () => {
    session.current = makeUser({
      employeeId: 'emp-1',
      permissions: { 'employees.read': 'all', 'employees.update': 'all' },
    });
    record.current = { ...employee, role: 'admin_master', isLastActiveAdminMaster: true };
    renderForm('/funcionarios/emp-1');

    await waitFor(() => expect(roleSelect().value).toBe('admin_master'));
    expect(roleSelect().disabled).toBe(true);
    expect(
      screen.getByText('Único Admin Master do sistema — não pode ser rebaixado.'),
    ).toBeTruthy();
  });

  it('lets an Admin Master change their own level when another one exists', async () => {
    session.current = makeUser({
      employeeId: 'emp-1',
      permissions: { 'employees.read': 'all', 'employees.update': 'all' },
    });
    record.current = { ...employee, role: 'admin_master' };
    renderForm('/funcionarios/emp-1');

    await waitFor(() => expect(roleSelect().value).toBe('admin_master'));
    expect(roleSelect().disabled).toBe(false);
  });

  it('tells a viewer whose profile cannot change this level', async () => {
    session.current = makeUser({
      role: 'marketing',
      sector: 'marketing',
      permissions: { 'employees.read': 'sector' },
    });
    renderForm('/funcionarios/emp-1');

    await waitFor(() => expect(roleSelect().value).toBe('marketing'));
    expect(roleSelect().disabled).toBe(true);
    expect(screen.getByText('Seu perfil não pode alterar este nível.')).toBeTruthy();
    expect(
      (screen.getByRole('button', { name: /Salvar alterações/i }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it('offers RH/DP every level but Admin Master and Diretoria', async () => {
    session.current = makeUser({
      role: 'rh_dp',
      permissions: { 'employees.read': 'all', 'employees.update': 'all' },
    });
    renderForm('/funcionarios/emp-1');

    await waitFor(() => expect(roleSelect().value).toBe('marketing'));
    const values = Array.from(roleSelect().options).map((option) => option.value);
    expect(values).toContain('rh_dp');
    expect(values).not.toContain('diretoria');
    expect(values).not.toContain('admin_master');
    expect(values).not.toContain('');
  });

  it('locks a Diretoria record for RH/DP and says who assigns that level', async () => {
    session.current = makeUser({
      role: 'rh_dp',
      permissions: { 'employees.read': 'all', 'employees.update': 'all' },
    });
    record.current = { ...employee, role: 'diretoria', sector: 'diretoria' };
    renderForm('/funcionarios/emp-1');

    await waitFor(() => expect(roleSelect().value).toBe('diretoria'));
    expect(roleSelect().disabled).toBe(true);
    expect(
      screen.getByText('Diretoria é atribuída pela própria Diretoria ou pelo Admin Master.'),
    ).toBeTruthy();
    // The rest of the record is still RH/DP's to edit.
    expect((screen.getByLabelText('Cargo') as HTMLInputElement).disabled).toBe(false);
  });

  it('gives Diretoria the level and nothing else, and sends only the level', async () => {
    session.current = makeUser({ role: 'diretoria', permissions: { 'employees.read': 'all' } });
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderForm('/funcionarios/emp-1');

    await waitFor(() => expect(roleSelect().value).toBe('marketing'));
    expect((screen.getByLabelText('Cargo') as HTMLInputElement).disabled).toBe(true);
    expect(roleSelect().disabled).toBe(false);

    fireEvent.change(roleSelect(), { target: { value: 'vendedor_expansao' } });
    save();

    await waitFor(() => expect(updateEmployee).toHaveBeenCalledTimes(1));
    expect(updateEmployee.mock.calls[0]?.[0]).toEqual({ role: 'vendedor_expansao' });
  });

  it('asks before a demotion and does nothing when the answer is no', async () => {
    session.current = makeUser({
      permissions: { 'employees.read': 'all', 'employees.update': 'all' },
    });
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    renderForm('/funcionarios/emp-1');
    await waitFor(() => expect(roleSelect().value).toBe('marketing'));

    fireEvent.change(roleSelect(), { target: { value: 'vendedor_expansao' } });
    save();

    await waitFor(() => expect(confirm).toHaveBeenCalledTimes(1));
    expect(confirm.mock.calls[0]?.[0]).toContain('Vendedor Expansão');
    expect(updateEmployee).not.toHaveBeenCalled();
  });

  it('does not ask on a promotion', async () => {
    session.current = makeUser({
      permissions: { 'employees.read': 'all', 'employees.update': 'all' },
    });
    const confirm = vi.spyOn(window, 'confirm');
    renderForm('/funcionarios/emp-1');
    await waitFor(() => expect(roleSelect().value).toBe('marketing'));

    fireEvent.change(roleSelect(), { target: { value: 'diretoria' } });
    save();

    await waitFor(() => expect(updateEmployee).toHaveBeenCalledTimes(1));
    expect(confirm).not.toHaveBeenCalled();
    expect((updateEmployee.mock.calls[0]?.[0] as Record<string, unknown>).role).toBe('diretoria');
  });
});
