import {
  ALL_PIPELINES,
  cityKey,
  DDD_REGIONS,
  NO_BRAND,
  NO_OWNER,
  salesRanges,
  salesTrendOf,
  saoPauloDayStart,
  saoPauloToday,
  type LeadPipeline,
  type LeadSource,
  type SalesCampaignRow,
  type SalesDashboard,
  type SalesDashboardQuery,
  type SalesFunnelStep,
  type SalesRange,
  type SalesResults,
  type SalesSellerRow,
} from '@wings/shared';
import { sql, type SQL } from 'drizzle-orm';
import { crmConfig, listStages, type Executor } from './crm.js';

/**
 * Dashboard › Vendas v1: the executive row, the diagnosis and the actions,
 * all aggregates of the CRM's own tables (`leads`, `lead_stage_history`,
 * `lead_activities`, `lead_tasks`) plus the platforms' daily spend
 * (`ad_metrics_daily`) for CPL, CAC and ROAS. Nothing leaves this module but
 * counts, sums and staff names; region is derived from the phone's DDD here
 * and never written back to the lead.
 */

export interface SalesDashboardInput extends Omit<SalesDashboardQuery, 'from' | 'to'> {
  from?: string;
  to?: string;
  /** Set for a seller: only their own deals, and none of the team's views. */
  ownerEmployeeId?: string;
  /** `ads.read`: may see ad spend. */
  spendVisible: boolean;
  now?: Date;
}

/** [start, end) instants of a range of São Paulo days. */
const bounds = (range: SalesRange) => {
  const start = saoPauloDayStart(range.from);
  const end = new Date(saoPauloDayStart(range.to).getTime() + 86_400_000);
  return { start, end };
};

/** A lead whose Instagram check decided (or a person corrected): the ones the counts can speak of. */
const igChecked = sql`(l.instagram_check_status in ('confere', 'nao_encontrado', 'nao_bate') or l.instagram_manual is not null)`;
const campaignKey = sql`coalesce(nullif(trim(l.campaign_name), ''), nullif(trim(l.utm_campaign), ''))`;
const num = (value: unknown) => Number(value ?? 0);
const numOrNull = (value: unknown) =>
  value === null || value === undefined ? null : Number(value);
const ratio = (part: number, whole: number) => (whole > 0 ? part / whole : null);

function filterSql(input: SalesDashboardInput): SQL {
  const parts: SQL[] = [
    input.pipeline === ALL_PIPELINES
      ? sql`l.pipeline is not null`
      : sql`l.pipeline = ${input.pipeline}`,
  ];
  if (input.ownerEmployeeId) parts.push(sql`l.owner_employee_id = ${input.ownerEmployeeId}`);
  if (input.owner === NO_OWNER) parts.push(sql`l.owner_employee_id is null`);
  else if (input.owner) parts.push(sql`l.owner_employee_id = ${input.owner}`);
  if (input.brand === NO_BRAND) parts.push(sql`l.brand is null`);
  else if (input.brand) parts.push(sql`l.brand = ${input.brand}`);
  if (input.source) parts.push(sql`l.source = ${input.source}`);
  if (input.campaign) {
    // The same match as the CRM's list, so a click from here opens the same deals.
    const needle = `%${input.campaign.toLowerCase()}%`;
    parts.push(
      sql`(lower(coalesce(l.campaign_name, '')) like ${needle} or coalesce(l.campaign_id, '') = ${input.campaign} or lower(coalesce(l.utm_campaign, '')) like ${needle})`,
    );
  }
  return sql.join(parts, sql` and `);
}

async function rows<T extends Record<string, unknown>>(db: Executor, query: SQL) {
  return (await db.execute<T>(query)).rows;
}

/** Won cents per São Paulo day (UTC−3) of a range, for the trend. */
async function wonByDayOf(db: Executor, where: SQL, range: SalesRange) {
  const { start, end } = bounds(range);
  const found = await rows<{ day: string; cents: string }>(
    db,
    sql`select to_char(l.closed_at at time zone 'UTC' - interval '3 hours', 'YYYY-MM-DD') as day,
               coalesce(sum(l.value_cents), 0)::bigint as cents
          from leads l
         where ${where} and l.won and l.closed_at >= ${start} and l.closed_at < ${end}
         group by 1`,
  );
  return new Map(found.map((row) => [row.day, num(row.cents)]));
}

async function resultsOf(db: Executor, where: SQL, range: SalesRange): Promise<SalesResults> {
  const { start, end } = bounds(range);
  const [row] = await rows<{ won: number; won_cents: string; unvalued: number; lost: number }>(
    db,
    sql`select (count(*) filter (where l.won))::int as won,
               coalesce(sum(l.value_cents) filter (where l.won), 0)::bigint as won_cents,
               (count(*) filter (where l.won and l.value_cents is null))::int as unvalued,
               (count(*) filter (where not l.won))::int as lost
          from leads l
         where ${where} and l.won is not null and l.closed_at >= ${start} and l.closed_at < ${end}`,
  );
  const won = row?.won ?? 0;
  const lost = row?.lost ?? 0;
  const wonCents = num(row?.won_cents);
  const valued = won - (row?.unvalued ?? 0);
  return {
    wonCents,
    won,
    wonWithoutValue: row?.unvalued ?? 0,
    ticketCents: valued > 0 ? Math.round(wonCents / valued) : null,
    lost,
    conversionRate: ratio(won, won + lost),
  };
}

/** Phone → its DDD, `abroad` for a number from outside Brazil, null otherwise. */
const phoneClass = sql`case
  when l.phone ~ '^55[0-9]{10,11}$' then substr(l.phone, 3, 2)
  when l.phone ~ '^[0-9]{8,15}$' then 'abroad'
  else null end`;

/** Joins spellings that differ only in case, accents and spaces, keeping the most common one. */
function foldText(items: { text: string | null; total: number; won?: number }[]) {
  const groups = new Map<
    string,
    { text: string | null; total: number; won: number; best: number }
  >();
  for (const item of items) {
    const key = item.text === null ? '' : cityKey(item.text);
    const found = groups.get(key);
    if (!found)
      groups.set(key, {
        text: key ? item.text : null,
        total: item.total,
        won: item.won ?? 0,
        best: item.total,
      });
    else {
      found.total += item.total;
      found.won += item.won ?? 0;
      if (item.total > found.best) Object.assign(found, { text: item.text, best: item.total });
    }
  }
  return [...groups.values()]
    .map(({ text, total, won }) => ({ text, total, won }))
    .sort(
      (a, b) =>
        Number(a.text === null) - Number(b.text === null) ||
        b.total - a.total ||
        (a.text ?? '').localeCompare(b.text ?? '', 'pt-BR'),
    );
}

export async function salesDashboardOf(
  db: Executor,
  input: SalesDashboardInput,
): Promise<SalesDashboard> {
  const now = input.now ?? new Date();
  const ranges = salesRanges(input.period, now, { from: input.from, to: input.to });
  const where = filterSql(input);
  const { start, end } = bounds(ranges.current);
  const team = input.ownerEmployeeId === undefined;
  const pipeline: LeadPipeline | null = input.pipeline === ALL_PIPELINES ? null : input.pipeline;
  const wonIn = sql`(l.won and l.closed_at >= ${start} and l.closed_at < ${end})`;
  // Spend is per platform campaign: it cannot be split by seller.
  const spendVisible = input.spendVisible && team && !input.owner;

  const today = saoPauloToday(now);
  const [current, previous, previousYear, openRows, closeTime, lostRows, overdue, noOwner, dates] =
    await Promise.all([
      resultsOf(db, where, ranges.current),
      resultsOf(db, where, ranges.previous),
      resultsOf(db, where, ranges.previousYear),
      rows<{
        stage_id: string | null;
        total: number;
        value: string;
        weighted: number;
        unvalued: number;
      }>(
        db,
        sql`select l.stage_id, count(*)::int as total,
                   coalesce(sum(l.value_cents), 0)::bigint as value,
                   coalesce(sum(l.value_cents * coalesce(s.probability, 0) / 100.0), 0)::float8 as weighted,
                   (count(*) filter (where l.value_cents is null))::int as unvalued
              from leads l left join crm_stages s on s.id = l.stage_id
             where ${where} and l.won is null
             group by l.stage_id`,
      ),
      rows<{ count: number; avg_days: number | null }>(
        db,
        sql`select count(*)::int as count,
                   avg(greatest(extract(epoch from l.closed_at - l.created_at), 0)) / 86400 as avg_days
              from leads l where ${where} and ${wonIn}`,
      ),
      rows<{ reason: string | null; total: number }>(
        db,
        sql`select nullif(trim(l.lost_reason), '') as reason, count(*)::int as total
              from leads l
             where ${where} and l.won = false and l.closed_at >= ${start} and l.closed_at < ${end}
             group by 1`,
      ),
      rows<{ total: number }>(
        db,
        sql`select count(distinct l.id)::int as total
              from leads l join lead_tasks t on t.lead_id = l.id
             where ${where} and l.won is null and t.kind = 'first_contact'
               and (l.entered_at >= ${crmConfig().trackingStart} or t.created_at >= ${crmConfig().trackingStart})
               and t.done_at is null and t.due_at < ${now}`,
      ),
      rows<{ total: number }>(
        db,
        sql`select count(*)::int as total from leads l
             where ${where} and l.won is null and l.owner_employee_id is null`,
      ),
      // Expected close dates of the open deals: the period's forecast and the next 15 days.
      rows<{
        dated: number;
        deals: number;
        open_cents: string;
        weighted: number;
        unvalued: number;
        soon: number;
        soon_cents: string;
        overdue: number;
      }>(
        db,
        sql`with d as (
              select l.expected_close_at as day, l.value_cents as value,
                     coalesce(s.probability, 0) as probability,
                     l.expected_close_at between ${today}::date and ${ranges.current.to}::date as in_period,
                     l.expected_close_at between ${today}::date and ${today}::date + 14 as soon
                from leads l left join crm_stages s on s.id = l.stage_id
               where ${where} and l.won is null and l.expected_close_at is not null)
            select count(*)::int as dated,
                   (count(*) filter (where in_period))::int as deals,
                   coalesce(sum(value) filter (where in_period), 0)::bigint as open_cents,
                   coalesce(sum(value * probability / 100.0) filter (where in_period), 0)::float8 as weighted,
                   (count(*) filter (where in_period and value is null))::int as unvalued,
                   (count(*) filter (where soon))::int as soon,
                   coalesce(sum(value) filter (where soon), 0)::bigint as soon_cents,
                   (count(*) filter (where day < ${today}::date))::int as overdue
              from d`,
      ),
    ]);
  const dated = dates[0];

  const open = openRows.reduce(
    (sum, row) => ({
      total: sum.total + row.total,
      valueCents: sum.valueCents + num(row.value),
      weightedCents: sum.weightedCents + row.weighted,
      withoutValue: sum.withoutValue + row.unvalued,
    }),
    { total: 0, valueCents: 0, weightedCents: 0, withoutValue: 0 },
  );
  open.weightedCents = Math.round(open.weightedCents);

  const [funnel, views, wonCurrent, wonPrevious, wonPreviousYear] = await Promise.all([
    pipeline ? funnelOf(db, { where, pipeline, start, end, openRows }) : null,
    team
      ? teamViewsOf(db, { where, start, end, wonIn, range: ranges.current, spendVisible, pipeline })
      : null,
    wonByDayOf(db, where, ranges.current),
    wonByDayOf(db, where, ranges.previous),
    wonByDayOf(db, where, ranges.previousYear),
  ]);

  return {
    pipeline,
    scope: team ? 'all' : 'own',
    ranges,
    results: { current, previous, previousYear },
    goalCents: null,
    trend: salesTrendOf(ranges, today, {
      current: wonCurrent,
      previous: wonPrevious,
      previousYear: wonPreviousYear,
    }),
    open,
    forecast: {
      wonCents: current.wonCents,
      openCents: num(dated?.open_cents),
      weightedCents: Math.round(dated?.weighted ?? 0),
      deals: dated?.deals ?? 0,
      withoutValue: dated?.unvalued ?? 0,
      dated: dated?.dated ?? 0,
      ended: ranges.current.to < today,
    },
    funnel,
    timeToClose: {
      avgDays: numOrNull(closeTime[0]?.avg_days),
      count: closeTime[0]?.count ?? 0,
    },
    sellers: views?.sellers ?? [],
    brands: views?.brands ?? [],
    services: views?.services ?? [],
    sources: views?.sources ?? [],
    campaigns: views?.campaigns ?? [],
    pages: views?.pages ?? [],
    spendVisible,
    regions: views?.regions ?? [],
    cities: views?.cities ?? [],
    lostReasons: foldText(lostRows.map((row) => ({ text: row.reason, total: row.total }))).map(
      (row) => ({ reason: row.text, total: row.total }),
    ),
    actions: {
      closingSoon: dated?.soon ?? 0,
      closingSoonCents: num(dated?.soon_cents),
      forecastOverdue: dated?.overdue ?? 0,
      stalled: null,
      firstContactOverdue: overdue[0]?.total ?? 0,
      goalsAtRisk: null,
      noOwner: noOwner[0]?.total ?? 0,
    },
    campaignOptions: views?.campaignOptions ?? [],
  };
}

async function funnelOf(
  db: Executor,
  args: {
    where: SQL;
    pipeline: LeadPipeline;
    start: Date;
    end: Date;
    openRows: { stage_id: string | null; total: number; value: string; weighted: number }[];
  },
): Promise<SalesFunnelStep[]> {
  const { where, start, end } = args;
  const stages = await listStages(db, { pipeline: args.pipeline });
  const [reachedRows, stayRows] = await Promise.all([
    // Deals created in the period, by the furthest stage they reached (a win reaches them all).
    rows<{ top: number; total: number }>(
      db,
      sql`select case when l.won then 2147483647 else greatest(
                   coalesce((select s.position from crm_stages s where s.id = l.stage_id), 0),
                   coalesce((select max(s.position) from lead_stage_history h
                               join crm_stages s on s.id = h.to_stage_id where h.lead_id = l.id), 0)
                 ) end as top,
                 count(*)::int as total
            from leads l where ${where} and l.created_at >= ${start} and l.created_at < ${end}
           group by 1`,
    ),
    // Time in a stage, for every exit from it in the period: since the entry before, or the deal's creation.
    rows<{ stage_id: string; exits: number; avg_days: number | null }>(
      db,
      sql`with moves as (
            select h.from_stage_id, h.at, l.created_at,
                   lag(h.at) over (partition by h.lead_id order by h.at) as prev_at
              from lead_stage_history h join leads l on l.id = h.lead_id
             where ${where})
          select from_stage_id as stage_id, count(*)::int as exits,
                 avg(greatest(extract(epoch from at - coalesce(prev_at, created_at)), 0)) / 86400 as avg_days
            from moves
           where from_stage_id is not null and at >= ${start} and at < ${end}
           group by 1`,
    ),
  ]);
  const openOf = new Map(args.openRows.map((row) => [row.stage_id, row]));
  const stayOf = new Map(stayRows.map((row) => [row.stage_id, row]));
  const reachedAt = (position: number) =>
    reachedRows.reduce((sum, row) => sum + (row.top >= position ? row.total : 0), 0);
  const steps: SalesFunnelStep[] = stages
    .filter((stage) => stage.active || openOf.has(stage.id))
    .map((stage) => {
      const row = openOf.get(stage.id);
      const stay = stayOf.get(stage.id);
      return {
        stage: { id: stage.id, name: stage.name, probability: stage.probability },
        open: {
          total: row?.total ?? 0,
          valueCents: num(row?.value),
          weightedCents: Math.round(row?.weighted ?? 0),
        },
        reached: reachedAt(stage.position),
        toNext: null,
        avgDays: numOrNull(stay?.avg_days),
        exits: stay?.exits ?? 0,
      };
    });
  steps.forEach((step, i) => {
    const next = steps[i + 1];
    if (next) step.toNext = ratio(next.reached, step.reached);
  });
  const stageless = openOf.get(null);
  if (stageless)
    steps.unshift({
      stage: null,
      open: { total: stageless.total, valueCents: num(stageless.value), weightedCents: 0 },
      reached: 0,
      toNext: null,
      avgDays: null,
      exits: 0,
    });
  return steps;
}

type Slice = { open: number; open_cents: string; won: number; won_cents: string };

async function teamViewsOf(
  db: Executor,
  args: {
    where: SQL;
    start: Date;
    end: Date;
    wonIn: SQL;
    range: SalesRange;
    spendVisible: boolean;
    pipeline: LeadPipeline | null;
  },
) {
  const { where, start, end, wonIn } = args;
  const createdIn = sql`(l.created_at >= ${start} and l.created_at < ${end})`;
  const inPeriod = sql`(${createdIn} or ${wonIn})`;
  const slice = sql`(count(*) filter (where l.won is null))::int as open,
                   coalesce(sum(l.value_cents) filter (where l.won is null), 0)::bigint as open_cents,
                   (count(*) filter (where ${wonIn}))::int as won,
                   coalesce(sum(l.value_cents) filter (where ${wonIn}), 0)::bigint as won_cents`;
  const openOrWon = sql`(l.won is null or ${wonIn})`;
  const [
    owners,
    activities,
    firstContact,
    brands,
    services,
    sources,
    campaigns,
    regions,
    cities,
    pages,
  ] = await Promise.all([
    rows<Slice & { owner: string | null; name: string | null }>(
      db,
      sql`select l.owner_employee_id as owner, e.full_name as name, ${slice}
              from leads l left join employees e on e.id = l.owner_employee_id
             where ${where} and ${openOrWon}
             group by 1, 2`,
    ),
    rows<{ actor: string; name: string | null; total: number }>(
      db,
      sql`select a.actor_employee_id as actor, e.full_name as name, count(*)::int as total
              from lead_activities a join leads l on l.id = a.lead_id
              join employees e on e.id = a.actor_employee_id
             where ${where} and a.at >= ${start} and a.at < ${end}
             group by 1, 2`,
    ),
    rows<{ owner: string; count: number; avg_hours: number | null }>(
      db,
      sql`select owner, count(*)::int as count,
                   avg(extract(epoch from first_at - created_at)) / 3600 as avg_hours
              from (select l.owner_employee_id as owner, l.created_at,
                           least(l.first_contact_at,
                                 (select min(a.at) from lead_activities a where a.lead_id = l.id)) as first_at
                      from leads l
                     where ${where} and ${createdIn} and l.owner_employee_id is not null) d
             where first_at is not null and first_at >= created_at
             group by 1`,
    ),
    rows<Slice & { brand: string | null }>(
      db,
      sql`select l.brand, ${slice} from leads l where ${where} and ${openOrWon} group by 1`,
    ),
    args.pipeline
      ? []
      : rows<Slice & { pipeline: LeadPipeline }>(
          db,
          sql`select l.pipeline, ${slice} from leads l where ${where} and ${openOrWon} group by 1`,
        ),
    rows<{ source: LeadSource; leads: number; won: number; won_cents: string }>(
      db,
      sql`select l.source, (count(*) filter (where ${createdIn}))::int as leads,
                   (count(*) filter (where ${wonIn}))::int as won,
                   coalesce(sum(l.value_cents) filter (where ${wonIn}), 0)::bigint as won_cents
              from leads l where ${where} and ${inPeriod}
             group by 1`,
    ),
    // Every campaign in scope, so its platform ids are known even when the period brought no deal.
    rows<{
      campaign: string | null;
      leads: number;
      won: number;
      won_cents: string;
      ids: string[] | null;
      all_leads: number;
      ig_checked: number;
      ig_suspect: number;
      ig_fake: number;
    }>(
      db,
      sql`select ${campaignKey} as campaign,
                   (count(*) filter (where ${createdIn}))::int as leads,
                   (count(*) filter (where ${wonIn}))::int as won,
                   coalesce(sum(l.value_cents) filter (where ${wonIn}), 0)::bigint as won_cents,
                   array_agg(distinct l.ad_campaign_external_id)
                     filter (where l.ad_campaign_external_id is not null) as ids,
                   count(*)::int as all_leads,
                   (count(*) filter (where ${createdIn} and ${igChecked}))::int as ig_checked,
                   (count(*) filter (where ${createdIn} and l.instagram_verdict_effective = 'suspeito'))::int as ig_suspect,
                   (count(*) filter (where ${createdIn} and l.instagram_verdict_effective = 'falso'))::int as ig_fake
              from leads l where ${where}
             group by 1`,
    ),
    rows<{ class: string | null; leads: number; won: number }>(
      db,
      sql`select ${phoneClass} as class, (count(*) filter (where ${createdIn}))::int as leads,
                   (count(*) filter (where ${wonIn}))::int as won
              from leads l where ${where} and ${inPeriod}
             group by 1`,
    ),
    rows<{ city: string | null; leads: number; won: number }>(
      db,
      sql`select nullif(trim(l.city), '') as city, (count(*) filter (where ${createdIn}))::int as leads,
                   (count(*) filter (where ${wonIn}))::int as won
              from leads l where ${where} and ${inPeriod}
             group by 1`,
    ),
    // Per landing page (its slug, no query string): only pages whose leads have a decided check.
    rows<{ page: string; leads: number; ig_checked: number; ig_suspect: number; ig_fake: number }>(
      db,
      sql`select regexp_replace(l.landing_page, '[?#].*$', '') as page,
                   count(*)::int as leads,
                   (count(*) filter (where ${igChecked}))::int as ig_checked,
                   (count(*) filter (where l.instagram_verdict_effective = 'suspeito'))::int as ig_suspect,
                   (count(*) filter (where l.instagram_verdict_effective = 'falso'))::int as ig_fake
              from leads l where ${where} and ${createdIn} and l.landing_page is not null
             group by 1
            having count(*) filter (where ${igChecked}) > 0
             order by 5 desc, 4 desc, 2 desc
             limit 30`,
    ),
  ]);

  // --- sellers
  const sellers = new Map<string | null, SalesSellerRow>();
  const seller = (id: string | null, name: string | null) => {
    let found = sellers.get(id);
    if (!found) {
      found = {
        ownerEmployeeId: id,
        ownerName: name,
        won: 0,
        wonCents: 0,
        open: 0,
        openCents: 0,
        activities: 0,
        firstContactHours: null,
        firstContactCount: 0,
        goalCents: null,
      };
      sellers.set(id, found);
    }
    return found;
  };
  for (const row of owners)
    Object.assign(seller(row.owner, row.name), {
      open: row.open,
      openCents: num(row.open_cents),
      won: row.won,
      wonCents: num(row.won_cents),
    });
  for (const row of activities) seller(row.actor, row.name).activities = row.total;
  for (const row of firstContact) {
    const found = sellers.get(row.owner);
    if (found)
      Object.assign(found, {
        firstContactHours: numOrNull(row.avg_hours),
        firstContactCount: row.count,
      });
  }

  // --- campaigns and spend: a platform id counts under one name only (the one with most deals)
  const keyOfId = new Map<string, { key: string | null; weight: number }>();
  for (const row of campaigns)
    for (const id of row.ids ?? []) {
      const seen = keyOfId.get(id);
      if (!seen || row.all_leads > seen.weight)
        keyOfId.set(id, { key: row.campaign, weight: row.all_leads });
    }
  const spendOf = new Map<string | null, number>();
  const linked = new Set<string | null>();
  if (args.spendVisible && keyOfId.size > 0) {
    const ids = [...keyOfId.keys()];
    const spend = await rows<{ id: string; cents: string }>(
      db,
      sql`select entity_external_id as id, coalesce(sum(spend_cents), 0)::bigint as cents
            from ad_metrics_daily
           where level = 'campaign' and day >= ${args.range.from} and day <= ${args.range.to}
             and entity_external_id in (${sql.join(
               ids.map((id) => sql`${id}`),
               sql`, `,
             )})
           group by 1`,
    );
    for (const { key } of keyOfId.values()) linked.add(key);
    for (const row of spend) {
      const key = keyOfId.get(row.id)?.key ?? null;
      spendOf.set(key, (spendOf.get(key) ?? 0) + num(row.cents));
    }
  }
  const campaignRows: SalesCampaignRow[] = campaigns
    .map((row) => {
      const wonCents = num(row.won_cents);
      const spendCents = linked.has(row.campaign) ? (spendOf.get(row.campaign) ?? 0) : null;
      const paid = spendCents !== null && spendCents > 0 ? spendCents : null;
      return {
        campaign: row.campaign,
        leads: row.leads,
        won: row.won,
        wonCents,
        spendCents,
        cplCents: paid !== null && row.leads > 0 ? Math.round(paid / row.leads) : null,
        cacCents: paid !== null && row.won > 0 ? Math.round(paid / row.won) : null,
        roas: paid !== null ? wonCents / paid : null,
        instagram: { checked: row.ig_checked, suspect: row.ig_suspect, fake: row.ig_fake },
      };
    })
    .filter((row) => row.leads > 0 || row.won > 0 || (row.spendCents ?? 0) > 0)
    .sort(
      (a, b) =>
        Number(a.campaign === null) - Number(b.campaign === null) ||
        b.wonCents - a.wonCents ||
        b.won - a.won ||
        b.leads - a.leads,
    );

  // --- region by the phone's DDD, computed here and never stored
  type Region = SalesDashboard['regions'][number];
  const byUf = new Map<string, Region>();
  for (const row of regions) {
    const uf = row.class && row.class !== 'abroad' ? (DDD_REGIONS[row.class]?.uf ?? null) : null;
    const kind: Region['kind'] = uf ? 'uf' : row.class === 'abroad' ? 'abroad' : 'none';
    const key = uf ?? kind;
    const found = byUf.get(key) ?? { kind, uf, leads: 0, won: 0 };
    found.leads += row.leads;
    found.won += row.won;
    byUf.set(key, found);
  }

  const slices = (row: Slice) => ({
    open: row.open,
    openCents: num(row.open_cents),
    won: row.won,
    wonCents: num(row.won_cents),
  });
  const byValue = (
    a: { wonCents: number; openCents: number; open: number },
    b: { wonCents: number; openCents: number; open: number },
  ) => b.wonCents - a.wonCents || b.openCents - a.openCents || b.open - a.open;

  return {
    sellers: [...sellers.values()].sort(
      (a, b) =>
        Number(a.ownerEmployeeId === null) - Number(b.ownerEmployeeId === null) ||
        b.wonCents - a.wonCents ||
        b.won - a.won ||
        b.openCents - a.openCents ||
        b.open - a.open,
    ),
    brands: brands.map((row) => ({ brand: row.brand, ...slices(row) })).sort(byValue),
    services: services.map((row) => ({ pipeline: row.pipeline, ...slices(row) })).sort(byValue),
    sources: sources
      .map((row) => ({
        source: row.source,
        leads: row.leads,
        won: row.won,
        wonCents: num(row.won_cents),
      }))
      .filter((row) => row.leads > 0 || row.won > 0)
      .sort((a, b) => b.leads - a.leads || b.won - a.won),
    campaigns: campaignRows,
    pages: pages.map((row) => ({
      page: row.page,
      leads: row.leads,
      instagram: { checked: row.ig_checked, suspect: row.ig_suspect, fake: row.ig_fake },
    })),
    regions: [...byUf.values()]
      .filter((row) => row.leads > 0 || row.won > 0)
      .sort(
        (a, b) =>
          Number(a.kind !== 'uf') - Number(b.kind !== 'uf') ||
          b.leads - a.leads ||
          (a.uf ?? a.kind).localeCompare(b.uf ?? b.kind),
      ),
    cities: foldText(cities.map((row) => ({ text: row.city, total: row.leads, won: row.won })))
      .map((row) => ({ city: row.text, leads: row.total, won: row.won }))
      .filter((row) => row.leads > 0 || row.won > 0),
    campaignOptions: campaigns
      .map((row) => row.campaign)
      .filter((name): name is string => name !== null)
      .sort((a, b) => a.localeCompare(b, 'pt-BR')),
  };
}
