import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../api/client.js';
import { CompaniesPage } from './CompaniesPage.js';
import { ContactsPage } from './ContactsPage.js';

/**
 * Contatos and Empresas: a request that failed says why; it never reads as
 * "0 contato(s)", "Nenhuma empresa encontrada." or "não encontrado".
 */

const { answer } = vi.hoisted(() => ({
  answer: {} as Record<'contacts' | 'contact' | 'companies' | 'company', Record<string, unknown>>,
}));

const idle = { mutate: vi.fn(), isPending: false, error: null };
const ok = { isLoading: false, isError: false, isSuccess: true, refetch: vi.fn() };

vi.mock('../../api/auth.js', async () => {
  const actual = await vi.importActual<typeof import('../../api/auth.js')>('../../api/auth.js');
  return {
    ...actual,
    useSession: () => ({
      data: { id: 'e1', role: 'admin', permissions: { 'leads.write': 'all', 'crm.manage': 'all' } },
    }),
  };
});
vi.mock('../../api/crm.js', () => ({
  useContacts: () => ({ ...ok, data: { contacts: [], duplicates: [] }, ...answer.contacts }),
  useContact: () => ({ ...ok, data: { contact: contactOf(), leads: [] }, ...answer.contact }),
  useCreateContact: () => idle,
  useMergeContacts: () => idle,
  useUpdateContact: () => idle,
  useCompanies: () => ({ ...ok, data: { companies: [], duplicates: [] }, ...answer.companies }),
  useCompany: () => ({
    ...ok,
    data: { company: companyOf(), leads: [], contacts: [] },
    ...answer.company,
  }),
  useCreateCompany: () => idle,
  useMergeCompanies: () => idle,
  useUpdateCompany: () => idle,
  useCompanyToClient: () => idle,
}));

const contactOf = () => ({
  id: 'c1',
  name: 'Elena Prado',
  phone: null,
  email: null,
  jobTitle: null,
  companyId: null,
  companyName: null,
  leads: 0,
  openLeads: 0,
});
const companyOf = () => ({
  id: 'k1',
  name: 'Padaria Sol',
  cnpj: null,
  phone: null,
  email: null,
  website: null,
  city: null,
  state: null,
  segment: null,
  clientId: null,
  contacts: 0,
  leads: 0,
  openLeads: 0,
  createdAt: '2026-10-01T12:00:00.000Z',
});

const failed = (error: unknown) => ({
  data: undefined,
  isLoading: false,
  isError: true,
  isSuccess: false,
  error,
  refetch: vi.fn(),
});

const show = (path: string) =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/crm-vendas/contatos" element={<ContactsPage />} />
        <Route path="/crm-vendas/contatos/:id" element={<ContactsPage />} />
        <Route path="/crm-vendas/empresas" element={<CompaniesPage />} />
        <Route path="/crm-vendas/empresas/:id" element={<CompaniesPage />} />
      </Routes>
    </MemoryRouter>,
  );

beforeEach(() => {
  answer.contacts = {};
  answer.contact = {};
  answer.companies = {};
  answer.company = {};
});
afterEach(cleanup);

describe('Contatos', () => {
  it('the list says why, with no "0 contato(s)" and no "Nenhum contato encontrado."', () => {
    answer.contacts = failed(new ApiError(500, {}));
    show('/crm-vendas/contatos');
    expect(screen.getByRole('alert').textContent).toContain(
      'Não foi possível carregar os contatos',
    );
    expect(screen.getByRole('alert').textContent).toContain('erro 500');
    expect(screen.queryByText(/Nenhum contato encontrado/)).toBeNull();
    expect(screen.queryByText(/0 contato/)).toBeNull();
  });

  it('the list still says "Nenhum contato encontrado." when the request succeeded empty', () => {
    show('/crm-vendas/contatos');
    expect(screen.getByText('Nenhum contato encontrado.')).toBeTruthy();
    expect(screen.getByText('0 contato(s)')).toBeTruthy();
  });

  it('the duplicates say why, not "Nenhum duplicado encontrado."', () => {
    answer.contacts = failed(new ApiError(403, {}));
    show('/crm-vendas/contatos');
    fireEvent.click(screen.getByRole('button', { name: 'Possíveis duplicados' }));
    expect(screen.getByRole('alert').textContent).toContain('você não tem permissão');
    expect(screen.queryByText(/Nenhum duplicado encontrado/)).toBeNull();
  });

  it('a contact that did not load says why, not "não encontrado"', () => {
    answer.contact = failed(new ApiError(401, {}));
    show('/crm-vendas/contatos/c1');
    expect(screen.getByRole('alert').textContent).toContain('sua sessão expirou');
    expect(screen.queryByText('Contato não encontrado.')).toBeNull();
  });

  it('a contact that really is missing (404) reads "não foi encontrado"', () => {
    answer.contact = failed(new ApiError(404, {}));
    show('/crm-vendas/contatos/c1');
    expect(screen.getByRole('alert').textContent).toContain('não foi encontrado');
  });
});

describe('Empresas', () => {
  it('the list says why, with no "0 empresa(s)" and no "Nenhuma empresa encontrada."', () => {
    answer.companies = failed(new TypeError('x'));
    show('/crm-vendas/empresas');
    expect(screen.getByRole('alert').textContent).toContain('sem conexão com o servidor');
    expect(screen.queryByText(/Nenhuma empresa encontrada/)).toBeNull();
    expect(screen.queryByText(/0 empresa/)).toBeNull();
  });

  it('the list still says "Nenhuma empresa encontrada." when the request succeeded empty', () => {
    show('/crm-vendas/empresas');
    expect(screen.getByText('Nenhuma empresa encontrada.')).toBeTruthy();
  });

  it('the duplicates say why, not "Nenhuma duplicada encontrada."', () => {
    answer.companies = failed(new ApiError(500, {}));
    show('/crm-vendas/empresas');
    fireEvent.click(screen.getByRole('button', { name: 'Possíveis duplicadas' }));
    expect(screen.getByRole('alert').textContent).toContain('erro 500');
    expect(screen.queryByText(/Nenhuma duplicada encontrada/)).toBeNull();
  });

  it('a company that did not load says why, not "não encontrada"', () => {
    answer.company = failed(new ApiError(500, {}));
    show('/crm-vendas/empresas/k1');
    expect(screen.getByRole('alert').textContent).toContain('Não foi possível carregar a empresa');
    expect(screen.queryByText('Empresa não encontrada.')).toBeNull();
  });
});
