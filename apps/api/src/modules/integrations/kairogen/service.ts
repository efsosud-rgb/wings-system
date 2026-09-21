import {
  KAIROGEN_READ_TOOLS,
  KAIROGEN_TOOLS,
  type KairogenCredits,
  type KairogenPendingAuthorization,
  type KairogenStatus,
  type KairogenTool,
  type KairogenToolName,
} from '@wings/shared';
import { eq, sql } from 'drizzle-orm';
import type { Database } from '../../../db/client.js';
import { employees, integrationConnections } from '../../../db/schema/index.js';
import { McpClient, McpError, type McpToolResult } from '../../../lib/mcp-client/index.js';
import type { Env } from '../../../env.js';
import { createSecretBox, type SecretBox } from '../../../lib/secret-box.js';
import {
  KAIROGEN_MCP_ENDPOINT,
  OAuthError,
  discover,
  exchangeCode,
  pollDeviceFlow,
  refreshTokens,
  registerClient,
  revokeToken,
  startCodeFlow,
  startDeviceFlow,
  type TokenSet,
} from './oauth.js';

/**
 * The system's one connection to Kairogen.
 *
 * Tokens exist in three places only: Kairogen, the encrypted columns of
 * `integration_connections`, and the memory of the request that is using them.
 * They are never returned by a function here, never logged, never handed to
 * the browser or to a language model.
 */

export const PROVIDER = 'kairogen';
/** Refresh this long before the access token expires. */
const REFRESH_MARGIN_MS = 60_000;

export interface KairogenDeps {
  db: Database;
  box: SecretBox;
  fetch: typeof fetch;
  /** APP_BASE_URL + /api/integrations/kairogen/callback */
  redirectUri: string;
  /** KAIROGEN_CLIENT_ID, when registration by hand was needed. */
  configuredClientId?: string;
  now?: () => Date;
}

interface StoredPending extends KairogenPendingAuthorization {
  /** The device code or the PKCE verifier, encrypted. */
  secretEnc: string;
  /** Code flow: compared with the `state` that comes back. */
  state: string | null;
  startedBy: string;
  /** Device flow: no check of the token endpoint before this instant. */
  nextPollAt: string | null;
}

/**
 * The connection's dependencies from the app's own. Null without
 * INTEGRATIONS_ENCRYPTION_KEY: whoever needs Kairogen then answers 503.
 */
export function kairogenDepsOf(wings: {
  db: Database;
  env: Env;
  kairogenFetch?: typeof fetch;
}): KairogenDeps | null {
  if (!wings.env.INTEGRATIONS_ENCRYPTION_KEY) return null;
  return {
    db: wings.db,
    box: createSecretBox(wings.env.INTEGRATIONS_ENCRYPTION_KEY),
    fetch: wings.kairogenFetch ?? fetch,
    redirectUri: `${wings.env.APP_BASE_URL}/api/integrations/kairogen/callback`,
    configuredClientId: wings.env.KAIROGEN_CLIENT_ID,
  };
}

type Row = typeof integrationConnections.$inferSelect;

const nowOf = (deps: KairogenDeps) => deps.now?.() ?? new Date();

async function row(db: Database): Promise<Row | null> {
  const found = await db.query.integrationConnections.findFirst({
    where: eq(integrationConnections.provider, PROVIDER),
  });
  return found ?? null;
}

async function upsert(db: Database, values: Partial<Row>, now: Date): Promise<void> {
  await db
    .insert(integrationConnections)
    .values({ provider: PROVIDER, ...values, updatedAt: now })
    .onConflictDoUpdate({
      target: [integrationConnections.tenantId, integrationConnections.provider],
      set: { ...values, updatedAt: now },
    });
}

function clientOf(
  deps: KairogenDeps,
  stored: Row,
): { clientId: string; clientSecret: string | null } {
  if (!stored.clientId) throw new OAuthError('token_refused', 'Cliente não registrado.');
  return {
    clientId: stored.clientId,
    clientSecret: stored.clientSecretEnc ? deps.box.open(stored.clientSecretEnc) : null,
  };
}

function tokenColumns(deps: KairogenDeps, tokens: TokenSet): Partial<Row> {
  return {
    accessTokenEnc: deps.box.seal(tokens.accessToken),
    refreshTokenEnc: tokens.refreshToken ? deps.box.seal(tokens.refreshToken) : null,
    accessExpiresAt: tokens.expiresAt,
    ...(tokens.scopes.length > 0 ? { scopes: tokens.scopes } : {}),
  };
}

// ---------------------------------------------------------------------------
// Connecting
// ---------------------------------------------------------------------------

/** The client id to authorize with: the configured one, the stored one, or a fresh registration. */
async function ensureClient(deps: KairogenDeps, stored: Row | null, now: Date) {
  const server = await discover(deps.fetch);
  if (deps.configuredClientId) {
    if (stored?.clientId !== deps.configuredClientId) {
      await upsert(deps.db, { clientId: deps.configuredClientId, clientSecretEnc: null }, now);
    }
    return { server, client: { clientId: deps.configuredClientId, clientSecret: null } };
  }
  if (stored?.clientId) return { server, client: clientOf(deps, stored) };

  const registered = await registerClient(deps.fetch, server, deps.redirectUri);
  await upsert(
    deps.db,
    {
      clientId: registered.clientId,
      clientSecretEnc: registered.clientSecret ? deps.box.seal(registered.clientSecret) : null,
    },
    now,
  );
  return { server, client: registered };
}

/**
 * Starts an authorization. Device flow by default; when Kairogen refuses it for
 * this client, the caller may ask again with `code`.
 */
export async function startConnection(
  deps: KairogenDeps,
  input: { flow: 'device' | 'code'; employeeId: string },
): Promise<void> {
  const now = nowOf(deps);
  const { server, client } = await ensureClient(deps, await row(deps.db), now);

  let pending: StoredPending;
  if (input.flow === 'device') {
    const device = await startDeviceFlow(deps.fetch, server, client.clientId, now);
    pending = {
      flow: 'device',
      userCode: device.userCode,
      verificationUri: device.verificationUri,
      verificationUriComplete: device.verificationUriComplete,
      authorizationUrl: null,
      expiresAt: device.expiresAt.toISOString(),
      intervalSeconds: device.intervalSeconds,
      secretEnc: deps.box.seal(device.deviceCode),
      state: null,
      startedBy: input.employeeId,
      nextPollAt: new Date(now.getTime() + device.intervalSeconds * 1000).toISOString(),
    };
  } else {
    const code = startCodeFlow(server, client.clientId, deps.redirectUri);
    pending = {
      flow: 'code',
      userCode: null,
      verificationUri: null,
      verificationUriComplete: null,
      authorizationUrl: code.authorizationUrl,
      expiresAt: new Date(now.getTime() + 10 * 60_000).toISOString(),
      intervalSeconds: 0,
      secretEnc: deps.box.seal(code.codeVerifier),
      state: code.state,
      startedBy: input.employeeId,
      nextPollAt: null,
    };
  }
  await upsert(deps.db, { state: 'pending', pending, lastError: null }, now);
}

async function finishConnection(
  deps: KairogenDeps,
  tokens: TokenSet,
  employeeId: string,
  now: Date,
): Promise<void> {
  await upsert(
    deps.db,
    {
      ...tokenColumns(deps, tokens),
      state: 'connected',
      pending: null,
      lastError: null,
      connectedBy: employeeId,
      connectedAt: now,
    },
    now,
  );
  // What the server offers this account, read once while the token is fresh.
  await describeServer(deps).catch(() => undefined);
}

export type PollOutcome =
  'connected' | 'pending' | 'too_soon' | 'expired' | 'denied' | 'nothing_pending';

/** One check of the token endpoint, never sooner than the server asked. */
export async function pollConnection(deps: KairogenDeps): Promise<PollOutcome> {
  const now = nowOf(deps);
  const stored = await row(deps.db);
  const pending = stored?.pending as StoredPending | null | undefined;
  if (!stored || stored.state !== 'pending' || !pending || pending.flow !== 'device') {
    return 'nothing_pending';
  }
  if (new Date(pending.expiresAt) <= now) {
    await upsert(deps.db, { state: 'disconnected', pending: null, lastError: 'expired' }, now);
    return 'expired';
  }
  if (pending.nextPollAt && new Date(pending.nextPollAt) > now) return 'too_soon';

  const server = await discover(deps.fetch);
  try {
    const tokens = await pollDeviceFlow(
      deps.fetch,
      server,
      clientOf(deps, stored),
      deps.box.open(pending.secretEnc),
      now,
    );
    await finishConnection(deps, tokens, pending.startedBy, now);
    return 'connected';
  } catch (error) {
    if (!(error instanceof OAuthError)) throw error;
    if (error.code === 'authorization_pending' || error.code === 'slow_down') {
      // RFC 8628: on slow_down the interval grows by five seconds, for good.
      const interval = pending.intervalSeconds + (error.code === 'slow_down' ? 5 : 0);
      await upsert(
        deps.db,
        {
          pending: {
            ...pending,
            intervalSeconds: interval,
            nextPollAt: new Date(now.getTime() + interval * 1000).toISOString(),
          },
        },
        now,
      );
      return 'pending';
    }
    const outcome = error.code === 'denied' ? 'denied' : 'expired';
    await upsert(deps.db, { state: 'disconnected', pending: null, lastError: outcome }, now);
    return outcome;
  }
}

/** The browser came back from Kairogen with a code. */
export async function completeCodeFlow(
  deps: KairogenDeps,
  input: { code: string; state: string; issuer?: string },
): Promise<void> {
  const now = nowOf(deps);
  const stored = await row(deps.db);
  const pending = stored?.pending as StoredPending | null | undefined;
  if (!stored || stored.state !== 'pending' || !pending || pending.flow !== 'code') {
    throw new OAuthError('invalid_grant', 'Nenhuma autorização em andamento.');
  }
  const server = await discover(deps.fetch);
  // `state` ties the answer to the request we made; `iss` to the server we asked.
  if (pending.state === null || input.state !== pending.state) {
    throw new OAuthError('invalid_grant', 'A resposta não corresponde ao pedido feito.');
  }
  if (input.issuer !== undefined && input.issuer !== server.issuer) {
    throw new OAuthError('invalid_grant', 'A resposta veio de outro servidor.');
  }
  if (new Date(pending.expiresAt) <= now) {
    await upsert(deps.db, { state: 'disconnected', pending: null, lastError: 'expired' }, now);
    throw new OAuthError('expired', 'A autorização expirou. Comece de novo.');
  }
  try {
    const tokens = await exchangeCode(
      deps.fetch,
      server,
      clientOf(deps, stored),
      {
        code: input.code,
        codeVerifier: deps.box.open(pending.secretEnc),
        redirectUri: deps.redirectUri,
      },
      now,
    );
    await finishConnection(deps, tokens, pending.startedBy, now);
  } catch (error) {
    await upsert(
      deps.db,
      { state: 'disconnected', pending: null, lastError: 'token_refused' },
      now,
    );
    throw error;
  }
}

export async function disconnect(deps: KairogenDeps): Promise<{ revoked: boolean }> {
  const now = nowOf(deps);
  const stored = await row(deps.db);
  let revoked = false;
  if (stored?.clientId && (stored.refreshTokenEnc || stored.accessTokenEnc)) {
    try {
      const server = await discover(deps.fetch);
      const token = deps.box.open((stored.refreshTokenEnc ?? stored.accessTokenEnc) as string);
      revoked = await revokeToken(deps.fetch, server, clientOf(deps, stored), token);
    } catch {
      // Forgetting the tokens must not depend on Kairogen being reachable.
    }
  }
  await upsert(
    deps.db,
    {
      state: 'disconnected',
      accessTokenEnc: null,
      refreshTokenEnc: null,
      accessExpiresAt: null,
      pending: null,
      scopes: [],
      tools: [],
      protocolVersion: null,
      lastError: null,
      connectedBy: null,
      connectedAt: null,
    },
    now,
  );
  return { revoked };
}

// ---------------------------------------------------------------------------
// Using the connection
// ---------------------------------------------------------------------------

/**
 * A valid access token, refreshed when it is about to expire. The refresh runs
 * under a lock on the connection row: two requests at once must not both spend
 * a refresh token that Kairogen rotates on use.
 */
async function accessToken(deps: KairogenDeps, force = false): Promise<string> {
  // The transaction RETURNS its verdict instead of throwing it: a throw would
  // roll back the very update that records the connection as lost.
  const verdict = await deps.db.transaction(
    async (tx): Promise<{ token: string } | { failure: McpError }> => {
      await tx.execute(
        sql`select id from integration_connections where provider = ${PROVIDER} for update`,
      );
      const stored = await tx.query.integrationConnections.findFirst({
        where: eq(integrationConnections.provider, PROVIDER),
      });
      if (!stored || stored.state !== 'connected' || !stored.accessTokenEnc) {
        return { failure: new McpError('unauthorized', 'O Kairogen não está conectado.') };
      }
      const now = nowOf(deps);
      const fresh =
        stored.accessExpiresAt === null ||
        stored.accessExpiresAt.getTime() - now.getTime() > REFRESH_MARGIN_MS;
      if (fresh && !force) return { token: deps.box.open(stored.accessTokenEnc) };

      const lost = async (reason: string) => {
        await tx
          .update(integrationConnections)
          .set({ state: 'needs_reconnect', lastError: reason, updatedAt: now })
          .where(eq(integrationConnections.id, stored.id));
        return { failure: new McpError('unauthorized', 'A conexão com o Kairogen expirou.') };
      };
      if (!stored.refreshTokenEnc) return lost('no_refresh_token');
      try {
        const tokens = await refreshTokens(
          deps.fetch,
          await discover(deps.fetch),
          clientOf(deps, stored),
          deps.box.open(stored.refreshTokenEnc),
          now,
        );
        await tx
          .update(integrationConnections)
          .set({ ...tokenColumns(deps, tokens), lastError: null, updatedAt: now })
          .where(eq(integrationConnections.id, stored.id));
        return { token: tokens.accessToken };
      } catch (error) {
        if (!(error instanceof OAuthError)) throw error;
        // Kairogen being down is not a reason to throw the connection away.
        if (error.code === 'unavailable' || error.code === 'discovery_failed') {
          return { failure: new McpError('unavailable', 'O Kairogen não respondeu.') };
        }
        return lost('refresh_refused');
      }
    },
  );
  if ('failure' in verdict) throw verdict.failure;
  return verdict.token;
}

function mcp(deps: KairogenDeps, forceRefresh: { next: boolean }): McpClient {
  return new McpClient({
    endpoint: KAIROGEN_MCP_ENDPOINT,
    fetch: deps.fetch,
    getAccessToken: () => {
      const force = forceRefresh.next;
      forceRefresh.next = false;
      return accessToken(deps, force);
    },
  });
}

/**
 * Calls one of the eight tools. A 401 is answered once with a forced refresh —
 * a token can be revoked before its time — and only for tools that read: a
 * generation is never sent twice.
 */
export async function callKairogen(
  deps: KairogenDeps,
  tool: KairogenToolName,
  args: Record<string, unknown> = {},
  options: { timeoutMs?: number } = {},
): Promise<McpToolResult> {
  const reads = KAIROGEN_READ_TOOLS.includes(tool);
  const force = { next: false };
  const client = mcp(deps, force);
  try {
    return await client.callTool(tool, args, { retry: reads, timeoutMs: options.timeoutMs });
  } catch (error) {
    if (!(error instanceof McpError) || error.code !== 'unauthorized' || !reads) throw error;
    force.next = true;
    return mcp(deps, force).callTool(tool, args, { retry: true, timeoutMs: options.timeoutMs });
  }
}

/** Protocol version and the tools on offer, stored for the settings screen and the docs. */
export async function describeServer(deps: KairogenDeps): Promise<KairogenTool[]> {
  const client = mcp(deps, { next: false });
  const { protocolVersion } = await client.initialize();
  const known: readonly string[] = KAIROGEN_TOOLS;
  const tools = (await client.listTools()).filter((tool) => known.includes(tool.name));
  await upsert(deps.db, { protocolVersion, tools }, nowOf(deps));
  return tools;
}

/** The balance, from whatever shape `get_credits` answers in. */
export function creditsFrom(result: McpToolResult, now: Date): KairogenCredits {
  const seen = new Set<unknown>();
  const find = (value: unknown, depth: number): number | null => {
    if (depth > 3 || value === null || typeof value !== 'object' || seen.has(value)) return null;
    seen.add(value);
    const entries = Object.entries(value as Record<string, unknown>);
    for (const key of ['credits', 'balance', 'remaining', 'credits_remaining', 'available']) {
      const hit = entries.find(([name]) => name.toLowerCase() === key)?.[1];
      if (typeof hit === 'number' && Number.isFinite(hit)) return hit;
    }
    for (const [, nested] of entries) {
      const hit = find(nested, depth + 1);
      if (hit !== null) return hit;
    }
    return null;
  };
  const fromData = typeof result.data === 'number' ? result.data : find(result.data, 0);
  const fromText = /(\d+(?:[.,]\d+)?)/.exec(result.text)?.[1];
  const balance = fromData ?? (fromText ? Number(fromText.replace(',', '.')) : null);
  return {
    balance,
    raw: balance === null ? result.text.slice(0, 200) || null : null,
    checkedAt: now.toISOString(),
  };
}

const DETAIL: Record<string, string> = {
  expired: 'O código expirou antes da autorização. Conecte de novo.',
  denied: 'A autorização foi negada no Kairogen.',
  token_refused: 'O Kairogen recusou a autorização. Conecte de novo.',
  refresh_refused: 'O Kairogen não renovou o acesso. Conecte de novo.',
  no_refresh_token: 'O acesso expirou e não pode ser renovado. Conecte de novo.',
};

export async function getStatus(
  deps: KairogenDeps,
  options: { withCredits?: boolean } = {},
): Promise<KairogenStatus> {
  const [stored] = await deps.db
    .select({ connection: integrationConnections, connectedByName: employees.fullName })
    .from(integrationConnections)
    .leftJoin(employees, eq(employees.id, integrationConnections.connectedBy))
    .where(eq(integrationConnections.provider, PROVIDER));
  const connection = stored?.connection;
  const now = nowOf(deps);

  const raw = connection?.pending as StoredPending | null | undefined;
  const pending: KairogenPendingAuthorization | null =
    connection?.state === 'pending' && raw
      ? {
          flow: raw.flow,
          userCode: raw.userCode,
          verificationUri: raw.verificationUri,
          verificationUriComplete: raw.verificationUriComplete,
          authorizationUrl: raw.authorizationUrl,
          expiresAt: raw.expiresAt,
          intervalSeconds: raw.intervalSeconds,
        }
      : null;

  let credits: KairogenCredits | null = null;
  let detail = connection?.lastError ? (DETAIL[connection.lastError] ?? null) : null;
  let state = connection?.state ?? 'disconnected';
  if (options.withCredits && state === 'connected') {
    try {
      credits = creditsFrom(await callKairogen(deps, 'get_credits'), now);
    } catch (error) {
      const again = await row(deps.db);
      state = again?.state ?? state;
      detail =
        state === 'needs_reconnect'
          ? (DETAIL[again?.lastError ?? ''] ?? 'Conecte de novo.')
          : error instanceof McpError
            ? 'Não foi possível ler o saldo agora.'
            : detail;
      if (!(error instanceof McpError)) throw error;
    }
  }

  return {
    state,
    detail,
    connectedAt: connection?.connectedAt?.toISOString() ?? null,
    connectedByName: state === 'connected' ? (stored?.connectedByName ?? null) : null,
    scopes: connection?.scopes ?? [],
    pending,
    credits,
    protocolVersion: connection?.protocolVersion ?? null,
    tools: (connection?.tools as KairogenTool[] | undefined) ?? [],
  };
}
