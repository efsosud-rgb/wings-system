import { z } from 'zod';
import {
  LEAD_PIPELINES,
  LEAD_SOURCES,
  NO_OWNER,
  type LeadPipeline,
  type LeadSource,
} from './leads.js';

/**
 * Dashboard › Vendas, v1 (rows 1, 3 and 4 of the sales panel). Every number
 * is an aggregate of the CRM's own tables, in the caller's scope (a seller
 * sees only their own deals). A figure the data cannot give yet (a goal, an
 * expected close date, a stage deadline) comes back `null`, and the screen
 * shows "—" with the reason; nothing is estimated in its place.
 */

// --- period -------------------------------------------------------------------------

export const SALES_PERIODS = ['month', '7d', '30d', '90d', 'quarter', 'year', 'custom'] as const;
export type SalesPeriod = (typeof SALES_PERIODS)[number];
export const SALES_PERIOD_LABELS: Record<SalesPeriod, string> = {
  month: 'Mês atual',
  '7d': 'Últimos 7 dias',
  '30d': 'Últimos 30 dias',
  '90d': 'Últimos 90 dias',
  quarter: 'Trimestre atual',
  year: 'Ano atual',
  custom: 'Personalizado',
};

/** Which earlier range the executive row compares with. */
export const SALES_COMPARISONS = ['previous', 'previous_year', 'none'] as const;
export type SalesComparison = (typeof SALES_COMPARISONS)[number];
export const SALES_COMPARISON_LABELS: Record<SalesComparison, string> = {
  previous: 'Período anterior',
  previous_year: 'Mesmo período do ano anterior',
  none: 'Sem comparação',
};

/** The funnel filter's value for every funnel at once. */
export const ALL_PIPELINES = 'todos';
/** The brand filter's value for deals with no brand. */
export const NO_BRAND = 'none';

/** Days as São Paulo calendar dates (YYYY-MM-DD); `to` is inclusive. */
export interface SalesRange {
  from: string;
  to: string;
}

const DAY_MS = 86_400_000;
const isoDay = (date: Date) => date.toISOString().slice(0, 10);
const dayAt = (day: string) => new Date(`${day}T00:00:00Z`);
const addDays = (day: string, days: number) =>
  isoDay(new Date(dayAt(day).getTime() + days * DAY_MS));
const daysBetween = (from: string, to: string) =>
  Math.round((dayAt(to).getTime() - dayAt(from).getTime()) / DAY_MS) + 1;

/** Today in São Paulo (UTC−3, no daylight saving since 2019). */
export const saoPauloToday = (now: Date) => isoDay(new Date(now.getTime() - 3 * 3_600_000));

/** First instant of a São Paulo day, as a UTC instant. */
export const saoPauloDayStart = (day: string) => new Date(`${day}T03:00:00Z`);

/** The same calendar dates one year earlier (29/02 falls on 01/03). */
const yearBefore = (day: string) => {
  const date = dayAt(day);
  return isoDay(
    new Date(Date.UTC(date.getUTCFullYear() - 1, date.getUTCMonth(), date.getUTCDate())),
  );
};

function startOfUnit(day: string, unit: 'month' | 'quarter' | 'year'): string {
  const date = dayAt(day);
  const month =
    unit === 'year'
      ? 0
      : unit === 'quarter'
        ? Math.floor(date.getUTCMonth() / 3) * 3
        : date.getUTCMonth();
  return isoDay(new Date(Date.UTC(date.getUTCFullYear(), month, 1)));
}

/**
 * The period the panel shows and the two it compares with. A "to date" period
 * (month, quarter, year) compares with the same number of days at the start of
 * the unit before (1–15/10 against 1–15/09), never with a whole month; a
 * rolling one with the same length just before it.
 */
export function salesRanges(
  period: SalesPeriod,
  now: Date,
  custom?: { from?: string; to?: string },
): { current: SalesRange; previous: SalesRange; previousYear: SalesRange } {
  const today = saoPauloToday(now);
  let current: SalesRange;
  if (period === 'custom' && custom?.from && custom.to)
    current = { from: custom.from, to: custom.to };
  else if (period === '7d' || period === '30d' || period === '90d')
    current = { from: addDays(today, -(Number.parseInt(period, 10) - 1)), to: today };
  else {
    const unit = period === 'quarter' || period === 'year' ? period : 'month';
    current = { from: startOfUnit(today, unit), to: today };
  }
  const length = daysBetween(current.from, current.to);

  let previous: SalesRange;
  if (period === 'month' || period === 'quarter' || period === 'year') {
    const before = startOfUnit(addDays(current.from, -1), period);
    const end = addDays(current.from, -1);
    const to = addDays(before, length - 1);
    previous = { from: before, to: to < end ? to : end };
  } else {
    previous = { from: addDays(current.from, -length), to: addDays(current.from, -1) };
  }
  return {
    current,
    previous,
    previousYear: { from: yearBefore(current.from), to: yearBefore(current.to) },
  };
}

// --- query --------------------------------------------------------------------------

const optional = <T extends z.ZodType>(schema: T) =>
  schema.optional().or(z.literal('').transform(() => undefined));
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const salesDashboardQuerySchema = z
  .object({
    pipeline: z.enum([...LEAD_PIPELINES, ALL_PIPELINES]).default(ALL_PIPELINES),
    period: z.enum(SALES_PERIODS).default('month'),
    from: optional(day),
    to: optional(day),
    /** An employee id, or `none` for the deals nobody owns. */
    owner: optional(z.uuid().or(z.literal(NO_OWNER))),
    /** A brand as the deals carry it, or `none` for the deals with no brand. */
    brand: optional(z.string().trim().max(120)),
    source: optional(z.enum(LEAD_SOURCES)),
    /** Campaign name or id, matched as the CRM's list matches it. */
    campaign: optional(z.string().trim().max(200)),
  })
  .refine(
    (value) =>
      value.period !== 'custom' ||
      (value.from !== undefined && value.to !== undefined && value.from <= value.to),
    { message: 'Informe o início e o fim do período.', path: ['from'] },
  )
  .refine(
    (value) =>
      value.period !== 'custom' ||
      !value.from ||
      !value.to ||
      daysBetween(value.from, value.to) <= 731,
    { message: 'O período vai até dois anos.', path: ['to'] },
  );
export type SalesDashboardQuery = z.infer<typeof salesDashboardQuerySchema>;

// --- answer -------------------------------------------------------------------------

/** One slice of open deals: a count, its value and the probability-weighted value, cents. */
export interface SalesSlice {
  total: number;
  valueCents: number;
  weightedCents: number;
}

/** What closed in one range. */
export interface SalesResults {
  /** Sum of the won deals' values, cents. */
  wonCents: number;
  won: number;
  /** Won deals with no value: counted in `won`, missing from `wonCents` and the ticket. */
  wonWithoutValue: number;
  /** `wonCents` ÷ won deals with a value; null when none had one. */
  ticketCents: number | null;
  lost: number;
  /** won ÷ (won + lost) closed in the range; null when nothing closed. */
  conversionRate: number | null;
}

export interface SalesFunnelStep {
  stage: { id: string; name: string; probability: number } | null;
  /** Open deals in the stage now. */
  open: SalesSlice;
  /** Deals created in the period that reached this stage or a later one (or were won). */
  reached: number;
  /** reached(next) ÷ reached(this); null for the last stage or when nothing reached this one. */
  toNext: number | null;
  /** Average days a deal stayed in the stage, over the exits in the period; null with no exit. */
  avgDays: number | null;
  exits: number;
}

export interface SalesSellerRow {
  ownerEmployeeId: string | null;
  ownerName: string | null;
  won: number;
  wonCents: number;
  open: number;
  openCents: number;
  /** Calls and meetings this person recorded in the period. */
  activities: number;
  /** Average hours from the deal's creation to its first contact, over the deals created in the period that had one. */
  firstContactHours: number | null;
  firstContactCount: number;
  /** The month's goal; null until the Metas screen exists. */
  goalCents: number | null;
}

export interface SalesBrandRow {
  brand: string | null;
  open: number;
  openCents: number;
  won: number;
  wonCents: number;
}

export interface SalesServiceRow {
  pipeline: LeadPipeline | null;
  open: number;
  openCents: number;
  won: number;
  wonCents: number;
}

export interface SalesSourceRow {
  source: LeadSource;
  /** Deals created in the period. */
  leads: number;
  won: number;
  wonCents: number;
}

export interface SalesCampaignRow {
  /** The campaign's name as the deals carry it (or its UTM); null for "sem campanha". */
  campaign: string | null;
  leads: number;
  won: number;
  wonCents: number;
  /** Ad spend in the period of the platform campaigns these deals came from; null when none is linked or the caller may not see spend. */
  spendCents: number | null;
  cplCents: number | null;
  cacCents: number | null;
  /** wonCents ÷ spendCents. */
  roas: number | null;
}

/** `uf` by the phone's DDD; `none` = no phone or an unknown DDD; `abroad` = a number from outside Brazil. */
export interface SalesRegionRow {
  kind: 'uf' | 'none' | 'abroad';
  uf: string | null;
  leads: number;
  won: number;
}

export interface SalesCityRow {
  /** The most common spelling among those that differ only in case, accents and spaces; null = not given. */
  city: string | null;
  leads: number;
  won: number;
}

export interface SalesDashboard {
  pipeline: LeadPipeline | null;
  /** `own`: a seller's own deals only; ranking, brands, campaigns and region are not sent. */
  scope: 'own' | 'all';
  ranges: { current: SalesRange; previous: SalesRange; previousYear: SalesRange };
  results: { current: SalesResults; previous: SalesResults; previousYear: SalesResults };
  /** Null until goals exist (Metas, CRM Configurações). */
  goalCents: number | null;
  /** Open deals now, whatever the period. */
  open: SalesSlice & { withoutValue: number };
  /** Null until deals have an expected close date. */
  forecastCents: number | null;
  /** Null when every funnel is shown at once (their stages differ). */
  funnel: SalesFunnelStep[] | null;
  /** Average days from creation to a win, over the deals won in the period. */
  timeToClose: { avgDays: number | null; count: number };
  sellers: SalesSellerRow[];
  brands: SalesBrandRow[];
  /** Per funnel, only when every funnel is shown. */
  services: SalesServiceRow[];
  sources: SalesSourceRow[];
  campaigns: SalesCampaignRow[];
  /** Whether the caller may see ad spend (`ads.read`); without it CPL, CAC and ROAS are null. */
  spendVisible: boolean;
  regions: SalesRegionRow[];
  cities: SalesCityRow[];
  lostReasons: { reason: string | null; total: number }[];
  actions: {
    /** Null until deals have an expected close date. */
    closingSoon: number | null;
    /** Null until stages have a deadline. */
    stalled: number | null;
    /** Open deals whose first-contact task is past due and not done. */
    firstContactOverdue: number;
    /** Null until goals exist. */
    goalsAtRisk: number | null;
    /** Open deals with no owner (always 0 in a seller's own scope). */
    noOwner: number;
  };
  /** Campaign names in scope, for the filter. */
  campaignOptions: string[];
}

// --- region helpers -----------------------------------------------------------------

/** Folds case, accents and runs of spaces, so "São  Paulo" and "sao paulo" are one city. */
export const cityKey = (city: string) =>
  city.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
