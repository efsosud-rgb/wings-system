import { createHash, randomUUID } from 'node:crypto';
import {
  AD_ACCOUNT_PLATFORM,
  GOOGLE_CHANNEL_TYPE,
  addAdsPayloadSchema,
  META_OBJECTIVE,
  applyUtms,
  isGooglePlatform,
  parseSearchKeyword,
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
  adExecutionSteps,
  adExecutions,
  adGuardrailEvents,
  budgetPeriods,
} from '../../db/schema/index.js';
import { writeAudit } from '../../lib/audit.js';
import {
  buildAdTree,
  buildAdsInAdSet,
  draftHasTree,
  prepareAdTree,
  prepareMedia,
  recordStep,
  type PreparedTree,
  type TreeDraft,
} from './ad-tree.js';
import {
  addAdsPayloadHash,
  draftPayloadHash,
  engageKillSwitch,
  releaseReservation,
} from './budget-guard.js';
import {
  canPreflight,
  isAdTreeWriter,
  type AdsPlatformClient,
  type AdTreeWriter,
  type CreateCampaignSpec,
  type MutationOutcome,
  type PlannedWrite,
  type PlatformObjective,
  type PreflightOutcome,
  type ResumeCompanions,
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
 *      against is real rather than remembered;
 *   8. where the platform can validate without writing (Google's
 *      `validateOnly`), the exact request is validated first, and a refusal
 *      there is a rejection with nothing sent.
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

  // New ads in an ad set that exists: their own road, since there is no
  // single write to validate and no campaign or budget to touch.
  if (change.kind === 'add_ads') {
    return executeAddAds(db, client, change, account, options, now, refuse);
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

  // What is about to go out, built once: the same request is validated where
  // the platform can validate without writing, and then sent.
  const write: PlannedWrite = draft
    ? { kind: 'create_campaign', spec: createSpecOf(draft) }
    : change.kind === 'set_daily_budget'
      ? {
          kind: 'set_daily_budget',
          campaignId: campaign!.externalId,
          dailyBudgetCents: change.toValueCents ?? 0,
        }
      : change.kind === 'pause_campaign'
        ? { kind: 'pause_campaign', campaignId: campaign!.externalId }
        : {
            kind: 'resume_campaign',
            campaignId: campaign!.externalId,
            // Born paused all the way down, so a resume switches on what this
            // system itself created under the campaign — and nothing else.
            enableWith: await companionsOf(db, campaign!.id),
          };

  // 8. Preflight. A refusal here is Google saying no to the exact request,
  // so it is recorded and the reservation given back like any rejection;
  // "no answer" validates nothing and leaves the change untouched to retry.
  let preflightRejection: Extract<PreflightOutcome, { status: 'rejected' }> | null = null;
  if (canPreflight(client)) {
    const preflight = await client.validateWrite(write);
    if (preflight.status === 'unavailable') {
      return refuse(
        'platform_unavailable',
        `A plataforma não respondeu à validação prévia (${preflight.reason}). Nada foi enviado; tente de novo.`,
      );
    }
    if (preflight.status === 'rejected') preflightRejection = preflight;
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
  if (preflightRejection) {
    outcome = {
      status: 'rejected',
      code: preflightRejection.code,
      message: `Recusado na validação prévia: ${preflightRejection.message}`,
    };
  } else if (write.kind === 'create_campaign') {
    outcome = await client.createCampaign(write.spec);
  } else if (write.kind === 'set_daily_budget') {
    outcome = await client.setDailyBudget(write.campaignId, write.dailyBudgetCents);
  } else if (write.kind === 'pause_campaign') {
    outcome = await client.pauseCampaign(write.campaignId);
  } else {
    outcome = await client.resumeCampaign(write.campaignId, write.enableWith);
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
      // One atomic write made all of these along with the campaign (Google):
      // listed so a person sees what exists, and so a resume can find them.
      let seq = 1;
      for (const object of outcome.created ?? []) {
        seq += 1;
        await recordStep(db, execution.id, {
          seq,
          kind: object.kind,
          label: object.label,
          status: 'created',
          externalId: object.externalId || null,
          message: null,
        });
      }

      if (tree) {
        const built = await buildAdTree(db, tree.writer, {
          executionId: execution.id,
          startSeq: 1,
          adAccountId: account.id,
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
        platformResponse: {
          code: outcome.code,
          message: outcome.message,
          ...(outcome.detail ?? {}),
          ...(preflightRejection ? { preflight: true } : {}),
        },
      })
      .where(eq(adExecutions.id, execution.id));

    // The platform said no, so nothing was spent: give the budget back.
    await releaseReservation(db, change.id, 'failed');

    await writeAudit(db, {
      actorEmployeeId: options.actorEmployeeId ?? null,
      action: 'ads.change_rejected_by_platform',
      entity: 'ad_change_request',
      entityId: change.id,
      metadata: { code: outcome.code, preflight: preflightRejection !== null },
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

/**
 * The platform's spec for a draft, read from the approved draft and never
 * defaulted (see `CreateCampaignSpec`). Since 2026-09-19 no draft can ask for
 * ACTIVE; older approved ones could.
 */
export function createSpecOf(
  draft: Pick<
    typeof adCampaignDrafts.$inferSelect,
    'name' | 'startPaused' | 'dailyBudgetCents' | 'startDate' | 'endDate'
  > & { payload: CampaignDraft },
): CreateCampaignSpec {
  const payload = draft.payload;
  const search = payload.search;
  return {
    name: draft.name,
    objective: META_OBJECTIVE[payload.objective] as PlatformObjective,
    status: draft.startPaused ? 'PAUSED' : 'ACTIVE',
    dailyBudgetCents: draft.dailyBudgetCents,
    ...(isGooglePlatform(payload.platform)
      ? {
          google: {
            channel: GOOGLE_CHANNEL_TYPE[payload.platform],
            // Traffic buys clicks; leads and conversions buy conversions.
            // Search bids as the draft says (below); Demand Gen by objective.
            bidding:
              search?.bidding === 'maximize_conversions'
                ? 'MAXIMIZE_CONVERSIONS'
                : search?.bidding === 'maximize_clicks' || payload.objective === 'traffic'
                  ? 'MAXIMIZE_CLICKS'
                  : 'MAXIMIZE_CONVERSIONS',
            startDate: draft.startDate,
            endDate: draft.endDate,
            reach: {
              states: payload.reach.states,
              cities: payload.reach.cities,
              // A draft approved before the map existed has none.
              customLocations: payload.reach.customLocations ?? [],
            },
            ...(payload.platform === 'google_search' && search
              ? {
                  search: {
                    adGroupName: search.adGroupName?.trim() || draft.name,
                    locationMode:
                      search.locationMode === 'presence_or_interest'
                        ? 'PRESENCE_OR_INTEREST'
                        : 'PRESENCE',
                    bidding:
                      search.bidding === 'maximize_conversions'
                        ? 'MAXIMIZE_CONVERSIONS'
                        : 'MAXIMIZE_CLICKS',
                    maxCpcCents:
                      search.bidding === 'maximize_conversions' ? undefined : search.maxCpcCents,
                    // The schema refused anything but [exact] and "phrase".
                    keywords: search.keywords.flatMap((raw) => {
                      const parsed = parseSearchKeyword(raw);
                      return parsed
                        ? [
                            {
                              text: parsed.text,
                              match: parsed.match === 'exact' ? 'EXACT' : 'PHRASE',
                            },
                          ]
                        : [];
                    }),
                    negativeKeywords: search.negativeKeywords.map(
                      (raw) => parseSearchKeyword(raw)?.text ?? raw.trim(),
                    ),
                    headlines: search.headlines,
                    descriptions: search.descriptions,
                    finalUrl:
                      applyUtms(payload.destinationUrl, payload.utms) ?? payload.destinationUrl,
                  },
                }
              : {}),
          },
        }
      : {}),
  };
}

/**
 * The ad groups and ads this system created (paused) under a campaign, from
 * the steps of its executions. Nothing made by hand on the platform is ever
 * here, so a resume switches on only what the system itself switched off.
 */
export async function companionsOf(db: Database, campaignId: string): Promise<ResumeCompanions> {
  const rows = await db
    .select({ kind: adExecutionSteps.kind, externalId: adExecutionSteps.externalId })
    .from(adExecutionSteps)
    .innerJoin(adExecutions, eq(adExecutions.id, adExecutionSteps.executionId))
    .innerJoin(adChangeRequests, eq(adChangeRequests.id, adExecutions.changeRequestId))
    .where(
      and(
        eq(adChangeRequests.campaignId, campaignId),
        // What this system created under the campaign: the tree of its
        // creation and the ads added to it later.
        inArray(adChangeRequests.kind, ['create_campaign', 'add_ads']),
        eq(adExecutionSteps.status, 'created'),
        // Google records its ad groups as `ad_group`, Meta its ad sets as `ad_set`.
        inArray(adExecutionSteps.kind, ['ad_group', 'ad_set', 'ad']),
      ),
    );
  const ids = (...kinds: string[]) =>
    rows.flatMap((row) => (kinds.includes(row.kind) && row.externalId ? [row.externalId] : []));
  return { adGroupIds: ids('ad_group', 'ad_set'), adIds: ids('ad') };
}

export type PreflightResult =
  | { ok: true; status: 'ok'; operations: string[] }
  | { ok: false; status: 'rejected'; code: string; message: string }
  | { ok: false; status: 'unavailable'; reason: string }
  | { ok: false; status: 'refused'; reason: ExecutionRefusal; message: string };

/**
 * Validates a change against the real account without writing: the exact
 * request the executor would send, with the platform's validate-only flag.
 * Any client of the platform will do — a reader included — because nothing
 * is written. Nothing about the change is altered by this; it is a rehearsal.
 */
export async function preflightChange(
  db: Database,
  client: AdsPlatformClient,
  changeRequestId: string,
): Promise<PreflightResult> {
  const refuse = (reason: ExecutionRefusal, message: string): PreflightResult => ({
    ok: false,
    status: 'refused',
    reason,
    message,
  });
  if (!canPreflight(client)) {
    return refuse('platform_unavailable', 'Esta plataforma não valida sem escrever.');
  }
  const change = await db.query.adChangeRequests.findFirst({
    where: eq(adChangeRequests.id, changeRequestId),
  });
  if (!change) return refuse('not_approved', 'Alteração não encontrada.');
  const account = await db.query.adAccounts.findFirst({
    where: eq(adAccounts.id, change.adAccountId),
  });
  if (!account) return refuse('campaign_missing', 'Conta não encontrada.');
  if (client.accountExternalId !== account.externalId) {
    return refuse('wrong_account', 'O cliente da plataforma não pertence à conta desta alteração.');
  }

  // New ads are validated one by one inside their execution (validate_only
  // with the creative inline), right before each is created.
  if (change.kind === 'add_ads') {
    return {
      ok: false,
      status: 'unavailable',
      reason: 'Os anúncios novos são validados um a um na execução, antes de cada criação.',
    };
  }

  let write: PlannedWrite;
  if (change.kind === 'create_campaign') {
    const stored = change.draftId
      ? await db.query.adCampaignDrafts.findFirst({
          where: eq(adCampaignDrafts.id, change.draftId),
        })
      : undefined;
    if (!stored) return refuse('draft_missing', 'O rascunho desta campanha não foi encontrado.');
    write = {
      kind: 'create_campaign',
      spec: createSpecOf({ ...stored, payload: stored.payload as CampaignDraft }),
    };
  } else {
    const campaign = change.campaignId
      ? await db.query.adCampaigns.findFirst({ where: eq(adCampaigns.id, change.campaignId) })
      : undefined;
    if (!campaign) return refuse('campaign_missing', 'Campanha não encontrada.');
    write =
      change.kind === 'set_daily_budget'
        ? {
            kind: 'set_daily_budget',
            campaignId: campaign.externalId,
            dailyBudgetCents: change.toValueCents ?? 0,
          }
        : change.kind === 'pause_campaign'
          ? { kind: 'pause_campaign', campaignId: campaign.externalId }
          : {
              kind: 'resume_campaign',
              campaignId: campaign.externalId,
              enableWith: await companionsOf(db, campaign.id),
            };
  }

  const outcome = await client.validateWrite(write);
  if (outcome.status === 'ok') return { ok: true, status: 'ok', operations: outcome.operations };
  if (outcome.status === 'rejected') return { ok: false, ...outcome };
  return { ok: false, status: 'unavailable', reason: outcome.reason };
}

/**
 * Executes an approved `add_ads`: the stored payload must still hash to what
 * was approved, the ad set must still belong to the campaign on the platform,
 * and every file must be here before the first write. Then media, and a
 * creative and an ad per creative (each validated first), all born paused.
 * Nothing created: rejected. Something created and then a stop: unknown, the
 * account frozen, as any partial write.
 */
async function executeAddAds(
  db: Database,
  client: AdsPlatformClient,
  change: typeof adChangeRequests.$inferSelect,
  account: typeof adAccounts.$inferSelect,
  options: ExecuteOptions,
  now: Date,
  refuse: (reason: ExecutionRefusal, message: string) => ExecutionResult,
): Promise<ExecutionResult> {
  const parsed = addAdsPayloadSchema.safeParse(change.payload);
  if (!parsed.success) return refuse('draft_missing', 'O pedido dos anúncios não foi encontrado.');
  const payload = parsed.data;
  if (addAdsPayloadHash({ adAccountId: account.id, payload }) !== change.payloadHash) {
    return refuse('payload_changed', 'O pedido mudou depois da aprovação.');
  }
  const campaign = change.campaignId
    ? await db.query.adCampaigns.findFirst({ where: eq(adCampaigns.id, change.campaignId) })
    : undefined;
  if (!campaign) return refuse('campaign_missing', 'Campanha não encontrada.');
  if (!isAdTreeWriter(client)) {
    return refuse('writes_disabled', 'O cliente desta plataforma não cria anúncios.');
  }

  // The ad set must still be this campaign's, as the approver was told.
  const liveSets = await client.listAdSets().catch(() => null);
  if (!liveSets) {
    return refuse(
      'platform_unavailable',
      'A Meta não respondeu à leitura dos conjuntos. Nada foi enviado.',
    );
  }
  const liveSet = liveSets.find((set) => set.id === payload.adSetExternalId);
  if (!liveSet || liveSet.campaignId !== campaign.externalId) {
    return refuse(
      'platform_drift',
      'O conjunto de anúncios não pertence mais a esta campanha na Meta. Solicite uma nova aprovação.',
    );
  }

  const media = await prepareMedia(db, payload.variations, { videoDir: options.videoDir });
  if (!media.ok) return refuse(media.reason, media.message);

  const [execution] = await db
    .insert(adExecutions)
    .values({
      changeRequestId: change.id,
      idempotencyKey: randomUUID(),
      requestHash: requestHashOf({
        campaign: campaign.externalId,
        adSet: payload.adSetExternalId,
        kind: change.kind,
        payload: change.payloadHash,
      }),
      startedAt: now,
    })
    .returning({ id: adExecutions.id });
  if (!execution) throw new Error('failed to record execution');
  await db
    .update(adChangeRequests)
    .set({ status: 'executing' })
    .where(eq(adChangeRequests.id, change.id));

  const built = await buildAdsInAdSet(db, client, {
    executionId: execution.id,
    adAccountId: account.id,
    adSetExternalId: payload.adSetExternalId,
    campaignName: payload.campaignName,
    pageId: payload.identity.pageId,
    instagramActorId: payload.identity.instagramActorId,
    destinationUrl: payload.destinationUrl,
    utms: payload.utms,
    variations: payload.variations,
    prepared: media.value,
    firstPosition: payload.firstPosition,
  });

  if (built.status === 'complete') {
    await db
      .update(adExecutions)
      .set({
        outcome: 'applied',
        finishedAt: new Date(),
        platformResponse: { status: 'applied', adIds: built.adIds },
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
        adIds: built.adIds,
        adSet: payload.adSetExternalId,
      },
    });
    return { ok: true, outcome: 'applied', executionId: execution.id };
  }

  const created = await db
    .select({ id: adExecutionSteps.id })
    .from(adExecutionSteps)
    .where(
      and(eq(adExecutionSteps.executionId, execution.id), eq(adExecutionSteps.status, 'created')),
    );
  if (created.length === 0) {
    // Refused before anything existed (validate_only, most likely): nothing to look after.
    await db
      .update(adExecutions)
      .set({
        outcome: 'rejected',
        finishedAt: new Date(),
        platformResponse: { message: built.reason },
      })
      .where(eq(adExecutions.id, execution.id));
    await db
      .update(adChangeRequests)
      .set({ status: 'failed' })
      .where(eq(adChangeRequests.id, change.id));
    await writeAudit(db, {
      actorEmployeeId: options.actorEmployeeId ?? null,
      action: 'ads.change_rejected_by_platform',
      entity: 'ad_change_request',
      entityId: change.id,
      metadata: { kind: change.kind, reason: built.reason },
    });
    return {
      ok: false,
      outcome: 'rejected',
      executionId: execution.id,
      code: 'add_ads_refused',
      message: built.reason,
    };
  }

  // Part of it exists: the same road as any unknown outcome.
  await db
    .update(adExecutions)
    .set({ outcome: 'unknown', finishedAt: new Date(), platformResponse: { reason: built.reason } })
    .where(eq(adExecutions.id, execution.id));
  await db
    .update(adChangeRequests)
    .set({ status: 'unknown' })
    .where(eq(adChangeRequests.id, change.id));
  await db.insert(adGuardrailEvents).values({
    adAccountId: account.id,
    kind: 'unknown_execution_outcome',
    detail: { changeRequestId: change.id, executionId: execution.id, reason: built.reason },
  });
  await engageKillSwitch(
    db,
    account.id,
    'Criação de anúncios interrompida no meio: verifique a plataforma antes de continuar',
  );
  await writeAudit(db, {
    actorEmployeeId: options.actorEmployeeId ?? null,
    action: 'ads.change_outcome_unknown',
    entity: 'ad_change_request',
    entityId: change.id,
    metadata: { reason: built.reason },
  });
  return { ok: false, outcome: 'unknown', executionId: execution.id, reason: built.reason };
}
