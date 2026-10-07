import { createHash, randomBytes } from 'node:crypto';

/**
 * Google's OAuth 2.0 code flow for one person (docs/integracoes/google-workspace.md).
 *
 * Plain `fetch` against Google's endpoints, like the Google Ads and GA4 clients:
 * no library. The scopes are the smallest set that creates events with a Meet
 * on any calendar the person can write to, finds the shared Wings Company
 * calendar, sends mail as the person and names the account that consented.
 * Nothing here logs a token, a code or an address.
 */

export const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const GOOGLE_REVOKE_URL = 'https://oauth2.googleapis.com/revoke';

export const GOOGLE_WORKSPACE_SCOPES = [
  'openid',
  'email',
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
  'https://www.googleapis.com/auth/gmail.send',
] as const;

export class GoogleOAuthError extends Error {
  constructor(
    readonly code: string,
    message = code,
  ) {
    super(message);
  }
}

export interface GoogleClient {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export interface GoogleTokens {
  accessToken: string;
  /** Google hands a refresh token on the first consent only (prompt=consent asks every time). */
  refreshToken: string | null;
  expiresAt: Date;
  scopes: string[];
  /** From the id_token the token endpoint returned over TLS; null when it carried none. */
  email: string | null;
}

const base64url = (bytes: Buffer) => bytes.toString('base64url');

export interface CodeAuthorization {
  authorizationUrl: string;
  state: string;
  codeVerifier: string;
}

export function startCodeFlow(client: GoogleClient, loginHint?: string | null): CodeAuthorization {
  const codeVerifier = base64url(randomBytes(48));
  const state = base64url(randomBytes(24));
  const url = new URL(GOOGLE_AUTH_URL);
  url.search = new URLSearchParams({
    response_type: 'code',
    client_id: client.clientId,
    redirect_uri: client.redirectUri,
    scope: GOOGLE_WORKSPACE_SCOPES.join(' '),
    state,
    code_challenge: base64url(createHash('sha256').update(codeVerifier).digest()),
    code_challenge_method: 'S256',
    // A refresh token comes only with offline access, and only on a consent screen.
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
    ...(loginHint ? { login_hint: loginHint } : {}),
  }).toString();
  return { authorizationUrl: url.toString(), state, codeVerifier };
}

interface TokenResponse {
  access_token?: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
  scope?: unknown;
  id_token?: unknown;
  error?: unknown;
}

/** The e-mail claim of an id_token the token endpoint itself handed us (no signature check needed). */
function emailOfIdToken(idToken: unknown): string | null {
  if (typeof idToken !== 'string') return null;
  const payload = idToken.split('.')[1];
  if (!payload) return null;
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
      email?: unknown;
    };
    return typeof claims.email === 'string' ? claims.email.toLowerCase() : null;
  } catch {
    return null;
  }
}

async function tokenRequest(
  transport: typeof fetch,
  client: GoogleClient,
  grant: Record<string, string>,
  now: Date,
  previousRefreshToken: string | null,
): Promise<GoogleTokens> {
  let response: Response;
  try {
    response = await transport(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: client.clientId,
        client_secret: client.clientSecret,
        ...grant,
      }).toString(),
    });
  } catch {
    throw new GoogleOAuthError('google_unreachable', 'O Google não respondeu.');
  }
  const body = (await response.json().catch(() => ({}))) as TokenResponse;
  if (!response.ok || typeof body.access_token !== 'string') {
    const code = typeof body.error === 'string' ? body.error : `http_${response.status}`;
    // invalid_grant: the refresh token was revoked, or the code was used twice or expired.
    throw new GoogleOAuthError(code === 'invalid_grant' ? 'invalid_grant' : 'token_rejected');
  }
  const expiresIn = typeof body.expires_in === 'number' ? body.expires_in : 3600;
  return {
    accessToken: body.access_token,
    refreshToken:
      typeof body.refresh_token === 'string' ? body.refresh_token : previousRefreshToken,
    expiresAt: new Date(now.getTime() + expiresIn * 1000),
    scopes: typeof body.scope === 'string' ? body.scope.split(' ').filter(Boolean) : [],
    email: emailOfIdToken(body.id_token),
  };
}

export const exchangeCode = (
  transport: typeof fetch,
  client: GoogleClient,
  input: { code: string; codeVerifier: string },
  now = new Date(),
) =>
  tokenRequest(
    transport,
    client,
    {
      grant_type: 'authorization_code',
      code: input.code,
      code_verifier: input.codeVerifier,
      redirect_uri: client.redirectUri,
    },
    now,
    null,
  );

export const refreshTokens = (
  transport: typeof fetch,
  client: GoogleClient,
  refreshToken: string,
  now = new Date(),
) =>
  tokenRequest(
    transport,
    client,
    { grant_type: 'refresh_token', refresh_token: refreshToken },
    now,
    refreshToken,
  );

/** Best effort: a token we are about to forget is also told to stop working. */
export async function revokeToken(transport: typeof fetch, token: string): Promise<void> {
  try {
    await transport(`${GOOGLE_REVOKE_URL}?${new URLSearchParams({ token }).toString()}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
  } catch {
    // The row is deleted anyway; Google expires the token on its own.
  }
}
