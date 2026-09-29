import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { applyUtms, variationMedia, type CampaignDraft, type CopyVariation } from '@wings/shared';
import { and, eq, inArray } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import {
  adChangeRequests,
  adCreativeUploads,
  adExecutionSteps,
  adExecutions,
  adVideoUploads,
} from '../../db/schema/index.js';
import { TargetingResolutionError } from './platform/meta-client.js';
import type {
  AdSetOptimization,
  AdTreeWriter,
  CreativeMedia,
  ResolvedTargeting,
  StepOutcome,
} from './platform/types.js';

/**
 * Everything under a new campaign: its media, one ad set, one ad per variation.
 *
 * Split in two on purpose. `prepareAdTree` only reads — our own database, the
 * video volume, and the platform's search — and runs before the first write,
 * so a missing file or a city Meta cannot place sends nothing at all.
 * `buildAdTree` writes, in a fixed order, and records every object it makes
 * the moment it exists. It never retries and never cleans up: if a step fails,
 * what was created stays recorded and a person decides what to do with it.
 */

export type StepKind =
  | 'campaign'
  | 'image'
  | 'video'
  | 'ad_set'
  | 'creative'
  | 'ad'
  | 'ad_group'
  | 'keyword'
  | 'negative_keyword';

export interface ExecutionStep {
  seq: number;
  kind: StepKind;
  label: string;
  status: 'created' | 'failed' | 'unknown';
  externalId: string | null;
  message: string | null;
}

/** A draft with everything an ad set and its ads need. Older drafts lack it. */
export type TreeDraft = CampaignDraft & {
  identity: NonNullable<CampaignDraft['identity']>;
  placements: NonNullable<CampaignDraft['placements']>;
  ageMin: number;
  ageMax: number;
};

export function draftHasTree(draft: CampaignDraft): draft is TreeDraft {
  return (
    draft.platform === 'meta' &&
    draft.identity !== undefined &&
    draft.placements !== undefined &&
    draft.ageMin !== undefined &&
    draft.ageMax !== undefined
  );
}

export interface PreparedTree {
  targeting: ResolvedTargeting;
  images: Map<string, { bytes: Buffer; name: string }>;
  videos: Map<string, { filePath: string; byteSize: number; name: string }>;
}

export type PrepareResult =
  | { ok: true; value: PreparedTree }
  | {
      ok: false;
      reason: 'media_missing' | 'targeting_unresolved' | 'platform_unavailable';
      message: string;
    };

export async function prepareAdTree(
  db: Database,
  writer: AdTreeWriter,
  draft: TreeDraft,
  options: { videoDir?: string },
): Promise<PrepareResult> {
  const creativeIds = new Set<string>();
  const videoIds = new Set<string>();
  for (const variation of draft.variations) {
    const media = variationMedia(variation);
    media.creativeIds.forEach((id) => creativeIds.add(id));
    media.videoIds.forEach((id) => videoIds.add(id));
  }

  const images: PreparedTree['images'] = new Map();
  if (creativeIds.size > 0) {
    const rows = await db
      .select()
      .from(adCreativeUploads)
      .where(inArray(adCreativeUploads.id, [...creativeIds]));
    for (const row of rows) {
      const extension = row.mimeType === 'image/png' ? 'png' : 'jpg';
      images.set(row.id, {
        bytes: row.data,
        name: `wings-${row.sha256.slice(0, 12)}.${extension}`,
      });
    }
  }
  if (images.size !== creativeIds.size) {
    return {
      ok: false,
      reason: 'media_missing',
      message: 'Uma das imagens do pedido não foi encontrada.',
    };
  }

  const videos: PreparedTree['videos'] = new Map();
  if (videoIds.size > 0) {
    if (!options.videoDir) {
      return {
        ok: false,
        reason: 'media_missing',
        message: 'O armazenamento de vídeos não está configurado neste ambiente.',
      };
    }
    const rows = await db
      .select()
      .from(adVideoUploads)
      .where(inArray(adVideoUploads.id, [...videoIds]));
    for (const row of rows) {
      const filePath = join(options.videoDir, row.storageKey);
      const info = await stat(filePath).catch(() => null);
      // The size on disk must be the size that was accepted: a truncated file
      // would upload "successfully" as a broken video.
      if (info?.size === row.byteSize) {
        videos.set(row.id, {
          filePath,
          byteSize: row.byteSize,
          name: `wings-${row.sha256.slice(0, 12)}`,
        });
      }
    }
    if (videos.size !== videoIds.size) {
      return {
        ok: false,
        reason: 'media_missing',
        message: 'Um dos vídeos do pedido não foi encontrado.',
      };
    }
  }

  try {
    const targeting = await writer.resolveTargeting({
      states: draft.reach.states,
      cities: draft.reach.cities,
    });
    return { ok: true, value: { targeting, images, videos } };
  } catch (error) {
    if (error instanceof TargetingResolutionError) {
      return { ok: false, reason: 'targeting_unresolved', message: error.message };
    }
    return {
      ok: false,
      reason: 'platform_unavailable',
      message: 'Não foi possível consultar as localidades na Meta. Nada foi enviado.',
    };
  }
}

/** Writes one row per object, as it happens. `seq` continues from `startSeq`. */
export async function recordStep(
  db: Database,
  executionId: string,
  step: ExecutionStep,
): Promise<void> {
  await db.insert(adExecutionSteps).values({ executionId, ...step });
}

export async function stepsOfExecution(
  db: Database,
  executionId: string,
): Promise<ExecutionStep[]> {
  const rows = await db
    .select()
    .from(adExecutionSteps)
    .where(eq(adExecutionSteps.executionId, executionId));
  return rows
    .sort((a, b) => a.seq - b.seq)
    .map((row) => ({
      seq: row.seq,
      kind: row.kind as StepKind,
      label: row.label,
      status: row.status as ExecutionStep['status'],
      externalId: row.externalId,
      message: row.message,
    }));
}

/**
 * The Meta id of a video an earlier execution on this account uploaded for the
 * same local video, if any: the newest created `video` step whose note names
 * it. Null when it was never uploaded, or every attempt failed before the end.
 */
export async function priorVideo(
  db: Database,
  adAccountId: string,
  localVideoId: string,
): Promise<string | null> {
  const rows = await db
    .select({ externalId: adExecutionSteps.externalId, createdAt: adExecutionSteps.createdAt })
    .from(adExecutionSteps)
    .innerJoin(adExecutions, eq(adExecutions.id, adExecutionSteps.executionId))
    .innerJoin(adChangeRequests, eq(adChangeRequests.id, adExecutions.changeRequestId))
    .where(
      and(
        eq(adChangeRequests.adAccountId, adAccountId),
        eq(adExecutionSteps.kind, 'video'),
        eq(adExecutionSteps.status, 'created'),
        eq(adExecutionSteps.message, `video:${localVideoId}`),
      ),
    );
  const newest = rows.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
  return newest?.externalId ?? null;
}

function optimizationFor(draft: TreeDraft, pixelId: string): AdSetOptimization {
  // Traffic buys landing-page views. Leads — and conversions, which on this
  // account means the same site form — optimise for the pixel's Lead event.
  return draft.objective === 'traffic'
    ? { goal: 'LANDING_PAGE_VIEWS' }
    : { goal: 'OFFSITE_CONVERSIONS', pixelId, event: 'LEAD' };
}

export type BuildResult =
  | { status: 'complete'; adSetId: string; adIds: string[] }
  | { status: 'incomplete'; reason: string };

/**
 * Media, then the ad set, then a creative and an ad per variation. Stops at the
 * first step that does not answer "created".
 */
export async function buildAdTree(
  db: Database,
  writer: AdTreeWriter,
  input: {
    executionId: string;
    /** The step number the campaign itself was recorded under. */
    startSeq: number;
    /** Our id of the account, to find media an earlier execution already uploaded. */
    adAccountId: string;
    campaignExternalId: string;
    draft: TreeDraft;
    prepared: PreparedTree;
    pixelId: string;
  },
): Promise<BuildResult> {
  const { draft, prepared, executionId } = input;
  let seq = input.startSeq;

  /** Runs one write, records it, and says whether to go on. */
  const step = async <T>(
    kind: StepKind,
    label: string,
    run: () => Promise<StepOutcome<T>>,
    idOf: (value: T) => string,
    /** Kept with a created step: how a later execution finds it (`video:<local id>`). */
    note: string | null = null,
  ): Promise<{ ok: true; value: T } | { ok: false; reason: string }> => {
    seq += 1;
    let outcome: StepOutcome<T>;
    try {
      outcome = await run();
    } catch (error) {
      // A throw in the middle of a write says nothing about whether it landed.
      outcome = {
        status: 'unknown',
        reason: error instanceof Error ? error.name : 'unexpected failure',
      };
    }

    if (outcome.status === 'created') {
      await recordStep(db, executionId, {
        seq,
        kind,
        label,
        status: 'created',
        externalId: idOf(outcome.value),
        message: note,
      });
      return { ok: true, value: outcome.value };
    }

    const message =
      outcome.status === 'rejected' ? `${outcome.code}: ${outcome.message}` : outcome.reason;
    await recordStep(db, executionId, {
      seq,
      kind,
      label,
      status: outcome.status === 'rejected' ? 'failed' : 'unknown',
      externalId: null,
      message,
    });
    return { ok: false, reason: `${label}: ${message}` };
  };

  // 1. Media, each file once however many variations or cards use it.
  const uploaded = new Map<string, CreativeMedia>();
  for (const [id, image] of prepared.images) {
    const result = await step(
      'image',
      `Imagem ${image.name}`,
      () => writer.uploadImage(image),
      (value) => value.imageHash,
    );
    if (!result.ok) return { status: 'incomplete', reason: result.reason };
    uploaded.set(id, { kind: 'image', imageHash: result.value.imageHash });
  }
  for (const [id, video] of prepared.videos) {
    // A video this system already put in the account (an earlier execution
    // that failed after it) is used again, never uploaded twice. The step
    // keeps the local id in its message, which is how it is found next time.
    const earlier = await priorVideo(db, input.adAccountId, id);
    const result = earlier
      ? await step(
          'video',
          `Vídeo ${video.name} (reaproveitado)`,
          () => writer.reuseVideo(earlier, video.name),
          (value) => value.videoId,
          `video:${id}`,
        )
      : await step(
          'video',
          `Vídeo ${video.name}`,
          () => writer.uploadVideo(video),
          (value) => value.videoId,
          `video:${id}`,
        );
    if (!result.ok) return { status: 'incomplete', reason: result.reason };
    uploaded.set(id, { kind: 'video', ...result.value });
  }

  // 2. The ad set.
  const adSet = await step(
    'ad_set',
    `Conjunto ${draft.name}`,
    () =>
      writer.createAdSet({
        campaignId: input.campaignExternalId,
        name: `${draft.name} — conjunto`,
        startDate: draft.startDate,
        endDate: draft.endDate,
        optimization: optimizationFor(draft, input.pixelId),
        targeting: prepared.targeting,
        customLocations: draft.reach.customLocations,
        ageMin: draft.ageMin,
        ageMax: draft.ageMax,
        placements:
          draft.placements.mode === 'manual'
            ? {
                facebook: draft.placements.facebook,
                instagram: draft.placements.instagram,
                // The schema refuses anything but 'feed' here.
                threads: draft.placements.threads as 'feed'[],
              }
            : null,
      }),
    (value) => value.id,
  );
  if (!adSet.ok) return { status: 'incomplete', reason: adSet.reason };

  // 3. One creative and one ad per variation.
  const mediaOf = (id: string | undefined): CreativeMedia => {
    const media = id ? uploaded.get(id) : undefined;
    if (!media) throw new Error('unreachable: prepared media covers every variation');
    return media;
  };
  const bodyOf = (variation: CopyVariation, index: number) => {
    if (variation.creativeType === 'carousel') {
      return {
        type: 'carousel' as const,
        cards: (variation.cards ?? []).map((card) => ({
          media: mediaOf(card.mediaType === 'video' ? card.videoId : card.creativeId),
          headline: card.headline,
          description: card.description,
          link:
            applyUtms(card.link, draft.utms, { creativeType: 'carousel', position: index + 1 }) ??
            card.link,
        })),
      };
    }
    return {
      type: 'single' as const,
      media: mediaOf(variation.creativeType === 'video' ? variation.videoId : variation.creativeId),
    };
  };

  const adIds: string[] = [];
  for (const [index, variation] of draft.variations.entries()) {
    const name = `${draft.name} — v${index + 1}`;
    const creativeSpec = {
      name,
      pageId: draft.identity.pageId,
      instagramUserId: draft.identity.instagramActorId,
      message: variation.primaryText,
      headline: variation.headline,
      callToAction: variation.callToAction,
      // Each ad carries its own utm_content (video-1, imagem-2…).
      link:
        applyUtms(draft.destinationUrl, draft.utms, {
          creativeType: variation.creativeType,
          position: index + 1,
        }) ?? draft.destinationUrl,
      body: bodyOf(variation, index),
    };
    // Meta judges the ad with its creative inline first, creating nothing; a
    // refusal here is the same step failing, with nothing more on the platform.
    const creative = await step(
      'creative',
      `Criativo ${name}`,
      async () => {
        const checked = await writer.validateAd({
          name: `Anúncio ${name}`,
          adSetId: adSet.value.id,
          creative: creativeSpec,
        });
        if (checked.status !== 'created') {
          return checked.status === 'rejected'
            ? { ...checked, message: `validate_only: ${checked.message}` }
            : checked;
        }
        return writer.createCreative(creativeSpec);
      },
      (value) => value.id,
    );
    if (!creative.ok) return { status: 'incomplete', reason: creative.reason };

    const ad = await step(
      'ad',
      `Anúncio ${name}`,
      () => writer.createAd({ name, adSetId: adSet.value.id, creativeId: creative.value.id }),
      (value) => value.id,
    );
    if (!ad.ok) return { status: 'incomplete', reason: ad.reason };
    adIds.push(ad.value.id);
  }

  return { status: 'complete', adSetId: adSet.value.id, adIds };
}
