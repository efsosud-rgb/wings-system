import { z } from 'zod';
import {
  agentCampaignProposalSchema,
  agentChangeProposalSchema,
  type AgentCampaignProposal,
  type AgentChangeProposal,
  type AgentConsultation,
  type AgentModel,
} from './agent.js';
import type { AdPlatform } from './dashboard.js';
import type { ObjectiveKind } from './verdicts.js';

/**
 * Insights and suggestions of the marketing dashboard, part 2.
 *
 * The same rules as the conversation with the agent (`agent.ts`): the model
 * reads our own tables through tools and writes cards; nothing on an ad
 * platform changes because a card exists. A suggestion becomes a request only
 * when a person clicks "Criar pedido", and that request is the person's own,
 * through the budget guard and the approval gate, marked "sugerido pela IA".
 * A campaign suggestion only fills the builder; launching stays a click too.
 */

// ---------------------------------------------------------------------------
// Runs: one generation, scheduled or on demand
// ---------------------------------------------------------------------------

export const INSIGHT_RUN_KINDS = ['insights', 'campaign_suggestions'] as const;
export type InsightRunKind = (typeof INSIGHT_RUN_KINDS)[number];

export const INSIGHT_RUN_TRIGGERS = ['schedule', 'manual'] as const;
export type InsightRunTrigger = (typeof INSIGHT_RUN_TRIGGERS)[number];

export const INSIGHT_RUN_STATUSES = ['running', 'done', 'failed'] as const;
export type InsightRunStatus = (typeof INSIGHT_RUN_STATUSES)[number];

/** Its own ceiling, in US dollars per day, apart from the agent's per-person one. */
export const DEFAULT_INSIGHTS_DAILY_USD = 1;

/** Every Monday at 07:00 in São Paulo, for both kinds. */
export const INSIGHTS_SCHEDULE = { weekday: 1, hour: 7, timeZone: 'America/Sao_Paulo' } as const;

export interface InsightRun {
  id: string;
  kind: InsightRunKind;
  trigger: InsightRunTrigger;
  status: InsightRunStatus;
  startedAt: string;
  finishedAt: string | null;
  /** Who clicked "Gerar agora"; null for the schedule. */
  requestedByName: string | null;
  model: AgentModel | null;
  costMicroUsd: number;
  /** How many cards it wrote. */
  produced: number;
  /** "O que consultei": every tool the model read, in order. */
  consulted: AgentConsultation[];
  /** Why it failed, as a code, never anybody's words. */
  error: string | null;
}

export interface InsightsUsageToday {
  /** What the runs that produced cards cost today: the ceiling counts only these. */
  spentMicroUsd: number;
  limitMicroUsd: number;
  /** Runs that failed today, and what they cost anyway: shown, not counted against the ceiling. */
  failedRuns: number;
  failedMicroUsd: number;
  /** Ceiling reached, or too many failed runs today (see INSIGHTS_FAILED_RUNS_PER_DAY). */
  exhausted: boolean;
}

/**
 * A failed run does not count against the daily ceiling, so this many
 * failures in a day stop "Gerar agora" instead: a broken generator must not
 * keep spending just because it never produces a card.
 */
export const INSIGHTS_FAILED_RUNS_PER_DAY = 3;

// ---------------------------------------------------------------------------
// Insights
// ---------------------------------------------------------------------------

export const INSIGHT_KINDS = [
  'budget_curve',
  'customer_profile',
  'region',
  'placements',
  'formats_hours',
  'creative_fatigue',
  'spend_pacing',
] as const;
export type InsightKind = (typeof INSIGHT_KINDS)[number];

export const INSIGHT_KIND_LABEL: Record<InsightKind, string> = {
  budget_curve: 'Verba ideal por campanha',
  customer_profile: 'Perfil de cliente',
  region: 'Região',
  placements: 'Posicionamentos',
  formats_hours: 'Formatos e horários',
  creative_fatigue: 'Fadiga de criativo',
  spend_pacing: 'Ritmo de gasto',
};

export const INSIGHT_CONFIDENCES = ['low', 'medium', 'high'] as const;
export type InsightConfidence = (typeof INSIGHT_CONFIDENCES)[number];

export const INSIGHT_CONFIDENCE_LABEL: Record<InsightConfidence, string> = {
  low: 'Baixa',
  medium: 'Média',
  high: 'Alta',
};

export const IMPACT_DIRECTIONS = ['save', 'gain', 'neutral'] as const;
export type ImpactDirection = (typeof IMPACT_DIRECTIONS)[number];

const evidenceSchema = z
  .array(
    z.object({
      label: z.string().trim().min(1).max(60),
      value: z.string().trim().min(1).max(60),
    }),
  )
  .min(1)
  .max(10)
  .refine((items) => items.some((item) => /\d/.test(item.value)), 'Ao menos um número');

/**
 * One insight, as the model must write it. Every field the screen shows is
 * here, and the numbers are mandatory: an insight without a figure is an
 * opinion. `action` is the only thing that can become a request, and it is
 * held to the same schema as a proposal in the conversation.
 */
export const insightSchema = z.object({
  kind: z.enum(INSIGHT_KINDS),
  title: z.string().trim().min(5).max(120),
  /** What the numbers show, with the numbers. */
  findings: z.string().trim().min(20).max(700),
  evidence: evidenceSchema,
  suggestion: z.string().trim().min(10).max(500),
  impact: z.object({
    text: z.string().trim().min(5).max(200),
    /** Reais per month, positive; null when it cannot be put in money. */
    estimatedCentsPerMonth: z.number().int().min(0).nullable(),
    direction: z.enum(IMPACT_DIRECTIONS),
  }),
  confidence: z.enum(INSIGHT_CONFIDENCES),
  /** The campaign it is about, as the read tools report it; absent for account-wide insights. */
  campaignExternalId: z.string().trim().min(1).max(64).optional(),
  /** Present when the suggestion is a change the system can request. */
  action: agentChangeProposalSchema.optional(),
});
export type Insight = z.output<typeof insightSchema>;

export const INSIGHTS_PER_RUN_MAX = 12;

export const registerInsightsSchema = z.object({
  insights: z.array(insightSchema).min(1).max(INSIGHTS_PER_RUN_MAX),
});

export const INSIGHT_STATUSES = ['open', 'seen', 'requested', 'refused'] as const;
export type InsightStatus = (typeof INSIGHT_STATUSES)[number];

export const INSIGHT_STATUS_LABEL: Record<InsightStatus, string> = {
  open: 'Aberto',
  seen: 'Visto',
  requested: 'Pedido criado',
  refused: 'Recusado pelo guardião',
};

/** What "Criar pedido" would create, filled by the server from its own tables. */
export interface InsightAction {
  payload: AgentChangeProposal;
  campaignName: string;
  platform: AdPlatform;
  currentDailyBudgetCents: number | null;
  requestable: boolean;
  notRequestableReason: string | null;
}

export interface InsightCard {
  id: string;
  runId: string;
  kind: InsightKind;
  title: string;
  findings: string;
  evidence: { label: string; value: string }[];
  suggestion: string;
  impact: Insight['impact'];
  confidence: InsightConfidence;
  campaignExternalId: string | null;
  /** From our tables, never from the model. Null when the campaign is gone. */
  campaignName: string | null;
  platform: AdPlatform | null;
  action: InsightAction | null;
  status: InsightStatus;
  createdAt: string;
  actedAt: string | null;
  actedByName: string | null;
  /** Where to find the request, once there is one. */
  approvalId: string | null;
  /** The run's "O que consultei". */
  consulted: AgentConsultation[];
}

export interface InsightsResponse {
  configured: boolean;
  usage: InsightsUsageToday;
  latestRun: InsightRun | null;
  /** A run still going, when there is one: the screen polls. */
  runningRun: InsightRun | null;
  open: InsightCard[];
  /** Seen, requested or refused, newest first. */
  history: InsightCard[];
  /** When the next scheduled run is due. */
  nextScheduledAt: string;
}

// ---------------------------------------------------------------------------
// Campaign suggestions
// ---------------------------------------------------------------------------

const range = z
  .object({ min: z.number().int().min(0), max: z.number().int().min(0) })
  .refine((value) => value.max >= value.min, 'max menor que min');

export const campaignSuggestionSchema = z.object({
  /** The builder's own shape, held to the same limits as a proposal in the chat. */
  proposal: agentCampaignProposalSchema,
  /** Over the campaign's whole period. */
  expectedCplCents: range,
  expectedLeads: range,
  /** The numbers that motivated it, read from the tools. */
  motivation: evidenceSchema,
});
export type CampaignSuggestion = z.output<typeof campaignSuggestionSchema>;

export const SUGGESTIONS_PER_RUN_MIN = 2;
export const SUGGESTIONS_PER_RUN_MAX = 3;

export const registerSuggestionsSchema = z.object({
  suggestions: z
    .array(campaignSuggestionSchema)
    .min(SUGGESTIONS_PER_RUN_MIN)
    .max(SUGGESTIONS_PER_RUN_MAX),
});

export const SUGGESTION_STATUSES = ['open', 'applied', 'dismissed'] as const;
export type SuggestionStatus = (typeof SUGGESTION_STATUSES)[number];

export interface CampaignSuggestionCard {
  id: string;
  runId: string;
  proposal: AgentCampaignProposal;
  expectedCplCents: { min: number; max: number };
  expectedLeads: { min: number; max: number };
  motivation: { label: string; value: string }[];
  /** What only a person can choose, named by the server (media, Page, Instagram). */
  pending: string[];
  status: SuggestionStatus;
  createdAt: string;
  actedAt: string | null;
  actedByName: string | null;
}

export interface SuggestionsResponse {
  configured: boolean;
  usage: InsightsUsageToday;
  latestRun: InsightRun | null;
  runningRun: InsightRun | null;
  suggestions: CampaignSuggestionCard[];
  nextScheduledAt: string;
}

// ---------------------------------------------------------------------------
// CPL targets (Configurações do Dashboard)
// ---------------------------------------------------------------------------

/** Objectives a target makes sense for. */
export const TARGET_OBJECTIVE_KINDS: readonly ObjectiveKind[] = ['leads', 'traffic'];

export const TARGET_METRIC_LABEL: Record<'leads' | 'traffic', string> = {
  leads: 'CPL (custo por lead)',
  traffic: 'CPC (custo por clique)',
};

export interface CplTarget {
  objectiveKind: ObjectiveKind;
  /** The confirmed value; null until a person confirms one. */
  targetCents: number | null;
  confirmedAt: string | null;
  confirmedByName: string | null;
  /** What the history suggests, with how it was computed; null with too little history. */
  proposedCents: number | null;
  proposedBasis: string | null;
}

/**
 * The CPL target of one ad account, for its leads campaigns; it wins over the
 * company-wide one. `suggestedCents` is only a starting value for the input
 * (Meta R$ 85,90 as agreed on 28/09; Google none until its conversions are
 * trustworthy): nothing is judged against it until a person confirms.
 */
export interface AccountCplTarget {
  adAccountId: string;
  accountName: string;
  platform: 'meta' | 'google';
  targetCents: number | null;
  confirmedAt: string | null;
  confirmedByName: string | null;
  suggestedCents: number | null;
  suggestionNote: string | null;
}

export const ACCOUNT_CPL_SUGGESTION: Record<
  'meta' | 'google',
  { cents: number | null; note: string }
> = {
  meta: { cents: 8590, note: 'Sugestão inicial combinada em 28/09. Só vale depois de confirmada.' },
  google: {
    cents: null,
    note: 'Sem meta até o Google ter conversões confiáveis; até lá as campanhas de leads ficam "Sem meta".',
  },
};

export interface DashboardSettings {
  targets: CplTarget[];
  accountTargets: AccountCplTarget[];
}

export const setAccountCplTargetSchema = z.object({
  adAccountId: z.string().uuid(),
  /** Whole cents; null clears the target, and the company-wide one applies again. */
  targetCents: z.number().int().min(100).max(100_000_00).nullable(),
});
export type SetAccountCplTargetInput = z.input<typeof setAccountCplTargetSchema>;

export const setCplTargetSchema = z.object({
  objectiveKind: z.enum(['leads', 'traffic']),
  /** Whole cents; null clears the target. */
  targetCents: z.number().int().min(100).max(100_000_00).nullable(),
});
export type SetCplTargetInput = z.input<typeof setCplTargetSchema>;

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------
//
//   GET  /ads/insights                          -> InsightsResponse            (ads.read)
//   POST /ads/insights/generate                 -> { run: InsightRun }  202    (ads.read)
//   GET  /ads/insights/runs/:id                 -> { run: InsightRun }         (ads.read)
//   POST /ads/insights/:id/seen                 -> { insight: InsightCard }    (ads.read)
//   POST /ads/insights/:id/request              -> { insight, approvalId } 201 (ads.request)
//   GET  /ads/insights/suggestions              -> SuggestionsResponse         (ads.read)
//   POST /ads/insights/suggestions/generate     -> { run: InsightRun }  202    (ads.read)
//   POST /ads/insights/suggestions/:id/applied  -> { suggestion }              (ads.read)
//   POST /ads/insights/suggestions/:id/dismiss  -> { suggestion }              (ads.read)
//   GET  /ads/dashboard/settings                -> DashboardSettings           (ads.read)
//   PUT  /ads/dashboard/settings/cpl-target     -> DashboardSettings           (ads.request)
//   PUT  /ads/dashboard/settings/account-cpl-target -> DashboardSettings       (ads.request)
//
// Without OPENROUTER_API_KEY the generate routes answer 503, never a fake card.
// A generate while a run of the same kind is going answers 409 `already_running`;
// past the daily ceiling, 429 `daily_limit`; after INSIGHTS_FAILED_RUNS_PER_DAY
// failed runs in the day, 429 `too_many_failures`.
