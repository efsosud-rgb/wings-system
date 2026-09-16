import { useSession } from '../api/auth.js';

/**
 * Stage 3 replaces this with the real list and form. Stage 1 only proves the
 * shell, session and routing work end to end.
 */
export function EmployeesPage() {
  const { data: user } = useSession();

  return (
    <>
      <header className="page-header">
        <h1>Cadastro de Funcionários</h1>
        <p>Módulo em construção — a listagem e o formulário chegam na próxima etapa.</p>
      </header>

      <section className="card">
        <p>
          Sessão ativa como <strong>{user?.fullName}</strong>.
        </p>
        <p className="muted">Permissões efetivas: {Object.keys(user?.permissions ?? {}).length}</p>
      </section>
    </>
  );
}
