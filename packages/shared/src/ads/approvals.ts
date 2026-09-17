import { z } from 'zod';

/**
 * Contract for the approvals panel.
 *
 * Every field here exists so an approver can decide **without leaving the
 * system**: what changes, on which account and campaign, how much it puts at
 * risk, who asked and when.
 */

export const APPROVAL_STATUSES = ['pending', 'escalated', 'approved', 'rejected'] as const;
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];

export const APPROVAL_TRIGGERS = [
  'policy_always',
  'above_single_threshold',
  'cumulative_24h',
] as const;
export type ApprovalTriggerKey = (typeof APPROVAL_TRIGGERS)[number];

export const APPROVAL_STATUS_LABEL: Record<ApprovalStatus, string> = {
  pending: 'Aguardando decisão',
  escalated: 'Escalada para a Diretoria',
  approved: 'Aprovada',
  rejected: 'Recusada',
};

export const APPROVAL_TRIGGER_LABEL: Record<ApprovalTriggerKey, string> = {
  policy_always: 'Toda alteração de orçamento exige aprovação',
  above_single_threshold: 'Acima do limite individual',
  cumulative_24h: 'Limite acumulado de 24h atingido',
};

export const CHANGE_KIND_LABEL: Record<string, string> = {
  set_daily_budget: 'Alterar orçamento diário',
  pause_campaign: 'Pausar campanha',
  resume_campaign: 'Retomar campanha',
};

export interface ApprovalListItem {
  id: string;
  status: ApprovalStatus;
  trigger: ApprovalTriggerKey;
  amountCents: number;
  accountName: string;
  platform: 'meta' | 'google' | 'tiktok';
  campaignName: string;
  changeKind: string;
  requestedAt: string;
  escalatedAt: string | null;
  decidedAt: string | null;
  requestedByName: string | null;
  requestedByAgent: boolean;
}

export interface ApprovalAuditEntry {
  at: string;
  action: string;
  actorName: string | null;
  metadata: Record<string, unknown>;
}

export interface ApprovalDetail extends ApprovalListItem {
  accountExternalId: string;
  campaignExternalId: string;
  /** Where the budget lives: campaign (CBO) or ad set (ABO). */
  budgetLevel: 'campaign' | 'ad_set' | 'none';
  fromValueCents: number | null;
  toValueCents: number | null;
  exposureDeltaCents: number;
  /** Reason given by whoever requested the change. */
  requestReason: string | null;
  decisionReason: string | null;
  decidedByName: string | null;
  /** Period figures, so the approver sees the change in context. */
  periodCapCents: number;
  periodUsableCents: number;
  periodCommittedCents: number;
  periodSpentCents: number;
  notifiedAt: string | null;
  notificationError: string | null;
  auditTrail: ApprovalAuditEntry[];
}

/** Rejecting requires a reason; approving does not. */
export const approvalDecisionSchema = z
  .object({
    decision: z.enum(['approved', 'rejected']),
    reason: z.string().trim().max(500).optional(),
  })
  .refine((value) => value.decision !== 'rejected' || (value.reason?.length ?? 0) >= 3, {
    message: 'Informe o motivo da recusa',
    path: ['reason'],
  });

export type ApprovalDecisionInput = z.output<typeof approvalDecisionSchema>;
