import {
  ROADMAP_WEIGHT_POINTS,
  type RoadmapComputed,
  type RoadmapDeliverable,
  type RoadmapDeliverableStatus,
  type RoadmapModule,
  type RoadmapReportRecipient,
  type RoadmapReportRun,
  type RoadmapReportRunStatus,
  type RoadmapWeight,
} from '@wings/shared';
import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import {
  employees,
  roadmapDeliverableChanges,
  roadmapDeliverables,
  roadmapModules,
  roadmapReportRecipients,
  roadmapReportRuns,
} from '../../db/schema/index.js';
import {
  computeRoadmap,
  modulePercentOf,
  type CompletionEvent,
  type ScoringModule,
} from './scoring.js';

export type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];
type Db = Database | Tx;

const isoDate = (value: string | Date | null) => {
  if (value === null) return null;
  return typeof value === 'string' ? value : value.toISOString().slice(0, 10);
};
const isoTs = (value: Date | null) => (value ? value.toISOString() : null);

type ModuleRow = typeof roadmapModules.$inferSelect;
type DeliverableRow = typeof roadmapDeliverables.$inferSelect;

function toDeliverable(row: DeliverableRow): RoadmapDeliverable {
  return {
    id: row.id,
    moduleId: row.moduleId,
    label: row.label,
    weight: row.weight,
    status: row.status,
    completedAt: isoDate(row.completedAt),
    source: row.source,
    notes: row.notes,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Every module with its deliverables, ordered the way the screen shows them. */
export async function fetchModulesWithDeliverables(
  db: Db,
): Promise<{ module: ModuleRow; deliverables: DeliverableRow[] }[]> {
  const moduleRows = await db.select().from(roadmapModules).orderBy(asc(roadmapModules.position));
  if (moduleRows.length === 0) return [];
  const deliverableRows = await db
    .select()
    .from(roadmapDeliverables)
    .orderBy(asc(roadmapDeliverables.createdAt));
  const byModule = new Map<string, DeliverableRow[]>();
  for (const row of deliverableRows) {
    const list = byModule.get(row.moduleId) ?? [];
    list.push(row);
    byModule.set(row.moduleId, list);
  }
  return moduleRows.map((module) => ({ module, deliverables: byModule.get(module.id) ?? [] }));
}

function toScoringModules(
  rows: { module: ModuleRow; deliverables: DeliverableRow[] }[],
): ScoringModule[] {
  return rows.map(({ module, deliverables }) => ({
    moduleId: module.id,
    key: module.key,
    label: module.label,
    deliverables: deliverables.map((d) => ({ weight: d.weight, status: d.status })),
  }));
}

/**
 * The velocity timeline comes from each deliverable's own `completed_at`, not
 * from replaying `roadmap_deliverable_changes`. That table exists so a human
 * edit is always traceable to who made it and what it was before — but most
 * deliverables are `auto_draft` and never touch it at all, so reconstructing
 * the timeline from partial edit history would under-count. The `pronto`
 * `completed_at` on every deliverable, generator-written or hand-edited
 * alike, is the one authoritative business date something finished.
 */
function completionEventsOf(rows: { deliverables: DeliverableRow[] }[]): CompletionEvent[] {
  const events: CompletionEvent[] = [];
  for (const { deliverables } of rows) {
    for (const deliverable of deliverables) {
      if (deliverable.status !== 'pronto' || !deliverable.completedAt) continue;
      events.push({
        completedAt: new Date(`${deliverable.completedAt}T00:00:00Z`),
        weightPoints: ROADMAP_WEIGHT_POINTS[deliverable.weight],
      });
    }
  }
  return events;
}

/**
 * Last week's total scope, approximated from `created_at`: the weight of
 * every deliverable that already existed 7+ days before `now`. No extra
 * snapshot table — the deliverables themselves are the history.
 */
function lastWeekTotalWeightOf(
  rows: { deliverables: DeliverableRow[] }[],
  now: Date,
): number | null {
  const weekAgo = new Date(now.getTime() - 7 * 24 * 3600_000);
  let total = 0;
  let any = false;
  for (const { deliverables } of rows) {
    for (const deliverable of deliverables) {
      if (deliverable.createdAt.getTime() <= weekAgo.getTime()) {
        total += ROADMAP_WEIGHT_POINTS[deliverable.weight];
        any = true;
      }
    }
  }
  return any ? total : null;
}

export interface RoadmapSnapshot {
  modules: RoadmapModule[];
  computed: RoadmapComputed;
}

/** Everything the "Módulos" screen and the report jobs need, as of `now`. */
export async function snapshotOf(db: Db, now: Date): Promise<RoadmapSnapshot> {
  const rows = await fetchModulesWithDeliverables(db);
  const scoringModules = toScoringModules(rows);

  const modules: RoadmapModule[] = rows.map(({ module, deliverables }) => {
    const { weightTotal, percent } = modulePercentOf(
      deliverables.map((d) => ({ weight: d.weight, status: d.status })),
    );
    return {
      id: module.id,
      key: module.key,
      label: module.label,
      position: module.position,
      isComingSoon: module.isComingSoon,
      deliverables: deliverables.map(toDeliverable),
      weightTotal,
      percent,
    };
  });

  const computed = computeRoadmap({
    reportDate: now.toISOString().slice(0, 10),
    modules: scoringModules,
    completionEvents: completionEventsOf(rows),
    lastWeekTotalWeight: lastWeekTotalWeightOf(rows, now),
    now,
  });

  return { modules, computed };
}

// --- deliverables ------------------------------------------------------------

export interface DeliverablePatch {
  status?: RoadmapDeliverableStatus;
  weight?: RoadmapWeight;
  notes?: string;
  completedAt?: string;
}

export async function updateDeliverable(
  db: Database,
  id: string,
  actorEmployeeId: string,
  patch: DeliverablePatch,
): Promise<RoadmapDeliverable | null> {
  return db.transaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(roadmapDeliverables)
      .where(eq(roadmapDeliverables.id, id))
      .for('update');
    if (!current) return null;

    const nextStatus = patch.status ?? current.status;
    const nextWeight = patch.weight ?? current.weight;
    const nextNotes = patch.notes !== undefined ? patch.notes : current.notes;
    // completed_at only makes sense once something is pronto; clearing status
    // away from pronto clears the date unless the caller supplied a new one.
    const nextCompletedAt =
      patch.completedAt !== undefined
        ? patch.completedAt
        : nextStatus === 'pronto'
          ? current.completedAt
          : null;

    const statusOrWeightChanged = nextStatus !== current.status || nextWeight !== current.weight;

    await tx
      .update(roadmapDeliverables)
      .set({
        status: nextStatus,
        weight: nextWeight,
        notes: nextNotes,
        completedAt: nextCompletedAt,
        source: 'manual',
        updatedAt: new Date(),
      })
      .where(eq(roadmapDeliverables.id, id));

    if (statusOrWeightChanged) {
      await tx.insert(roadmapDeliverableChanges).values({
        deliverableId: id,
        changedBy: actorEmployeeId,
        previous: { status: current.status, weight: current.weight },
        next: { status: nextStatus, weight: nextWeight },
      });
    }

    const [updated] = await tx
      .select()
      .from(roadmapDeliverables)
      .where(eq(roadmapDeliverables.id, id));
    return updated ? toDeliverable(updated) : null;
  });
}

// --- report runs ---------------------------------------------------------------

type ReportRunRow = typeof roadmapReportRuns.$inferSelect;

function toReportRun(row: ReportRunRow, approvedByName: string | null): RoadmapReportRun {
  return {
    id: row.id,
    reportDate: isoDate(row.reportDate) as string,
    status: row.status,
    computed: row.computed as RoadmapComputed,
    messageText: row.messageText,
    approvedBy: row.approvedBy,
    approvedByName,
    approvedAt: isoTs(row.approvedAt),
    sentAt: isoTs(row.sentAt),
    createdAt: row.createdAt.toISOString(),
  };
}

export async function listReportRuns(db: Db): Promise<RoadmapReportRun[]> {
  const rows = await db
    .select({ run: roadmapReportRuns, approvedByName: employees.fullName })
    .from(roadmapReportRuns)
    .leftJoin(employees, eq(employees.id, roadmapReportRuns.approvedBy))
    .orderBy(desc(roadmapReportRuns.reportDate));
  return rows.map((row) => toReportRun(row.run, row.approvedByName));
}

export async function getReportRun(db: Db, id: string): Promise<RoadmapReportRun | null> {
  const [row] = await db
    .select({ run: roadmapReportRuns, approvedByName: employees.fullName })
    .from(roadmapReportRuns)
    .leftJoin(employees, eq(employees.id, roadmapReportRuns.approvedBy))
    .where(eq(roadmapReportRuns.id, id));
  return row ? toReportRun(row.run, row.approvedByName) : null;
}

export async function getReportRunByDate(db: Db, reportDate: string): Promise<ReportRunRow | null> {
  const [row] = await db
    .select()
    .from(roadmapReportRuns)
    .where(eq(roadmapReportRuns.reportDate, reportDate));
  return row ?? null;
}

/**
 * Finds today's draft run, or creates it. `build` is called with the id the
 * new row WILL have, before it is inserted, so the message text it composes
 * can already carry the run's own link — there is no second write to patch a
 * link in afterwards, and no second (paid) call to the language model.
 * Idempotent: a second call the same day returns the existing row untouched.
 */
export async function findOrCreateDraftRun(
  db: Database,
  reportDate: string,
  build: (id: string) => Promise<{ computed: RoadmapComputed; messageText: string }>,
): Promise<{ run: ReportRunRow; created: boolean }> {
  const existing = await getReportRunByDate(db, reportDate);
  if (existing) return { run: existing, created: false };

  const id = randomUUID();
  const built = await build(id);
  const [inserted] = await db
    .insert(roadmapReportRuns)
    .values({
      id,
      reportDate,
      status: 'rascunho',
      computed: built.computed,
      messageText: built.messageText,
    })
    .onConflictDoNothing()
    .returning();
  if (inserted) return { run: inserted, created: true };

  // Lost a race against another run of the same job: use what won.
  const raced = await getReportRunByDate(db, reportDate);
  if (!raced) throw new Error('failed to create or find the draft run');
  return { run: raced, created: false };
}

export type ApproveOutcome = 'ok' | 'not_found' | 'not_draft';

export async function approveReportRun(
  db: Database,
  id: string,
  actorEmployeeId: string,
): Promise<ApproveOutcome> {
  return db.transaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(roadmapReportRuns)
      .where(eq(roadmapReportRuns.id, id))
      .for('update');
    if (!current) return 'not_found';
    if (current.status !== 'rascunho') return 'not_draft';
    await tx
      .update(roadmapReportRuns)
      .set({ status: 'aprovado', approvedBy: actorEmployeeId, approvedAt: new Date() })
      .where(eq(roadmapReportRuns.id, id));
    return 'ok';
  });
}

export async function markRunSent(
  db: Database,
  id: string,
  status: RoadmapReportRunStatus,
): Promise<void> {
  await db
    .update(roadmapReportRuns)
    .set({ status, sentAt: new Date() })
    .where(eq(roadmapReportRuns.id, id));
}

// --- recipients ------------------------------------------------------------------

type RecipientRow = typeof roadmapReportRecipients.$inferSelect;

const toRecipient = (row: RecipientRow): RoadmapReportRecipient => ({
  id: row.id,
  role: row.role,
  name: row.name,
  phone: row.phone,
  active: row.active,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});

export async function listRecipients(db: Db): Promise<RoadmapReportRecipient[]> {
  const rows = await db
    .select()
    .from(roadmapReportRecipients)
    .orderBy(asc(roadmapReportRecipients.role));
  return rows.map(toRecipient);
}

export async function activeRecipientPhones(
  db: Db,
  role: 'preview' | 'ceo',
): Promise<{ id: string; name: string; phone: string }[]> {
  const rows = await db
    .select()
    .from(roadmapReportRecipients)
    .where(and(eq(roadmapReportRecipients.role, role), eq(roadmapReportRecipients.active, true)));
  return rows.map((row) => ({ id: row.id, name: row.name, phone: row.phone }));
}

export async function createRecipient(
  db: Database,
  input: { role: 'preview' | 'ceo'; name: string; phone: string; active?: boolean },
): Promise<RoadmapReportRecipient> {
  const [row] = await db
    .insert(roadmapReportRecipients)
    .values({
      role: input.role,
      name: input.name,
      phone: input.phone,
      active: input.active ?? true,
    })
    .returning();
  return toRecipient(row as RecipientRow);
}

export async function updateRecipient(
  db: Database,
  id: string,
  patch: { name?: string; phone?: string; active?: boolean },
): Promise<RoadmapReportRecipient | null> {
  const [row] = await db
    .update(roadmapReportRecipients)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(roadmapReportRecipients.id, id))
    .returning();
  return row ? toRecipient(row) : null;
}

export async function deleteRecipient(db: Database, id: string): Promise<boolean> {
  const rows = await db
    .delete(roadmapReportRecipients)
    .where(eq(roadmapReportRecipients.id, id))
    .returning({ id: roadmapReportRecipients.id });
  return rows.length > 0;
}

// --- generator application --------------------------------------------------------

export interface GeneratedModuleInput {
  key: string;
  label: string;
  position: number;
  isComingSoon: boolean;
}

export interface GeneratedDeliverableInput {
  moduleKey: string;
  label: string;
  weight: RoadmapWeight;
  status: RoadmapDeliverableStatus;
  completedAt: string | null;
}

/**
 * Applies a generator run: modules are always kept in sync with
 * navigation.ts (there is no "manual module"), but a deliverable a human has
 * edited (`source: 'manual'`) is never overwritten — only rows still marked
 * `auto_draft` are replaced, matched by (module, label).
 */
export async function applyGenerated(
  db: Database,
  modules: readonly GeneratedModuleInput[],
  deliverables: readonly GeneratedDeliverableInput[],
): Promise<{
  modulesWritten: number;
  deliverablesCreated: number;
  deliverablesUpdated: number;
  deliverablesSkipped: number;
}> {
  const moduleIdByKey = new Map<string, string>();
  for (const module of modules) {
    const [existing] = await db
      .select()
      .from(roadmapModules)
      .where(eq(roadmapModules.key, module.key));
    if (existing) {
      await db
        .update(roadmapModules)
        .set({
          label: module.label,
          position: module.position,
          isComingSoon: module.isComingSoon,
          updatedAt: new Date(),
        })
        .where(eq(roadmapModules.id, existing.id));
      moduleIdByKey.set(module.key, existing.id);
    } else {
      const [inserted] = await db
        .insert(roadmapModules)
        .values({
          key: module.key,
          label: module.label,
          position: module.position,
          isComingSoon: module.isComingSoon,
        })
        .returning();
      if (inserted) moduleIdByKey.set(module.key, inserted.id);
    }
  }

  let created = 0;
  let updated = 0;
  let skipped = 0;
  for (const deliverable of deliverables) {
    const moduleId = moduleIdByKey.get(deliverable.moduleKey);
    if (!moduleId) continue;
    const [existing] = await db
      .select()
      .from(roadmapDeliverables)
      .where(
        and(
          eq(roadmapDeliverables.moduleId, moduleId),
          eq(roadmapDeliverables.label, deliverable.label),
        ),
      );
    if (!existing) {
      await db.insert(roadmapDeliverables).values({
        moduleId,
        label: deliverable.label,
        weight: deliverable.weight,
        status: deliverable.status,
        completedAt: deliverable.completedAt,
        source: 'auto_draft',
      });
      created += 1;
      continue;
    }
    if (existing.source === 'manual') {
      skipped += 1;
      continue;
    }
    await db
      .update(roadmapDeliverables)
      .set({
        weight: deliverable.weight,
        status: deliverable.status,
        completedAt: deliverable.completedAt,
        updatedAt: new Date(),
      })
      .where(eq(roadmapDeliverables.id, existing.id));
    updated += 1;
  }

  return {
    modulesWritten: moduleIdByKey.size,
    deliverablesCreated: created,
    deliverablesUpdated: updated,
    deliverablesSkipped: skipped,
  };
}
