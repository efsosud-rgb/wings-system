import type { PermissionKey } from '@wings/shared';
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { hasPermission, useSession } from '../api/auth.js';

/**
 * Closes the gap `ProtectedRoute` leaves open.
 *
 * `ProtectedRoute` asks only "are you signed in?". Anyone could type
 * `/administracao/usuarios` without `employees.read` and watch the screen
 * mount, fire its requests and fill with error states — the API refused every
 * call, so nothing leaked, but the person saw a broken page instead of an
 * honest "you don't have access".
 *
 * This is still convenience, not security: the API remains the authority and
 * re-checks every request. What it buys is an accurate screen.
 */
export function RequirePermission({
  permission,
  children,
}: {
  permission: PermissionKey;
  children: ReactNode;
}) {
  const session = useSession();

  if (session.isLoading) {
    return <div className="page-loading">Carregando…</div>;
  }

  if (!hasPermission(session.data, permission)) {
    return <NoAccess />;
  }

  return <>{children}</>;
}

export function NoAccess() {
  return (
    <>
      <header className="page-header">
        <h1>Sem acesso</h1>
      </header>
      <section className="card">
        <p>Seu nível de acesso não alcança esta tela.</p>
        <p className="field-hint">
          Se você precisa dela para trabalhar, peça a um Admin Master — o acesso é concedido por
          papel, não por tela.
        </p>
        <p>
          <Link to="/">Voltar ao início</Link>
        </p>
      </section>
    </>
  );
}
