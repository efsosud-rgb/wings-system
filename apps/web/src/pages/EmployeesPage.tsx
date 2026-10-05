import {
  EMPLOYEE_STATUS,
  ROLES,
  SECTORS,
  type EmployeeStatus,
  type EmployeeView,
  type SectorSlug,
} from '@wings/shared';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { hasPermission, useSession } from '../api/auth.js';
import { useEmployees } from '../api/employees.js';
import { SectorSelect } from '../components/SectorSelect.js';
import { Alert, Button, Input, Select } from '../components/ui.js';
import { PageHeader } from '../components/PageHeader.js';

const STATUS_LABEL: Record<EmployeeStatus, string> = {
  active: 'Ativo',
  inactive: 'Inativo',
  on_leave: 'Afastado',
};

function formatPhone(digits: string): string {
  if (digits.length === 11)
    return `(${digits.slice(0, 2)}) ${digits.slice(2, 7)}-${digits.slice(7)}`;
  if (digits.length === 10)
    return `(${digits.slice(0, 2)}) ${digits.slice(2, 6)}-${digits.slice(6)}`;
  return digits;
}

function formatDateTime(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
}

export function EmployeesPage() {
  const { data: user } = useSession();
  const [search, setSearch] = useState('');
  const [sector, setSector] = useState<SectorSlug | ''>('');
  const [status, setStatus] = useState<EmployeeStatus | ''>('');
  const [page, setPage] = useState(1);

  const list = useEmployees({
    search: search.trim() || undefined,
    sector: sector || undefined,
    status: status || undefined,
    page,
    pageSize: 20,
  });

  const canCreate = hasPermission(user, 'employees.create');
  const total = list.data?.total ?? 0;
  const pageSize = list.data?.pageSize ?? 20;
  const lastPage = Math.max(1, Math.ceil(total / pageSize));

  return (
    <>
      <PageHeader
        title="Usuários e acessos"
        subtitle={`${total} ${total === 1 ? 'funcionário' : 'funcionários'} no seu escopo de acesso`}
        actions={
          canCreate && (
            <Link to="/administracao/usuarios/novo" className="btn btn-primary btn-inline">
              Novo funcionário
            </Link>
          )
        }
      />

      <section className="filters">
        <Input
          type="search"
          placeholder="Buscar por nome, e-mail ou cargo"
          value={search}
          onChange={(event) => {
            setSearch(event.target.value);
            setPage(1);
          }}
        />
        <SectorSelect
          value={sector}
          onChange={(event) => {
            setSector(event.target.value as SectorSlug | '');
            setPage(1);
          }}
        >
          <option value="">Todos os setores</option>
        </SectorSelect>
        <Select
          value={status}
          onChange={(event) => {
            setStatus(event.target.value as EmployeeStatus | '');
            setPage(1);
          }}
        >
          <option value="">Todos os status</option>
          {EMPLOYEE_STATUS.map((value) => (
            <option key={value} value={value}>
              {STATUS_LABEL[value]}
            </option>
          ))}
        </Select>
      </section>

      {list.isError && <Alert kind="error">Não foi possível carregar a lista.</Alert>}

      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>Nome</th>
              <th>CPF</th>
              <th>Cargo</th>
              <th>Setor</th>
              <th>Nível de acesso</th>
              <th>Status</th>
              <th>Último acesso</th>
            </tr>
          </thead>
          <tbody>
            {list.isLoading && (
              <tr>
                <td colSpan={7} className="muted">
                  Carregando…
                </td>
              </tr>
            )}
            {list.data?.employees.length === 0 && (
              <tr>
                <td colSpan={7} className="muted">
                  Nenhum funcionário encontrado.
                </td>
              </tr>
            )}
            {list.data?.employees.map((employee: EmployeeView) => (
              <tr key={employee.id}>
                <td>
                  <Link to={`/administracao/usuarios/${employee.id}`}>{employee.fullName}</Link>
                  <div className="cell-sub">{employee.email}</div>
                </td>
                {/* Always masked in listings; the full value needs an explicit,
                    audited reveal on the record itself. */}
                <td className="mono">{employee.cpfMasked}</td>
                <td>
                  {employee.cargo}
                  <div className="cell-sub">{formatPhone(employee.phone)}</div>
                </td>
                <td>
                  {SECTORS[employee.sector].name}
                  {employee.isSectorManager && <span className="tag">gestor</span>}
                </td>
                <td>{ROLES[employee.role].name}</td>
                <td>
                  <span className={`status status-${employee.status}`}>
                    {STATUS_LABEL[employee.status]}
                  </span>
                </td>
                <td className="muted">{formatDateTime(employee.lastLoginAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {lastPage > 1 && (
        <nav className="pagination">
          <Button variant="ghost" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
            Anterior
          </Button>
          <span className="muted">
            Página {page} de {lastPage}
          </span>
          <Button variant="ghost" disabled={page >= lastPage} onClick={() => setPage((p) => p + 1)}>
            Próxima
          </Button>
        </nav>
      )}
    </>
  );
}
