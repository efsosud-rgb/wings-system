import {
  brazilianPhoneVariants,
  WA_SYNC_WINDOW_HOURS,
  type SectorSlug,
  type WaNumber,
  type WaNumberCheck,
  type WaNumberConnect,
  type WaNumberEligibility,
  type WaNumberRegister,
  type WaNumberStatus,
  type WaNumberUpdate,
  type WaSignupConfig,
  type WaSyncState,
} from '@wings/shared';
import { and, asc, eq, isNull, lt, ne, or, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { Database } from '../../db/client.js';
import { employees, waNumbers } from '../../db/schema/index.js';
import type { Env } from '../../env.js';
import { createSecretBox, type SecretBox } from '../../lib/secret-box.js';
import {
  exchangeSignupCode,
  readWabaNumbers,
  readWabaOwner,
  refreshBusinessToken,
  requestSmbSync,
  subscribeWaba,
  WHATSAPP_GRAPH_VERSION,
  type GraphBusinessNumber,
  type WhatsAppConfig,
} from './graph.js';
import type { WaChange } from './webhook-parse.js';

/**
 * The company's work numbers (docs/whatsapp/central.md, conectar-numero.md). An Admin Master
 * registers each one first (owner, department, the phone checks); connecting it by coexistence
 * comes later, on the registered row. The browser runs Meta's Embedded Signup and hands over the
 * code and the WABA; here the code becomes the business token, the WABA's numbers are read with it
 * (so an id from the browser is believed only if Meta shows it, and only the registered number is
 * taken), our app subscribes to the WABA's webhooks, and the contacts and the history are asked
 * for, each once, within 24 h. The token is sealed at once and never leaves the API. The official
 * number is never a work number: taken as one, all its messages would be skipped without a word.
 */

/** The official number, as the environment names it: never registered nor connected here. */
export interface OfficialNumber {
  phoneNumberId: string | null;
  wabaId: string | null;
  /** WINGS_WHATSAPP_NUMBER: 55 + DDD + number. */
  phone: string | null;
}

export const officialNumberOf = (env: Env): OfficialNumber => ({
  phoneNumberId: env.WHATSAPP_PHONE_NUMBER_ID ?? null,
  wabaId: env.WHATSAPP_WABA_ID ?? null,
  phone: env.WINGS_WHATSAPP_NUMBER ?? null,
});

const samePhone = (a: string | null | undefined, b: string | null | undefined) =>
  Boolean(a && b && brazilianPhoneVariants(a).some((v) => brazilianPhoneVariants(b).includes(v)));

export interface NumbersDeps {
  db: Database;
  box: SecretBox;
  app: { appId: string; appSecret: string };
  official: OfficialNumber;
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
    official: officialNumberOf(env),
    fetchImpl: wings.whatsappFetch ?? fetch,
    now: wings.now ?? (() => new Date()),
  };
}

export type ConnectErrorCode =
  | 'owner_invalid'
  | 'official_number'
  | 'phone_taken'
  | 'phone_locked'
  | 'number_mismatch'
  | 'not_registered'
  | 'not_eligible'
  | 'code_refused'
  | 'waba_unreadable'
  | 'number_not_found'
  | 'number_ambiguous'
  | 'not_business_app'
  | 'not_found'
  | 'sync_expired'
  | 'busy';

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

const deadlineOf = (connectedAt: Date) =>
  new Date(connectedAt.getTime() + WA_SYNC_WINDOW_HOURS * 3_600_000);

/** Every number, the newest registry first. Never the token. */
export async function listNumbers(db: Database): Promise<WaNumber[]> {
  const owner = alias(employees, 'owner');
  const by = alias(employees, 'connected_by');
  const rows = await db
    .select({ row: waNumbers, ownerName: owner.fullName, byName: by.fullName })
    .from(waNumbers)
    .leftJoin(owner, eq(owner.id, waNumbers.ownerEmployeeId))
    .leftJoin(by, eq(by.id, waNumbers.connectedBy))
    .orderBy(sql`${waNumbers.createdAt} desc`);
  return rows.map(({ row, ownerName, byName }) => numberOf(row, ownerName, byName));
}

function numberOf(row: Row, ownerName: string | null, byName: string | null): WaNumber {
  return {
    id: row.id,
    phone: row.phone,
    label: row.label,
    sector: row.sector as SectorSlug | null,
    eligibility: row.eligibility as WaNumberEligibility,
    eligibilityNotes: row.eligibilityNotes,
    checks: row.checks as WaNumberCheck[],
    phoneNumberId: row.phoneNumberId,
    wabaId: row.wabaId,
    businessId: row.businessId,
    displayPhone: row.displayPhone,
    verifiedName: row.verifiedName,
    ownerEmployeeId: row.ownerEmployeeId,
    ownerName,
    status: row.status as WaNumberStatus,
    connectedAt: row.connectedAt?.toISOString() ?? null,
    connectedByName: byName,
    tokenExpiresAt: row.tokenExpiresAt?.toISOString() ?? null,
    tokenRenewTriedAt: row.tokenRenewTriedAt?.toISOString() ?? null,
    tokenRenewError: row.tokenRenewError,
    disconnectReason: row.disconnectReason,
    disconnectedAt: row.disconnectedAt?.toISOString() ?? null,
    webhooksSubscribed: row.webhooksSubscribed,
    contactsSync: row.contactsSync as WaSyncState | null,
    historySync: row.historySync as WaSyncState | null,
    historyProgress: row.historyProgress,
    syncDeadline: row.connectedAt ? deadlineOf(row.connectedAt).toISOString() : null,
  };
}

/** Who may own a number: any active employee (sellers, Diretoria, the Admin). */
export async function activePeople(db: Database) {
  return db
    .select({ id: employees.id, name: employees.fullName })
    .from(employees)
    .where(eq(employees.status, 'active'))
    .orderBy(asc(employees.fullName));
}

async function activeOwner(db: Database, id: string) {
  const owner = await db.query.employees.findFirst({
    where: and(eq(employees.id, id), eq(employees.status, 'active')),
    columns: { id: true },
  });
  if (!owner) throw new ConnectError('owner_invalid');
}

// drizzle wraps the driver's error: its code is on `cause`.
const isUniqueViolation = (error: unknown) => {
  const found = error as { code?: unknown; cause?: { code?: unknown } } | null;
  return found?.code === '23505' || found?.cause?.code === '23505';
};

/** The Admin Master's registry: a number before (or without) its connection. */
export async function registerNumber(
  db: Database,
  official: OfficialNumber,
  input: WaNumberRegister,
  actorId: string,
): Promise<WaNumber> {
  if (samePhone(input.phone, official.phone)) throw new ConnectError('official_number');
  await activeOwner(db, input.ownerEmployeeId);
  try {
    const [row] = await db
      .insert(waNumbers)
      .values({
        phone: input.phone,
        label: input.label,
        ownerEmployeeId: input.ownerEmployeeId,
        sector: input.sector ?? null,
        eligibility: input.eligibility ?? 'a_confirmar',
        eligibilityNotes: input.eligibilityNotes ?? null,
        checks: input.checks ?? [],
        createdBy: actorId,
      })
      .returning({ id: waNumbers.id });
    return await numberById(db, row!.id);
  } catch (error) {
    if (isUniqueViolation(error)) throw new ConnectError('phone_taken');
    throw error;
  }
}

/** Any field of the registry; the number itself only before the connection (then it is Meta's). */
export async function updateNumber(
  db: Database,
  official: OfficialNumber,
  id: string,
  input: WaNumberUpdate,
): Promise<WaNumber> {
  const row = await db.query.waNumbers.findFirst({ where: eq(waNumbers.id, id) });
  if (!row) throw new ConnectError('not_found');
  if (input.phone !== undefined && input.phone !== row.phone) {
    if (row.status !== 'registered') throw new ConnectError('phone_locked');
    if (samePhone(input.phone, official.phone)) throw new ConnectError('official_number');
  }
  if (input.ownerEmployeeId !== undefined) await activeOwner(db, input.ownerEmployeeId);
  try {
    await db
      .update(waNumbers)
      .set({ ...input, updatedAt: new Date() })
      .where(eq(waNumbers.id, id));
  } catch (error) {
    if (isUniqueViolation(error)) throw new ConnectError('phone_taken');
    throw error;
  }
  return numberById(db, id);
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
 * The browser's half of Embedded Signup connects a registered number. Everything before the row is
 * written is a read (or the code exchange), so a refusal there leaves nothing behind. Connecting
 * the same number again (after it left, or for a new token) replaces its token and starts its 24
 * hours anew.
 */
export async function connectNumber(
  deps: NumbersDeps,
  input: WaNumberConnect,
  actorId: string,
): Promise<{ number: WaNumber; steps: FinishSteps }> {
  const registered = await deps.db.query.waNumbers.findFirst({
    where: eq(waNumbers.id, input.numberId),
  });
  if (!registered) throw new ConnectError('not_registered');
  // The registry's check comes first (Eric, 26/10): only a number confirmed for coexistence.
  if (registered.eligibility !== 'confirmado') throw new ConnectError('not_eligible');
  await activeOwner(deps.db, registered.ownerEmployeeId);
  if (input.wabaId === deps.official.wabaId) throw new ConnectError('official_number');
  return reserved(deps, registered.id, () => connectReserved(deps, registered, input, actorId));
}

async function connectReserved(
  deps: NumbersDeps,
  registered: Row,
  input: WaNumberConnect,
  actorId: string,
): Promise<{ number: WaNumber; steps: FinishSteps }> {
  // First: the code dies 30 seconds after Meta issued it.
  const exchanged = await exchangeSignupCode(deps.fetchImpl, deps.app, input.code);
  if (!exchanged.ok) throw new ConnectError('code_refused', exchanged.code);
  const { token, expiresIn } = exchanged.data;

  const listed = await readWabaNumbers(deps.fetchImpl, token, input.wabaId);
  if (!listed.ok) throw new ConnectError('waba_unreadable', listed.code);
  const number = pickNumber(listed.data, input.phoneNumberId);
  if (
    number.id === deps.official.phoneNumberId ||
    samePhone(number.display_phone_number, deps.official.phone)
  )
    throw new ConnectError('official_number');
  // Only the number registered on this row: another one shared in Meta's window is refused.
  if (
    registered.phone &&
    number.display_phone_number &&
    !samePhone(number.display_phone_number, registered.phone)
  )
    throw new ConnectError('number_mismatch');
  // Only a number that stays in the WhatsApp Business app is connected here; a new number
  // needs Meta's registration, which this screen does not do. A missing field is not a "no".
  if (number.is_on_biz_app === false) throw new ConnectError('not_business_app');
  const elsewhere = await deps.db.query.waNumbers.findFirst({
    where: and(eq(waNumbers.phoneNumberId, number.id), ne(waNumbers.id, registered.id)),
    columns: { id: true },
  });
  if (elsewhere) throw new ConnectError('number_mismatch');
  const owned = await readWabaOwner(deps.fetchImpl, token, input.wabaId);

  const now = deps.now();
  await deps.db
    .update(waNumbers)
    .set({
      phoneNumberId: number.id,
      wabaId: input.wabaId,
      businessId: owned.ok ? owned.data : null,
      displayPhone: number.display_phone_number?.slice(0, 40) ?? null,
      verifiedName: number.verified_name?.slice(0, 200) ?? null,
      tokenEnc: deps.box.seal(token),
      tokenExpiresAt: expiresIn ? new Date(now.getTime() + expiresIn * 1000) : null,
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
    })
    .where(eq(waNumbers.id, registered.id));
  const steps = await finishConnection(deps, registered.id, token);
  return { number: await numberById(deps.db, registered.id), steps };
}

export interface FinishSteps {
  webhooks: 'ok' | 'failed';
  contacts: WaSyncState | 'skipped' | null;
  history: WaSyncState | 'skipped' | null;
}

/** Longer than a connection's Meta calls (15 s each); a reservation left by a dead container ends. */
const RESERVE_MS = 2 * 60_000;

/**
 * Runs `work` holding the number's reservation in the row (`connecting_until`), so two
 * connections of one number never run at once, whatever API container takes each request.
 */
async function reserved<T>(deps: NumbersDeps, id: string, work: () => Promise<T>): Promise<T> {
  const now = deps.now();
  const [held] = await deps.db
    .update(waNumbers)
    .set({ connectingUntil: new Date(now.getTime() + RESERVE_MS) })
    .where(
      and(
        eq(waNumbers.id, id),
        or(isNull(waNumbers.connectingUntil), lt(waNumbers.connectingUntil, now)),
      ),
    )
    .returning({ id: waNumbers.id });
  if (!held) throw new ConnectError('busy');
  try {
    return await work();
  } finally {
    await deps.db.update(waNumbers).set({ connectingUntil: null }).where(eq(waNumbers.id, id));
  }
}

/**
 * Subscribe, then the contacts, then the history — in that order, because a sync sent before the
 * subscription would deliver its webhooks to nobody. Stops at the first failure. A sync already
 * requested, or with no answer from Meta (`unknown`), is never sent again; after the 24 hours
 * only the subscription (which has no deadline) is tried. The caller holds the number's
 * reservation (`reserved`), so a one-time sync is never sent twice.
 */
async function finishConnection(
  deps: NumbersDeps,
  id: string,
  token: string,
): Promise<FinishSteps> {
  const row = await deps.db.query.waNumbers.findFirst({ where: eq(waNumbers.id, id) });
  if (!row?.wabaId || !row.phoneNumberId || !row.connectedAt) throw new ConnectError('not_found');
  const { wabaId, phoneNumberId } = row;
  const syncsOpen = deps.now() <= deadlineOf(row.connectedAt);
  const steps: FinishSteps = {
    webhooks: 'ok',
    contacts: row.contactsSync as WaSyncState | null,
    history: row.historySync as WaSyncState | null,
  };
  const skipRest = (): FinishSteps => ({
    ...steps,
    contacts: steps.contacts ?? 'skipped',
    history: steps.history ?? 'skipped',
  });
  const save = (values: Partial<typeof waNumbers.$inferInsert>) =>
    deps.db
      .update(waNumbers)
      .set({ ...values, updatedAt: deps.now() })
      .where(eq(waNumbers.id, row.id));

  if (!row.webhooksSubscribed) {
    const subscribed = await subscribeWaba(deps.fetchImpl, token, wabaId);
    if (!subscribed.ok || !subscribed.data) {
      steps.webhooks = 'failed';
      return skipRest();
    }
    await save({ webhooksSubscribed: true });
  }
  if (!syncsOpen) return skipRest();

  const sync = async (type: 'contacts' | 'history'): Promise<WaSyncState> => {
    const result = await requestSmbSync(
      deps.fetchImpl,
      token,
      phoneNumberId,
      type === 'contacts' ? 'smb_app_state_sync' : 'history',
    );
    const state: WaSyncState = result.ok ? 'requested' : result.unknown ? 'unknown' : 'failed';
    await save(
      type === 'contacts'
        ? { contactsSync: state, contactsSyncRequest: result.ok ? result.data : null }
        : { historySync: state, historySyncRequest: result.ok ? result.data : null },
    );
    return state;
  };
  if (steps.contacts === null || steps.contacts === 'failed') {
    steps.contacts = await sync('contacts');
    if (steps.contacts !== 'requested') return skipRest();
  }
  if (steps.history === null || steps.history === 'failed') steps.history = await sync('history');
  return steps;
}

/** Whether a sync is still owed: not asked for yet, or refused by Meta. */
const syncOwed = (state: string | null) => state === null || state === 'failed';

/**
 * "Tentar de novo" on the screen: the steps that failed. The subscription at any time; the two
 * syncs only inside the 24 hours. Never a sync that went through or that Meta did not answer.
 */
export async function retryConnection(
  deps: NumbersDeps,
  id: string,
): Promise<{ number: WaNumber; steps: FinishSteps }> {
  const row = await deps.db.query.waNumbers.findFirst({ where: eq(waNumbers.id, id) });
  if (!row || row.status !== 'connected' || !row.tokenEnc || !row.connectedAt)
    throw new ConnectError('not_found');
  const syncsLeft = syncOwed(row.contactsSync) || syncOwed(row.historySync);
  if (row.webhooksSubscribed && syncsLeft && deps.now() > deadlineOf(row.connectedAt))
    throw new ConnectError('sync_expired');
  const token = deps.box.open(row.tokenEnc);
  const steps = await reserved(deps, row.id, () => finishConnection(deps, row.id, token));
  return { number: await numberById(deps.db, row.id), steps };
}

/** Ten days before the end: the screen warns, the daily pass renews, the Admin Masters hear. */
export const TOKEN_WARN_DAYS = 10;

/**
 * "Renovar acesso" (and the daily pass, `renewExpiringTokens`): a new 60-day token for a connected
 * number, sealed at once. A refusal keeps the current token and records Meta's code; never the
 * token itself, anywhere.
 */
export async function renewToken(
  deps: NumbersDeps,
  id: string,
): Promise<{ number: WaNumber; renewed: boolean; metaCode: number | null }> {
  const row = await deps.db.query.waNumbers.findFirst({ where: eq(waNumbers.id, id) });
  if (!row || row.status !== 'connected' || !row.tokenEnc) throw new ConnectError('not_found');
  const sealed = row.tokenEnc;
  const result = await reserved(deps, id, async () => {
    const answer = await refreshBusinessToken(deps.fetchImpl, deps.app, deps.box.open(sealed));
    const now = deps.now();
    await deps.db
      .update(waNumbers)
      .set(
        answer.ok
          ? {
              tokenEnc: deps.box.seal(answer.data.token),
              tokenExpiresAt: answer.data.expiresIn
                ? new Date(now.getTime() + answer.data.expiresIn * 1000)
                : null,
              tokenRenewTriedAt: now,
              tokenRenewError: null,
              updatedAt: now,
            }
          : {
              tokenRenewTriedAt: now,
              tokenRenewError: answer.code === null ? 'no_answer' : `meta_${answer.code}`,
              updatedAt: now,
            },
      )
      .where(eq(waNumbers.id, id));
    return answer;
  });
  return {
    number: await numberById(deps.db, id),
    renewed: result.ok,
    metaCode: result.ok ? null : result.code,
  };
}

/** Once a day: each connected number within ten days of its end is renewed (one try a day). */
export async function renewExpiringTokens(
  deps: NumbersDeps,
  log: (facts: Record<string, unknown>) => void,
) {
  const now = deps.now();
  const due = await deps.db
    .select({ id: waNumbers.id })
    .from(waNumbers)
    .where(
      and(
        eq(waNumbers.status, 'connected'),
        lt(waNumbers.tokenExpiresAt, new Date(now.getTime() + TOKEN_WARN_DAYS * 86_400_000)),
        or(
          isNull(waNumbers.tokenRenewTriedAt),
          lt(waNumbers.tokenRenewTriedAt, new Date(now.getTime() - 20 * 3_600_000)),
        ),
      ),
    );
  for (const { id } of due) {
    try {
      const { renewed, metaCode } = await renewToken(deps, id);
      log({ job: 'whatsapp_token', number: id, renewed, ...(metaCode ? { metaCode } : {}) });
    } catch (error) {
      log({
        job: 'whatsapp_token',
        number: id,
        error: error instanceof ConnectError ? error.code : 'error',
      });
    }
  }
}

async function numberById(db: Database, id: string): Promise<WaNumber> {
  const found = (await listNumbers(db)).find((n) => n.id === id);
  if (!found) throw new ConnectError('not_found');
  return found;
}

/**
 * The work number a webhook change is about, rather than the official one: by its number when it
 * names one, else by its WABA (unless that is the official number's WABA). The official number
 * itself never counts, even if a row names it.
 */
export async function workNumberOf(
  db: Database,
  change: WaChange,
  official: Pick<OfficialNumber, 'phoneNumberId' | 'wabaId'>,
): Promise<{ id: string; status: string } | null> {
  if (change.phoneNumberId && change.phoneNumberId === official.phoneNumberId) return null;
  const which = change.phoneNumberId
    ? eq(waNumbers.phoneNumberId, change.phoneNumberId)
    : change.wabaId && change.wabaId !== official.wabaId
      ? eq(waNumbers.wabaId, change.wabaId)
      : null;
  if (!which) return null;
  const found = await db.query.waNumbers.findFirst({
    where: which,
    columns: { id: true, status: true },
  });
  return found ?? null;
}

/** How a send or a file read goes through a connected work number: its own id and token. */
export async function numberConfigOf(
  db: Database,
  box: SecretBox | null,
  numberId: string,
): Promise<WhatsAppConfig | null> {
  const row = await db.query.waNumbers.findFirst({ where: eq(waNumbers.id, numberId) });
  if (!box || !row || row.status !== 'connected' || !row.tokenEnc || !row.phoneNumberId)
    return null;
  return { token: box.open(row.tokenEnc), phoneNumberId: row.phoneNumberId, wabaId: row.wabaId };
}

const LEFT = new Set(['ACCOUNT_OFFBOARDED', 'PARTNER_REMOVED']);

/**
 * What Meta's webhook says about a connected number (from the queue, `intake.ts`): it left
 * (offboarded on the phone, or removed for inactivity), how far its history is, or that the owner
 * said no to the history. A change for a WABA or number that is not ours does nothing.
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
  if (change.historyProgress !== null || change.historyDeclined) {
    const which = change.phoneNumberId
      ? eq(waNumbers.phoneNumberId, change.phoneNumberId)
      : change.wabaId
        ? eq(waNumbers.wabaId, change.wabaId)
        : null;
    if (which)
      await db
        .update(waNumbers)
        .set({
          ...(change.historyProgress !== null
            ? {
                historyProgress: sql`greatest(coalesce(${waNumbers.historyProgress}, 0), ${change.historyProgress})`,
              }
            : {}),
          // The owner said no to the history on the phone (Meta's 2593109): it will not come.
          ...(change.historyDeclined ? { historySync: 'declined' } : {}),
          updatedAt: now,
        })
        .where(which);
  }
}
