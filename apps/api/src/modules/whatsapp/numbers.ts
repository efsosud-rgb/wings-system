import {
  WA_SYNC_WINDOW_HOURS,
  type WaNumber,
  type WaNumberConnect,
  type WaNumberStatus,
  type WaSignupConfig,
  type WaSyncState,
} from '@wings/shared';
import { and, eq, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { Database } from '../../db/client.js';
import { employees, waNumbers } from '../../db/schema/index.js';
import type { Env } from '../../env.js';
import { createSecretBox, type SecretBox } from '../../lib/secret-box.js';
import { listSellers } from '../leads/crm.js';
import {
  exchangeSignupCode,
  readWabaNumbers,
  readWabaOwner,
  requestSmbSync,
  subscribeWaba,
  WHATSAPP_GRAPH_VERSION,
  type GraphBusinessNumber,
} from './graph.js';
import type { WaChange } from './webhook-parse.js';

/**
 * Connecting a seller's own WhatsApp Business number by coexistence
 * (docs/whatsapp/conectar-numero.md). The browser runs Meta's Embedded Signup and hands over
 * the code and the WABA; here the code becomes the business token, the WABA's numbers are read
 * with it (so an id from the browser is believed only if Meta shows it), our app subscribes to
 * the WABA's webhooks, and the contacts and the history are asked for, each once, within 24 h.
 * The token is sealed at once and never leaves the API.
 */

export interface NumbersDeps {
  db: Database;
  box: SecretBox;
  app: { appId: string; appSecret: string };
  fetchImpl: typeof fetch;
  now: () => Date;
}

/** The variables a connection needs, by name; the screen says which are missing. */
export function missingForSignup(env: Env): string[] {
  const needed = {
    WHATSAPP_APP_ID: env.WHATSAPP_APP_ID,
    WHATSAPP_APP_SECRET: env.WHATSAPP_APP_SECRET,
    WHATSAPP_ES_CONFIG_ID: env.WHATSAPP_ES_CONFIG_ID,
    INTEGRATIONS_ENCRYPTION_KEY: env.INTEGRATIONS_ENCRYPTION_KEY,
  };
  return Object.entries(needed)
    .filter(([, value]) => !value)
    .map(([name]) => name);
}

export function signupConfigOf(env: Env): WaSignupConfig | null {
  if (missingForSignup(env).length > 0 || !env.WHATSAPP_APP_ID || !env.WHATSAPP_ES_CONFIG_ID)
    return null;
  return {
    appId: env.WHATSAPP_APP_ID,
    configId: env.WHATSAPP_ES_CONFIG_ID,
    graphVersion: WHATSAPP_GRAPH_VERSION,
  };
}

/** Null while a variable is missing: the routes answer 503. */
export function numbersDepsOf(wings: {
  db: Database;
  env: Env;
  whatsappFetch?: typeof fetch;
  now?: () => Date;
}): NumbersDeps | null {
  const { env } = wings;
  if (!signupConfigOf(env) || !env.INTEGRATIONS_ENCRYPTION_KEY || !env.WHATSAPP_APP_ID) return null;
  if (!env.WHATSAPP_APP_SECRET) return null;
  return {
    db: wings.db,
    box: createSecretBox(env.INTEGRATIONS_ENCRYPTION_KEY),
    app: { appId: env.WHATSAPP_APP_ID, appSecret: env.WHATSAPP_APP_SECRET },
    fetchImpl: wings.whatsappFetch ?? fetch,
    now: wings.now ?? (() => new Date()),
  };
}

export type ConnectErrorCode =
  | 'owner_invalid'
  | 'code_refused'
  | 'waba_unreadable'
  | 'number_not_found'
  | 'number_ambiguous'
  | 'not_business_app'
  | 'not_found'
  | 'sync_expired';

export class ConnectError extends Error {
  constructor(
    readonly code: ConnectErrorCode,
    /** Meta's error code, when Meta refused. */
    readonly metaCode: number | null = null,
  ) {
    super(code);
  }
}

type Row = typeof waNumbers.$inferSelect;

const deadlineOf = (row: Pick<Row, 'connectedAt'>) =>
  new Date(row.connectedAt.getTime() + WA_SYNC_WINDOW_HOURS * 3_600_000);

/** Every number, the newest connection first. Never the token. */
export async function listNumbers(db: Database): Promise<WaNumber[]> {
  const owner = alias(employees, 'owner');
  const by = alias(employees, 'connected_by');
  const rows = await db
    .select({ row: waNumbers, ownerName: owner.fullName, byName: by.fullName })
    .from(waNumbers)
    .leftJoin(owner, eq(owner.id, waNumbers.ownerEmployeeId))
    .leftJoin(by, eq(by.id, waNumbers.connectedBy))
    .orderBy(sql`${waNumbers.connectedAt} desc`);
  return rows.map(({ row, ownerName, byName }) => numberOf(row, ownerName, byName));
}

function numberOf(row: Row, ownerName: string | null, byName: string | null): WaNumber {
  return {
    id: row.id,
    phoneNumberId: row.phoneNumberId,
    wabaId: row.wabaId,
    businessId: row.businessId,
    displayPhone: row.displayPhone,
    verifiedName: row.verifiedName,
    ownerEmployeeId: row.ownerEmployeeId,
    ownerName,
    status: row.status as WaNumberStatus,
    connectedAt: row.connectedAt.toISOString(),
    connectedByName: byName,
    disconnectReason: row.disconnectReason,
    disconnectedAt: row.disconnectedAt?.toISOString() ?? null,
    webhooksSubscribed: row.webhooksSubscribed,
    contactsSync: row.contactsSync as WaSyncState | null,
    historySync: row.historySync as WaSyncState | null,
    historyProgress: row.historyProgress,
    syncDeadline: deadlineOf(row).toISOString(),
  };
}

/** Which of the WABA's numbers is the one connected: the browser's, if Meta lists it. */
function pickNumber(
  listed: GraphBusinessNumber[],
  wanted: string | undefined,
): GraphBusinessNumber & { id: string } {
  const numbers = listed.filter(
    (n): n is GraphBusinessNumber & { id: string } =>
      typeof n.id === 'string' && /^\d+$/.test(n.id),
  );
  if (wanted) {
    const found = numbers.find((n) => n.id === wanted);
    if (!found) throw new ConnectError('number_not_found');
    return found;
  }
  const inApp = numbers.filter((n) => n.is_on_biz_app === true);
  const only = numbers.length === 1 ? numbers[0] : inApp.length === 1 ? inApp[0] : undefined;
  if (only) return only;
  throw new ConnectError(numbers.length === 0 ? 'number_not_found' : 'number_ambiguous');
}

/**
 * The browser's half of Embedded Signup becomes a connected number. Everything before the row is
 * written is a read (or the code exchange), so a refusal there leaves nothing behind. Connecting
 * the same number again (after it left) replaces its token and starts its 24 hours anew.
 */
export async function connectNumber(
  deps: NumbersDeps,
  input: WaNumberConnect,
  actorId: string,
): Promise<{ number: WaNumber; steps: FinishSteps }> {
  const owner = (await listSellers(deps.db)).find(
    (seller) => seller.id === input.ownerEmployeeId && seller.active,
  );
  if (!owner) throw new ConnectError('owner_invalid');

  // First: the code dies 30 seconds after Meta issued it.
  const exchanged = await exchangeSignupCode(deps.fetchImpl, deps.app, input.code);
  if (!exchanged.ok) throw new ConnectError('code_refused', exchanged.code);
  const token = exchanged.data;

  const listed = await readWabaNumbers(deps.fetchImpl, token, input.wabaId);
  if (!listed.ok) throw new ConnectError('waba_unreadable', listed.code);
  const number = pickNumber(listed.data, input.phoneNumberId);
  // Only a number that stays in the WhatsApp Business app is connected here; a new number
  // needs Meta's registration, which this screen does not do. A missing field is not a "no".
  if (number.is_on_biz_app === false) throw new ConnectError('not_business_app');
  const owned = await readWabaOwner(deps.fetchImpl, token, input.wabaId);

  const now = deps.now();
  const fresh = {
    wabaId: input.wabaId,
    businessId: owned.ok ? owned.data : null,
    displayPhone: number.display_phone_number?.slice(0, 40) ?? null,
    verifiedName: number.verified_name?.slice(0, 200) ?? null,
    ownerEmployeeId: owner.id,
    tokenEnc: deps.box.seal(token),
    status: 'connected',
    connectedBy: actorId,
    connectedAt: now,
    disconnectReason: null,
    disconnectedAt: null,
    webhooksSubscribed: false,
    contactsSync: null,
    contactsSyncRequest: null,
    historySync: null,
    historySyncRequest: null,
    historyProgress: null,
    updatedAt: now,
  };
  const [row] = await deps.db
    .insert(waNumbers)
    .values({ phoneNumberId: number.id, ...fresh })
    .onConflictDoUpdate({ target: [waNumbers.tenantId, waNumbers.phoneNumberId], set: fresh })
    .returning();
  const steps = await finishConnection(deps, row!, token);
  return { number: await numberById(deps.db, row!.id), steps };
}

export interface FinishSteps {
  webhooks: 'ok' | 'failed';
  contacts: WaSyncState | 'skipped' | null;
  history: WaSyncState | 'skipped' | null;
}

/**
 * Subscribe, then the contacts, then the history — in that order, because a sync sent before the
 * subscription would deliver its webhooks to nobody. Stops at the first failure. A sync already
 * requested, or with no answer from Meta (`unknown`), is never sent again.
 */
async function finishConnection(deps: NumbersDeps, row: Row, token: string): Promise<FinishSteps> {
  const steps: FinishSteps = {
    webhooks: 'ok',
    contacts: row.contactsSync as WaSyncState | null,
    history: row.historySync as WaSyncState | null,
  };
  const set = (values: Partial<typeof waNumbers.$inferInsert>) =>
    deps.db
      .update(waNumbers)
      .set({ ...values, updatedAt: deps.now() })
      .where(eq(waNumbers.id, row.id));

  if (!row.webhooksSubscribed) {
    const subscribed = await subscribeWaba(deps.fetchImpl, token, row.wabaId);
    if (!subscribed.ok || !subscribed.data) {
      steps.webhooks = 'failed';
      return {
        ...steps,
        contacts: steps.contacts ?? 'skipped',
        history: steps.history ?? 'skipped',
      };
    }
    await set({ webhooksSubscribed: true });
  }

  const sync = async (type: 'contacts' | 'history'): Promise<WaSyncState> => {
    const result = await requestSmbSync(
      deps.fetchImpl,
      token,
      row.phoneNumberId,
      type === 'contacts' ? 'smb_app_state_sync' : 'history',
    );
    const state: WaSyncState = result.ok ? 'requested' : result.unknown ? 'unknown' : 'failed';
    await set(
      type === 'contacts'
        ? { contactsSync: state, contactsSyncRequest: result.ok ? result.data : null }
        : { historySync: state, historySyncRequest: result.ok ? result.data : null },
    );
    return state;
  };
  if (steps.contacts === null || steps.contacts === 'failed') {
    steps.contacts = await sync('contacts');
    if (steps.contacts !== 'requested') return { ...steps, history: steps.history ?? 'skipped' };
  }
  if (steps.history === null || steps.history === 'failed') steps.history = await sync('history');
  return steps;
}

/**
 * "Tentar de novo" on the screen: the steps that failed, while the 24 hours last. Never one
 * that went through or that Meta did not answer.
 */
export async function retryConnection(
  deps: NumbersDeps,
  id: string,
): Promise<{ number: WaNumber; steps: FinishSteps }> {
  const row = await deps.db.query.waNumbers.findFirst({ where: eq(waNumbers.id, id) });
  if (!row || row.status !== 'connected') throw new ConnectError('not_found');
  if (deps.now() > deadlineOf(row)) throw new ConnectError('sync_expired');
  const steps = await finishConnection(deps, row, deps.box.open(row.tokenEnc));
  return { number: await numberById(deps.db, row.id), steps };
}

async function numberById(db: Database, id: string): Promise<WaNumber> {
  const found = (await listNumbers(db)).find((n) => n.id === id);
  if (!found) throw new ConnectError('not_found');
  return found;
}

const LEFT = new Set(['ACCOUNT_OFFBOARDED', 'PARTNER_REMOVED']);

/**
 * What Meta's webhook says about a connected number (from the queue, `intake.ts`): it left
 * (offboarded on the phone, or removed for inactivity), or how far its history is.
 * A change for a WABA or number that is not ours does nothing.
 */
export async function applyNumberChange(db: Database, change: WaChange, now: Date) {
  if (change.account && change.wabaId) {
    const { event, reason } = change.account;
    // Coming back is a new Embedded Signup on the screen (`connectNumber`), with a new token.
    if (LEFT.has(event))
      await db
        .update(waNumbers)
        .set({
          status: 'disconnected',
          disconnectReason: reason ? `${event}: ${reason}` : event,
          disconnectedAt: now,
          updatedAt: now,
        })
        .where(and(eq(waNumbers.wabaId, change.wabaId), eq(waNumbers.status, 'connected')));
  }
  if (change.historyProgress !== null) {
    const which = change.phoneNumberId
      ? eq(waNumbers.phoneNumberId, change.phoneNumberId)
      : change.wabaId
        ? eq(waNumbers.wabaId, change.wabaId)
        : null;
    if (which)
      await db
        .update(waNumbers)
        .set({
          historyProgress: sql`greatest(coalesce(${waNumbers.historyProgress}, 0), ${change.historyProgress})`,
          updatedAt: now,
        })
        .where(which);
  }
}
