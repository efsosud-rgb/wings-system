import type { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useSession } from '../api/auth.js';

/**
 * Gate for authenticated areas. This is convenience only — the API rejects
 * unauthorised calls regardless of what the browser renders.
 */
export function ProtectedRoute({ children }: { children: ReactNode }) {
  const session = useSession();
  const location = useLocation();

  if (session.isLoading) {
    return <div className="page-loading">Carregando…</div>;
  }

  if (!session.data) {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }

  return <>{children}</>;
}
