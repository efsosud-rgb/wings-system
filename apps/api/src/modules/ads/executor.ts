import { createHash, randomUUID } from 'node:crypto';
import {
  AD_ACCOUNT_PLATFORM,
  GOOGLE_CHANNEL_TYPE,
  META_OBJECTIVE,
  isGooglePlatform,
  type CampaignDraft,
} from '@wings/shared';
import { and, eq, inArray } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import {
  adAccounts,
  adApprovalRequests,
  adCampaignDrafts,
  adCampaigns,
  adChangeRequests,
  adExecutions,
  adGuardrailEvents,
  budgetPeriods,
} from '../../db/schema/index.js';
import { writeAudit } from '../../lib/audit.js';
import {
  buildAdTree,
  draftHasTree,
  prepareAdTree,
  recordStep,
  type PreparedTree,
  type TreeDraft,
} from './ad-tree.js';
import { draftPayloadHash, engageKillSwitch, releaseReservation } from './budget-guard.js';
import {
  isAdTreeWriter,
  type AdsPlatformClient,
  type AdTreeWriter,
  type MutationOutcome,
  type PlatformObjective,
} from './platform/types.js';
import { reconciliationFreshness } from './reconcile.js';

/**
 * Execution: the first and only place a change reaches a real ad platform.
 *
 * Everything before this stage decided *whether* something may happen. This
 * decides *that it happens*, and it refuses unless every earlier guarantee
 * still holds at this instant:
 *
 *   1. a person approved this exact change (payload hash matches);
 *   2. the kill switch is off;
 *   3. the budget period still has room for the reserved exposure;
 *   4. the platform still looks the way the approval assumed — or, for a
 *      campaign being created, the stored draft is still the one approved and
 *      no campaign of that name has appeared in the meantime;
 *   5. nothing has executed this change already;
 *   6. the client is bound to the account the change belongs to;
 *   7. the account reconciled recently, so the spend the cap was checked
 *      against is real rather than remembered.
 *
 * A timeout is treated as "maybe it happened", never as a failure to retry.
 */

export type ExecutionRefusal =
  | 'not_approved'
  | 'approval_missing'
  | 'payload_changed'
  | 'kill_switch_engaged'
  | 'cap_no_longer_allows'
  | 'platform_drift'
  | 'already_executed'
  | 'writes_disabled'
  | 'wrong_account'
  | 'reconciliation_stale'
  | 'campaign_missing'
  | 'draft_missing'
  | 'media_missing'
  | 'targeting_unresolved'
  | 'platform_unavailable';

export type ExecutionResult =
  | { ok: true; outcome: 'applied'; executionId: string }
  | { ok: false; outcome: 'rejected'; executionId: string; code: string; message: string }
  | { ok: false; outcome: 'unknown'; executionId: string; reason: string }
  | { ok: false; outcome: 'refused'; reason: ExecutionRefusal; message: string };

export interface ExecuteOptions {
  /** Writes are off unless the caller says otherwise, in writing. */
  allowWrites?: boolean;
  now?: Date;
  actorEmployeeId?: string | null;
  /** The pixel a leads ad set optimises for (`META_PIXEL_ID`). */
  metaPixelId?: string;
  /** Where uploaded ad videos live (`CREATIVE_VIDEO_DIR`). */
  videoDir?: string;
}

function requestHashOf(input: Record<string, unknown>): string {
  return createHash('sha256').update(JSON.stringify(input)).digest('hex');
}

export async function executeApprovedChange(
  db: Database,
  client: AdsPlatformClient,
  changeRequestId: string,
  options: ExecuteOptions = {},
): Promise<ExecutionResult> {
  const now = options.now ?? new Date();

  const refuse = (reason: ExecutionRefusal, message: string): ExecutionResult => ({
    ok: false,
    outcome: 'refused',
    reason,
    message,
  });

  const change = await db.query.adChangeRequests.findFirst({
    where: eq(adChangeRequests.id, changeRequestId),
  });
  if (!change) return refuse('not_approved', 'Alteração não encontrada.');

  const approval = await db.query.adApprovalRequests.findFirst({
    where: eq(adApprovalRequests.changeRequestId, change.id),
  });
  if (change.autoApproved === false) {
    if (!approval) return refuse('approval_missing', 'Não há aprovação registrada.');
    if (approval.status !== 'approved') {
      return refuse('not_approved', 'A aprovação não está concedida.');
    }
    // The approval is bound to the exact change it was granted for.
    if (approval.payloadHash !== change.payloadHash) {
      return refuse('payload_changed', 'A alteração mudou depois da aprovação.');
    }
  }

  // Checked first: a change that already ran must report that plainly, rather
  // than "not approved" simply because its status moved on.
  const previous = await db.query.adExecutions.findMany({
    where: eq(adExecutions.changeRequestId, change.id),
  });
  if (previous.some((execution) => execution.outcome === 'applied')) {
    return refuse('already_executed', 'Esta alteração já foi executada.');
  }
  if (previous.some((execution) => execution.outcome === 'unknown')) {
    // A previous attempt may have landed. Reconciliation must clarify first;
    // retrying blindly is how a budget gets set twice.
    return refuse(
      'already_executed',
      'Uma tentativa anterior ficou com resultado desconhecido. Reconcilie antes de tentar de novo.',
    );
  }

  // Only an approved change may execute.
  if (change.status !== 'approved') {
    return refuse('not_approved', 'Esta alteração não foi aprovada.');
  }

  const account = await db.query.adAccounts.findFirst({
    where: eq(adAccounts.id, change.adAccountId),
  });
  if (!account) return refuse('campaign_missing', 'Conta não encontrada.');

  // 2. The kill switch stops everything, regardless of approvals.
  if (account.killSwitchEngaged) {
    return refuse('kill_switch_engaged', 'Trava de emergência acionada.');
  }

  if (!options.allowWrites || !client.isLive) {
    return refuse(
      'writes_disabled',
      'Execução em contas reais está desabilitada nesta configuração.',
    );
  }

  // 6. A client writes to whichever account it was built for. The ingestion
  // loop once filed one account's data under another this way; here the same
  // mistake would move another account's money.
  if (client.accountExternalId !== account.externalId) {
    return refuse('wrong_account', 'O cliente da plataforma não pertence à conta desta alteração.');
  }

  // 7. Dead-man switch. Checked here, not only by the scheduled job, because
  // the job that would notice staleness may be the very thing that stopped.
  // A refusal changes nothing: run the ingestion, then try again.
  const freshness = await reconciliationFreshness(db, account.id, { now });
  if (!freshness.fresh) {
    await db.insert(adGuardrailEvents).values({
      adAccountId: account.id,
      kind: 'reconciliation_stale',
      detail: {
        note: 'Execução recusada: gasto real desconhecido',
        reason: freshness.reason,
        ageMinutes: freshness.ageMinutes,
        changeRequestId: change.id,
      },
    });
    return refuse(
      'reconciliation_stale',
      freshness.reason === 'never_reconciled'
        ? 'Esta conta ainda não foi reconciliada neste mês. Rode a ingestão antes de executar.'
        : `A última reconciliação tem ${freshness.ageMinutes} min. Rode a ingestão antes de executar.`,
    );
  }

  const period = await db.query.budgetPeriods.findFirst({
    where: eq(budgetPeriods.id, change.budgetPeriodId),
  });
  if (!period) return refuse('cap_no_longer_allows', 'Período de orçamento não encontrado.');

  // Spend may have grown since the reservation was taken. In practice the
  // database constraint plus applyReportedSpend keep this true already — this
  // is defence in depth for anything that wrote the period row another way.
  const allowed = Math.min(period.usableCents, Math.max(0, period.capCents - period.spentCents));
  if (period.committedCents > allowed) {
    await engageKillSwitch(db, account.id, 'Gasto reportado consumiu o espaço reservado');
    return refuse('cap_no_longer_allows', 'O orçamento do mês não comporta mais esta alteração.');
  }

  // What the write is aimed at: an existing campaign, or the draft of a new one.
  let campaign: typeof adCampaigns.$inferSelect | null = null;
  let draft: (typeof adCampaignDrafts.$inferSelect & { payload: CampaignDraft }) | null = null;
  let tree: { writer: AdTreeWriter; draft: TreeDraft; prepared: PreparedTree } | null = null;

  if (change.kind === 'create_campaign') {
    const stored = change.draftId
      ? await db.query.adCampaignDrafts.findFirst({
          where: eq(adCampaignDrafts.id, change.draftId),
        })
      : undefined;
    if (!stored) return refuse('draft_missing', 'O rascunho desta campanha não foi encontrado.');
    if (stored.campaignId) return refuse('already_executed', 'Esta campanha já foi criada.');

    // 4. The approval covers the whole draft. Drafts have no update path, so a
    // mismatch means something wrote the row another way — refuse, do not guess.
    const hash = draftPayloadHash({
      adAccountId: change.adAccountId,
      payload: stored.payload,
      exposureDeltaCents: change.exposureDeltaCents,
    });
    if (hash !== change.payloadHash) {
      return refuse('payload_changed', 'O rascunho mudou depois da aprovação.');
    }

    // A campaign of this name appearing since the request means somebody made
    // it by hand, or an earlier attempt landed after all. Creating a twin
    // would leave two campaigns nobody can tell apart.
    const existing = (await client.listCampaigns()).find((item) => item.name === stored.name);
    if (existing) {
      await releaseReservation(db, change.id, 'superseded');
      return refuse(
        'platform_drift',
        'Já existe na plataforma uma campanha com este nome. Solicite uma nova aprovação com outro nome.',
      );
    }
    draft = { ...stored, payload: stored.payload as CampaignDraft };

    // A draft is written for one platform. Drafts from before Google existed
    // carry `platform: 'meta'`, so they pass unchanged.
    if (AD_ACCOUNT_PLATFORM[draft.payload.platform] !== account.platform) {
      return refuse('wrong_account', 'O rascunho não pertence à plataforma desta conta.');
    }

    // A campaign with its ad set and ads is several writes. Everything that can
    // be checked by reading is checked now, before the first of them: the
    // files exist, and the platform can place every state and city.
    if (draftHasTree(draft.payload)) {
      if (!isAdTreeWriter(client)) {
        return refuse(
          'writes_disabled',
          'O cliente desta plataforma não cria conjuntos de anúncios nem anúncios.',
        );
      }
      const prepared = await prepareAdTree(db, client, draft.payload, {
        videoDir: options.videoDir,
      });
      if (!prepared.ok) return refuse(prepared.reason, prepared.message);
      tree = { writer: client, draft: draft.payload, prepared: prepared.value };
    }
  } else {
    const found = change.campaignId
      ? await db.query.adCampaigns.findFirst({ where: eq(adCampaigns.id, change.campaignId) })
      : undefined;
    if (!found) return refuse('campaign_missing', 'Campanha não encontrada.');
    campaign = found;

    // 4. The platform must still look the way the approver was told it looked.
    const live = await client.getCampaign(campaign.externalId);
    if (!live) return refuse('campaign_missing', 'Campanha não encontrada na plataforma.');

    const liveBudget = live.dailyBudgetCents ?? 0;
    const expectedBudget = change.fromValueCents ?? 0;
    if (change.kind === 'set_daily_budget' && liveBudget !== expectedBudget) {
      await db.insert(adGuardrailEvents).values({
        adAccountId: account.id,
        kind: 'usable_would_be_exceeded',
        detail: {
          note: 'Estado da campanha na plataforma mudou desde a aprovação',
          expectedCents: expectedBudget,
          foundCents: liveBudget,
          changeRequestId: change.id,
        },
      });
      await releaseReservation(db, change.id, 'superseded');
      return refuse(
        'platform_drift',
        'A campanha mudou na plataforma desde a aprovação. Solicite uma nova aprovação.',
      );
    }
  }

  // Record the attempt before making it, so an interrupted process still
  // leaves evidence that something may have gone out.
  const idempotencyKey = randomUUID();
  const [execution] = await db
    .insert(adExecutions)
    .values({
      changeRequestId: change.id,
      idempotencyKey,
      requestHash: requestHashOf({
        campaign: campaign?.externalId ?? null,
        draft: draft?.id ?? null,
        kind: change.kind,
        to: change.toValueCents,
      }),
      startedAt: now,
    })
    .returning({ id: adExecutions.id });
  if (!execution) throw new Error('failed to record execution');

  await db
    .update(adChangeRequests)
    .set({ status: 'executing' })
    .where(eq(adChangeRequests.id, change.id));

  let outcome: MutationOutcome;
  if (draft) {
    const payload = draft.payload;
    outcome = await client.createCampaign({
      name: draft.name,
      objective: META_OBJECTIVE[payload.objective] as PlatformObjective,
      // Read from the approved draft, never defaulted: see CreateCampaignSpec.
      // Since 2026-09-19 no draft can ask for ACTIVE; older approved ones could.
      status: draft.startPaused ? 'PAUSED' : 'ACTIVE',
      dailyBudgetCents: draft.dailyBudgetCents,
      ...(isGooglePlatform(payload.platform)
        ? {
            google: {
              channel: GOOGLE_CHANNEL_TYPE[payload.platform],
              // Traffic buys clicks; leads and conversions buy conversions.
              bidding: payload.objective === 'traffic' ? 'MAXIMIZE_CLICKS' : 'MAXIMIZE_CONVERSIONS',
              startDate: draft.startDate,
              endDate: draft.endDate,
              locations: { states: payload.reach.states, cities: payload.reach.cities },
            },
          }
        : {}),
    });
  } else if (!campaign) {
    throw new Error('unreachable: a change is about a campaign or a draft');
  } else if (change.kind === 'set_daily_budget') {
    outcome = await client.setDailyBudget(campaign.externalId, change.toValueCents ?? 0);
  } else if (change.kind === 'pause_campaign') {
    outcome = await client.pauseCampaign(campaign.externalId);
  } else {
    outcome = await client.resumeCampaign(campaign.externalId);
  }

  if (outcome.status === 'applied') {
    if (draft) {
      // Mirror the new campaign at once, so it can be paused, resumed or
      // rebudgeted without waiting for the next ingestion. Reconciliation
      // upserts on the same key and will simply agree.
      const [created] = await db
        .insert(adCampaigns)
        .values({
          adAccountId: account.id,
          externalId: outcome.campaign.id,
          name: outcome.campaign.name,
          status: outcome.campaign.status,
          dailyBudgetCents: outcome.campaign.dailyBudgetCents ?? 0,
          budgetLevel: 'campaign',
          lastSyncedAt: now,
        })
        .onConflictDoUpdate({
          target: [adCampaigns.adAccountId, adCampaigns.externalId],
          set: { status: outcome.campaign.status, lastSyncedAt: now, updatedAt: now },
        })
        .returning({ id: adCampaigns.id });
      if (!created) throw new Error('failed to mirror the created campaign');

      await db
        .update(adCampaignDrafts)
        .set({ campaignId: created.id })
        .where(eq(adCampaignDrafts.id, draft.id));
      await db
        .update(adChangeRequests)
        .set({ campaignId: created.id })
        .where(eq(adChangeRequests.id, change.id));

      await recordStep(db, execution.id, {
        seq: 1,
        kind: 'campaign',
        label: `Campanha ${outcome.campaign.name}`,
        status: 'created',
        externalId: outcome.campaign.id,
        message: null,
      });

      if (tree) {
        const built = await buildAdTree(db, tree.writer, {
          executionId: execution.id,
          startSeq: 1,
          campaignExternalId: outcome.campaign.id,
          draft: tree.draft,
          prepared: tree.prepared,
          pixelId: options.metaPixelId ?? '',
        });
        if (built.status === 'incomplete') {
          // The campaign exists and the rest does not, or not all of it. That is
          // not "applied" and not "rejected": it is a state a person must look
          // at, so it takes the same road as any unknown outcome — recorded,
          // account frozen, nothing retried.
          outcome = {
            status: 'unknown',
            reason: `Criação interrompida depois da campanha. ${built.reason}`,
          };
        }
      }
    } else if (campaign) {
      await db
        .update(adCampaigns)
        .set({
          dailyBudgetCents: outcome.campaign.dailyBudgetCents ?? 0,
          status: outcome.campaign.status,
          lastSyncedAt: now,
          updatedAt: now,
        })
        .where(eq(adCampaigns.id, campaign.id));
    }
  }

  if (outcome.status === 'applied') {
    await db
      .update(adExecutions)
      .set({
        outcome: 'applied',
        finishedAt: new Date(),
        platformResponse: { status: 'applied', ...(outcome.detail ?? {}) },
      })
      .where(eq(adExecutions.id, execution.id));

    await db
      .update(adChangeRequests)
      .set({ status: 'executed', executedAt: new Date() })
      .where(eq(adChangeRequests.id, change.id));

    await writeAudit(db, {
      actorEmployeeId: options.actorEmployeeId ?? null,
      action: 'ads.change_executed',
      entity: 'ad_change_request',
      entityId: change.id,
      metadata: {
        platform: account.platform,
        kind: change.kind,
        toValueCents: change.toValueCents,
        exposureDeltaCents: change.exposureDeltaCents,
      },
    });

    return { ok: true, outcome: 'applied', executionId: execution.id };
  }

  if (outcome.status === 'rejected') {
    await db
      .update(adExecutions)
      .set({
        outcome: 'rejected',
        finishedAt: new Date(),
        platformResponse: { code: outcome.code, message: outcome.message },
      })
      .where(eq(adExecutions.id, execution.id));

    // The platform said no, so nothing was spent: give the budget back.
    await releaseReservation(db, change.id, 'failed');

    await writeAudit(db, {
      actorEmployeeId: options.actorEmployeeId ?? null,
      action: 'ads.change_rejected_by_platform',
      entity: 'ad_change_request',
      entityId: change.id,
      metadata: { code: outcome.code },
    });

    return {
      ok: false,
      outcome: 'rejected',
      executionId: execution.id,
      code: outcome.code,
      message: outcome.message,
    };
  }

  // Unknown: the change may have been applied. The reservation is deliberately
  // NOT released, the account is frozen, and reconciliation must establish the
  // truth before anything else touches this account.
  await db
    .update(adExecutions)
    .set({
      outcome: 'unknown',
      finishedAt: new Date(),
      platformResponse: { reason: outcome.reason },
    })
    .where(eq(adExecutions.id, execution.id));

  await db
    .update(adChangeRequests)
    .set({ status: 'unknown' })
    .where(eq(adChangeRequests.id, change.id));

  await db.insert(adGuardrailEvents).values({
    adAccountId: account.id,
    kind: 'unknown_execution_outcome',
    detail: { changeRequestId: change.id, executionId: execution.id, reason: outcome.reason },
  });

  await engageKillSwitch(
    db,
    account.id,
    'Execução com resultado desconhecido: verifique a plataforma antes de continuar',
  );

  await writeAudit(db, {
    actorEmployeeId: options.actorEmployeeId ?? null,
    action: 'ads.change_outcome_unknown',
    entity: 'ad_change_request',
    entityId: change.id,
    metadata: { reason: outcome.reason },
  });

  return { ok: false, outcome: 'unknown', executionId: execution.id, reason: outcome.reason };
}

/** Approved changes waiting to be executed, oldest first. */
export async function pendingExecutions(db: Database, adAccountId?: string) {
  const rows = await db.query.adChangeRequests.findMany({
    where: adAccountId
      ? and(eq(adChangeRequests.adAccountId, adAccountId), eq(adChangeRequests.status, 'approved'))
      : eq(adChangeRequests.status, 'approved'),
  });
  return rows.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
}

/** Changes left in an unknown state; these block further execution. */
export async function unresolvedExecutions(db: Database) {
  return db.query.adChangeRequests.findMany({
    where: inArray(adChangeRequests.status, ['unknown', 'executing']),
  });
}
