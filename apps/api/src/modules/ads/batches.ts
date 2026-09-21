import { eq, sql } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import { adApprovalRequests } from '../../db/schema/index.js';

/**
 * Grouped view of approvals that are still waiting.
 *
 * This is a *view*, not a new decision path. Requests that pile up on the same
 * campaign are read together so an approver can see their combined weight
 * before deciding — but every decision is still taken and recorded one by one,
 * through the same gate. There is deliberately no bulk-approve endpoint: a
 * single click that moves several budgets at once is exactly the thing the
 * approval policy exists to prevent.
 *
 * The totals here describe exposure that is **already reserved**: a pending
 * request holds its delta in `committed_cents` from the moment it is created.
 * Approving does not add to it; rejecting gives it back.
 */

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
  suggestedByAgent: boolean;
}

export interface PendingGroup {
  campaignId: string;
  campaignName: string;
  campaignExternalId: string;
  accountId: string;
  accountName: string;
  platform: 'meta' | 'google' | 'tiktok';
  items: PendingGroupItem[];
  /** Sum of the exposure these requests hold, which may be negative. */
  totalExposureDeltaCents: number;
  /** Sum of the amounts being judged, always positive. */
  totalAmountCents: number;
  periodMonth: string;
  capCents: number;
  usableCents: number;
  committedCents: number;
  spentCents: number;
  /** Share of the usable slice held by this group's reservations. */
  shareOfUsablePercent: number;
  oldestRequestedAt: string;
  anyEscalated: boolean;
}

type GroupRow = {
  approval_id: string;
  change_request_id: string;
  status: 'pending' | 'escalated';
  change_kind: string;
  amount_cents: string;
  exposure_delta_cents: string;
  from_value_cents: string | null;
  to_value_cents: string | null;
  requested_at: Date | string;
  escalated_at: Date | string | null;
  requested_by_name: string | null;
  requested_by_agent: boolean;
  suggested_by_agent: boolean;
  campaign_id: string;
  campaign_name: string;
  campaign_external_id: string;
  account_id: string;
  account_name: string;
  platform: 'meta' | 'google' | 'tiktok';
  period_month: string;
  cap_cents: string;
  usable_cents: string;
  committed_cents: string;
  spent_cents: string;
} & Record<string, unknown>;

function iso(value: Date | string): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

/** Every waiting approval, grouped by the campaign it touches. */
export async function pendingGroups(db: Database): Promise<PendingGroup[]> {
  const rows = await db.execute<GroupRow>(sql`
    select ar.id as approval_id, cr.id as change_request_id, ar.status,
           cr.kind as change_kind, ar.amount_cents::text as amount_cents,
           cr.exposure_delta_cents::text as exposure_delta_cents,
           cr.from_value_cents::text as from_value_cents,
           cr.to_value_cents::text as to_value_cents,
           ar.requested_at, ar.escalated_at,
           req.full_name as requested_by_name, ar.requested_by_agent,
           cr.suggested_by_agent,
           -- A campaign still to be created is its own group, under its draft.
           coalesce(c.id, d.id) as campaign_id, coalesce(c.name, d.name) as campaign_name,
           coalesce(c.external_id, '') as campaign_external_id,
           acc.id as account_id, acc.name as account_name, acc.platform,
           p.period_month, p.cap_cents::text as cap_cents, p.usable_cents::text as usable_cents,
           p.committed_cents::text as committed_cents, p.spent_cents::text as spent_cents
      from ad_approval_requests ar
      join ad_change_requests cr on cr.id = ar.change_request_id
      left join ad_campaigns c on c.id = cr.campaign_id
      left join ad_campaign_drafts d on d.id = cr.draft_id
      join ad_accounts acc on acc.id = ar.ad_account_id
      join ad_budget_periods p on p.id = cr.budget_period_id
      left join employees req on req.id = ar.requested_by
     where ar.status in ('pending', 'escalated')
     order by ar.requested_at asc
  `);

  const groups = new Map<string, PendingGroup>();

  for (const row of rows.rows) {
    const item: PendingGroupItem = {
      approvalId: row.approval_id,
      changeRequestId: row.change_request_id,
      status: row.status,
      changeKind: row.change_kind,
      amountCents: Number(row.amount_cents),
      exposureDeltaCents: Number(row.exposure_delta_cents),
      fromValueCents: row.from_value_cents === null ? null : Number(row.from_value_cents),
      toValueCents: row.to_value_cents === null ? null : Number(row.to_value_cents),
      requestedAt: iso(row.requested_at),
      escalatedAt: row.escalated_at === null ? null : iso(row.escalated_at),
      requestedByName: row.requested_by_name,
      requestedByAgent: row.requested_by_agent,
      suggestedByAgent: row.suggested_by_agent,
    };

    const existing = groups.get(row.campaign_id);
    if (existing) {
      existing.items.push(item);
      existing.totalExposureDeltaCents += item.exposureDeltaCents;
      existing.totalAmountCents += item.amountCents;
      existing.anyEscalated = existing.anyEscalated || item.status === 'escalated';
      continue;
    }

    groups.set(row.campaign_id, {
      campaignId: row.campaign_id,
      campaignName: row.campaign_name,
      campaignExternalId: row.campaign_external_id,
      accountId: row.account_id,
      accountName: row.account_name,
      platform: row.platform,
      items: [item],
      totalExposureDeltaCents: item.exposureDeltaCents,
      totalAmountCents: item.amountCents,
      periodMonth: row.period_month,
      capCents: Number(row.cap_cents),
      usableCents: Number(row.usable_cents),
      committedCents: Number(row.committed_cents),
      spentCents: Number(row.spent_cents),
      shareOfUsablePercent: 0,
      // Rows arrive oldest first, so the first item of a group is its oldest.
      oldestRequestedAt: item.requestedAt,
      anyEscalated: item.status === 'escalated',
    });
  }

  const result = [...groups.values()];
  for (const group of result) {
    group.shareOfUsablePercent =
      group.usableCents > 0
        ? Math.round((group.totalExposureDeltaCents / group.usableCents) * 100)
        : 0;
  }

  // Escalated groups first, then the longest-waiting.
  return result.sort((a, b) => {
    if (a.anyEscalated !== b.anyEscalated) return a.anyEscalated ? -1 : 1;
    return a.oldestRequestedAt.localeCompare(b.oldestRequestedAt);
  });
}

/**
 * The next approval still waiting on the same campaign.
 *
 * Navigation only: it carries someone from one decision to the next without
 * deciding anything for them.
 */
export async function nextPendingInGroup(
  db: Database,
  approvalId: string,
): Promise<{ approvalId: string; remaining: number } | null> {
  const current = await db.query.adApprovalRequests.findFirst({
    where: eq(adApprovalRequests.id, approvalId),
  });
  if (!current) return null;

  const rows = await db.execute<
    { id: string; requested_at: Date | string } & Record<string, unknown>
  >(sql`
    select ar.id, ar.requested_at
      from ad_approval_requests ar
      join ad_change_requests cr on cr.id = ar.change_request_id
     where ar.status in ('pending', 'escalated')
       and ar.id <> ${approvalId}
       and cr.campaign_id = (
         select campaign_id from ad_change_requests where id = ${current.changeRequestId}
       )
     order by ar.requested_at asc
  `);

  const next = rows.rows[0];
  if (!next) return null;
  return { approvalId: next.id, remaining: rows.rows.length };
}
