import { and, eq, gte, inArray, isNull, sql } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import {
  adApprovalRequests,
  adChangeRequests,
  adGuardrailEvents,
  employees,
  roles,
} from '../../db/schema/index.js';
import { writeAudit } from '../../lib/audit.js';
import { approveWithinCeiling, releaseReservation, type ApprovalRefusal } from './budget-guard.js';
import { formatBrl, type Cents } from './platform/money.js';

/**
 * The approvals gate: the only way a money-moving change becomes executable.
 *
 * Nothing here touches an ad platform. This stage builds the gate itself, so
 * that when execution is enabled later it has something to ask permission of.
 */

/**
 * Which policy decides whether a human must approve.
 *
 *  - `always`     — every budget change needs a decision (current default)
 *  - `thresholds` — changes above the single-change limit need a decision, and
 *                   so does any change that would push the rolling 24h total of
 *                   auto-approved changes past the cumulative limit
 *
 * The default is `always` because it is the stricter of the two: under it, no
 * money can move without a person agreeing.
 */
export type ApprovalPolicyMode = 'always' | 'thresholds';

export interface ApprovalPolicy {
  mode: ApprovalPolicyMode;
  /** Single change above this needs approval (threshold mode). */
  singleChangeLimitCents: Cents;
  /** Auto-approved changes within 24h above this need approval. */
  cumulative24hLimitCents: Cents;
  /** How long a pending decision waits before escalating to Diretoria. */
  escalateAfterMinutes: number;
}

export const DEFAULT_APPROVAL_POLICY: ApprovalPolicy = {
  mode: 'always',
  singleChangeLimitCents: 50_000, // R$500,00
  cumulative24hLimitCents: 200_000, // R$2.000,00
  escalateAfterMinutes: 240, // 4 hours
};

export type ApprovalTrigger = 'policy_always' | 'above_single_threshold' | 'cumulative_24h';

export interface ApprovalDecisionNeeded {
  required: true;
  trigger: ApprovalTrigger;
  /** Auto-approved total in the rolling window, for the notification text. */
  rolling24hCents: Cents;
}

export interface ApprovalNotNeeded {
  required: false;
  rolling24hCents: Cents;
}

/**
 * Notification seam.
 *
 * WhatsApp (Z-API) and e-mail plug in here later. The gate never depends on a
 * notification succeeding: a failure is recorded on the request and the change
 * stays pending. Silence is never treated as consent.
 */
export interface ApprovalNotification {
  approvalId: string;
  adAccountId: string;
  amountCents: Cents;
  trigger: ApprovalTrigger;
  kind: 'requested' | 'escalated' | 'decided';
  status: 'pending' | 'escalated' | 'approved' | 'rejected';
}

export interface ApprovalNotifier {
  send(notification: ApprovalNotification): Promise<void>;
}

/** Default notifier: records intent in the log until a channel is wired. */
export class LoggingApprovalNotifier implements ApprovalNotifier {
  constructor(private readonly log: (message: string) => void = console.warn) {}

  async send(notification: ApprovalNotification): Promise<void> {
    this.log(
      `[approvals] ${notification.kind}: ${formatBrl(notification.amountCents)} ` +
        `(${notification.trigger}) approval=${notification.approvalId} status=${notification.status}`,
    );
  }
}

/** Sum of auto-approved changes in the trailing 24 hours, in cents. */
export async function rollingAutoApprovedCents(
  db: Database,
  adAccountId: string,
  now: Date,
): Promise<Cents> {
  const since = new Date(now.getTime() - 24 * 3600_000);
  const rows = await db.execute<{ total: string } & Record<string, unknown>>(sql`
    select coalesce(sum(abs(exposure_delta_cents)), 0)::text as total
      from ad_change_requests
     where ad_account_id = ${adAccountId}
       and auto_approved = true
       and created_at >= ${since.toISOString()}
  `);
  return Number(rows.rows[0]?.total ?? 0);
}

/**
 * Decides whether a proposed change may proceed without a person.
 *
 * The amount judged is the absolute exposure delta — what the change puts at
 * risk for the rest of the month, not merely the daily figure. That is the
 * conservative reading: it triggers approval sooner, never later.
 */
export async function evaluateApproval(
  db: Database,
  input: {
    adAccountId: string;
    amountCents: Cents;
    now?: Date;
    policy?: ApprovalPolicy;
  },
): Promise<ApprovalDecisionNeeded | ApprovalNotNeeded> {
  const policy = input.policy ?? DEFAULT_APPROVAL_POLICY;
  const now = input.now ?? new Date();
  const amount = Math.abs(input.amountCents);
  const rolling24hCents = await rollingAutoApprovedCents(db, input.adAccountId, now);

  if (policy.mode === 'always') {
    return { required: true, trigger: 'policy_always', rolling24hCents };
  }

  if (amount > policy.singleChangeLimitCents) {
    return { required: true, trigger: 'above_single_threshold', rolling24hCents };
  }

  // Death by a thousand small changes: many sub-threshold changes in a day
  // add up to a large movement nobody agreed to.
  if (rolling24hCents + amount > policy.cumulative24hLimitCents) {
    return { required: true, trigger: 'cumulative_24h', rolling24hCents };
  }

  return { required: false, rolling24hCents };
}

export interface GateResult {
  /** Present when a human decision is required. */
  approvalId?: string;
  status: 'pending_approval' | 'auto_approved';
  trigger?: ApprovalTrigger;
}

/**
 * Puts a reserved change through the gate.
 *
 * The change must already hold its budget reservation, so an approval can only
 * ever be sought for something that fits inside the cap.
 */
export async function gateChange(
  db: Database,
  input: {
    changeRequestId: string;
    notifier?: ApprovalNotifier;
    policy?: ApprovalPolicy;
    now?: Date;
  },
): Promise<GateResult> {
  const now = input.now ?? new Date();
  const policy = input.policy ?? DEFAULT_APPROVAL_POLICY;
  const notifier = input.notifier ?? new LoggingApprovalNotifier();

  const change = await db.query.adChangeRequests.findFirst({
    where: eq(adChangeRequests.id, input.changeRequestId),
  });
  if (!change) throw new Error('change request not found');

  const verdict = await evaluateApproval(db, {
    adAccountId: change.adAccountId,
    amountCents: change.exposureDeltaCents,
    now,
    policy,
  });

  if (!verdict.required) {
    await db
      .update(adChangeRequests)
      .set({ status: 'approved', autoApproved: true, decidedAt: now })
      .where(eq(adChangeRequests.id, change.id));

    await writeAudit(db, {
      action: 'ads.change_auto_approved',
      entity: 'ad_change_request',
      entityId: change.id,
      metadata: {
        amountCents: Math.abs(change.exposureDeltaCents),
        rolling24hCents: verdict.rolling24hCents,
        policyMode: policy.mode,
      },
    });
    return { status: 'auto_approved' };
  }

  const [approval] = await db
    .insert(adApprovalRequests)
    .values({
      changeRequestId: change.id,
      adAccountId: change.adAccountId,
      amountCents: Math.abs(change.exposureDeltaCents),
      trigger: verdict.trigger,
      requestedBy: change.requestedBy,
      requestedByAgent: change.requestedByAgent,
      requestedAt: now,
      payloadHash: change.payloadHash,
    })
    .returning({ id: adApprovalRequests.id });

  if (!approval) throw new Error('failed to create approval request');

  await writeAudit(db, {
    actorEmployeeId: change.requestedBy,
    action: 'ads.approval_requested',
    entity: 'ad_approval_request',
    entityId: approval.id,
    metadata: {
      amountCents: Math.abs(change.exposureDeltaCents),
      trigger: verdict.trigger,
      rolling24hCents: verdict.rolling24hCents,
    },
  });

  await notify(db, notifier, {
    approvalId: approval.id,
    adAccountId: change.adAccountId,
    amountCents: Math.abs(change.exposureDeltaCents),
    trigger: verdict.trigger,
    kind: 'requested',
    status: 'pending',
  });

  return { approvalId: approval.id, status: 'pending_approval', trigger: verdict.trigger };
}

/**
 * Sends a notification without ever letting its failure change the decision.
 * A silent notification failure must not look like an approval.
 */
async function notify(
  db: Database,
  notifier: ApprovalNotifier,
  notification: ApprovalNotification,
): Promise<void> {
  try {
    await notifier.send(notification);
    await db
      .update(adApprovalRequests)
      .set({ notifiedAt: new Date(), notificationError: null })
      .where(eq(adApprovalRequests.id, notification.approvalId));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await db
      .update(adApprovalRequests)
      .set({ notificationError: message })
      .where(eq(adApprovalRequests.id, notification.approvalId));
    await db.insert(adGuardrailEvents).values({
      adAccountId: notification.adAccountId,
      kind: 'unknown_execution_outcome',
      detail: {
        note: 'Falha ao notificar aprovador; a solicitação segue pendente.',
        approvalId: notification.approvalId,
        error: message,
      },
    });
  }
}

export type DecisionRefusal =
  'not_found' | 'approver_not_allowed' | 'payload_changed' | ApprovalRefusal;

export type DecisionResult =
  | { ok: true; status: 'approved' | 'rejected' }
  | { ok: false; reason: DecisionRefusal; message: string };

/** Only Admin Master or Diretoria may decide; anybody else is refused. */
async function approverIsAllowed(db: Database, employeeId: string): Promise<boolean> {
  const rows = await db
    .select({ roleKey: roles.key })
    .from(employees)
    .innerJoin(roles, eq(roles.id, employees.roleId))
    .where(and(eq(employees.id, employeeId), eq(employees.status, 'active')));
  const roleKey = rows[0]?.roleKey;
  return roleKey === 'admin_master' || roleKey === 'diretoria';
}

export async function decideApproval(
  db: Database,
  input: {
    approvalId: string;
    approverEmployeeId: string;
    decision: 'approved' | 'rejected';
    reason?: string;
    notifier?: ApprovalNotifier;
    now?: Date;
    ip?: string | null;
    userAgent?: string | null;
  },
): Promise<DecisionResult> {
  const now = input.now ?? new Date();
  const notifier = input.notifier ?? new LoggingApprovalNotifier();

  const approval = await db.query.adApprovalRequests.findFirst({
    where: eq(adApprovalRequests.id, input.approvalId),
  });
  if (!approval) return { ok: false, reason: 'not_found', message: 'Solicitação não encontrada.' };

  if (approval.status !== 'pending' && approval.status !== 'escalated') {
    return {
      ok: false,
      reason: 'already_decided',
      message:
        approval.status === 'expired'
          ? 'Esta solicitação expirou sem decisão. Faça um pedido novo.'
          : 'Esta solicitação já foi decidida.',
    };
  }

  if (!(await approverIsAllowed(db, input.approverEmployeeId))) {
    await writeAudit(db, {
      actorEmployeeId: input.approverEmployeeId,
      action: 'ads.approval_denied_to_actor',
      entity: 'ad_approval_request',
      entityId: approval.id,
      ip: input.ip,
      userAgent: input.userAgent,
      metadata: { note: 'Apenas Admin Master ou Diretoria podem aprovar.' },
    });
    return {
      ok: false,
      reason: 'approver_not_allowed',
      message: 'Apenas Admin Master ou Diretoria podem aprovar alterações de orçamento.',
    };
  }

  // The approval is bound to the exact change; if it drifted, decide again.
  const change = await db.query.adChangeRequests.findFirst({
    where: eq(adChangeRequests.id, approval.changeRequestId),
  });
  if (!change || change.payloadHash !== approval.payloadHash) {
    return {
      ok: false,
      reason: 'payload_changed',
      message: 'A alteração mudou desde o pedido; solicite uma nova aprovação.',
    };
  }

  // One decision wins (T-4). Approve, reject and the expiry job each move the
  // change only from `pending_approval`, under the period lock, so a second
  // decision at the same instant finds it already moved and changes nothing.
  // Approving also judges the change against the commitment worked out now,
  // the same number its request and its execution are judged by.
  const decided = await db.transaction(async (tx) => {
    if (input.decision === 'approved') {
      const moved = await approveWithinCeiling(tx, change.id, input.approverEmployeeId, now);
      if (!moved.ok) return moved;
    } else {
      // Rejection frees the reserved exposure for other changes.
      const released = await releaseReservation(
        tx,
        change.id,
        'rejected',
        input.approverEmployeeId,
        {
          from: ['pending_approval'],
          now,
        },
      );
      if (!released) {
        return {
          ok: false as const,
          reason: 'already_decided' as const,
          message: 'Esta solicitação já foi decidida ou expirou.',
        };
      }
    }
    await tx
      .update(adApprovalRequests)
      .set({
        status: input.decision,
        decidedAt: now,
        decidedBy: input.approverEmployeeId,
        decisionReason: input.reason ?? null,
      })
      .where(eq(adApprovalRequests.id, approval.id));
    return { ok: true as const };
  });
  if (!decided.ok) return decided;

  await writeAudit(db, {
    actorEmployeeId: input.approverEmployeeId,
    action: input.decision === 'approved' ? 'ads.approval_granted' : 'ads.approval_rejected',
    entity: 'ad_approval_request',
    entityId: approval.id,
    ip: input.ip,
    userAgent: input.userAgent,
    metadata: {
      amountCents: approval.amountCents,
      trigger: approval.trigger,
      escalated: approval.status === 'escalated',
      reasonGiven: Boolean(input.reason),
    },
  });

  await notify(db, notifier, {
    approvalId: approval.id,
    adAccountId: approval.adAccountId,
    amountCents: approval.amountCents,
    trigger: approval.trigger,
    kind: 'decided',
    status: input.decision,
  });

  return { ok: true, status: input.decision };
}

/**
 * Escalates decisions nobody answered.
 *
 * Escalation raises the alarm; it never decides. A request that ages out moves
 * to Diretoria and keeps waiting, because an unanswered request must never
 * become an execution.
 */
export async function escalateStaleApprovals(
  db: Database,
  options: { policy?: ApprovalPolicy; notifier?: ApprovalNotifier; now?: Date } = {},
): Promise<string[]> {
  const policy = options.policy ?? DEFAULT_APPROVAL_POLICY;
  const notifier = options.notifier ?? new LoggingApprovalNotifier();
  const now = options.now ?? new Date();
  const cutoff = new Date(now.getTime() - policy.escalateAfterMinutes * 60_000);

  const stale = await db.query.adApprovalRequests.findMany({
    where: and(
      eq(adApprovalRequests.status, 'pending'),
      isNull(adApprovalRequests.escalatedAt),
      sql`${adApprovalRequests.requestedAt} <= ${cutoff.toISOString()}`,
    ),
  });

  const escalated: string[] = [];
  for (const approval of stale) {
    await db
      .update(adApprovalRequests)
      .set({ status: 'escalated', escalatedAt: now })
      .where(eq(adApprovalRequests.id, approval.id));

    await writeAudit(db, {
      action: 'ads.approval_escalated',
      entity: 'ad_approval_request',
      entityId: approval.id,
      metadata: {
        amountCents: approval.amountCents,
        waitedMinutes: Math.floor((now.getTime() - approval.requestedAt.getTime()) / 60_000),
        escalatedTo: 'diretoria',
      },
    });

    await notify(db, notifier, {
      approvalId: approval.id,
      adAccountId: approval.adAccountId,
      amountCents: approval.amountCents,
      trigger: approval.trigger,
      kind: 'escalated',
      status: 'escalated',
    });
    escalated.push(approval.id);
  }
  return escalated;
}

/** Everything still waiting on a person, oldest first. */
export async function listOpenApprovals(db: Database, adAccountId?: string) {
  const open = await db.query.adApprovalRequests.findMany({
    where: adAccountId
      ? and(
          eq(adApprovalRequests.adAccountId, adAccountId),
          inArray(adApprovalRequests.status, ['pending', 'escalated']),
        )
      : inArray(adApprovalRequests.status, ['pending', 'escalated']),
  });
  return open.sort((a, b) => a.requestedAt.getTime() - b.requestedAt.getTime());
}

/** Convenience for dashboards: what has been auto-approved recently. */
export async function autoApprovedSince(db: Database, adAccountId: string, since: Date) {
  return db.query.adChangeRequests.findMany({
    where: and(
      eq(adChangeRequests.adAccountId, adAccountId),
      eq(adChangeRequests.autoApproved, true),
      gte(adChangeRequests.createdAt, since),
    ),
  });
}
