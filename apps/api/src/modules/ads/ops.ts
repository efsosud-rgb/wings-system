import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import {
  adAccounts,
  adCampaignDrafts,
  adCampaigns,
  adChangeRequests,
  adGuardrailEvents,
} from '../../db/schema/index.js';
import { writeAudit } from '../../lib/audit.js';
import { gateChange, type ApprovalNotifier, type GateResult } from './approvals.js';
import { releaseKillSwitch, releaseReservation, reserveChange } from './budget-guard.js';
import type { AdsPlatformClient } from './platform/types.js';
import { reconciliationFreshness } from './reconcile.js';

/**
 * Operator actions for a supervised write session.
 *
 * Everything here is something a person does deliberately, by hand, with
 * someone watching: ask for a change, look at the state, clear an emergency.
 * None of it writes to an ad platform — asking for a change only puts it in
 * front of an approver, and the executor remains the single place a change
 * leaves the building.
 */

export type ChangeKind = 'set_daily_budget' | 'pause_campaign' | 'resume_campaign';

export type OpsRefusal =
  | 'account_not_found'
  | 'campaign_not_found'
  | 'reservation_refused'
  | 'kill_switch_not_engaged'
  | 'unresolved_execution'
  | 'change_not_unknown'
  | 'campaign_unreadable';

export type OpsResult<T> =
  { ok: true; value: T } | { ok: false; reason: OpsRefusal; message: string };

function refuse<T>(reason: OpsRefusal, message: string): OpsResult<T> {
  return { ok: false, reason, message };
}

async function activeAccountByExternalId(db: Database, externalId: string) {
  return db.query.adAccounts.findFirst({
    where: and(eq(adAccounts.externalId, externalId), isNull(adAccounts.archivedAt)),
  });
}

/**
 * Asks for a change to a campaign, exactly as any other requester would: the
 * budget guard reserves it, then the gate puts it in front of an approver.
 */
export async function requestCampaignChange(
  db: Database,
  input: {
    accountExternalId: string;
    campaignExternalId: string;
    kind: ChangeKind;
    toDailyBudgetCents?: number;
    reason: string;
    notifier?: ApprovalNotifier;
    now?: Date;
  },
): Promise<OpsResult<GateResult & { changeRequestId: string; exposureDeltaCents: number }>> {
  const account = await activeAccountByExternalId(db, input.accountExternalId);
  if (!account) return refuse('account_not_found', 'Conta não encontrada ou arquivada.');

  const campaign = await db.query.adCampaigns.findFirst({
    where: and(
      eq(adCampaigns.adAccountId, account.id),
      eq(adCampaigns.externalId, input.campaignExternalId),
    ),
  });
  if (!campaign) {
    return refuse('campaign_not_found', 'Campanha não encontrada nesta conta. Rode a ingestão?');
  }

  const reserved = await reserveChange(db, {
    adAccountId: account.id,
    campaignId: campaign.id,
    kind: input.kind,
    toDailyBudgetCents: input.toDailyBudgetCents,
    reason: input.reason,
    now: input.now,
  });
  if (!reserved.ok) {
    return refuse('reservation_refused', `${reserved.reason}: ${reserved.message}`);
  }

  const gate = await gateChange(db, {
    changeRequestId: reserved.value.changeRequestId,
    notifier: input.notifier,
    now: input.now,
  });

  return {
    ok: true,
    value: {
      ...gate,
      changeRequestId: reserved.value.changeRequestId,
      exposureDeltaCents: reserved.value.exposureDeltaCents,
    },
  };
}

/**
 * Releases the kill switch, on the record.
 *
 * Refused while any change on the account still has an unknown outcome: the
 * freeze exists precisely because nobody knows what the platform did, and
 * lifting it first would let a second change land on top of the mystery.
 */
export async function releaseKillSwitchOnRecord(
  db: Database,
  input: { accountExternalId: string; reason: string },
): Promise<OpsResult<{ previousReason: string | null }>> {
  const account = await activeAccountByExternalId(db, input.accountExternalId);
  if (!account) return refuse('account_not_found', 'Conta não encontrada ou arquivada.');
  if (!account.killSwitchEngaged) {
    return refuse('kill_switch_not_engaged', 'A trava não está acionada nesta conta.');
  }

  const unresolved = await db.query.adChangeRequests.findMany({
    where: and(
      eq(adChangeRequests.adAccountId, account.id),
      inArray(adChangeRequests.status, ['unknown', 'executing']),
    ),
  });
  if (unresolved.length > 0) {
    return refuse(
      'unresolved_execution',
      `Há ${unresolved.length} alteração(ões) com resultado desconhecido. ` +
        `Resolva com resolve-unknown antes de liberar: ${unresolved.map((c) => c.id).join(', ')}`,
    );
  }

  await releaseKillSwitch(db, account.id, input.reason);
  await writeAudit(db, {
    actorEmployeeId: null,
    action: 'ads.kill_switch_released',
    entity: 'ad_account',
    entityId: account.id,
    metadata: { via: 'ops-cli', reason: input.reason, previousReason: account.killSwitchReason },
  });
  return { ok: true, value: { previousReason: account.killSwitchReason } };
}

/** The platform id of the account a change belongs to, to build its client. */
export async function accountExternalIdOfChange(
  db: Database,
  changeRequestId: string,
): Promise<string | null> {
  const rows = await db
    .select({ externalId: adAccounts.externalId })
    .from(adChangeRequests)
    .innerJoin(adAccounts, eq(adAccounts.id, adChangeRequests.adAccountId))
    .where(eq(adChangeRequests.id, changeRequestId));
  return rows[0]?.externalId ?? null;
}

export type UnknownResolution = 'applied' | 'not_applied';

/**
 * Settles a change whose outcome the platform never confirmed, by reading what
 * the platform actually shows now. Read-only against the platform.
 *
 * The execution row keeps its `unknown` outcome — that is what happened at the
 * time. What gets settled is the change: either it is on the platform, and is
 * recorded as executed, or it is not, and its reservation is handed back. A
 * change that did not land is never retried; a new request must be made, with
 * a new approval.
 *
 * The kill switch is deliberately left on. Lifting it is a separate act.
 */
export async function resolveUnknownExecution(
  db: Database,
  client: AdsPlatformClient,
  changeRequestId: string,
  now = new Date(),
): Promise<OpsResult<{ resolution: UnknownResolution; observed: string }>> {
  const change = await db.query.adChangeRequests.findFirst({
    where: eq(adChangeRequests.id, changeRequestId),
  });
  if (!change || (change.status !== 'unknown' && change.status !== 'executing')) {
    return refuse('change_not_unknown', 'Esta alteração não está com resultado desconhecido.');
  }

  const account = await db.query.adAccounts.findFirst({
    where: eq(adAccounts.id, change.adAccountId),
  });
  if (!account) return refuse('campaign_not_found', 'Campanha não encontrada.');
  if (client.accountExternalId !== account.externalId) {
    return refuse('account_not_found', 'O cliente da plataforma não pertence a esta conta.');
  }
  if (change.kind === 'create_campaign') {
    return resolveUnknownCreation(db, client, { change, accountId: account.id, now });
  }

  const campaign = change.campaignId
    ? await db.query.adCampaigns.findFirst({ where: eq(adCampaigns.id, change.campaignId) })
    : undefined;
  if (!campaign) return refuse('campaign_not_found', 'Campanha não encontrada.');

  const live = await client.getCampaign(campaign.externalId);
  if (!live) {
    return refuse('campaign_unreadable', 'A plataforma não devolveu a campanha. Tente de novo.');
  }

  const landed =
    change.kind === 'pause_campaign'
      ? live.status === 'PAUSED'
      : change.kind === 'resume_campaign'
        ? live.status === 'ACTIVE'
        : (live.dailyBudgetCents ?? 0) === (change.toValueCents ?? 0);
  const resolution: UnknownResolution = landed ? 'applied' : 'not_applied';
  const observed = `status ${live.status}, orçamento diário ${live.dailyBudgetCents ?? 0}`;

  if (landed) {
    await db
      .update(adCampaigns)
      .set({
        status: live.status,
        dailyBudgetCents: live.dailyBudgetCents ?? 0,
        lastSyncedAt: now,
        updatedAt: now,
      })
      .where(eq(adCampaigns.id, campaign.id));
    await db
      .update(adChangeRequests)
      .set({ status: 'executed', executedAt: now })
      .where(eq(adChangeRequests.id, change.id));
  } else {
    await releaseReservation(db, change.id, 'failed');
    // releaseReservation is a no-op for a change holding no reservation; the
    // status must still leave `unknown`, or the account stays unreleasable.
    await db
      .update(adChangeRequests)
      .set({ status: 'failed' })
      .where(eq(adChangeRequests.id, change.id));
  }

  await db.insert(adGuardrailEvents).values({
    adAccountId: account.id,
    kind: 'unknown_execution_outcome',
    detail: {
      note: 'Resultado desconhecido resolvido pela leitura da plataforma',
      changeRequestId: change.id,
      resolution,
      observedStatus: live.status,
      observedDailyBudgetCents: live.dailyBudgetCents ?? 0,
    },
  });
  await writeAudit(db, {
    actorEmployeeId: null,
    action: 'ads.unknown_outcome_resolved',
    entity: 'ad_change_request',
    entityId: change.id,
    metadata: { via: 'ops-cli', resolution, observedStatus: live.status },
  });

  return { ok: true, value: { resolution, observed } };
}

/**
 * A create that timed out left no id behind, so the campaign is looked for by
 * name — which is why the guard refuses a name already in use on the account.
 */
async function resolveUnknownCreation(
  db: Database,
  client: AdsPlatformClient,
  input: { change: typeof adChangeRequests.$inferSelect; accountId: string; now: Date },
): Promise<OpsResult<{ resolution: UnknownResolution; observed: string }>> {
  const { change, accountId, now } = input;
  const draft = change.draftId
    ? await db.query.adCampaignDrafts.findFirst({ where: eq(adCampaignDrafts.id, change.draftId) })
    : undefined;
  if (!draft) return refuse('campaign_not_found', 'Rascunho da campanha não encontrado.');

  const live = (await client.listCampaigns()).find((item) => item.name === draft.name);
  const resolution: UnknownResolution = live ? 'applied' : 'not_applied';
  const observed = live
    ? `campanha ${live.id} existe, status ${live.status}`
    : 'nenhuma campanha com este nome na plataforma';

  if (live) {
    const [created] = await db
      .insert(adCampaigns)
      .values({
        adAccountId: accountId,
        externalId: live.id,
        name: live.name,
        status: live.status,
        dailyBudgetCents: live.dailyBudgetCents ?? 0,
        budgetLevel: 'campaign',
        lastSyncedAt: now,
      })
      .onConflictDoUpdate({
        target: [adCampaigns.adAccountId, adCampaigns.externalId],
        set: { status: live.status, lastSyncedAt: now, updatedAt: now },
      })
      .returning({ id: adCampaigns.id });
    if (!created) throw new Error('failed to mirror the created campaign');

    await db
      .update(adCampaignDrafts)
      .set({ campaignId: created.id })
      .where(eq(adCampaignDrafts.id, draft.id));
    await db
      .update(adChangeRequests)
      .set({ status: 'executed', executedAt: now, campaignId: created.id })
      .where(eq(adChangeRequests.id, change.id));
  } else {
    await releaseReservation(db, change.id, 'failed');
    await db
      .update(adChangeRequests)
      .set({ status: 'failed' })
      .where(eq(adChangeRequests.id, change.id));
  }

  await db.insert(adGuardrailEvents).values({
    adAccountId: accountId,
    kind: 'unknown_execution_outcome',
    detail: {
      note: 'Resultado desconhecido resolvido pela leitura da plataforma',
      changeRequestId: change.id,
      resolution,
      observedCampaignExternalId: live?.id ?? null,
      observedStatus: live?.status ?? null,
    },
  });
  await writeAudit(db, {
    actorEmployeeId: null,
    action: 'ads.unknown_outcome_resolved',
    entity: 'ad_change_request',
    entityId: change.id,
    metadata: { via: 'ops-cli', resolution, observedStatus: live?.status ?? null },
  });

  return { ok: true, value: { resolution, observed } };
}

export interface AccountStatus {
  externalId: string;
  name: string;
  killSwitchEngaged: boolean;
  killSwitchReason: string | null;
  /** Null when the account never reconciled this month. */
  reconciledMinutesAgo: number | null;
  reconciliationFresh: boolean;
  changes: { pendingApproval: number; approved: number; unknown: number };
}

/** What an operator should look at before, during and after a write session. */
export async function accountsStatus(db: Database, now = new Date()): Promise<AccountStatus[]> {
  const accounts = await db.query.adAccounts.findMany({ where: isNull(adAccounts.archivedAt) });
  const result: AccountStatus[] = [];

  for (const account of accounts) {
    const freshness = await reconciliationFreshness(db, account.id, { now });
    const changes = await db.query.adChangeRequests.findMany({
      where: and(
        eq(adChangeRequests.adAccountId, account.id),
        inArray(adChangeRequests.status, ['pending_approval', 'approved', 'unknown', 'executing']),
      ),
    });
    result.push({
      externalId: account.externalId,
      name: account.name,
      killSwitchEngaged: account.killSwitchEngaged,
      killSwitchReason: account.killSwitchReason,
      reconciledMinutesAgo: freshness.ageMinutes,
      reconciliationFresh: freshness.fresh,
      changes: {
        pendingApproval: changes.filter((c) => c.status === 'pending_approval').length,
        approved: changes.filter((c) => c.status === 'approved').length,
        unknown: changes.filter((c) => c.status === 'unknown' || c.status === 'executing').length,
      },
    });
  }
  return result;
}

export interface OpenAlertRow {
  accountName: string;
  kind: string;
  severity: string;
  title: string;
  entityLevel: string | null;
  entityExternalId: string | null;
  adName: string | null;
  adStatus: string | null;
  adSetName: string | null;
  campaignName: string | null;
  campaignExternalId: string | null;
  campaignStatus: string | null;
  campaignBudgetLevel: string | null;
  firstSeenAt: Date;
  lastSeenAt: Date;
  detail: Record<string, unknown>;
}

/** Every open alert, with the ad, ad set and campaign it points at. */
export async function openAlerts(db: Database): Promise<OpenAlertRow[]> {
  const rows = await db.execute<
    {
      account_name: string;
      kind: string;
      severity: string;
      title: string;
      entity_level: string | null;
      entity_external_id: string | null;
      ad_name: string | null;
      ad_status: string | null;
      ad_set_name: string | null;
      campaign_name: string | null;
      campaign_external_id: string | null;
      campaign_status: string | null;
      campaign_budget_level: string | null;
      first_seen_at: Date | string;
      last_seen_at: Date | string;
      detail: Record<string, unknown>;
    } & Record<string, unknown>
  >(sql`
    select acc.name as account_name, al.kind, al.severity, al.title,
           al.entity_level, al.entity_external_id,
           ad.name as ad_name, coalesce(ad.effective_status, ad.status::text) as ad_status,
           s.name as ad_set_name,
           coalesce(c_ad.name, c_direct.name) as campaign_name,
           coalesce(c_ad.external_id, c_direct.external_id) as campaign_external_id,
           coalesce(c_ad.status, c_direct.status)::text as campaign_status,
           coalesce(c_ad.budget_level, c_direct.budget_level)::text as campaign_budget_level,
           al.first_seen_at, al.last_seen_at, al.detail
      from ad_alerts al
      join ad_accounts acc on acc.id = al.ad_account_id and acc.archived_at is null
      left join ad_ads ad
        on al.entity_level = 'ad'
       and ad.ad_account_id = al.ad_account_id and ad.external_id = al.entity_external_id
      left join ad_sets s on s.id = ad.ad_set_id
      left join ad_campaigns c_ad on c_ad.id = ad.campaign_id
      left join ad_campaigns c_direct
        on al.entity_level = 'campaign'
       and c_direct.ad_account_id = al.ad_account_id
       and c_direct.external_id = al.entity_external_id
     where al.resolved_at is null
     order by case al.severity when 'critical' then 0 when 'warning' then 1 else 2 end,
              (al.detail->>'frequencyMilli')::numeric desc nulls last,
              al.first_seen_at
  `);

  return rows.rows.map((row) => ({
    accountName: row.account_name,
    kind: row.kind,
    severity: row.severity,
    title: row.title,
    entityLevel: row.entity_level,
    entityExternalId: row.entity_external_id,
    adName: row.ad_name,
    adStatus: row.ad_status,
    adSetName: row.ad_set_name,
    campaignName: row.campaign_name,
    campaignExternalId: row.campaign_external_id,
    campaignStatus: row.campaign_status,
    campaignBudgetLevel: row.campaign_budget_level,
    firstSeenAt: new Date(row.first_seen_at),
    lastSeenAt: new Date(row.last_seen_at),
    detail: row.detail ?? {},
  }));
}

const KIND_LABEL: Record<string, string> = {
  ad_rejected: 'Anúncio reprovado',
  budget_pacing: 'Ritmo de gasto',
  creative_fatigue: 'Desgaste de criativo',
  quality_below_average: 'Qualidade abaixo da média',
  conversion_silence: 'Silêncio de conversão',
};

function brl(cents: unknown): string {
  const value = Number(cents);
  if (!Number.isFinite(value)) return '—';
  return `R$ ${(value / 100).toFixed(2).replace('.', ',')}`;
}

function day(date: Date): string {
  return new Intl.DateTimeFormat('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

/**
 * The open alerts as a sheet to take into a conversation: one block per alert,
 * with room for the verdict of someone who knows the account.
 */
export function renderAlertsSheet(alerts: OpenAlertRow[], now = new Date()): string {
  const lines: string[] = [
    `# Alertas abertos — ${day(now)}`,
    '',
    `${alerts.length} alerta(s). Para cada um: **verdadeiro**, **falso** ou **depende** — e por quê.`,
    '',
  ];

  alerts.forEach((alert, index) => {
    const detail = alert.detail;
    lines.push(`## ${index + 1}. ${KIND_LABEL[alert.kind] ?? alert.kind} — ${alert.severity}`);
    lines.push('');
    lines.push(`- **Alerta:** ${alert.title}`);
    lines.push(`- **Conta:** ${alert.accountName}`);
    if (alert.campaignName) {
      lines.push(
        `- **Campanha:** ${alert.campaignName} (\`${alert.campaignExternalId}\`, ` +
          `${alert.campaignStatus}, orçamento em ${alert.campaignBudgetLevel})`,
      );
    }
    if (alert.adSetName) lines.push(`- **Conjunto:** ${alert.adSetName}`);
    if (alert.entityLevel === 'ad') {
      lines.push(
        `- **Anúncio:** ${alert.adName ?? '(sem nome)'} (\`${alert.entityExternalId}\`, ${alert.adStatus ?? '—'})`,
      );
    }
    if (alert.kind === 'creative_fatigue') {
      lines.push(
        `- **Frequência (${String(detail.lookbackDays)} dias):** ` +
          `${(Number(detail.frequencyMilli) / 1000).toFixed(1)} ` +
          `— limiar ${(Number(detail.thresholdMilli) / 1000).toFixed(1)}, ` +
          `pico diário ${(Number(detail.maxDailyFrequencyMilli) / 1000).toFixed(1)}`,
      );
      lines.push(
        `- **Volume:** ${String(detail.impressions)} impressões, maior alcance diário ` +
          `${String(detail.maxDailyReach)}, gasto ${brl(detail.spendCents)}`,
      );
      lines.push(`- **Como é estimada:** ${String(detail.estimate)}`);
      // The stored figure is an upper bound; only the platform knows the real one.
      lines.push('- **Frequência de 7 dias no Gerenciador (preencher):** ______');
    } else {
      lines.push(`- **Detalhe:** \`${JSON.stringify(detail)}\``);
    }
    lines.push(
      `- **Aberto desde:** ${day(alert.firstSeenAt)} · visto por último ${day(alert.lastSeenAt)}`,
    );
    lines.push('');
    lines.push('Veredito: ☐ verdadeiro ☐ falso ☐ depende');
    lines.push('');
    lines.push('Por quê / o que ele faria: ____________________________________________');
    lines.push('');
  });

  return lines.join('\n');
}
