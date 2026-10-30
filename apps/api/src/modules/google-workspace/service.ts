import { GMAIL_READ_SCOPE, type GoogleWorkspaceStatus } from '@wings/shared';
import { eq, sql } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import { googleWorkspaceConnections } from '../../db/schema/index.js';
import type { Env } from '../../env.js';
import { createSecretBox, type SecretBox } from '../../lib/secret-box.js';
import { GoogleCalendarError, listCalendars } from './calendar.js';
import {
  exchangeCode,
  GoogleOAuthError,
  refreshTokens,
  revokeToken,
  startCodeFlow,
  type GoogleClient,
  type GoogleTokens,
} from './oauth.js';

/**
 * One person's Google Workspace connection: started from the account page,
 * completed by Google's redirect, used by the meetings (Agenda + Meet) and by
 * the e-mail to the lead (Gmail). The person's token acts only as them.
 *
 * Tokens are stored sealed by `secret-box.ts`; the refresh happens under a
 * row lock so two requests of the same person never race Google's rotation.
 */

export interface GoogleWorkspaceDeps {
  db: Database;
  env: Env;
  box: SecretBox;
  client: GoogleClient;
  transport: typeof fetch;
  now: () => Date;
}

export const GOOGLE_CALLBACK_PATH = '/api/me/google/callback';

/** Null while the system has no OAuth client or no key to keep tokens under: the routes answer 503. */
export function googleWorkspaceDepsOf(wings: {
  db: Database;
  env: Env;
  googleFetch?: typeof fetch;
  now?: () => Date;
}): GoogleWorkspaceDeps | null {
  const { env } = wings;
  if (
    !env.INTEGRATIONS_ENCRYPTION_KEY ||
    !env.GOOGLE_WORKSPACE_CLIENT_ID ||
    !env.GOOGLE_WORKSPACE_CLIENT_SECRET
  ) {
    return null;
  }
  return {
    db: wings.db,
    env,
    box: createSecretBox(env.INTEGRATIONS_ENCRYPTION_KEY),
    client: {
      clientId: env.GOOGLE_WORKSPACE_CLIENT_ID,
      clientSecret: env.GOOGLE_WORKSPACE_CLIENT_SECRET,
      redirectUri: `${env.APP_BASE_URL}${GOOGLE_CALLBACK_PATH}`,
    },
    transport: wings.googleFetch ?? fetch,
    now: wings.now ?? (() => new Date()),
  };
}

type Row = typeof googleWorkspaceConnections.$inferSelect;

interface PendingFlow {
  state: string;
  verifierEnc: string;
  startedAt: string;
}

const PENDING_MINUTES = 15;
const REFRESH_MARGIN_MS = 60_000;

const connectionOf = (deps: GoogleWorkspaceDeps, employeeId: string) =>
  deps.db.query.googleWorkspaceConnections.findFirst({
    where: eq(googleWorkspaceConnections.employeeId, employeeId),
  });

function tokenColumns(deps: GoogleWorkspaceDeps, tokens: GoogleTokens, previous: Row | null) {
  const refresh = tokens.refreshToken ?? null;
  return {
    accessTokenEnc: deps.box.seal(tokens.accessToken),
    refreshTokenEnc: refresh ? deps.box.seal(refresh) : (previous?.refreshTokenEnc ?? null),
    accessExpiresAt: tokens.expiresAt,
    scopes: tokens.scopes.length ? tokens.scopes : (previous?.scopes ?? []),
    googleEmail: tokens.email ?? previous?.googleEmail ?? null,
  };
}

/** Where the browser goes: Google's consent screen, tied to this person by `state` + PKCE. */
export async function startConnect(
  deps: GoogleWorkspaceDeps,
  employeeId: string,
  loginHint: string | null,
): Promise<string> {
  const flow = startCodeFlow(deps.client, loginHint);
  const pending: PendingFlow = {
    state: flow.state,
    verifierEnc: deps.box.seal(flow.codeVerifier),
    startedAt: deps.now().toISOString(),
  };
  const existing = await connectionOf(deps, employeeId);
  if (existing) {
    await deps.db
      .update(googleWorkspaceConnections)
      .set({ pending, updatedAt: deps.now() })
      .where(eq(googleWorkspaceConnections.id, existing.id));
  } else {
    await deps.db.insert(googleWorkspaceConnections).values({ employeeId, pending });
  }
  return flow.authorizationUrl;
}

/** Google sent the browser back: the code becomes this person's tokens. */
export async function completeConnect(
  deps: GoogleWorkspaceDeps,
  employeeId: string,
  input: { code: string; state: string },
): Promise<void> {
  const row = await connectionOf(deps, employeeId);
  const pending = (row?.pending ?? null) as PendingFlow | null;
  if (!row || !pending) throw new GoogleOAuthError('no_pending_flow');
  const startedAt = Date.parse(pending.startedAt);
  if (
    pending.state !== input.state ||
    Number.isNaN(startedAt) ||
    deps.now().getTime() - startedAt > PENDING_MINUTES * 60_000
  ) {
    throw new GoogleOAuthError('state_mismatch');
  }
  const tokens = await exchangeCode(
    deps.transport,
    deps.client,
    { code: input.code, codeVerifier: deps.box.open(pending.verifierEnc) },
    deps.now(),
  );
  if (!tokens.refreshToken && !row.refreshTokenEnc) {
    // Without a refresh token the connection would die within the hour.
    throw new GoogleOAuthError('no_refresh_token');
  }
  await deps.db
    .update(googleWorkspaceConnections)
    .set({
      ...tokenColumns(deps, tokens, row),
      state: 'connected',
      pending: null,
      lastError: null,
      connectedAt: deps.now(),
      updatedAt: deps.now(),
    })
    .where(eq(googleWorkspaceConnections.id, row.id));
}

export async function failConnect(
  deps: GoogleWorkspaceDeps,
  employeeId: string,
  code: string,
): Promise<void> {
  const row = await connectionOf(deps, employeeId);
  if (!row) return;
  await deps.db
    .update(googleWorkspaceConnections)
    .set({ pending: null, lastError: code, updatedAt: deps.now() })
    .where(eq(googleWorkspaceConnections.id, row.id));
}

/** Forgets the tokens (and tells Google to), so the next use asks for consent again. */
export async function disconnect(deps: GoogleWorkspaceDeps, employeeId: string): Promise<void> {
  const row = await connectionOf(deps, employeeId);
  if (!row) return;
  const token = row.refreshTokenEnc ?? row.accessTokenEnc;
  if (token) {
    try {
      await revokeToken(deps.transport, deps.box.open(token));
    } catch {
      // A token we cannot even open is forgotten all the same.
    }
  }
  await deps.db.delete(googleWorkspaceConnections).where(eq(googleWorkspaceConnections.id, row.id));
}

export interface GoogleAccess {
  accessToken: string;
  email: string | null;
}

/**
 * A usable access token of this person, refreshed under a row lock when it is
 * about to expire. Throws `not_connected` (no connection) or `needs_reconnect`
 * (Google refused the refresh: the person revoked it, or the password changed).
 */
export async function accessTokenFor(
  deps: GoogleWorkspaceDeps,
  employeeId: string,
): Promise<GoogleAccess> {
  const current = await connectionOf(deps, employeeId);
  if (!current || current.state !== 'connected' || !current.refreshTokenEnc) {
    throw new GoogleOAuthError(
      current?.state === 'needs_reconnect' ? 'needs_reconnect' : 'not_connected',
    );
  }
  const fresh = (row: Row) =>
    row.accessTokenEnc &&
    row.accessExpiresAt &&
    row.accessExpiresAt.getTime() - deps.now().getTime() > REFRESH_MARGIN_MS;
  if (fresh(current)) {
    return { accessToken: deps.box.open(current.accessTokenEnc!), email: current.googleEmail };
  }
  return deps.db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(googleWorkspaceConnections)
      .where(eq(googleWorkspaceConnections.id, current.id))
      .for('update');
    if (!row || row.state !== 'connected' || !row.refreshTokenEnc) {
      throw new GoogleOAuthError('not_connected');
    }
    if (fresh(row)) {
      return { accessToken: deps.box.open(row.accessTokenEnc!), email: row.googleEmail };
    }
    let tokens: GoogleTokens;
    try {
      tokens = await refreshTokens(
        deps.transport,
        deps.client,
        deps.box.open(row.refreshTokenEnc),
        deps.now(),
      );
    } catch (error) {
      if (error instanceof GoogleOAuthError && error.code === 'invalid_grant') {
        await tx
          .update(googleWorkspaceConnections)
          .set({ state: 'needs_reconnect', lastError: 'invalid_grant', updatedAt: deps.now() })
          .where(eq(googleWorkspaceConnections.id, row.id));
        throw new GoogleOAuthError('needs_reconnect');
      }
      throw error;
    }
    await tx
      .update(googleWorkspaceConnections)
      .set({ ...tokenColumns(deps, tokens, row), lastError: null, updatedAt: deps.now() })
      .where(eq(googleWorkspaceConnections.id, row.id));
    return { accessToken: tokens.accessToken, email: tokens.email ?? row.googleEmail };
  });
}

/** Whether the leads' replies are read from this mailbox, or the person must connect once more to allow it. */
export const mailReadOf = (deps: GoogleWorkspaceDeps | null, scopes: string[]) =>
  deps?.env.CRM_EMAIL_REPLIES_ENABLED !== 'true'
    ? ('off' as const)
    : scopes.includes(GMAIL_READ_SCOPE)
      ? ('on' as const)
      : ('reconnect' as const);

/** `mailReadOf` for one person, from their stored consent (no call to Google). */
export async function mailReadFor(deps: GoogleWorkspaceDeps | null, employeeId: string) {
  const row = deps ? await connectionOf(deps, employeeId) : undefined;
  return row?.state === 'connected' ? mailReadOf(deps, row.scopes) : ('off' as const);
}

/** What the account page shows: connected as whom, and which calendars events may go to. */
export async function statusFor(
  deps: GoogleWorkspaceDeps | null,
  employeeId: string,
): Promise<GoogleWorkspaceStatus> {
  const base: GoogleWorkspaceStatus = {
    configured: deps !== null,
    state: 'disconnected',
    email: null,
    scopes: [],
    calendars: { mine: null, wings: null },
    wingsCalendarConfigured: Boolean(deps?.env.GOOGLE_WORKSPACE_WINGS_CALENDAR_ID),
    lastError: null,
    mailRead: 'off',
  };
  if (!deps) return base;
  const row = await connectionOf(deps, employeeId);
  if (!row) return base;
  base.lastError = row.lastError;
  base.email = row.googleEmail;
  base.scopes = row.scopes;
  base.mailRead = mailReadOf(deps, row.scopes);
  if (row.state === 'needs_reconnect') return { ...base, state: 'needs_reconnect' };
  if (row.state !== 'connected' || !row.refreshTokenEnc) {
    return { ...base, state: row.pending ? 'pending' : 'disconnected' };
  }
  let access: GoogleAccess;
  try {
    access = await accessTokenFor(deps, employeeId);
  } catch (error) {
    if (error instanceof GoogleOAuthError && error.code === 'needs_reconnect') {
      return { ...base, state: 'needs_reconnect', lastError: 'invalid_grant' };
    }
    return { ...base, state: 'connected', lastError: 'google_unreachable' };
  }
  try {
    const calendars = await listCalendars(deps.transport, access.accessToken);
    const wingsId = deps.env.GOOGLE_WORKSPACE_WINGS_CALENDAR_ID ?? null;
    const mine = calendars.find((c) => c.primary) ?? null;
    const wings = wingsId ? (calendars.find((c) => c.id === wingsId) ?? null) : null;
    return {
      ...base,
      state: 'connected',
      calendars: {
        mine: mine ? { id: 'primary', name: mine.summary } : null,
        wings: wingsId
          ? {
              id: wingsId,
              name: wings?.summary ?? 'Wings Company',
              access: !wings
                ? 'none'
                : wings.accessRole === 'owner' || wings.accessRole === 'writer'
                  ? 'writer'
                  : 'reader',
            }
          : null,
      },
    };
  } catch (error) {
    return {
      ...base,
      state: 'connected',
      lastError:
        error instanceof GoogleCalendarError ? `calendar_${error.code}` : 'calendar_failed',
    };
  }
}

/** For the scheduler and the account page: everyone connected, by employee id. */
export async function connectedEmployeeIds(deps: GoogleWorkspaceDeps): Promise<string[]> {
  const rows = await deps.db
    .select({ employeeId: googleWorkspaceConnections.employeeId })
    .from(googleWorkspaceConnections)
    .where(sql`${googleWorkspaceConnections.state} = 'connected'`);
  return rows.map((r) => r.employeeId);
}
