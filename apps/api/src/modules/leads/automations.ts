import {
  addBusinessHours,
  automationEmailConfigSchema,
  automationNotifyConfigSchema,
  automationOwnerConfigSchema,
  automationSequenceConfigSchema,
  automationTaskConfigSchema,
  renderTemplate,
  type LeadPipeline,
  leadHidesWings,
} from '@wings/shared';
import { and, asc, eq, inArray, isNull, lt, lte, ne } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import {
  crmAutomationRules,
  crmAutomationRuns,
  crmEmailOutbox,
  crmEmailTemplates,
  crmNotifications,
  crmSequences,
  crmSequenceSteps,
  employees,
  leadEvents,
  leadTasks,
  leads,
} from '../../db/schema/index.js';
import { changeLead, createTask, nextInRotation } from './crm.js';
import {
  testTransport,
  type CrmMailMode,
  type CrmMailSent,
  type CrmMailTransport,
} from './crm-mail.js';

/**
 * Regras de automação: when a deal enters a stage, its rules become rows of
 * `crm_automation_runs` (at once or after a delay) and a processor runs what
 * is due. The actions are the CRM's own services (`createTask`, `changeLead`,
 * `nextInRotation`), so a rule does exactly what a person would do by hand
 * and leaves the same records. Nothing here logs or stores personal data:
 * results hold ids, counts and a short reason.
 *
 * A deal that leaves the stage, or closes, cancels what is still pending for
 * that entry. Moves that only mirror RD or an import never start rules.
 */

export interface AutomationDeps {
  mail: CrmMailTransport;
  now?: () => Date;
}

type LeadRow = typeof leads.$inferSelect;
type RunRow = typeof crmAutomationRuns.$inferSelect;
type Outcome = { status: 'done' | 'skipped' | 'failed'; result: Record<string, unknown> };

const skipped = (reason: string): Outcome => ({ status: 'skipped', result: { reason } });
const MAX_PER_PASS = 100;

/** Rules of the stage a deal has just entered become runs; what is due runs now. */
export async function onStageEntered(
  db: Database,
  lead: Pick<LeadRow, 'id' | 'stageId' | 'stageChangedAt' | 'won'>,
  deps: AutomationDeps,
): Promise<{ queued: number }> {
  if (!lead.stageId) return { queued: 0 };
  const now = (deps.now ?? (() => new Date()))();
  const enteredAt = lead.stageChangedAt ?? now;
  // Leaving a stage ends what that stage's rules still owed.
  await db
    .update(crmAutomationRuns)
    .set({ status: 'cancelled', doneAt: now, result: { reason: 'left_stage' } })
    .where(
      and(
        eq(crmAutomationRuns.leadId, lead.id),
        eq(crmAutomationRuns.status, 'pending'),
        ne(crmAutomationRuns.stageId, lead.stageId),
      ),
    );
  if (lead.won !== null) return { queued: 0 };
  const rules = await db
    .select()
    .from(crmAutomationRules)
    .where(and(eq(crmAutomationRules.stageId, lead.stageId), eq(crmAutomationRules.active, true)))
    .orderBy(asc(crmAutomationRules.position), asc(crmAutomationRules.createdAt));
  if (rules.length === 0) return { queued: 0 };
  const inserted = await db
    .insert(crmAutomationRuns)
    .values(
      rules.map((rule) => ({
        leadId: lead.id,
        ruleId: rule.id,
        stageId: lead.stageId,
        kind: rule.kind,
        runAt: new Date(enteredAt.getTime() + rule.delayMinutes * 60_000),
        dedupeKey: `${lead.id}:${rule.id}:${enteredAt.getTime()}`,
      })),
    )
    .onConflictDoNothing()
    .returning({ id: crmAutomationRuns.id });
  await processDueRuns(db, deps, { leadId: lead.id });
  return { queued: inserted.length };
}

/** Runs what is due (optionally of one lead), each in its own transaction; one failing never stops the rest. */
export async function processDueRuns(
  db: Database,
  deps: AutomationDeps,
  scope: { leadId?: string } = {},
): Promise<{ done: number; skipped: number; failed: number }> {
  const totals = { done: 0, skipped: 0, failed: 0 };
  const now = (deps.now ?? (() => new Date()))();
  // A processor that died mid-action leaves its row `running`: it is closed as
  // failed and never run again, because the action may have half happened.
  await db
    .update(crmAutomationRuns)
    .set({ status: 'failed', result: { reason: 'interrupted' } })
    .where(
      and(
        eq(crmAutomationRuns.status, 'running'),
        lt(crmAutomationRuns.doneAt, new Date(now.getTime() - 15 * 60_000)),
      ),
    );
  // A sequence started in this pass has steps due at once: go again until nothing is.
  for (let pass = 0; pass < 4; pass++) {
    let ran = 0;
    const due = await db
      .select({ id: crmAutomationRuns.id })
      .from(crmAutomationRuns)
      .where(
        and(
          eq(crmAutomationRuns.status, 'pending'),
          lte(crmAutomationRuns.runAt, now),
          scope.leadId ? eq(crmAutomationRuns.leadId, scope.leadId) : undefined,
        ),
      )
      .orderBy(asc(crmAutomationRuns.runAt))
      .limit(MAX_PER_PASS);
    for (const { id } of due) {
      // Claim the row; a concurrent processor that got there first leaves nothing to do.
      const [claimed] = await db
        .update(crmAutomationRuns)
        .set({ status: 'running', doneAt: now })
        .where(and(eq(crmAutomationRuns.id, id), eq(crmAutomationRuns.status, 'pending')))
        .returning();
      if (!claimed) continue;
      let outcome: Outcome;
      try {
        outcome = await executeRun(db, claimed, deps, now);
      } catch (error) {
        outcome = { status: 'failed', result: { reason: reasonOf(error) } };
      }
      await db
        .update(crmAutomationRuns)
        .set({ status: outcome.status, result: outcome.result, doneAt: new Date() })
        .where(eq(crmAutomationRuns.id, id));
      ran++;
      totals[
        outcome.status === 'done' ? 'done' : outcome.status === 'skipped' ? 'skipped' : 'failed'
      ]++;
    }
    if (ran === 0) break;
  }
  return totals;
}

/** A short code, never a message that could carry a name or an address. */
const reasonOf = (error: unknown) =>
  error instanceof Error && /^[a-z_]{3,40}$/.test(error.message) ? error.message : 'error';

async function executeRun(
  db: Database,
  run: RunRow,
  deps: AutomationDeps,
  now: Date,
): Promise<Outcome> {
  const lead = await db.query.leads.findFirst({ where: eq(leads.id, run.leadId) });
  if (!lead) return skipped('lead_gone');
  if (lead.won !== null) return skipped('closed');
  if (run.stageId && lead.stageId !== run.stageId) return skipped('left_stage');

  let kind = run.kind;
  let config: unknown;
  if (run.stepId) {
    const step = await db.query.crmSequenceSteps.findFirst({
      where: eq(crmSequenceSteps.id, run.stepId),
    });
    if (!step) return skipped('step_gone');
    config = step.config;
    kind = step.kind;
  } else if (run.ruleId) {
    const rule = await db.query.crmAutomationRules.findFirst({
      where: eq(crmAutomationRules.id, run.ruleId),
    });
    if (!rule) return skipped('rule_gone');
    if (!rule.active) return skipped('rule_off');
    config = rule.config;
  } else {
    return skipped('no_source');
  }

  switch (kind) {
    case 'create_task':
      return createTaskAction(db, lead, config, now);
    case 'change_owner':
      return changeOwnerAction(db, lead, config);
    case 'notify':
      return notifyAction(db, lead, config);
    case 'send_email':
      return sendEmailAction(db, lead, run, config, deps);
    case 'start_sequence':
      return startSequenceAction(db, lead, run, config, now);
    default:
      return skipped('unknown_kind');
  }
}

async function resolvePerson(lead: LeadRow, person: string): Promise<string | null> {
  return person === 'owner' ? lead.ownerEmployeeId : person;
}

async function createTaskAction(
  db: Database,
  lead: LeadRow,
  rawConfig: unknown,
  now: Date,
): Promise<Outcome> {
  const config = automationTaskConfigSchema.safeParse(rawConfig);
  if (!config.success) return skipped('bad_config');
  const assignee = await resolvePerson(lead, config.data.assignee);
  if (!assignee) return skipped('no_owner');
  // The core already makes the first-contact task when a lead gets an owner, and a
  // person may have made the same follow-up: a rule never makes a twin of an open task.
  const open = await db
    .select({ kind: leadTasks.kind, title: leadTasks.title })
    .from(leadTasks)
    .where(and(eq(leadTasks.leadId, lead.id), isNull(leadTasks.doneAt)));
  if (
    open.some(
      (t) =>
        (config.data.taskKind === 'first_contact' && t.kind === 'first_contact') ||
        (t.kind === config.data.taskKind && t.title === config.data.title),
    )
  )
    return skipped('already_exists');
  const dueAt = config.data.businessHours
    ? addBusinessHours(now, config.data.dueInHours)
    : new Date(now.getTime() + config.data.dueInHours * 3_600_000);
  const task = await createTask(db, {
    leadId: lead.id,
    kind: config.data.taskKind,
    title: config.data.title,
    dueAt,
    assigneeEmployeeId: assignee,
    createdBy: null,
    auto: true,
  });
  return { status: 'done', result: { taskId: task.id } };
}

async function changeOwnerAction(
  db: Database,
  lead: LeadRow,
  rawConfig: unknown,
): Promise<Outcome> {
  const config = automationOwnerConfigSchema.safeParse(rawConfig);
  if (!config.success) return skipped('bad_config');
  let ownerId: string | null = config.data.to === 'rotation' ? null : config.data.to;
  if (config.data.to === 'rotation') {
    if (!lead.pipeline) return skipped('no_pipeline');
    ownerId = await db.transaction((tx) => nextInRotation(tx, lead.pipeline as LeadPipeline));
    if (!ownerId) return skipped('empty_rotation');
  } else {
    const person = await db.query.employees.findFirst({
      where: and(eq(employees.id, config.data.to), eq(employees.status, 'active')),
      columns: { id: true },
    });
    if (!person) return skipped('owner_inactive');
  }
  const result = await changeLead(db, {
    leadId: lead.id,
    ownerEmployeeId: ownerId,
    source: 'wings',
    actorEmployeeId: null,
  });
  if (!result.ok) return skipped(result.reason);
  return { status: 'done', result: { changed: result.changed } };
}

async function notifyAction(db: Database, lead: LeadRow, rawConfig: unknown): Promise<Outcome> {
  const config = automationNotifyConfigSchema.safeParse(rawConfig);
  if (!config.success) return skipped('bad_config');
  const recipients = new Set<string>();
  for (const person of config.data.recipients) {
    const id = await resolvePerson(lead, person);
    if (id) recipients.add(id);
  }
  if (recipients.size === 0) return skipped('no_recipient');
  const active = await db
    .select({ id: employees.id })
    .from(employees)
    .where(and(inArray(employees.id, [...recipients]), eq(employees.status, 'active')));
  if (active.length === 0) return skipped('no_recipient');
  await db.insert(crmNotifications).values(
    active.map((person) => ({
      recipientEmployeeId: person.id,
      leadId: lead.id,
      kind: 'automation',
      message: config.data.message,
    })),
  );
  return { status: 'done', result: { notified: active.length } };
}

async function sendEmailAction(
  db: Database,
  lead: LeadRow,
  run: RunRow,
  rawConfig: unknown,
  deps: AutomationDeps,
): Promise<Outcome> {
  const config = automationEmailConfigSchema.safeParse(rawConfig);
  if (!config.success) return skipped('bad_config');
  const outcome = await sendTemplateToLead(db, {
    lead,
    templateId: config.data.templateId,
    transport: deps.mail ?? testTransport,
    runId: run.id,
    sentBy: null,
  });
  return outcome.ok
    ? { status: 'done', result: { outboxId: outcome.outboxId, mode: outcome.mode } }
    : outcome.reason === 'send_failed'
      ? { status: 'failed', result: { reason: outcome.reason, outboxId: outcome.outboxId } }
      : skipped(outcome.reason);
}

/** The template with the lead's own values filled in (first names only). */
export async function renderForLead(
  db: Database,
  lead: LeadRow,
  template: { subject: string; body: string },
): Promise<{ subject: string; body: string }> {
  const seller = lead.ownerEmployeeId
    ? await db.query.employees.findFirst({
        where: eq(employees.id, lead.ownerEmployeeId),
        columns: { fullName: true },
      })
    : null;
  const values = {
    nome: lead.name?.trim().split(/\s+/)[0] ?? '',
    marca: lead.brand ?? '',
    vendedor: seller?.fullName.trim().split(/\s+/)[0] ?? '',
    etapa: lead.stage ?? '',
  };
  return {
    subject: renderTemplate(template.subject, values),
    body: renderTemplate(template.body, values),
  };
}

/**
 * One template to one lead, through the transport, with the outbox row and
 * the timeline event written either way (a failed send is recorded as such,
 * never retried by itself). The message text is stored in the outbox, never logged.
 */
export async function sendTemplateToLead(
  db: Database,
  input: {
    lead: LeadRow;
    templateId: string;
    transport: CrmMailTransport;
    runId: string | null;
    sentBy: string | null;
  },
): Promise<
  | { ok: true; outboxId: string; mode: CrmMailMode }
  | {
      ok: false;
      reason: 'template_gone' | 'template_off' | 'no_email' | 'brand_hidden' | 'send_failed';
      outboxId?: string;
    }
> {
  const { lead } = input;
  const template = await db.query.crmEmailTemplates.findFirst({
    where: eq(crmEmailTemplates.id, input.templateId),
  });
  if (!template) return { ok: false, reason: 'template_gone' };
  if (!template.active) return { ok: false, reason: 'template_off' };
  // Expansão with a brand: no e-mail from a Wings address reaches the lead (the brand rule).
  if (leadHidesWings(lead)) return { ok: false, reason: 'brand_hidden' };
  if (!lead.email) return { ok: false, reason: 'no_email' };
  const { subject, body } = await renderForLead(db, lead, template);
  let status: 'recorded' | 'sent' | 'failed' =
    input.transport.mode === 'test' ? 'recorded' : 'sent';
  let sent: CrmMailSent | null = null;
  try {
    // A person sends from their own Gmail; an automation sends from the lead's owner's.
    sent = await input.transport.send({
      to: lead.email,
      subject,
      text: body,
      senderEmployeeId: input.sentBy ?? lead.ownerEmployeeId,
    });
  } catch {
    status = 'failed';
  }
  const mode = sent?.mode ?? input.transport.mode;
  const [row] = await db
    .insert(crmEmailOutbox)
    .values({
      leadId: lead.id,
      templateId: template.id,
      runId: input.runId,
      subject,
      body,
      mode,
      status,
      sentBy: input.sentBy,
      fromEmail: sent?.fromEmail ?? null,
      messageId: sent?.messageId ?? null,
      gmailMessageId: sent?.gmailMessageId ?? null,
      gmailThreadId: sent?.gmailThreadId ?? null,
    })
    .returning({ id: crmEmailOutbox.id });
  if (!row) throw new Error('outbox_failed');
  await db.insert(leadEvents).values({
    leadId: lead.id,
    kind: 'lead.email_sent',
    actorEmployeeId: input.sentBy,
    detail: { outboxId: row.id, templateId: template.id, mode, status },
  });
  return status === 'failed'
    ? { ok: false, reason: 'send_failed', outboxId: row.id }
    : { ok: true, outboxId: row.id, mode };
}

async function startSequenceAction(
  db: Database,
  lead: LeadRow,
  run: RunRow,
  rawConfig: unknown,
  now: Date,
): Promise<Outcome> {
  const config = automationSequenceConfigSchema.safeParse(rawConfig);
  if (!config.success) return skipped('bad_config');
  const sequence = await db.query.crmSequences.findFirst({
    where: eq(crmSequences.id, config.data.sequenceId),
  });
  if (!sequence || !sequence.active) return skipped('sequence_off');
  const steps = await db
    .select()
    .from(crmSequenceSteps)
    .where(eq(crmSequenceSteps.sequenceId, sequence.id))
    .orderBy(asc(crmSequenceSteps.position));
  if (steps.length === 0) return skipped('sequence_empty');
  let at = now.getTime();
  const rows = steps.map((step) => {
    at += step.afterHours * 3_600_000;
    return {
      leadId: lead.id,
      sequenceId: sequence.id,
      stepId: step.id,
      stageId: run.stageId,
      kind: step.kind,
      runAt: new Date(at),
      dedupeKey: `${run.id}:${step.id}`,
    };
  });
  await db.insert(crmAutomationRuns).values(rows).onConflictDoNothing();
  await db.insert(leadEvents).values({
    leadId: lead.id,
    kind: 'lead.sequence_started',
    actorEmployeeId: null,
    detail: { sequenceId: sequence.id, steps: steps.length },
  });
  return { status: 'done', result: { sequenceId: sequence.id, steps: steps.length } };
}

/** What is still owed to one deal, for its page: the pending runs, soonest first. */
export async function pendingRunsOf(db: Database, leadId: string) {
  return db
    .select({
      id: crmAutomationRuns.id,
      kind: crmAutomationRuns.kind,
      runAt: crmAutomationRuns.runAt,
    })
    .from(crmAutomationRuns)
    .where(and(eq(crmAutomationRuns.leadId, leadId), eq(crmAutomationRuns.status, 'pending')))
    .orderBy(asc(crmAutomationRuns.runAt));
}
