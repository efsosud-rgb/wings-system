import { defaultPathFor } from '@wings/shared';
import { Navigate } from 'react-router-dom';
import { useSession } from '../api/auth.js';

/**
 * Where "/" goes: the first screen this person can actually open.
 *
 * Previously hard-coded to the employee list, which was wrong for anyone
 * without `employees.read` — they landed on a screen that only produced
 * errors.
 */
export function LandingRoute() {
  const session = useSession();
  const user = session.data;

  if (session.isLoading) return <div className="page-loading">Carregando…</div>;
  if (!user) return <Navigate to="/login" replace />;

  return (
    <Navigate to={defaultPathFor({ role: user.role, permissions: user.permissions })} replace />
  );
}
