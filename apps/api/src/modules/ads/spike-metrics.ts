import { existsSync, readFileSync } from 'node:fs';

/**
 * Stage 6.0 spike — read-only exploration of what this ad account actually
 * reports.
 *
 * The cockpit's numbers are only as honest as the fields underneath them, and
 * Meta's availability varies by account, objective and impression volume. This
 * script asks the real account rather than assuming the documentation applies.
 *
 * Read-only: every call is a GET. Nothing is created, changed or spent.
 */

function readEnvFile(path: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!existsSync(path)) return out;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[
      trimmed
        .slice(0, eq)
        .replace(/^export\s+/, '')
        .trim()
    ] = value;
  }
  return out;
}

const secrets = readEnvFile('/etc/wings-crm/meta.env');
const TOKEN = secrets.META_SYSTEM_USER_TOKEN ?? '';
const ACCOUNT = secrets.META_AD_ACCOUNT_ID ?? '';
const VERSION = 'v23.0';

if (!TOKEN || !ACCOUNT) throw new Error('read credentials missing');

interface GraphResult {
  body: Record<string, unknown>;
  usageHeader: string | null;
}

async function get(path: string, params: Record<string, string>): Promise<GraphResult> {
  const url = new URL(`https://graph.facebook.com/${VERSION}/${path}`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);

  const response = await fetch(url, { headers: { Authorization: `Bearer ${TOKEN}` } });
  const body = (await response.json()) as Record<string, unknown>;
  if (!response.ok) {
    const error = body.error as { code?: number; message?: string } | undefined;
    console.warn(`    ! error ${error?.code ?? response.status}: ${error?.message ?? 'unknown'}`);
  }
  return { body, usageHeader: response.headers.get('x-business-use-case-usage') };
}

const YEAR_RANGE = JSON.stringify({ since: '2026-01-01', until: '2026-09-17' });

async function main() {
  console.warn(`account: ${ACCOUNT}\n`);

  // --- 1. which insight fields come back at campaign level -----------------
  console.warn('[1] campaign insights, 2026-01-01 → today');
  const insights = await get(`${ACCOUNT}/insights`, {
    level: 'campaign',
    fields:
      'campaign_id,campaign_name,spend,impressions,clicks,ctr,cpc,cpm,frequency,reach,actions,cost_per_action_type,quality_ranking,engagement_rate_ranking,conversion_rate_ranking',
    time_range: YEAR_RANGE,
    limit: '50',
  });
  const rows = (insights.body.data ?? []) as Record<string, unknown>[];
  console.warn(`    rows: ${rows.length}`);
  const sample = rows[0];
  if (sample) {
    console.warn(`    fields present: ${Object.keys(sample).sort().join(', ')}`);
    console.warn(
      `    sample: spend=${String(sample.spend)} impressions=${String(sample.impressions)} clicks=${String(sample.clicks)} ctr=${String(sample.ctr)} frequency=${String(sample.frequency)}`,
    );
    console.warn(
      `    rankings: quality=${String(sample.quality_ranking ?? '(absent)')} engagement=${String(sample.engagement_rate_ranking ?? '(absent)')} conversion=${String(sample.conversion_rate_ranking ?? '(absent)')}`,
    );
  }

  // --- 2. which action types this account actually reports -----------------
  console.warn('\n[2] action types reported (these decide what "a lead" means)');
  const actionTypes = new Map<string, number>();
  for (const row of rows) {
    for (const action of (row.actions ?? []) as { action_type: string; value: string }[]) {
      actionTypes.set(
        action.action_type,
        (actionTypes.get(action.action_type) ?? 0) + Number(action.value),
      );
    }
  }
  if (actionTypes.size === 0) console.warn('    none reported in this window');
  for (const [type, total] of [...actionTypes].sort((a, b) => b[1] - a[1]).slice(0, 15)) {
    console.warn(`    ${type.padEnd(42)} ${total}`);
  }

  // --- 3. cost_per_action_type, for CPL/CPA ------------------------------
  console.warn('\n[3] cost per action (sample row)');
  const costs = (sample?.cost_per_action_type ?? []) as { action_type: string; value: string }[];
  if (costs.length === 0) console.warn('    absent in this window');
  for (const cost of costs.slice(0, 8)) {
    console.warn(`    ${cost.action_type.padEnd(42)} ${cost.value}`);
  }

  // --- 4. daily granularity ------------------------------------------------
  console.warn('\n[4] daily rows (time_increment=1)');
  const daily = await get(`${ACCOUNT}/insights`, {
    level: 'campaign',
    fields: 'campaign_id,spend,impressions,clicks,actions',
    time_range: YEAR_RANGE,
    time_increment: '1',
    limit: '5',
  });
  const dailyRows = (daily.body.data ?? []) as Record<string, unknown>[];
  console.warn(`    rows (first page): ${dailyRows.length}`);
  if (dailyRows[0]) {
    console.warn(
      `    first: ${String(dailyRows[0].date_start)} spend=${String(dailyRows[0].spend)} impressions=${String(dailyRows[0].impressions)}`,
    );
  }
  console.warn(`    paging present: ${Boolean((daily.body.paging as { next?: string })?.next)}`);

  // --- 5. attribution windows ---------------------------------------------
  console.warn('\n[5] attribution windows');
  const attributed = await get(`${ACCOUNT}/insights`, {
    level: 'campaign',
    fields: 'campaign_id,actions',
    time_range: YEAR_RANGE,
    action_attribution_windows: JSON.stringify(['1d_click', '7d_click', '1d_view']),
    limit: '3',
  });
  const attributedRow = ((attributed.body.data ?? []) as Record<string, unknown>[])[0];
  const attributedActions = (attributedRow?.actions ?? []) as Record<string, unknown>[];
  console.warn(
    `    per-window keys on an action: ${attributedActions[0] ? Object.keys(attributedActions[0]).join(', ') : '(no actions in window)'}`,
  );

  // --- 6. ad-level entities and review state ------------------------------
  console.warn('\n[6] ads, review state and creative fields');
  const ads = await get(`${ACCOUNT}/ads`, {
    fields:
      'id,name,status,effective_status,issues_info,adset_id,campaign_id,creative{id,name,thumbnail_url,title,body}',
    limit: '25',
  });
  const adRows = (ads.body.data ?? []) as Record<string, unknown>[];
  console.warn(`    ads: ${adRows.length}`);
  const statuses = new Map<string, number>();
  let withIssues = 0;
  let withThumb = 0;
  for (const ad of adRows) {
    const status = String(ad.effective_status ?? 'UNKNOWN');
    statuses.set(status, (statuses.get(status) ?? 0) + 1);
    if (ad.issues_info) withIssues += 1;
    if ((ad.creative as { thumbnail_url?: string } | undefined)?.thumbnail_url) withThumb += 1;
  }
  console.warn(`    effective_status: ${[...statuses].map(([s, n]) => `${s}=${n}`).join(' ')}`);
  console.warn(`    with issues_info: ${withIssues} | with creative thumbnail: ${withThumb}`);
  if (adRows[0]) {
    console.warn(`    ad fields returned: ${Object.keys(adRows[0]).sort().join(', ')}`);
  }

  // --- 7. budget_remaining -------------------------------------------------
  console.warn('\n[7] budget_remaining on campaigns and ad sets');
  const campaigns = await get(`${ACCOUNT}/campaigns`, {
    fields: 'id,name,daily_budget,budget_remaining,start_time,stop_time',
    limit: '10',
  });
  const campaignRows = (campaigns.body.data ?? []) as Record<string, unknown>[];
  console.warn(
    `    campaign fields: ${campaignRows[0] ? Object.keys(campaignRows[0]).sort().join(', ') : '(none)'}`,
  );
  const withSchedule = campaignRows.filter((c) => c.start_time ?? c.stop_time).length;
  console.warn(`    campaigns carrying start/stop times (calendar view): ${withSchedule}`);

  // --- 8. rate limit signal ------------------------------------------------
  console.warn('\n[8] rate limiting');
  console.warn(`    x-business-use-case-usage header present: ${Boolean(insights.usageHeader)}`);
  if (insights.usageHeader) {
    try {
      const usage = JSON.parse(insights.usageHeader) as Record<string, { call_count?: number }[]>;
      const first = Object.values(usage)[0]?.[0];
      console.warn(`    call_count so far: ${first?.call_count ?? 'n/a'}%`);
    } catch {
      console.warn('    (header present but unparsed)');
    }
  }

  console.warn('\nread-only: no object was created, changed or spent.');
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? `${error.name}: ${error.message}` : error);
  process.exit(1);
});
