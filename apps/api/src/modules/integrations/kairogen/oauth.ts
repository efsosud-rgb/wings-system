import { createHash, randomBytes } from 'node:crypto';

/**
 * OAuth 2.1 against Kairogen's authorization server, as its own metadata
 * describes it (docs/integracoes/kairogen.md): a public client (no secret)
 * using the device flow, with authorization code + PKCE as the second road.
 *
 * Every function takes the transport, so tests run against a simulated
 * authorization server. No error carries a token, a code or a verifier.
 */

export const KAIROGEN_ISSUER = 'https://api.kairogen.ai';
export const KAIROGEN_RESOURCE = 'https://mcp.kairogen.ai';
export const KAIROGEN_MCP_ENDPOINT = 'https://mcp.kairogen.ai/mcp';
export const KAIROGEN_SCOPE = 'kairogen:read kairogen:generate';
const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';

export type OAuthErrorCode =
  | 'discovery_failed'
  | 'registration_refused'
  | 'device_flow_refused'
  | 'authorization_pending'
  | 'slow_down'
  | 'expired'
  | 'denied'
  | 'invalid_grant'
  | 'token_refused'
  | 'unavailable';

export class OAuthError extends Error {
  constructor(
    readonly code: OAuthErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'OAuthError';
  }
}

export interface AuthorizationServer {
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  deviceAuthorizationEndpoint: string | null;
  registrationEndpoint: string | null;
  revocationEndpoint: string | null;
}

export interface TokenSet {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: Date | null;
  scopes: string[];
}

type Transport = typeof fetch;

/** Every endpoint must be https on Kairogen's own domain: metadata is input, not truth. */
function trusted(url: unknown): string | null {
  if (typeof url !== 'string') return null;
  try {
    const parsed = new URL(url);
    const host = parsed.hostname;
    return parsed.protocol === 'https:' && (host === 'kairogen.ai' || host.endsWith('.kairogen.ai'))
      ? url
      : null;
  } catch {
    return null;
  }
}

async function call(
  transport: Transport,
  url: string,
  init: RequestInit,
): Promise<{ status: number; body: Record<string, unknown> }> {
  let response: Response;
  try {
    response = await transport(url, { ...init, signal: AbortSignal.timeout(20_000) });
  } catch {
    throw new OAuthError('unavailable', 'O Kairogen não respondeu.');
  }
  let body: Record<string, unknown> = {};
  try {
    body = (await response.json()) as Record<string, unknown>;
  } catch {
    // An empty or non-JSON body: the status is all there is.
  }
  return { status: response.status, body };
}

const form = (values: Record<string, string>): RequestInit => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
  body: new URLSearchParams(values).toString(),
});

export async function discover(transport: Transport): Promise<AuthorizationServer> {
  const { status, body } = await call(
    transport,
    `${KAIROGEN_ISSUER}/.well-known/oauth-authorization-server`,
    { headers: { Accept: 'application/json' } },
  );
  const authorizationEndpoint = trusted(body.authorization_endpoint);
  const tokenEndpoint = trusted(body.token_endpoint);
  if (
    status !== 200 ||
    body.issuer !== KAIROGEN_ISSUER ||
    !authorizationEndpoint ||
    !tokenEndpoint
  ) {
    throw new OAuthError('discovery_failed', 'Os dados de autorização do Kairogen não conferem.');
  }
  return {
    issuer: KAIROGEN_ISSUER,
    authorizationEndpoint,
    tokenEndpoint,
    deviceAuthorizationEndpoint: trusted(body.device_authorization_endpoint),
    registrationEndpoint: trusted(body.registration_endpoint),
    revocationEndpoint: trusted(body.revocation_endpoint),
  };
}

/** RFC 7591: asks Kairogen for a client id of our own. Public client, both grants. */
export async function registerClient(
  transport: Transport,
  server: AuthorizationServer,
  redirectUri: string,
): Promise<{ clientId: string; clientSecret: string | null }> {
  if (!server.registrationEndpoint) {
    throw new OAuthError('registration_refused', 'O Kairogen não oferece registro de cliente.');
  }
  const { status, body } = await call(transport, server.registrationEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      client_name: 'Wings System',
      redirect_uris: [redirectUri],
      grant_types: ['authorization_code', 'refresh_token', DEVICE_GRANT],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      scope: KAIROGEN_SCOPE,
    }),
  });
  if ((status !== 200 && status !== 201) || typeof body.client_id !== 'string') {
    throw new OAuthError(
      'registration_refused',
      `O Kairogen recusou o registro do cliente (${status}${typeof body.error === 'string' ? `, ${body.error}` : ''}).`,
    );
  }
  return {
    clientId: body.client_id,
    clientSecret: typeof body.client_secret === 'string' ? body.client_secret : null,
  };
}

export interface DeviceAuthorization {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string | null;
  expiresAt: Date;
  intervalSeconds: number;
}

export async function startDeviceFlow(
  transport: Transport,
  server: AuthorizationServer,
  clientId: string,
  now = new Date(),
): Promise<DeviceAuthorization> {
  if (!server.deviceAuthorizationEndpoint) {
    throw new OAuthError('device_flow_refused', 'O Kairogen não oferece o fluxo por código.');
  }
  const { status, body } = await call(
    transport,
    server.deviceAuthorizationEndpoint,
    form({ client_id: clientId, scope: KAIROGEN_SCOPE, resource: KAIROGEN_RESOURCE }),
  );
  const verificationUri = trusted(body.verification_uri);
  if (
    status !== 200 ||
    typeof body.device_code !== 'string' ||
    typeof body.user_code !== 'string' ||
    !verificationUri
  ) {
    throw new OAuthError(
      'device_flow_refused',
      `O Kairogen recusou o fluxo por código (${status}${typeof body.error === 'string' ? `, ${body.error}` : ''}).`,
    );
  }
  const expiresIn = typeof body.expires_in === 'number' ? body.expires_in : 600;
  return {
    deviceCode: body.device_code,
    userCode: body.user_code,
    verificationUri,
    verificationUriComplete: trusted(body.verification_uri_complete),
    expiresAt: new Date(now.getTime() + expiresIn * 1000),
    intervalSeconds: typeof body.interval === 'number' && body.interval > 0 ? body.interval : 5,
  };
}

function tokenSet(body: Record<string, unknown>, now: Date, previousRefresh?: string): TokenSet {
  return {
    accessToken: String(body.access_token),
    // A server that does not rotate refresh tokens sends none: the old one stays valid.
    refreshToken:
      typeof body.refresh_token === 'string' ? body.refresh_token : (previousRefresh ?? null),
    expiresAt:
      typeof body.expires_in === 'number' ? new Date(now.getTime() + body.expires_in * 1000) : null,
    scopes: typeof body.scope === 'string' ? body.scope.split(' ').filter(Boolean) : [],
  };
}

async function tokenRequest(
  transport: Transport,
  server: AuthorizationServer,
  values: Record<string, string>,
  client: { clientId: string; clientSecret: string | null },
  now: Date,
  previousRefresh?: string,
): Promise<TokenSet> {
  const { status, body } = await call(
    transport,
    server.tokenEndpoint,
    form({
      ...values,
      client_id: client.clientId,
      ...(client.clientSecret ? { client_secret: client.clientSecret } : {}),
    }),
  );
  if (status === 200 && typeof body.access_token === 'string') {
    return tokenSet(body, now, previousRefresh);
  }
  const error = typeof body.error === 'string' ? body.error : '';
  if (error === 'authorization_pending') throw new OAuthError('authorization_pending', 'pendente');
  if (error === 'slow_down') throw new OAuthError('slow_down', 'devagar');
  if (error === 'expired_token') throw new OAuthError('expired', 'O código expirou.');
  if (error === 'access_denied')
    throw new OAuthError('denied', 'A autorização foi negada no Kairogen.');
  if (error === 'invalid_grant')
    throw new OAuthError('invalid_grant', 'A autorização não vale mais.');
  if (status >= 500) throw new OAuthError('unavailable', 'O Kairogen não respondeu.');
  throw new OAuthError('token_refused', `O Kairogen recusou a troca do token (${status}).`);
}

export function pollDeviceFlow(
  transport: Transport,
  server: AuthorizationServer,
  client: { clientId: string; clientSecret: string | null },
  deviceCode: string,
  now = new Date(),
): Promise<TokenSet> {
  return tokenRequest(
    transport,
    server,
    { grant_type: DEVICE_GRANT, device_code: deviceCode },
    client,
    now,
  );
}

export interface CodeAuthorization {
  authorizationUrl: string;
  state: string;
  codeVerifier: string;
}

const base64url = (bytes: Buffer) => bytes.toString('base64url');

export function startCodeFlow(
  server: AuthorizationServer,
  clientId: string,
  redirectUri: string,
): CodeAuthorization {
  const codeVerifier = base64url(randomBytes(48));
  const state = base64url(randomBytes(24));
  const url = new URL(server.authorizationEndpoint);
  url.search = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: KAIROGEN_SCOPE,
    state,
    code_challenge: base64url(createHash('sha256').update(codeVerifier).digest()),
    code_challenge_method: 'S256',
    resource: KAIROGEN_RESOURCE,
  }).toString();
  return { authorizationUrl: url.toString(), state, codeVerifier };
}

export function exchangeCode(
  transport: Transport,
  server: AuthorizationServer,
  client: { clientId: string; clientSecret: string | null },
  input: { code: string; codeVerifier: string; redirectUri: string },
  now = new Date(),
): Promise<TokenSet> {
  return tokenRequest(
    transport,
    server,
    {
      grant_type: 'authorization_code',
      code: input.code,
      code_verifier: input.codeVerifier,
      redirect_uri: input.redirectUri,
      resource: KAIROGEN_RESOURCE,
    },
    client,
    now,
  );
}

export function refreshTokens(
  transport: Transport,
  server: AuthorizationServer,
  client: { clientId: string; clientSecret: string | null },
  refreshToken: string,
  now = new Date(),
): Promise<TokenSet> {
  return tokenRequest(
    transport,
    server,
    { grant_type: 'refresh_token', refresh_token: refreshToken, resource: KAIROGEN_RESOURCE },
    client,
    now,
    refreshToken,
  );
}

/** Best effort: a token we are about to forget is also told to stop working. */
export async function revokeToken(
  transport: Transport,
  server: AuthorizationServer,
  client: { clientId: string; clientSecret: string | null },
  token: string,
): Promise<boolean> {
  if (!server.revocationEndpoint) return false;
  try {
    const { status } = await call(
      transport,
      server.revocationEndpoint,
      form({
        token,
        client_id: client.clientId,
        ...(client.clientSecret ? { client_secret: client.clientSecret } : {}),
      }),
    );
    return status === 200;
  } catch {
    return false;
  }
}
