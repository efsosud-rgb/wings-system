import {
  ACCOUNT_CPL_SUGGESTION,
  objectiveKindOf,
  type AccountCplTarget,
  type CplTarget,
  type ObjectiveKind,
} from '@wings/shared';
import { and, eq, gte, inArray, lte, sql } from 'drizzle-orm';
import type { Database } from '../../../db/client.js';
import {
  accountCplTargets,
  adCampaigns,
  adMetricsDaily,
  cplTargets,
  employees,
  WINGS_TENANT_ID,
} from '../../../db/schema/index.js';
import { activeAccounts } from './queries.js';
import { addDays, dayIn } from './window.js';

/**
 * The CPL (leads) and CPC (traffic) targets the verdicts judge against.
 *
 * A target is a person's decision: `proposeTargets` only computes what the
 * last 90 days suggest, with the basis written out, and `confirmedTargets`
 * returns what somebody confirmed in Configurações do Dashboard. Until then a
 * leads campaign's verdict is "Sem meta", never a verdict against a guess.
 */

const HISTORY_DAYS = 90;
/** Fewer leads than this and the history says nothing worth proposing. */
const MIN_LEADS_FOR_PROPOSAL = 5;
const MIN_CLICKS_FOR_PROPOSAL = 100;

const brl = (cents: number) =>
  `R$ ${(cents / 100).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** Confirmed targets by objective kind; only kinds with a value are present. */
export async function confirmedTargets(db: Database): Promise<Map<ObjectiveKind, number>> {
  const rows = await db
    .select({ objectiveKind: cplTargets.objectiveKind, targetCents: cplTargets.targetCents })
    .from(cplTargets)
    .where(eq(cplTargets.tenantId, WINGS_TENANT_ID));
  const targets = new Map<ObjectiveKind, number>();
  for (const row of rows) {
    if (row.targetCents !== null) targets.set(row.objectiveKind as ObjectiveKind, row.targetCents);
  }
  return targets;
}

/**
 * What the history proposes: the weighted cost over the last 90 days of the
 * campaigns of each kind, rounded up to the real. Leads campaigns propose a
 * CPL, traffic campaigns a CPC. Null with too little history.
 */
export async function proposeTargets(
  db: Database,
  now = new Date(),
): Promise<Map<ObjectiveKind, { cents: number; basis: string }>> {
  const proposals = new Map<ObjectiveKind, { cents: number; basis: string }>();
  const accounts = await activeAccounts(db);
  const ids = accounts.map((account) => account.id);
  if (ids.length === 0) return proposals;
  const until = dayIn(now);
  const since = addDays(until, -(HISTORY_DAYS - 1));

  const [campaigns, sums] = await Promise.all([
    db.query.adCampaigns.findMany({ where: inArray(adCampaigns.adAccountId, ids) }),
    db
      .select({
        entity: adMetricsDaily.entityExternalId,
        spendCents: sql<string>`coalesce(sum(${adMetricsDaily.spendCents}), 0)`,
        clicks: sql<string>`coalesce(sum(${adMetricsDaily.clicks}), 0)`,
        conversions: sql<string>`coalesce(sum(${adMetricsDaily.conversions}), 0)`,
      })
      .from(adMetricsDaily)
      .where(
        and(
          inArray(adMetricsDaily.adAccountId, ids),
          eq(adMetricsDaily.level, 'campaign'),
          gte(adMetricsDaily.day, since),
          lte(adMetricsDaily.day, until),
        ),
      )
      .groupBy(adMetricsDaily.entityExternalId),
  ]);
  const platformOf = new Map(
    accounts.map((account) => [account.id, account.platform as 'meta' | 'google']),
  );
  const kindOf = new Map(
    campaigns.map((campaign) => [
      campaign.externalId,
      objectiveKindOf(campaign.objective, platformOf.get(campaign.adAccountId) ?? 'meta'),
    ]),
  );

  const totals = {
    leads: { spend: 0, leads: 0, campaigns: 0 },
    traffic: { spend: 0, clicks: 0, campaigns: 0 },
  };
  for (const row of sums) {
    const kind = kindOf.get(row.entity);
    const spend = Number(row.spendCents);
    if (kind === 'leads') {
      const leads = Number(row.conversions);
      if (leads === 0) continue;
      totals.leads.spend += spend;
      totals.leads.leads += leads;
      totals.leads.campaigns += 1;
    } else if (kind === 'traffic') {
      const clicks = Number(row.clicks);
      if (clicks === 0) continue;
      totals.traffic.spend += spend;
      totals.traffic.clicks += clicks;
      totals.traffic.campaigns += 1;
    }
  }

  if (totals.leads.leads >= MIN_LEADS_FOR_PROPOSAL) {
    const cpl = totals.leads.spend / totals.leads.leads;
    const cents = Math.ceil(cpl / 100) * 100;
    proposals.set('leads', {
      cents,
      basis: `CPL médio dos últimos ${HISTORY_DAYS} dias: ${brl(Math.round(cpl))} em ${totals.leads.campaigns} campanha(s) de leads, ${totals.leads.leads} leads por ${brl(totals.leads.spend)}. Arredondado para cima.`,
    });
  }
  if (totals.traffic.clicks >= MIN_CLICKS_FOR_PROPOSAL) {
    const cpc = totals.traffic.spend / totals.traffic.clicks;
    const cents = Math.ceil(cpc / 10) * 10;
    proposals.set('traffic', {
      cents,
      basis: `CPC médio dos últimos ${HISTORY_DAYS} dias: ${brl(Math.round(cpc))} em ${totals.traffic.campaigns} campanha(s) de tráfego, ${totals.traffic.clicks} cliques por ${brl(totals.traffic.spend)}. Arredondado para cima.`,
    });
  }
  return proposals;
}

/** Both kinds, confirmed or not, as the settings screen shows them. */
export async function dashboardTargets(db: Database, now = new Date()): Promise<CplTarget[]> {
  const [rows, proposals] = await Promise.all([
    db
      .select({
        objectiveKind: cplTargets.objectiveKind,
        targetCents: cplTargets.targetCents,
        confirmedAt: cplTargets.confirmedAt,
        confirmedByName: employees.fullName,
      })
      .from(cplTargets)
      .leftJoin(employees, eq(employees.id, cplTargets.confirmedBy))
      .where(eq(cplTargets.tenantId, WINGS_TENANT_ID)),
    proposeTargets(db, now),
  ]);
  const byKind = new Map(rows.map((row) => [row.objectiveKind, row]));
  return (['leads', 'traffic'] as const).map((kind) => {
    const row = byKind.get(kind);
    const proposal = proposals.get(kind);
    return {
      objectiveKind: kind,
      targetCents: row?.targetCents ?? null,
      confirmedAt: row?.confirmedAt?.toISOString() ?? null,
      confirmedByName:
        row?.targetCents !== null && row?.targetCents !== undefined
          ? (row.confirmedByName ?? null)
          : null,
      proposedCents: proposal?.cents ?? null,
      proposedBasis: proposal?.basis ?? null,
    };
  });
}

/** A person confirmed (or cleared) a target. Null clears it. */
export async function setTarget(
  db: Database,
  input: {
    objectiveKind: 'leads' | 'traffic';
    targetCents: number | null;
    employeeId: string;
    now?: Date;
  },
): Promise<void> {
  const now = input.now ?? new Date();
  const values = {
    targetCents: input.targetCents,
    confirmedBy: input.targetCents === null ? null : input.employeeId,
    confirmedAt: input.targetCents === null ? null : now,
    updatedAt: now,
  };
  await db
    .insert(cplTargets)
    .values({ tenantId: WINGS_TENANT_ID, objectiveKind: input.objectiveKind, ...values })
    .onConflictDoUpdate({ target: [cplTargets.tenantId, cplTargets.objectiveKind], set: values });
}

/** Confirmed leads targets by ad account id; accounts without one are absent. */
export async function confirmedAccountTargets(db: Database): Promise<Map<string, number>> {
  const rows = await db
    .select({
      adAccountId: accountCplTargets.adAccountId,
      targetCents: accountCplTargets.targetCents,
    })
    .from(accountCplTargets)
    .where(eq(accountCplTargets.objectiveKind, 'leads'));
  const targets = new Map<string, number>();
  for (const row of rows)
    if (row.targetCents !== null) targets.set(row.adAccountId, row.targetCents);
  return targets;
}

/** Every active account with its leads target, confirmed or only suggested, for the settings screen. */
export async function dashboardAccountTargets(db: Database): Promise<AccountCplTarget[]> {
  const [accounts, rows] = await Promise.all([
    activeAccounts(db),
    db
      .select({
        adAccountId: accountCplTargets.adAccountId,
        targetCents: accountCplTargets.targetCents,
        confirmedAt: accountCplTargets.confirmedAt,
        confirmedByName: employees.fullName,
      })
      .from(accountCplTargets)
      .leftJoin(employees, eq(employees.id, accountCplTargets.confirmedBy))
      .where(eq(accountCplTargets.objectiveKind, 'leads')),
  ]);
  const byAccount = new Map(rows.map((row) => [row.adAccountId, row]));
  return accounts.map((account) => {
    const platform = account.platform as 'meta' | 'google';
    const row = byAccount.get(account.id);
    const confirmed = row?.targetCents !== null && row?.targetCents !== undefined;
    const suggestion = ACCOUNT_CPL_SUGGESTION[platform];
    return {
      adAccountId: account.id,
      accountName: account.name,
      platform,
      targetCents: row?.targetCents ?? null,
      confirmedAt: confirmed ? (row?.confirmedAt?.toISOString() ?? null) : null,
      confirmedByName: confirmed ? (row?.confirmedByName ?? null) : null,
      suggestedCents: suggestion.cents,
      suggestionNote: suggestion.note,
    };
  });
}

/** A person confirmed (or cleared) an account's leads target. Null clears it. */
export async function setAccountTarget(
  db: Database,
  input: { adAccountId: string; targetCents: number | null; employeeId: string; now?: Date },
): Promise<void> {
  const now = input.now ?? new Date();
  const values = {
    targetCents: input.targetCents,
    confirmedBy: input.targetCents === null ? null : input.employeeId,
    confirmedAt: input.targetCents === null ? null : now,
    updatedAt: now,
  };
  await db
    .insert(accountCplTargets)
    .values({ adAccountId: input.adAccountId, objectiveKind: 'leads', ...values })
    .onConflictDoUpdate({
      target: [accountCplTargets.adAccountId, accountCplTargets.objectiveKind],
      set: values,
    });
}
