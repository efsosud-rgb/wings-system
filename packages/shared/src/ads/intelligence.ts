import { z } from 'zod';
import type { AgentChangeProposal } from './agent.js';
import {
  CALLS_TO_ACTION,
  compliantText,
  HEADLINE_MAX,
  PRIMARY_TEXT_MAX,
  SEARCH_DESCRIPTION_MAX,
  SEARCH_HEADLINE_MAX,
} from './campaign-builder.js';
import { DASHBOARD_WINDOWS, type AdPlatform } from './dashboard.js';

/**
 * Wings Ads Intelligence (docs/ads/intelligence.md): the audit, its findings
 * and the AI ad packages.
 *
 * The audit reads only our own mirror of the accounts, never the live
 * platform, and spends nothing. A finding that names a change offers "Criar
 * pedido", and that request goes through the same budget guard and approval
 * gate as any other (`reserveChange`, `gateChange`). Several checks are
 * inspired by the Meta and Google audit controls of AgriciDaniel/claude-ads
 * (MIT): each check names the control it follows in `source`.
 */

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

export const AUDIT_CHECKS = [
  'conversion_source',
  'conversions_api',
  'data_freshness',
  'data_consistency',
  'campaign_performance',
  'active_without_results',
  'spend_pacing',
  'creative_fatigue',
  'creative_diversity',
  'ad_policy',
  'copy_compliance',
  'tracking_utms',
  'budget_headroom',
  'pending_operations',
] as const;
export type AuditCheck = (typeof AUDIT_CHECKS)[number];

export const AUDIT_CHECK_INFO: Record<
  AuditCheck,
  { label: string; source: string; platforms: AdPlatform[] }
> = {
  conversion_source: {
    label: 'Pixel e conversões medindo',
    source: 'claude-ads M01 (Meta Pixel) e controle de conversões do Google',
    platforms: ['meta', 'google'],
  },
  conversions_api: {
    label: 'API de Conversões da Meta (Lead pelo servidor)',
    source: 'claude-ads M02 e M03 (Conversions API e deduplicação)',
    platforms: ['meta'],
  },
  data_freshness: {
    label: 'Dados atualizados',
    source: 'claude-ads M10 (data freshness)',
    platforms: ['meta', 'google'],
  },
  data_consistency: {
    label: 'Gasto da campanha bate com o dos anúncios',
    source: 'Wings: soma por nível no espelho',
    platforms: ['meta', 'google'],
  },
  campaign_performance: {
    label: 'Desempenho da campanha (veredito)',
    source: 'Wings: veredito do Dashboard (CPL, CTR, tendência, frequência, ritmo)',
    platforms: ['meta', 'google'],
  },
  active_without_results: {
    label: 'Campanhas ativas sem resultado',
    source: 'claude-ads M-ST2 (budget utilization) e Saúde da conta',
    platforms: ['meta', 'google'],
  },
  spend_pacing: {
    label: 'Ritmo de gasto',
    source: 'claude-ads M17 (budget distribution) e Saúde da conta',
    platforms: ['meta', 'google'],
  },
  creative_fatigue: {
    label: 'Criativos desgastados',
    source: 'claude-ads M28 e M-CR2 (fadiga e frequência)',
    platforms: ['meta', 'google'],
  },
  creative_diversity: {
    label: 'Variedade de formatos de criativo',
    source: 'claude-ads M25 (creative format diversity)',
    platforms: ['meta'],
  },
  ad_policy: {
    label: 'Anúncios reprovados ou com problema',
    source: 'Revisão da plataforma (ad_review_feedback) e alertas do cockpit',
    platforms: ['meta', 'google'],
  },
  copy_compliance: {
    label: 'Texto dos anúncios sem promessa de ganho',
    source: 'Wings: regras de compliance do construtor (checkCopyCompliance)',
    platforms: ['meta', 'google'],
  },
  tracking_utms: {
    label: 'UTMs e rastreamento dos links',
    source: 'claude-ads M39 (UTM parameters)',
    platforms: ['meta', 'google'],
  },
  budget_headroom: {
    label: 'Teto do mês e trava da conta',
    source: 'claude-ads M-ST1 (budget adequacy) e guardião de orçamento',
    platforms: ['meta', 'google'],
  },
  pending_operations: {
    label: 'Operações pendentes ou com resultado desconhecido',
    source: 'Wings: portão de aprovação e executor',
    platforms: ['meta', 'google'],
  },
};

/** `unknown`: we could not tell from what we have; never shown as a pass. */
export const AUDIT_STATUSES = ['fail', 'warn', 'pass', 'unknown', 'not_applicable'] as const;
export type AuditStatus = (typeof AUDIT_STATUSES)[number];

export const AUDIT_STATUS_LABEL: Record<AuditStatus, string> = {
  fail: 'Problema',
  warn: 'Atenção',
  pass: 'Em ordem',
  unknown: 'Sem dado',
  not_applicable: 'Não se aplica',
};

export const AUDIT_LEVELS = ['high', 'medium', 'low'] as const;
export type AuditLevel = (typeof AUDIT_LEVELS)[number];

export const AUDIT_LEVEL_LABEL: Record<AuditLevel, string> = {
  high: 'Alto',
  medium: 'Médio',
  low: 'Baixo',
};

const LEVEL_WEIGHT: Record<AuditLevel, number> = { high: 3, medium: 2, low: 1 };
const STATUS_WEIGHT: Record<AuditStatus, number> = {
  fail: 2,
  warn: 1,
  unknown: 0.5,
  pass: 0,
  not_applicable: 0,
};

/**
 * Impact × confidence ÷ effort, times how bad the status is. A pass scores 0;
 * the highest is a problem of high impact and confidence that takes little work (18).
 */
export function auditPriority(finding: {
  status: AuditStatus;
  impact: AuditLevel;
  confidence: AuditLevel;
  effort: AuditLevel;
}): number {
  const raw =
    (STATUS_WEIGHT[finding.status] *
      LEVEL_WEIGHT[finding.impact] *
      LEVEL_WEIGHT[finding.confidence]) /
    LEVEL_WEIGHT[finding.effort];
  return Math.round(raw * 10) / 10;
}

export const AUDIT_SCOPES = ['all', 'meta', 'google'] as const;
export type AuditScope = (typeof AUDIT_SCOPES)[number];

export const auditRunRequestSchema = z.object({
  scope: z.enum(AUDIT_SCOPES).default('all'),
  days: z
    .number()
    .int()
    .refine((value) => (DASHBOARD_WINDOWS as readonly number[]).includes(value), 'Período inválido')
    .default(14),
});
export type AuditRunRequest = z.output<typeof auditRunRequestSchema>;

/** What happened to a finding after the audit: a request made from it, or set aside. */
export const AUDIT_FINDING_STATES = ['open', 'requested', 'refused', 'dismissed'] as const;
export type AuditFindingState = (typeof AUDIT_FINDING_STATES)[number];

export interface AuditFinding {
  id: string;
  check: AuditCheck;
  platform: AdPlatform | null;
  accountName: string | null;
  status: AuditStatus;
  impact: AuditLevel;
  confidence: AuditLevel;
  effort: AuditLevel;
  priority: number;
  title: string;
  /** What the numbers show, with the numbers. */
  detail: string;
  /** What a person does about it; empty on a pass. */
  recommendation: string;
  entity: { level: 'account' | 'campaign' | 'ad'; externalId: string; name: string } | null;
  /** A change the system can request (pause, daily budget); null when it is work by hand. */
  action: AgentChangeProposal | null;
  requestable: boolean;
  notRequestableReason: string | null;
  state: AuditFindingState;
  changeRequestId: string | null;
  approvalId: string | null;
}

/** The same channel over the window and the window before it. Null CPL: no lead. */
export interface AuditPeriodComparison {
  platform: AdPlatform;
  current: { spendCents: number; conversions: number; clicks: number; impressions: number };
  previous: { spendCents: number; conversions: number; clicks: number; impressions: number };
  currentCplCents: number | null;
  previousCplCents: number | null;
}

export type AuditCounts = Record<AuditStatus, number>;

export interface AuditRunSummary {
  id: string;
  scope: AuditScope;
  days: number;
  status: 'completed' | 'failed';
  since: string;
  until: string;
  counts: AuditCounts;
  comparison: AuditPeriodComparison[];
  requestedByName: string | null;
  createdAt: string;
  error: string | null;
}

export interface AuditRunDetail {
  run: AuditRunSummary;
  findings: AuditFinding[];
}

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------

export interface ConversionsApiStatus {
  /** META_CAPI_ENABLED: off by default; only Eric turns it on. */
  enabled: boolean;
  /** The pixel (dataset) the events go to. Public id. */
  pixelId: string;
  /** Jobs of the last 7 days, by how they ended. */
  last7Days: { sent: number; skipped: number; failed: number; pending: number };
  lastSentAt: string | null;
  /** A code, never the provider's text: `meta_capi_http_400`, `timeout`… */
  lastError: string | null;
}

export interface IntelligenceAccount {
  id: string;
  platform: AdPlatform;
  name: string;
  externalId: string;
  killSwitchEngaged: boolean;
  /** When the ingest last mirrored its campaigns; null: never. */
  lastSyncedAt: string | null;
}

export interface IntelligenceOperation {
  id: string;
  kind: string;
  status: string;
  campaignName: string | null;
  platform: AdPlatform | null;
  requestedByName: string | null;
  suggestedByAgent: boolean;
  createdAt: string;
  executedAt: string | null;
  approvalId: string | null;
}

export interface IntelligenceOverview {
  /** Whether the API holds credentials for each platform: false shows "conexão pendente". */
  credentials: Record<AdPlatform, boolean>;
  accounts: IntelligenceAccount[];
  pendingApprovals: number;
  unknownExecutions: number;
  openAlerts: { total: number; critical: number };
  /** The last ingest that failed in a step, if the latest run failed. */
  ingestFailures: { step: string; platform: string }[];
  lastIngestAt: string | null;
  operations: IntelligenceOperation[];
  conversionsApi: ConversionsApiStatus;
  /** OPENROUTER_API_KEY present: the AI ad packages can be generated. */
  aiConfigured: boolean;
  latestAudit: AuditRunSummary | null;
}

// ---------------------------------------------------------------------------
// AI ad packages
// ---------------------------------------------------------------------------

export const AD_COPY_PLATFORMS = ['meta', 'google_search'] as const;
export type AdCopyPlatform = (typeof AD_COPY_PLATFORMS)[number];

export const AD_COPY_PLATFORM_LABEL: Record<AdCopyPlatform, string> = {
  meta: 'Meta (Facebook e Instagram)',
  google_search: 'Google Pesquisa',
};

export const AD_COPY_OBJECTIVES = ['leads', 'traffic', 'awareness'] as const;
export type AdCopyObjective = (typeof AD_COPY_OBJECTIVES)[number];

export const AD_COPY_OBJECTIVE_LABEL: Record<AdCopyObjective, string> = {
  leads: 'Gerar leads',
  traffic: 'Levar ao site',
  awareness: 'Reconhecimento da marca',
};

/**
 * What a person asks for. `facts` is the only source of numbers, prices,
 * conditions and results the model may use: a number in the answer that is
 * not here is refused (`inventedNumbers`).
 */
export const adCopyRequestSchema = z.object({
  platform: z.enum(AD_COPY_PLATFORMS),
  objective: z.enum(AD_COPY_OBJECTIVES),
  product: z.string().trim().min(3).max(300),
  audience: z.string().trim().max(400).optional(),
  facts: z.string().trim().max(1200).optional(),
  variations: z.number().int().min(2).max(5).default(3),
});
export type AdCopyRequest = z.output<typeof adCopyRequestSchema>;

/** Digits as written ("1.500", "30%", "2"); compared without separators. */
function numbersIn(text: string): string[] {
  return (text.match(/\d[\d.,]*/g) ?? []).map((value) =>
    value.replace(/[.,]+$/, '').replace(/[.,]/g, ''),
  );
}

/** Numbers in `text` that the person's own words never stated. */
export function inventedNumbers(text: string, allowedSource: string): string[] {
  const allowed = new Set(numbersIn(allowedSource));
  return [...new Set(numbersIn(text).filter((value) => !allowed.has(value)))];
}

const scene = z.object({
  seconds: z.number().int().min(1).max(60),
  visual: z.string().trim().min(3).max(300),
  text: z.string().trim().max(300).default(''),
});

const variation = z.object({
  headline: compliantText(HEADLINE_MAX, 'o título'),
  primaryText: compliantText(PRIMARY_TEXT_MAX, 'o texto principal').optional(),
  description: compliantText(SEARCH_DESCRIPTION_MAX, 'a descrição').optional(),
  callToAction: z.enum(CALLS_TO_ACTION).optional(),
  /** What this variation tests against the others, in one line. */
  angle: z.string().trim().min(3).max(160),
});
export type AdCopyVariation = z.output<typeof variation>;

/**
 * The model's answer. Every text goes through the builder's compliance rule;
 * the platform's own limits are checked per platform below.
 */
export const adCopyPackageSchema = z.object({
  variations: z.array(variation).min(1).max(5),
  creativeBrief: z.string().trim().min(10).max(800),
  videoScript: z.array(scene).max(8).default([]),
  audienceSuggestion: z.string().trim().max(400).default(''),
  structureSuggestion: z.string().trim().max(600).default(''),
  assumptions: z.array(z.string().trim().min(3).max(200)).max(6).default([]),
});
export type AdCopyPackage = z.output<typeof adCopyPackageSchema>;

/** Why one variation cannot be used on this platform, or with these facts. Empty: usable. */
export function variationProblems(
  item: AdCopyVariation,
  platform: AdCopyPlatform,
  allowedSource: string,
): string[] {
  const problems: string[] = [];
  if (platform === 'meta') {
    if (!item.primaryText) problems.push('Falta o texto principal.');
    if (!item.callToAction) problems.push('Falta a chamada para ação.');
  } else {
    if (item.headline.length > SEARCH_HEADLINE_MAX) {
      problems.push(`Título acima de ${SEARCH_HEADLINE_MAX} caracteres para o Google.`);
    }
    if (!item.description) problems.push('Falta a descrição.');
  }
  const words = [item.headline, item.primaryText, item.description].filter(Boolean).join(' ');
  const invented = inventedNumbers(words, allowedSource);
  if (invented.length > 0) {
    problems.push(`Número que não veio do briefing: ${invented.join(', ')}.`);
  }
  return problems;
}

export interface AdCopyDraft {
  id: string;
  createdAt: string;
  request: AdCopyRequest;
  /** Null when the generation failed: `error` says why. */
  package: AdCopyPackage | null;
  /** Variations the model wrote and the rules refused, with the reasons. */
  refused: { headline: string; problems: string[] }[];
  costMicroUsd: number;
  error: string | null;
}
