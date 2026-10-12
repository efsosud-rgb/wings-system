import type { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useSession } from '../api/auth.js';
import {
  sessionExpiredInThisTab,
  wasSignedIn,
  type LoginRedirectState,
} from '../api/session-expiry.js';

/**
 * Gate for authenticated areas. This is convenience only — the API rejects
 * unauthorised calls regardless of what the browser renders.
 *
 * Without a session the person goes to the login carrying where they were (path,
 * query string and fragment) and, when they had a session that ended, a flag that
 * makes the login say so. Signing in brings them back to that screen.
 */
export function ProtectedRoute({ children }: { children: ReactNode }) {
  const session = useSession();
  const location = useLocation();

  if (session.isLoading) {
    return <div className="page-loading">Carregando…</div>;
  }

  if (!session.data) {
    const state: LoginRedirectState = {
      from: `${location.pathname}${location.search}${location.hash}`,
      ...(sessionExpiredInThisTab() || wasSignedIn() ? { expired: true } : {}),
    };
    return <Navigate to="/login" replace state={state} />;
  }

  return <>{children}</>;
}
