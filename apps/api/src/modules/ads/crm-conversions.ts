import type { AdIdentifierKind, ConversionPlatform, ConversionSkipReason } from '@wings/shared';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import { adConversionSends, leadAdIdentifiers, leads } from '../../db/schema/index.js';
import type { Env } from '../../env.js';
import { leadContactOptOuts } from '../leads/contact-block.js';
import {
  googleAccessToken,
  googleEventOf,
  metaEventOf,
  sendGoogleEvent,
  sendMetaEvent,
  type BuiltEvent,
  type MatchKeys,
  type SendOutcome,
} from './crm-conversions-clients.js';

/**
 * Closing the loop (docs/ads/fechar-ciclo.md). A cycle in the API process:
 *
 * 1. `enqueueStageEvents` writes one outbox row per lead, stage and platform for
 *    the first entry of a lead in a configured stage (`ad_conversion_stage_events`),
 *    from `lead_stage_history`. The unique index makes a repeat a no-op.
 * 2. `dispatchDue` claims the rows that are due, reads what matches the lead,
 *    hashes e-mail and phone in memory when allowed, sends one event per call
 *    and writes the outcome: sent, back to the queue with a delay (a failure a
 *    new try cannot double), failed (refused, or may have arrived), or skipped.
 *
 * Each platform has its own switch and nothing is queued or sent while it is
 * off, before CRM_CONVERSIONS_SINCE, or without its credentials. Logs carry
 * counts and codes only.
 */

const DAY_MS = 86_400_000;
/** Meta refuses an event older than 7 days (and the whole batch with it). */
const META_MAX_AGE_MS = 7 * DAY_MS;
/** Google takes a click's conversion up to 90 days after the click; 63 with hashed data only. */
const GOOGLE_CLICK_MS = 90 * DAY_MS;
const GOOGLE_HASHED_MS = 63 * DAY_MS;
export const MAX_ATTEMPTS = 6;
const BATCH = 50;
/** A row left `sending` this long belongs to a process that died midway. */
const STALE_SENDING_MS = 15 * 60_000;
/** Only changes made here by a person or Sofia: an import or the RD mirror does not carry the real moment. */
const SENT_CHANGE_SOURCES = ['wings', 'sofia'];
/** Doors whose leads did not come from an ad, or were typed in by hand. */
const NEVER_SENT_LEAD_SOURCES = ['manual', 'csv_import', 'google_places', 'instagram_colagem'];

export interface ConversionsDeps {
  db: Database;
  env: Env;
  fetchImpl: typeof fetch;
  log: (facts: Record<string, unknown>) => void;
}

/** CRM_CONVERSIONS_SINCE as midnight in Brasília; null when unset. */
export function conversionsSince(env: Env): Date | null {
  return env.CRM_CONVERSIONS_SINCE ? new Date(`${env.CRM_CONVERSIONS_SINCE}T03:00:00Z`) : null;
}

export function platformEnabled(env: Env, platform: ConversionPlatform): boolean {
  return platform === 'meta'
    ? env.CRM_CONVERSIONS_META_ENABLED === 'true'
    : env.CRM_CONVERSIONS_GOOGLE_ENABLED === 'true';
}

/** What a platform still lacks to send, by variable name; empty when it can. */
export function missingConfig(env: Env, platform: ConversionPlatform): string[] {
  const needed: [string, string | undefined][] =
    platform === 'meta'
      ? [
          ['CRM_CONVERSIONS_META_DATASET_ID', env.CRM_CONVERSIONS_META_DATASET_ID],
          ['META_CAPI_TOKEN', env.META_CAPI_TOKEN],
        ]
      : [
          ['GOOGLE_ADS_CUSTOMER_ID', env.GOOGLE_ADS_CUSTOMER_ID],
          ['GOOGLE_ADS_CLIENT_ID', env.GOOGLE_ADS_CLIENT_ID],
          ['GOOGLE_ADS_CLIENT_SECRET', env.GOOGLE_ADS_CLIENT_SECRET],
          ['CRM_CONVERSIONS_GOOGLE_REFRESH_TOKEN', env.CRM_CONVERSIONS_GOOGLE_REFRESH_TOKEN],
        ];
  const missing = needed.filter(([, value]) => !value).map(([name]) => name);
  return env.CRM_CONVERSIONS_SINCE ? missing : ['CRM_CONVERSIONS_SINCE', ...missing];
}

const ready = (env: Env, platform: ConversionPlatform) =>
  platformEnabled(env, platform) && missingConfig(env, platform).length === 0;

/** Writes the outbox rows owed for one platform; answers how many are new. */
export async function enqueueStageEvents(
  db: Database,
  env: Env,
  platform: ConversionPlatform,
  now: Date,
): Promise<number> {
  const since = conversionsSince(env);
  if (!ready(env, platform) || !since) return 0;
  const windowStart = new Date(
    now.getTime() - (platform === 'meta' ? META_MAX_AGE_MS : GOOGLE_CLICK_MS),
  );
  const from = since > windowStart ? since : windowStart;
  const destination =
    platform === 'meta'
      ? sql`${env.CRM_CONVERSIONS_META_DATASET_ID ?? null}::text`
      : sql`m.google_conversion_action_id`;
  // The first entry of each lead in each mapped stage, whatever made it: going back and in again
  // never counts, nor does a first entry from before the cut-off.
  const result = await db.execute(sql`
    insert into ad_conversion_sends
      (tenant_id, lead_id, stage_id, history_id, platform, event_name, destination, event_time)
    select f.tenant_id, f.lead_id, f.to_stage_id, f.id, m.platform, m.event_name, ${destination}, f.at
    from (
      select distinct on (h.lead_id, h.to_stage_id) h.id, h.tenant_id, h.lead_id, h.to_stage_id, h.at, h.source
      from lead_stage_history h
      where h.to_stage_id in (
        select stage_id from ad_conversion_stage_events where platform = ${platform} and active
      )
      order by h.lead_id, h.to_stage_id, h.at asc, h.id asc
    ) f
    join ad_conversion_stage_events m
      on m.stage_id = f.to_stage_id and m.platform = ${platform} and m.active
    join leads l on l.id = f.lead_id
    where f.at >= ${from.toISOString()}::timestamptz
      and f.source in (${sql.join(
        SENT_CHANGE_SOURCES.map((s) => sql`${s}`),
        sql`, `,
      )})
      and l.import_batch_id is null
      and l.source not in (${sql.join(
        NEVER_SENT_LEAD_SOURCES.map((s) => sql`${s}`),
        sql`, `,
      )})
    on conflict (lead_id, stage_id, platform) do nothing
  `);
  return result.rowCount ?? 0;
}

type SendRow = typeof adConversionSends.$inferSelect;

/** Claims the due rows of one platform; two cycles at once never take the same row. */
async function claimDue(db: Database, platform: ConversionPlatform, now: Date): Promise<SendRow[]> {
  const claimed = await db.execute<{ id: string }>(sql`
    update ad_conversion_sends
       set state = 'sending', attempts = attempts + 1, updated_at = ${now.toISOString()}::timestamptz
     where id in (
       select id from ad_conversion_sends
        where platform = ${platform} and state = 'pending'
          and next_attempt_at <= ${now.toISOString()}::timestamptz
        order by next_attempt_at asc
        limit ${BATCH}
        for update skip locked
     )
     returning id`);
  const ids = claimed.rows.map((row) => row.id);
  if (ids.length === 0) return [];
  return db.select().from(adConversionSends).where(inArray(adConversionSends.id, ids));
}

/**
 * A row a dead process left `sending`. Google's goes back to the queue (it keeps the first event
 * of a `transactionId`); Meta's may have arrived and is failed for a person to check.
 */
async function settleStale(db: Database, platform: ConversionPlatform, now: Date) {
  const before = new Date(now.getTime() - STALE_SENDING_MS).toISOString();
  await db.execute(
    platform === 'google'
      ? sql`update ad_conversion_sends set state = 'pending', last_error = 'worker_lost', updated_at = now()
             where platform = 'google' and state = 'sending' and updated_at < ${before}::timestamptz`
      : sql`update ad_conversion_sends set state = 'failed', last_error = 'worker_lost', updated_at = now()
             where platform = 'meta' and state = 'sending' and updated_at < ${before}::timestamptz`,
  );
}

interface FoundId {
  kind: AdIdentifierKind;
  value: string;
  capturedAt: Date;
}

type LeadForSend = Pick<
  typeof leads.$inferSelect,
  | 'id'
  | 'email'
  | 'phone'
  | 'source'
  | 'externalId'
  | 'enteredAt'
  | 'legalBasis'
  | 'gclid'
  | 'fbclid'
  | 'gbraid'
  | 'wbraid'
>;

/**
 * The lead's identifiers: those kept on arrival, then the attribution columns of older leads
 * (seen at the lead's entry). Of each kind, the latest seen up to the stage event.
 */
async function identifiersOf(db: Database, lead: LeadForSend): Promise<FoundId[]> {
  const kept = await db
    .select({
      kind: leadAdIdentifiers.kind,
      value: leadAdIdentifiers.value,
      capturedAt: leadAdIdentifiers.capturedAt,
    })
    .from(leadAdIdentifiers)
    .where(eq(leadAdIdentifiers.leadId, lead.id));
  const found: FoundId[] = kept.map((row) => ({ ...row, kind: row.kind as AdIdentifierKind }));
  const legacy: [AdIdentifierKind, string | null][] = [
    ['gclid', lead.gclid],
    ['fbclid', lead.fbclid],
    ['gbraid', lead.gbraid],
    ['wbraid', lead.wbraid],
    ['meta_lead_id', lead.source === 'meta_lead_ads' ? lead.externalId : null],
  ];
  for (const [kind, value] of legacy) {
    if (value && !found.some((id) => id.kind === kind && id.value === value)) {
      found.push({ kind, value, capturedAt: lead.enteredAt });
    }
  }
  return found;
}

function latest(found: FoundId[], kind: AdIdentifierKind, eventTime: Date): FoundId | null {
  const ofKind = found
    .filter((id) => id.kind === kind)
    .sort((a, b) => b.capturedAt.getTime() - a.capturedAt.getTime());
  return ofKind.find((id) => id.capturedAt <= eventTime) ?? ofKind[0] ?? null;
}

function matchKeysOf(
  lead: LeadForSend,
  found: FoundId[],
  eventTime: Date,
  fresh: (id: FoundId) => boolean,
): MatchKeys {
  const pick = (kind: AdIdentifierKind) => {
    const id = latest(found, kind, eventTime);
    return id && fresh(id) ? id : null;
  };
  const fbclid = pick('fbclid');
  return {
    leadId: lead.id,
    metaLeadId: pick('meta_lead_id')?.value ?? null,
    // Without the cookie, fbc is built from the click id and the moment it was seen (Meta's rule).
    fbc:
      pick('fbc')?.value ?? (fbclid ? `fb.1.${fbclid.capturedAt.getTime()}.${fbclid.value}` : null),
    fbp: pick('fbp')?.value ?? null,
    gclid: pick('gclid')?.value ?? null,
    gbraid: pick('gbraid')?.value ?? null,
    wbraid: pick('wbraid')?.value ?? null,
    email: lead.email,
    phone: lead.phone,
  };
}

type Decision =
  { kind: 'skip'; reason: ConversionSkipReason } | { kind: 'send'; built: BuiltEvent };

/** What to do with one row: the refusals first, each ending the row (nothing is sent after one). */
async function decide(db: Database, env: Env, row: SendRow, now: Date): Promise<Decision> {
  const [lead] = await db
    .select({
      id: leads.id,
      email: leads.email,
      phone: leads.phone,
      source: leads.source,
      externalId: leads.externalId,
      enteredAt: leads.enteredAt,
      legalBasis: leads.legalBasis,
      gclid: leads.gclid,
      fbclid: leads.fbclid,
      gbraid: leads.gbraid,
      wbraid: leads.wbraid,
    })
    .from(leads)
    .where(eq(leads.id, row.leadId));
  if (!lead) return { kind: 'skip', reason: 'no_identifier' };
  // "Não me contate" by any key of the person (phone, e-mail, the lead): nothing about them leaves.
  if ((await leadContactOptOuts(db, lead.id)).entries.length > 0) {
    return { kind: 'skip', reason: 'opt_out' };
  }
  if (row.eventTime < lead.enteredAt) return { kind: 'skip', reason: 'before_lead' };
  // Hashed e-mail and phone only with the switch, and only of a person who gave consent on a form.
  const hashed = env.CRM_CONVERSIONS_HASHED_ENABLED === 'true' && lead.legalBasis === 'consent';
  const found = await identifiersOf(db, lead);
  const age = (from: Date) => now.getTime() - from.getTime();

  if (row.platform === 'meta') {
    if (age(row.eventTime) > META_MAX_AGE_MS) return { kind: 'skip', reason: 'expired' };
    const built = metaEventOf(
      { sendId: row.id, eventName: row.eventName, eventTime: row.eventTime },
      matchKeysOf(lead, found, row.eventTime, () => true),
      { hashed, testEventCode: env.CRM_CONVERSIONS_META_TEST_EVENT_CODE ?? null },
    );
    return built ? { kind: 'send', built } : { kind: 'skip', reason: 'no_identifier' };
  }

  const keys = matchKeysOf(
    lead,
    found,
    row.eventTime,
    (id) => age(id.capturedAt) <= GOOGLE_CLICK_MS,
  );
  const built = googleEventOf(
    { sendId: row.id, eventName: row.eventName, eventTime: row.eventTime },
    keys,
    { customerId: env.GOOGLE_ADS_CUSTOMER_ID ?? '', conversionActionId: row.destination ?? '' },
    {
      hashed: hashed && age(lead.enteredAt) <= GOOGLE_HASHED_MS,
      validateOnly: env.CRM_CONVERSIONS_GOOGLE_VALIDATE_ONLY !== 'false',
    },
  );
  if (built) return { kind: 'send', built };
  const hadClick = found.some((id) => ['gclid', 'gbraid', 'wbraid'].includes(id.kind));
  const hadHashed = hashed && Boolean(lead.email || lead.phone);
  return { kind: 'skip', reason: hadClick || hadHashed ? 'expired' : 'no_identifier' };
}

/** Five minutes, doubling with each try, never more than six hours. */
export const retryDelayMs = (attempts: number) =>
  Math.min(5 * 60_000 * 2 ** Math.max(attempts - 1, 0), 6 * 3_600_000);

async function settle(
  db: Database,
  row: SendRow,
  outcome: SendOutcome | { kind: 'skip'; reason: ConversionSkipReason },
  built: BuiltEvent | null,
  now: Date,
) {
  const base = {
    updatedAt: now,
    identifierKind: built?.identifierKind ?? null,
    fieldsSent: built?.fields ?? null,
  };
  const set =
    outcome.kind === 'skip'
      ? { ...base, state: 'skipped', skipReason: outcome.reason }
      : outcome.kind === 'sent'
        ? {
            ...base,
            state: 'sent',
            sentAt: now,
            lastError: null,
            platformRequestId: outcome.requestId,
            responseShape: outcome.shape,
          }
        : outcome.kind === 'retry' && row.attempts < MAX_ATTEMPTS
          ? {
              ...base,
              state: 'pending',
              lastError: outcome.code,
              nextAttemptAt: new Date(now.getTime() + retryDelayMs(row.attempts)),
              responseShape: outcome.shape ?? null,
            }
          : {
              ...base,
              state: 'failed',
              lastError: outcome.code,
              responseShape: outcome.shape ?? null,
            };
  // Only this claim's row: a stale settle never overwrites what came after it.
  await db
    .update(adConversionSends)
    .set(set)
    .where(and(eq(adConversionSends.id, row.id), eq(adConversionSends.state, 'sending')));
  return set.state;
}

export interface DispatchResult {
  sent: number;
  retried: number;
  failed: number;
  skipped: number;
  authError?: string;
}

/** Sends what is due for one platform. Off or unconfigured, it touches nothing. */
export async function dispatchDue(
  deps: ConversionsDeps,
  platform: ConversionPlatform,
  now: Date,
): Promise<DispatchResult> {
  const result: DispatchResult = { sent: 0, retried: 0, failed: 0, skipped: 0 };
  if (!ready(deps.env, platform)) return result;
  const { db, env } = deps;
  let googleToken: string | null = null;
  if (platform === 'google') {
    const auth = await googleAccessToken(deps.fetchImpl, {
      clientId: env.GOOGLE_ADS_CLIENT_ID ?? '',
      clientSecret: env.GOOGLE_ADS_CLIENT_SECRET ?? '',
      refreshToken: env.CRM_CONVERSIONS_GOOGLE_REFRESH_TOKEN ?? '',
    });
    // Without a token nothing is claimed: the rows wait, no try is spent.
    if ('error' in auth) return { ...result, authError: auth.error };
    googleToken = auth.token;
  }
  await settleStale(db, platform, now);
  for (const row of await claimDue(db, platform, now)) {
    const decision = await decide(db, env, row, now);
    if (decision.kind === 'skip') {
      await settle(db, row, decision, null, now);
      result.skipped += 1;
      continue;
    }
    const outcome =
      platform === 'meta'
        ? await sendMetaEvent(
            deps.fetchImpl,
            {
              datasetId: env.CRM_CONVERSIONS_META_DATASET_ID ?? '',
              token: env.META_CAPI_TOKEN ?? '',
            },
            decision.built,
          )
        : await sendGoogleEvent(deps.fetchImpl, googleToken ?? '', decision.built);
    const state = await settle(db, row, outcome, decision.built, now);
    if (state === 'sent') result.sent += 1;
    else if (state === 'pending') result.retried += 1;
    else result.failed += 1;
  }
  return result;
}

const LOCK_KEY = 'ads:crm-conversions:cycle';

/** One cycle: queue then send, per platform; one at a time across replicas (advisory lock). */
export async function runConversionsCycle(deps: ConversionsDeps, now = new Date()) {
  return deps.db.transaction(async (tx) => {
    const lock = await tx.execute<{ got: boolean }>(
      sql`select pg_try_advisory_xact_lock(hashtext(${LOCK_KEY})) as got`,
    );
    if (!lock.rows[0]?.got) return { ran: false as const };
    const platforms: Partial<Record<ConversionPlatform, DispatchResult & { queued: number }>> = {};
    for (const platform of ['meta', 'google'] as const) {
      if (!ready(deps.env, platform)) continue;
      const queued = await enqueueStageEvents(deps.db, deps.env, platform, now);
      platforms[platform] = { queued, ...(await dispatchDue(deps, platform, now)) };
    }
    return { ran: true as const, platforms };
  });
}

export function startConversionsScheduler(deps: ConversionsDeps & { tickMs?: number }) {
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      const result = await runConversionsCycle(deps);
      if (result.ran) deps.log({ job: 'crm-conversions', ...result.platforms });
    } catch (error) {
      deps.log({ job: 'crm-conversions', error: error instanceof Error ? error.name : 'unknown' });
    } finally {
      busy = false;
    }
  };
  const timer = setInterval(() => void tick(), deps.tickMs ?? 5 * 60_000);
  timer.unref();
  return () => clearInterval(timer);
}
