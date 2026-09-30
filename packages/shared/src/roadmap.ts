import { z } from 'zod';

/**
 * Roadmap: the daily progress report for the CEOs (Umberto and Thais),
 * approved by Eric (Admin Master) before it goes out (docs/roadmap.md).
 *
 * A module (a navigation module or submodule) holds deliverables; each
 * deliverable carries a weight (P/M/G) and a status (pronto / em_andamento /
 * pendente). The generator seeds deliverables from commit history as
 * `source: 'auto_draft'`; a human edit flips the row to `source: 'manual'`
 * and the generator never overwrites it again.
 */

// --- weight and status ---------------------------------------------------

export const ROADMAP_WEIGHTS = ['P', 'M', 'G'] as const;
export type RoadmapWeight = (typeof ROADMAP_WEIGHTS)[number];

export const ROADMAP_WEIGHT_LABELS: Record<RoadmapWeight, string> = {
  P: 'Pequeno',
  M: 'Médio',
  G: 'Grande',
};

/** P=1, M=2, G=3: how much a deliverable counts toward its module's total. */
export const ROADMAP_WEIGHT_POINTS: Record<RoadmapWeight, number> = { P: 1, M: 2, G: 3 };

export const ROADMAP_DELIVERABLE_STATUSES = ['pronto', 'em_andamento', 'pendente'] as const;
export type RoadmapDeliverableStatus = (typeof ROADMAP_DELIVERABLE_STATUSES)[number];

export const ROADMAP_DELIVERABLE_STATUS_LABELS: Record<RoadmapDeliverableStatus, string> = {
  pronto: 'Pronto',
  em_andamento: 'Em andamento',
  pendente: 'Pendente',
};

/** How much a status counts toward its module's %: pronto full, em_andamento half, pendente none. */
export const ROADMAP_STATUS_COMPLETION: Record<RoadmapDeliverableStatus, number> = {
  pronto: 1,
  em_andamento: 0.5,
  pendente: 0,
};

export const ROADMAP_DELIVERABLE_SOURCES = ['auto_draft', 'manual'] as const;
export type RoadmapDeliverableSource = (typeof ROADMAP_DELIVERABLE_SOURCES)[number];

export const ROADMAP_DELIVERABLE_SOURCE_LABELS: Record<RoadmapDeliverableSource, string> = {
  auto_draft: 'Rascunho automático',
  manual: 'Editado manualmente',
};

export const ROADMAP_REPORT_RUN_STATUSES = [
  'rascunho',
  'aprovado',
  'enviado',
  'enviado_simulado',
] as const;
export type RoadmapReportRunStatus = (typeof ROADMAP_REPORT_RUN_STATUSES)[number];

export const ROADMAP_REPORT_RUN_STATUS_LABELS: Record<RoadmapReportRunStatus, string> = {
  rascunho: 'Rascunho',
  aprovado: 'Aprovado',
  enviado: 'Enviado',
  enviado_simulado: 'Enviado (simulado)',
};

export const ROADMAP_RECIPIENT_ROLES = ['preview', 'ceo'] as const;
export type RoadmapRecipientRole = (typeof ROADMAP_RECIPIENT_ROLES)[number];

export const ROADMAP_RECIPIENT_ROLE_LABELS: Record<RoadmapRecipientRole, string> = {
  preview: 'Prévia (17:30)',
  ceo: 'CEO (18:00, após aprovação)',
};

// --- entities --------------------------------------------------------------

export interface RoadmapDeliverable {
  id: string;
  moduleId: string;
  label: string;
  weight: RoadmapWeight;
  status: RoadmapDeliverableStatus;
  completedAt: string | null;
  source: RoadmapDeliverableSource;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface RoadmapModule {
  id: string;
  key: string;
  label: string;
  position: number;
  isComingSoon: boolean;
  deliverables: RoadmapDeliverable[];
  /** Sum of ROADMAP_WEIGHT_POINTS over the module's deliverables. */
  weightTotal: number;
  /** 0–100; null when the module has no deliverables yet. */
  percent: number | null;
}

export interface RoadmapForecast {
  /** Weeks to finish at the fastest week observed in the last 4 weeks. */
  optimisticWeeks: number | null;
  /** Weeks to finish at the average of the 4-week and since-start velocities. */
  provavelWeeks: number | null;
  /** Weeks to finish at the slowest week observed in the last 4 weeks. */
  pessimisticWeeks: number | null;
}

export interface RoadmapVelocity {
  /** Weight completed per week, averaged over the last 4 weeks. Null with no data in the window. */
  last4WeeksPerWeek: number | null;
  /** Weight completed per week, averaged since the first recorded deliverable. Null with no data. */
  sinceStartPerWeek: number | null;
}

export interface RoadmapComputed {
  reportDate: string;
  modules: {
    moduleId: string;
    key: string;
    label: string;
    weightTotal: number;
    percent: number | null;
  }[];
  /** Weighted average of every module's % by its weight total; null when nothing has weight yet. */
  weightedTotalPercent: number | null;
  velocity: RoadmapVelocity;
  /** Null ("indeterminado") when velocity is zero — never a divide-by-zero. */
  forecast: RoadmapForecast | null;
  /** This week's total weight vs. last week's, as a percentage change. Null with no prior snapshot. */
  scopeChangePercent: number | null;
}

export interface RoadmapReportRun {
  id: string;
  reportDate: string;
  status: RoadmapReportRunStatus;
  computed: RoadmapComputed;
  messageText: string;
  approvedBy: string | null;
  approvedByName: string | null;
  approvedAt: string | null;
  sentAt: string | null;
  createdAt: string;
}

export interface RoadmapReportRecipient {
  id: string;
  role: RoadmapRecipientRole;
  name: string;
  phone: string;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface RoadmapDeliverableChange {
  id: string;
  deliverableId: string;
  changedBy: string | null;
  changedByName: string | null;
  previous: { status: RoadmapDeliverableStatus; weight: RoadmapWeight };
  next: { status: RoadmapDeliverableStatus; weight: RoadmapWeight };
  changedAt: string;
}

// --- request schemas ---------------------------------------------------------

export const roadmapDeliverableUpdateSchema = z.object({
  status: z.enum(ROADMAP_DELIVERABLE_STATUSES).optional(),
  weight: z.enum(ROADMAP_WEIGHTS).optional(),
  notes: z
    .string()
    .trim()
    .max(2000)
    .optional()
    .or(z.literal('').transform(() => undefined)),
  /** YYYY-MM-DD. Only meaningful when status is `pronto`. */
  completedAt: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional()
    .or(z.literal('').transform(() => undefined)),
});
export type RoadmapDeliverableUpdateInput = z.infer<typeof roadmapDeliverableUpdateSchema>;

export const roadmapRecipientCreateSchema = z.object({
  role: z.enum(ROADMAP_RECIPIENT_ROLES),
  name: z.string().trim().min(2, 'Informe o nome').max(120),
  phone: z.string().trim().min(10, 'Informe o telefone').max(30),
  active: z.boolean().optional(),
});
export type RoadmapRecipientCreateInput = z.infer<typeof roadmapRecipientCreateSchema>;

export const roadmapRecipientUpdateSchema = z.object({
  name: z.string().trim().min(2).max(120).optional(),
  phone: z.string().trim().min(10).max(30).optional(),
  active: z.boolean().optional(),
});
export type RoadmapRecipientUpdateInput = z.infer<typeof roadmapRecipientUpdateSchema>;

// Routes (docs/roadmap.md):
//   GET   /roadmap/modules                          -> { modules: RoadmapModule[], computed: RoadmapComputed }  roadmap.manage
//   PATCH /roadmap/deliverables/:id                  -> { deliverable: RoadmapDeliverable }                     roadmap.manage
//   GET   /roadmap/reports                           -> { runs: RoadmapReportRun[] }                            roadmap.manage
//   GET   /roadmap/reports/:id                       -> { run: RoadmapReportRun }                               roadmap.manage
//   POST  /roadmap/reports/:id/approve                -> { run: RoadmapReportRun }                               roadmap.manage
//   GET   /roadmap/recipients                        -> { recipients: RoadmapReportRecipient[] }                roadmap.manage
//   POST  /roadmap/recipients                        -> { recipient: RoadmapReportRecipient }                  roadmap.manage
//   PATCH /roadmap/recipients/:id                     -> { recipient: RoadmapReportRecipient }                  roadmap.manage
//   DELETE /roadmap/recipients/:id                    -> 204                                                    roadmap.manage
