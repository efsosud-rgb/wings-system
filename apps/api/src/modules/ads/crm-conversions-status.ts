import {
  CONVERSION_PLATFORMS,
  type ConversionMapping,
  type ConversionMappingInput,
  type ConversionPlatform,
  type ConversionPlatformStatus,
  type ConversionsPanel,
  type ConversionSkipReason,
} from '@wings/shared';
import { and, asc, eq, gte, sql } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import { adConversionSends, adConversionStageEvents, crmStages } from '../../db/schema/index.js';
import type { Env } from '../../env.js';
import { conversionsSince, missingConfig, platformEnabled, rehearsing } from './crm-conversions.js';

/**
 * The panel of closing the loop: per platform, what went, what failed and why,
 * what was skipped and why, in the last 30 days. Counts and codes only: no
 * lead id, no identifier, no hash.
 */

const WINDOW_MS = 30 * 86_400_000;

export async function mappingsOf(db: Database): Promise<ConversionMapping[]> {
  const rows = await db
    .select({
      id: adConversionStageEvents.id,
      stageId: adConversionStageEvents.stageId,
      stageName: crmStages.name,
      pipeline: crmStages.pipeline,
      platform: adConversionStageEvents.platform,
      eventName: adConversionStageEvents.eventName,
      googleConversionActionId: adConversionStageEvents.googleConversionActionId,
      active: adConversionStageEvents.active,
    })
    .from(adConversionStageEvents)
    .innerJoin(crmStages, eq(crmStages.id, adConversionStageEvents.stageId))
    .orderBy(
      asc(crmStages.pipeline),
      asc(crmStages.position),
      asc(adConversionStageEvents.platform),
    );
  return rows.map((row) => ({ ...row, platform: row.platform as ConversionPlatform }));
}

async function platformStatus(
  db: Database,
  env: Env,
  platform: ConversionPlatform,
  since: Date,
): Promise<ConversionPlatformStatus> {
  const recent = and(
    eq(adConversionSends.platform, platform),
    gte(adConversionSends.createdAt, since),
  );
  const [[counts], errors, skips] = await Promise.all([
    db
      .select({
        sent: sql<string>`count(*) filter (where ${adConversionSends.state} = 'sent')`,
        validated: sql<string>`count(*) filter (where ${adConversionSends.state} = 'validated')`,
        pending: sql<string>`count(*) filter (where ${adConversionSends.state} in ('pending', 'sending'))`,
        failed: sql<string>`count(*) filter (where ${adConversionSends.state} = 'failed')`,
        skipped: sql<string>`count(*) filter (where ${adConversionSends.state} = 'skipped')`,
        lastSentAt: sql<Date | null>`max(${adConversionSends.sentAt})`,
      })
      .from(adConversionSends)
      .where(recent),
    // The failed ones, and the ones waiting for another try, by the last code.
    db
      .select({ code: adConversionSends.lastError, count: sql<string>`count(*)` })
      .from(adConversionSends)
      .where(
        and(
          recent,
          sql`${adConversionSends.lastError} is not null`,
          sql`${adConversionSends.state} in ('failed', 'pending')`,
        ),
      )
      .groupBy(adConversionSends.lastError)
      .orderBy(sql`count(*) desc`),
    db
      .select({ reason: adConversionSends.skipReason, count: sql<string>`count(*)` })
      .from(adConversionSends)
      .where(and(recent, eq(adConversionSends.state, 'skipped')))
      .groupBy(adConversionSends.skipReason)
      .orderBy(sql`count(*) desc`),
  ]);
  const last = counts?.lastSentAt ? new Date(counts.lastSentAt) : null;
  return {
    platform,
    enabled: platformEnabled(env, platform),
    missing: missingConfig(env, platform),
    sent: Number(counts?.sent ?? 0),
    validated: Number(counts?.validated ?? 0),
    pending: Number(counts?.pending ?? 0),
    failed: Number(counts?.failed ?? 0),
    skipped: Number(counts?.skipped ?? 0),
    errors: errors.map((row) => ({ code: row.code ?? '', count: Number(row.count) })),
    skips: skips
      .filter((row) => row.reason)
      .map((row) => ({ reason: row.reason as ConversionSkipReason, count: Number(row.count) })),
    lastSentAt: last?.toISOString() ?? null,
  };
}

export async function conversionsPanel(
  db: Database,
  env: Env,
  now: Date,
): Promise<ConversionsPanel> {
  const since = new Date(now.getTime() - WINDOW_MS);
  const [platforms, mappings] = await Promise.all([
    Promise.all(CONVERSION_PLATFORMS.map((platform) => platformStatus(db, env, platform, since))),
    mappingsOf(db),
  ]);
  return {
    since: conversionsSince(env)?.toISOString() ?? null,
    hashedEnabled: env.CRM_CONVERSIONS_HASHED_ENABLED === 'true',
    googleValidateOnly: rehearsing(env, 'google'),
    metaTestEvents: Boolean(env.CRM_CONVERSIONS_META_TEST_EVENT_CODE),
    platforms,
    mappings,
  };
}

/** Creates or changes the event of one stage on one platform; null when the stage does not exist. */
export async function saveMapping(
  db: Database,
  input: ConversionMappingInput,
  actorEmployeeId: string,
): Promise<ConversionMapping | null> {
  const [stage] = await db
    .select({ id: crmStages.id })
    .from(crmStages)
    .where(eq(crmStages.id, input.stageId));
  if (!stage) return null;
  const values = {
    eventName: input.eventName,
    googleConversionActionId:
      input.platform === 'google' ? (input.googleConversionActionId ?? null) : null,
    active: input.active,
    updatedBy: actorEmployeeId,
    updatedAt: new Date(),
  };
  const [saved] = await db
    .insert(adConversionStageEvents)
    .values({ stageId: input.stageId, platform: input.platform, ...values })
    .onConflictDoUpdate({
      target: [adConversionStageEvents.stageId, adConversionStageEvents.platform],
      set: values,
    })
    .returning({ id: adConversionStageEvents.id });
  return (await mappingsOf(db)).find((mapping) => mapping.id === saved?.id) ?? null;
}
