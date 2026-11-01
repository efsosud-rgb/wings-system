import { z } from 'zod';
import type { AddAdsPayload, CampaignDraft, DraftDifference } from './campaign-builder.js';

/**
 * Contract for the approvals panel.
 *
 * Every field here exists so an approver can decide **without leaving the
 * system**: what changes, on which account and campaign, how much it puts at
 * risk, who asked and when.
 */

export const APPROVAL_STATUSES = [
  'pending',
  'escalated',
  'approved',
  'rejected',
  'expired',
] as const;
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
  expired: 'Expirada sem decisão',
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
  create_campaign: 'Criar campanha',
  add_ads: 'Adicionar anúncios',
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
  /** A person asked, from a card the traffic agent proposed. */
  suggestedByAgent: boolean;
}

export interface ApprovalAuditEntry {
  at: string;
  action: string;
  actorName: string | null;
  metadata: Record<string, unknown>;
}

/** Lifecycle of the underlying change, which drives the Executar button. */
export const CHANGE_STATUSES = [
  'pending_approval',
  'approved',
  'rejected',
  'executing',
  'executed',
  'failed',
  'unknown',
  'expired',
  'superseded',
] as const;
export type ChangeStatus = (typeof CHANGE_STATUSES)[number];

export const CHANGE_STATUS_LABEL: Record<ChangeStatus, string> = {
  pending_approval: 'Aguardando aprovação',
  approved: 'Aprovada, pronta para executar',
  rejected: 'Recusada',
  executing: 'Executando…',
  executed: 'Executada na plataforma',
  failed: 'Falhou na plataforma',
  unknown: 'Resultado desconhecido — conta congelada',
  expired: 'Expirada',
  superseded: 'Substituída',
};

export interface ApprovalDetail extends ApprovalListItem {
  /** State of the change itself, not of the decision. */
  changeStatus: ChangeStatus;
  executedAt: string | null;
  lastExecutionOutcome: 'applied' | 'rejected' | 'unknown' | null;
  /**
   * What the last execution made on the platform, object by object and in
   * order — how a person sees what exists after a failure in the middle.
   */
  executionSteps: ExecutionStepView[];
  /** False when the server has no write credentials or writes are disabled. */
  executionAvailable: boolean;
  accountId: string;
  accountExternalId: string;
  /** Empty while the campaign is still to be created. */
  campaignExternalId: string;
  /** The whole campaign being asked for; null for a change to an existing one. */
  draft: CampaignDraft | null;
  /** The ads being added to an existing campaign (`add_ads`); null for anything else. */
  addAds: AddAdsPayload | null;
  /**
   * How the request compares with the saved draft of the same name, when one
   * exists: the approver sees in bold what was edited after "Carregar".
   */
  savedDraftDrift: {
    savedDraftName: string;
    savedAt: string;
    differences: DraftDifference[];
  } | null;
  /** Where the budget lives: campaign (CBO) or ad set (ABO). */
  budgetLevel: 'campaign' | 'ad_set' | 'none';
  fromValueCents: number | null;
  toValueCents: number | null;
  exposureDeltaCents: number;
  /**
   * What the campaign will cost to its end at the daily budget asked for:
   * daily × days, with the days counted. A new campaign from its first day to
   * its last; a budget change from today to the campaign's end date. Null for
   * a change that is not about budget, or a campaign without an end date.
   */
  campaignForecast: {
    dailyCents: number;
    days: number;
    totalCents: number;
    from: string;
    until: string;
  } | null;
  /** Reason given by whoever requested the change. */
  requestReason: string | null;
  decisionReason: string | null;
  decidedByName: string | null;
  /** Period figures, so the approver sees the change in context. */
  periodCapCents: number;
  periodUsableCents: number;
  periodCommittedCents: number;
  periodSpentCents: number;
  /** When this account's period last reconciled with the platform; null when never. */
  periodLastReconciledAt: string | null;
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

export interface ExecutionStepView {
  seq: number;
  kind:
    | 'campaign'
    | 'image'
    | 'video'
    /** Meta's instant form, created on the Page before the ad set (or reused). */
    | 'lead_form'
    | 'ad_set'
    | 'creative'
    | 'ad'
    | 'ad_group'
    | 'keyword'
    | 'negative_keyword';
  label: string;
  status: 'created' | 'failed' | 'unknown';
  externalId: string | null;
  message: string | null;
}

/** A campaign saved in the builder, as the list shows it. */
export interface SavedCampaignDraft {
  id: string;
  name: string;
  platform: 'meta' | 'google_search' | 'youtube';
  updatedAt: string;
  createdByName: string | null;
}
