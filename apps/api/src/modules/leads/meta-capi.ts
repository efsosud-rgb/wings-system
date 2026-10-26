import { randomUUID } from 'node:crypto';
import type { ConversionsApiStatus } from '@wings/shared';
import { and, desc, eq, gte, sql } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import { jobs } from '../../db/schema/index.js';
import type { Env } from '../../env.js';

/**
 * Meta's Conversions API, the API side (docs/ads/conversions-api.md).
 *
 * The API only queues: one `meta_capi_lead` job per site-form submission, when
 * META_CAPI_ENABLED is "true". The worker reads the lead, checks its consent,
 * hashes what it sends and calls Meta; the token lives in the worker's
 * environment. The event id goes back to the page, so the browser pixel (GTM)
 * can send the same id and Meta counts the lead once.
 */

export const capiEnabled = (env: Env) => env.META_CAPI_ENABLED === 'true';

export interface CapiLeadInput {
  leadId: string;
  /** Shared with the browser pixel for deduplication. */
  eventId: string;
  /** Unix seconds of the submission. */
  eventTime: number;
  /** Meta requires it for website events; kept only in the job. */
  userAgent: string | null;
  /** The page the form was sent from, as the page reported it. */
  sourceUrl: string | null;
}

/** Queues the Lead event and answers its id; null when the integration is off. */
export async function enqueueMetaCapiLead(
  db: Database,
  env: Env,
  input: Omit<CapiLeadInput, 'eventId' | 'eventTime'>,
  now = new Date(),
): Promise<string | null> {
  if (!capiEnabled(env)) return null;
  const eventId = `lead-${randomUUID()}`;
  const job: CapiLeadInput = {
    ...input,
    userAgent: input.userAgent?.slice(0, 400) ?? null,
    sourceUrl: input.sourceUrl?.slice(0, 500) ?? null,
    eventId,
    eventTime: Math.floor(now.getTime() / 1000),
  };
  await db.insert(jobs).values({ type: 'meta_capi_lead', input: job });
  return eventId;
}

/** How the last 7 days of Lead events went, for the screen and the audit. */
export async function conversionsApiStatus(
  db: Database,
  env: Env,
  now = new Date(),
): Promise<ConversionsApiStatus> {
  const since = new Date(now.getTime() - 7 * 24 * 3_600_000);
  const recent = and(eq(jobs.type, 'meta_capi_lead'), gte(jobs.createdAt, since));
  const [[counts], [lastSent], [lastFailed]] = await Promise.all([
    db
      .select({
        sent: sql<string>`count(*) filter (where ${jobs.state} = 'done' and ${jobs.output} ->> 'skipped' is null)`,
        skipped: sql<string>`count(*) filter (where ${jobs.state} = 'done' and ${jobs.output} ->> 'skipped' is not null)`,
        failed: sql<string>`count(*) filter (where ${jobs.state} = 'failed')`,
        pending: sql<string>`count(*) filter (where ${jobs.state} in ('pending', 'running'))`,
      })
      .from(jobs)
      .where(recent),
    db
      .select({ at: jobs.finishedAt })
      .from(jobs)
      .where(
        and(
          eq(jobs.type, 'meta_capi_lead'),
          eq(jobs.state, 'done'),
          sql`${jobs.output} ->> 'skipped' is null`,
        ),
      )
      .orderBy(desc(jobs.finishedAt))
      .limit(1),
    db
      .select({ error: jobs.error })
      .from(jobs)
      .where(and(recent, eq(jobs.state, 'failed')))
      .orderBy(desc(jobs.finishedAt))
      .limit(1),
  ]);
  return {
    enabled: capiEnabled(env),
    pixelId: env.META_PIXEL_ID,
    last7Days: {
      sent: Number(counts?.sent ?? 0),
      skipped: Number(counts?.skipped ?? 0),
      failed: Number(counts?.failed ?? 0),
      pending: Number(counts?.pending ?? 0),
    },
    lastSentAt: lastSent?.at?.toISOString() ?? null,
    // The worker writes a code first (`meta_capi_http_400 …`); only the code leaves here.
    lastError: lastFailed?.error?.split(/[\s:]/)[0] ?? null,
  };
}
