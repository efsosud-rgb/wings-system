import {
  declaresNone,
  effectiveInstagramVerdict,
  instagramProfileUrl,
  INSTAGRAM_CHECK_SOURCES,
  INSTAGRAM_CHECK_STATUSES,
  INSTAGRAM_MANUAL_VERDICTS,
  INSTAGRAM_VERDICTS,
  type InstagramCheckSource,
  type InstagramCheckStatus,
  type InstagramCheckSteps,
  type InstagramManualVerdict,
  type InstagramVerdict,
  type LeadInstagramCheck,
} from '@wings/shared';
import { and, eq, sql } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import { jobs, leadEvents, leads } from '../../db/schema/index.js';

/**
 * The Instagram check of a site-form lead (docs/leads/instagram.md): the API queues the
 * `check_instagram` job and keeps a person's correction; the worker does the looking. The result
 * lives in `leads.instagram_*`, read back here as `LeadInstagramCheck`.
 */

type CheckRow = Pick<
  typeof leads.$inferSelect,
  | 'instagram'
  | 'instagramCheckStatus'
  | 'instagramCheckSource'
  | 'instagramCheckedAt'
  | 'instagramCheckDetail'
  | 'instagramVerdict'
  | 'instagramManual'
  | 'instagramManualAt'
  | 'instagramVerdictEffective'
>;

const oneOf = <T extends string>(list: readonly T[], value: unknown): T | null =>
  typeof value === 'string' && (list as readonly string[]).includes(value) ? (value as T) : null;

/** What a lead carries of the check, or null when no check was ever made or asked for. */
export function instagramCheckOf(row: CheckRow): LeadInstagramCheck | null {
  const status = oneOf<InstagramCheckStatus>(INSTAGRAM_CHECK_STATUSES, row.instagramCheckStatus);
  if (!status) return null;
  const detail = (row.instagramCheckDetail ?? {}) as {
    reason?: unknown;
    steps?: InstagramCheckSteps;
    followers?: unknown;
    posts?: unknown;
  };
  const manualVerdict = oneOf<InstagramManualVerdict>(INSTAGRAM_MANUAL_VERDICTS, row.instagramManual);
  const verdict = oneOf<InstagramVerdict>(INSTAGRAM_VERDICTS, row.instagramVerdict);
  return {
    status,
    source: oneOf<InstagramCheckSource>(INSTAGRAM_CHECK_SOURCES, row.instagramCheckSource) ?? 'nenhuma',
    checkedAt: row.instagramCheckedAt?.toISOString() ?? null,
    reason: typeof detail.reason === 'string' ? detail.reason : null,
    steps: detail.steps ?? null,
    followers: typeof detail.followers === 'number' ? detail.followers : null,
    posts: typeof detail.posts === 'number' ? detail.posts : null,
    verdict,
    manual:
      manualVerdict && row.instagramManualAt
        ? { verdict: manualVerdict, at: row.instagramManualAt.toISOString() }
        : null,
    effectiveVerdict: effectiveInstagramVerdict(verdict, manualVerdict),
    profileUrl: instagramProfileUrl(row.instagram),
  };
}

/** True when the lead gave an Instagram worth looking up ("não tenho" is an answer, not a handle). */
export const hasInstagramToCheck = (instagram: string | null | undefined): boolean =>
  Boolean(instagram?.trim()) && !declaresNone(instagram as string);

/**
 * Queues the worker's `check_instagram` job and marks the lead as waiting for it. One job at a
 * time per lead: a double click, or the arrival and the button together, find the earlier job
 * still pending or running and queue nothing. The previous result stays until the new one lands.
 */
export async function enqueueInstagramCheck(
  db: Database,
  leadId: string,
  actorEmployeeId: string | null,
): Promise<'queued' | 'in_progress' | 'nothing_to_check'> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`instagram_check:${leadId}`}))`);
    const [lead] = await tx
      .select({ instagram: leads.instagram })
      .from(leads)
      .where(eq(leads.id, leadId))
      .limit(1);
    if (!lead || !hasInstagramToCheck(lead.instagram)) return 'nothing_to_check';
    const open = await tx
      .select({ id: jobs.id })
      .from(jobs)
      .where(
        and(
          eq(jobs.type, 'check_instagram'),
          sql`${jobs.input} ->> 'leadId' = ${leadId}`,
          sql`${jobs.state} in ('pending', 'running')`,
        ),
      )
      .limit(1);
    if (open.length > 0) return 'in_progress';
    await tx.insert(jobs).values({ type: 'check_instagram', input: { leadId } });
    await tx
      .update(leads)
      .set({
        instagramCheckStatus: 'pendente',
        fieldChecks: sql`jsonb_set(coalesce(${leads.fieldChecks}, '{}'::jsonb), '{instagram}', '{"status":"pendente","reason":null,"checkedAt":null}'::jsonb)`,
        updatedAt: new Date(),
      })
      .where(eq(leads.id, leadId));
    await tx.insert(leadEvents).values({
      leadId,
      kind: 'instagram.queued',
      actorEmployeeId,
      detail: {},
    });
    return 'queued';
  });
}

/**
 * A person's correction of the check: "confere" (the profile is the company's) or "falso", or
 * null to take the correction back. The effective verdict follows at once, and the timeline says
 * who did it. The machine's own result stays beside it.
 */
export async function setInstagramManual(
  db: Database,
  leadId: string,
  actorEmployeeId: string,
  verdict: InstagramManualVerdict | null,
  now: Date = new Date(),
): Promise<void> {
  await db.transaction(async (tx) => {
    const [row] = await tx
      .select({ automatic: leads.instagramVerdict, previous: leads.instagramManual })
      .from(leads)
      .where(eq(leads.id, leadId))
      .for('update');
    if (!row) return;
    const automatic = oneOf<InstagramVerdict>(INSTAGRAM_VERDICTS, row.automatic);
    await tx
      .update(leads)
      .set({
        instagramManual: verdict,
        instagramManualAt: verdict ? now : null,
        instagramManualBy: verdict ? actorEmployeeId : null,
        instagramVerdictEffective: effectiveInstagramVerdict(automatic, verdict),
        updatedAt: now,
      })
      .where(eq(leads.id, leadId));
    await tx.insert(leadEvents).values({
      leadId,
      kind: 'instagram.corrected',
      actorEmployeeId,
      detail: { from: row.previous ?? null, to: verdict },
    });
  });
}
