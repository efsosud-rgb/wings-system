import type { LeadPipeline } from './leads.js';
import { salesPeriodQuerySchema, withPeriodChecks, type SalesRange } from './sales-panel.js';
import type { Scope } from './rbac/permissions.js';

/**
 * Painel de Vendas › Produtividade (docs/crm/produtividade.md): results per person
 * read from the dimensional model (`dw`), never time logged or screens watched.
 * Counts only; every rate is divided on the screen with "—" for an empty
 * denominator, and a measure the CRM does not record yet comes with its reason.
 */

export const productivityQuerySchema = withPeriodChecks(salesPeriodQuerySchema);
export type ProductivityQuery = typeof productivityQuerySchema._output;

export const PRODUCTIVITY_ACTIVITY_TYPES = [
  'ligacao',
  'mensagem',
  'email',
  'reuniao_agendada',
  'reuniao_realizada',
  'nota',
  'tarefa',
] as const;
export type ProductivityActivityType = (typeof PRODUCTIVITY_ACTIVITY_TYPES)[number];
export const PRODUCTIVITY_ACTIVITY_LABELS: Record<ProductivityActivityType, string> = {
  ligacao: 'Ligações',
  mensagem: 'Mensagens',
  email: 'E-mails',
  reuniao_agendada: 'Reuniões agendadas',
  reuniao_realizada: 'Reuniões realizadas',
  nota: 'Notas',
  tarefa: 'Tarefas concluídas',
};

/** The counts of one person (or of a whole team, summed) in the period. */
export interface ProductivityCounts {
  /** Deals that entered in the period with this owner. */
  received: number;
  /** First contact within one working hour: how many were, of how many are already decided. */
  firstContact: { inTime: number; decided: number; medianMinutes: number | null };
  activities: Record<ProductivityActivityType, number>;
  /** Stage changes this person made to a later stage of the same funnel. */
  stageAdvances: number;
  won: number;
  lost: number;
  /** Working minutes from the lead's message to this person's reply; null without the data. */
  whatsappMedianMinutes: number | null;
}

export interface ProductivityPerson extends ProductivityCounts {
  employeeId: string;
  name: string;
  active: boolean;
}

export interface ProductivityStage {
  id: string;
  name: string;
  order: number;
  /** Deals received in the period that reached this stage (or a later one). */
  reached: number;
}

export interface Productivity {
  scope: Scope;
  pipeline: LeadPipeline | null;
  range: SalesRange;
  /** The people the caller may see, one row each (a seller: only themselves). */
  people: ProductivityPerson[];
  /** The team's totals and how many people they cover: the screen divides for the average. */
  team: ProductivityCounts & { people: number };
  /** Only with one funnel chosen: the stages in order and how many received deals reached each. */
  stages: ProductivityStage[];
  lostReasons: { reason: string; count: number }[];
  /** A measure without data comes as the reason, never as a zero. */
  unavailable: { whatsapp: string | null; ficha: string; cof: string; projects: string };
  /** When the dimensional model was last loaded; null until the first load. */
  loadedAt: string | null;
}
