/**
 * Contract for the scenario simulator, the before/after diff and the grouped
 * approval view (Stage 6.7).
 *
 * All three are **read-only decision support**. Nothing here approves,
 * executes, or edits a request: the gate built in Stage 4 remains the only way
 * a budget moves, and every decision is still recorded one at a time.
 */

export interface ExposureScenario {
  label: 'current' | 'requested' | 'simulated';
  dailyBudgetCents: number;
  campaignExposureCents: number;
  committedCents: number;
  availableCents: number;
  usedOfUsablePercent: number;
  usedOfCapPercent: number;
  withinUsable: boolean;
  withinCap: boolean;
  /** Days the daily budget could run on what is available; null when zero. */
  runwayDays: number | null;
}

/**
 * Exposure is reserved when a change is *requested*, not when it is approved,
 * so these two totals differ while a request is pending.
 */
export interface SimulationPeriod {
  periodMonth: string;
  capCents: number;
  usableCents: number;
  spentCents: number;
  committedWithRequestCents: number;
  committedWithoutRequestCents: number;
}

export interface ChangeSimulation {
  changeRequestId: string;
  kind: string;
  campaignName: string;
  campaignExternalId: string;
  budgetLevel: 'campaign' | 'ad_set' | 'none';
  daysLeftInPeriod: number;
  overdeliveryFactorMilli: number;
  period: SimulationPeriod;
  current: ExposureScenario;
  requested: ExposureScenario;
  simulated: ExposureScenario | null;
  simulationAvailable: boolean;
  /** Mirrored platform state no longer matches what the request assumed. */
  drift: { field: string; expectedCents: number; mirroredCents: number } | null;
  campaignSyncedAt: string | null;
}

export interface PendingGroupItem {
  approvalId: string;
  changeRequestId: string;
  status: 'pending' | 'escalated';
  changeKind: string;
  amountCents: number;
  exposureDeltaCents: number;
  fromValueCents: number | null;
  toValueCents: number | null;
  requestedAt: string;
  escalatedAt: string | null;
  requestedByName: string | null;
  requestedByAgent: boolean;
}

export interface PendingGroup {
  campaignId: string;
  campaignName: string;
  campaignExternalId: string;
  accountId: string;
  accountName: string;
  platform: 'meta' | 'google' | 'tiktok';
  items: PendingGroupItem[];
  totalExposureDeltaCents: number;
  totalAmountCents: number;
  periodMonth: string;
  capCents: number;
  usableCents: number;
  committedCents: number;
  spentCents: number;
  shareOfUsablePercent: number;
  oldestRequestedAt: string;
  anyEscalated: boolean;
}

/** Where the next waiting decision on the same campaign lives. */
export interface NextPendingLink {
  approvalId: string;
  remaining: number;
}
