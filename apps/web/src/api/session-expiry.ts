/**
 * Where the browser learns that the session behind an open tab is gone.
 *
 * The API ends a session on its own (30 idle minutes, 12 hours absolute, a
 * deactivated person, a changed role) and answers 401 from then on. A tab left
 * open does not know that until something tells it: before this module the
 * screen kept standing, kept asking `GET /whatsapp/calls/ringing` every three
 * seconds and kept showing what it had loaded the day before.
 *
 * Kept free of imports so the HTTP client can call it without a cycle: the
 * client only reports a 401; `session-guard.ts` decides what that means.
 */

type Listener = () => void;

let listener: Listener | null = null;
let expiredByRequest = false;

/** The one place that reacts to a 401 (installed once, by the app). */
export function onUnauthorized(next: Listener | null): void {
  listener = next;
}

/** Called by the HTTP client for every 401 of a signed-in request. */
export function reportUnauthorized(): void {
  listener?.();
}

/** The guard noticed that a signed-in tab lost its session. Stays true until the next login. */
export function markSessionExpired(): void {
  expiredByRequest = true;
}

export function clearSessionExpired(): void {
  expiredByRequest = false;
}

/** A page-level read, safe to call while rendering. */
export function sessionExpiredInThisTab(): boolean {
  return expiredByRequest;
}

// --- "this browser had a session" -------------------------------------------------------
//
// A reload of an expired tab finds no cookie and `GET /auth/me` answers 401 with no
// way to tell "expired" from "never signed in". One flag in localStorage says which:
// set while signed in, cleared on logout. It holds no data about the person.

const SIGNED_IN_FLAG = 'wings:signed-in';

export function rememberSignedIn(): void {
  try {
    localStorage.setItem(SIGNED_IN_FLAG, '1');
  } catch {
    // Storage blocked: the login screen just shows no "expired" notice after a reload.
  }
}

export function forgetSignedIn(): void {
  try {
    localStorage.removeItem(SIGNED_IN_FLAG);
  } catch {
    // nothing to forget
  }
}

export function wasSignedIn(): boolean {
  try {
    return localStorage.getItem(SIGNED_IN_FLAG) === '1';
  } catch {
    return false;
  }
}

// --- the login screen's hand-over --------------------------------------------------------

/** What the redirect to `/login` carries in the router state. */
export interface LoginRedirectState {
  /** Where the person was: path, query string and fragment. */
  from?: string;
  /** The session ended while the person was using the system. */
  expired?: boolean;
}

export const SESSION_EXPIRED_MESSAGE = 'Sua sessão expirou. Entre de novo.';

const PUBLIC_PATHS = ['/login', '/esqueci-senha', '/definir-senha', '/redefinir-senha', '/lp/'];

/**
 * A return address is only ever an address inside this app: one path, never another
 * site (`//host`, `https://host`, `/\host`), never a screen that needs no session.
 */
export function safeReturnPath(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  if (!value.startsWith('/') || value.startsWith('//') || value.startsWith('/\\')) return undefined;
  if (/\p{Cc}/u.test(value)) return undefined;
  const pathname = value.split(/[?#]/)[0] ?? '';
  if (PUBLIC_PATHS.some((p) => pathname === p || (p.endsWith('/') && pathname.startsWith(p)))) {
    return undefined;
  }
  return value;
}
