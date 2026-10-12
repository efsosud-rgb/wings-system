import type { QueryClient } from '@tanstack/react-query';
import { sessionKey } from './auth.js';
import { api } from './client.js';
import { markSessionExpired, onUnauthorized } from './session-expiry.js';

/** A tab that comes back to the front is checked at most this often. */
const PROBE_EVERY_MS = 30_000;

/**
 * Turns "the API answered 401" into "this tab is signed out", once, for the whole app.
 *
 * Every request goes through the HTTP client, which reports a 401 here. When the
 * tab believed someone was signed in, the cached session becomes `null`; the
 * route gate (`ProtectedRoute`) then sends the person to `/login` with the
 * address they were on, which unmounts the shell and with it every periodic
 * query (the ringing call line, the WhatsApp lists, the dashboards). Requests
 * still in flight answer 401 into a guard that has nothing left to do.
 *
 * A 401 with nobody signed in (the first `GET /auth/me` of a visitor) changes
 * nothing: the gate already knows.
 *
 * Returns a function that removes the guard (tests).
 */
export function installSessionGuard(queryClient: QueryClient): () => void {
  const signedOut = () => {
    if (!queryClient.getQueryData(sessionKey)) return;
    markSessionExpired();
    queryClient.setQueryData(sessionKey, null);
  };
  onUnauthorized(signedOut);

  // A tab left in the background for hours has nothing asking the server anything
  // (a screen without a periodic query) and would show yesterday's data as today's.
  // Coming back to it asks once. A passive read: it finds out, it never extends the
  // session.
  let lastProbe = 0;
  const probe = () => {
    if (document.visibilityState !== 'visible') return;
    if (!queryClient.getQueryData(sessionKey)) return;
    const now = Date.now();
    if (now - lastProbe < PROBE_EVERY_MS) return;
    lastProbe = now;
    api.poll('/auth/me').catch(() => undefined);
  };
  document.addEventListener('visibilitychange', probe);

  return () => {
    onUnauthorized(null);
    document.removeEventListener('visibilitychange', probe);
  };
}
