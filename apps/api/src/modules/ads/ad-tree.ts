import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import {
  adDestination,
  adUtmContent,
  META_URL_TAGS,
  variationMedia,
  type CampaignDraft,
  type CopyVariation,
} from '@wings/shared';
import { and, eq, inArray } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import {
  adChangeRequests,
  adCreativeUploads,
  adExecutionSteps,
  adExecutions,
  adVideoUploads,
} from '../../db/schema/index.js';
import { metaLeadFormSpecOf, registerLeadFormIntake, reusableLeadForm } from './lead-forms.js';
import { TargetingResolutionError } from './platform/meta-client.js';
import {
  isLeadFormWriter,
  type AdSetOptimization,
  type AdTreeWriter,
  type CreativeMedia,
  type ResolvedTargeting,
  type StepOutcome,
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
  | 'lead_form'
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

export interface PreparedMedia {
  images: Map<string, { bytes: Buffer; name: string }>;
  videos: Map<string, { filePath: string; byteSize: number; name: string }>;
}

export interface PreparedTree extends PreparedMedia {
  targeting: ResolvedTargeting;
}

export type PrepareResult =
  | { ok: true; value: PreparedTree }
  | {
      ok: false;
      reason: 'media_missing' | 'targeting_unresolved' | 'platform_unavailable';
      message: string;
    };

/** Reads every image and video the variations use: our database and the video volume, nothing else. */
export async function prepareMedia(
  db: Database,
  variations: CopyVariation[],
  options: { videoDir?: string },
): Promise<
  { ok: true; value: PreparedMedia } | { ok: false; reason: 'media_missing'; message: string }
> {
  const creativeIds = new Set<string>();
  const videoIds = new Set<string>();
  for (const variation of variations) {
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

  return { ok: true, value: { images, videos } };
}

export async function prepareAdTree(
  db: Database,
  writer: AdTreeWriter,
  draft: TreeDraft,
  options: { videoDir?: string },
): Promise<PrepareResult> {
  const media = await prepareMedia(db, draft.variations, options);
  if (!media.ok) return media;
  const { images, videos } = media.value;

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
  // A lead campaign with the form on the ad optimises for the form itself.
  if (draft.leadCapture === 'instant_form') {
    return { goal: 'LEAD_GENERATION', pageId: draft.identity.pageId };
  }
  return draft.objective === 'traffic'
    ? { goal: 'LANDING_PAGE_VIEWS' }
    : { goal: 'OFFSITE_CONVERSIONS', pixelId, event: 'LEAD' };
}

/** The ad's link when the form is on the ad: the Page itself, as Meta's examples do. */
export const pageLink = (pageId: string) => `https://www.facebook.com/${pageId}/`;

export type BuildResult =
  | { status: 'complete'; adSetId: string; adIds: string[]; leadFormId?: string }
  | { status: 'incomplete'; reason: string };

type Stepper = <T>(
  kind: StepKind,
  label: string,
  run: () => Promise<StepOutcome<T>>,
  idOf: (value: T) => string,
  note?: string | null,
) => Promise<{ ok: true; value: T } | { ok: false; reason: string }>;

/** Runs one write at a time, records it the moment it answers, and numbers it after `startSeq`. */
function stepperFor(db: Database, executionId: string, startSeq: number): Stepper {
  let seq = startSeq;
  return async (kind, label, run, idOf, note = null) => {
    seq += 1;
    let outcome;
    try {
      outcome = await run();
    } catch (error) {
      // A throw in the middle of a write says nothing about whether it landed.
      outcome = {
        status: 'unknown' as const,
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
}

/** Media, each file once however many variations or cards use it. */
async function uploadMedia(
  db: Database,
  writer: AdTreeWriter,
  step: Stepper,
  adAccountId: string,
  prepared: PreparedMedia,
): Promise<{ ok: true; uploaded: Map<string, CreativeMedia> } | { ok: false; reason: string }> {
  const uploaded = new Map<string, CreativeMedia>();
  for (const [id, image] of prepared.images) {
    const result = await step(
      'image',
      `Imagem ${image.name}`,
      () => writer.uploadImage(image),
      (value) => value.imageHash,
    );
    if (!result.ok) return result;
    uploaded.set(id, { kind: 'image', imageHash: result.value.imageHash });
  }
  for (const [id, video] of prepared.videos) {
    // A video this system already put in the account (an earlier execution
    // that failed after it) is used again, never uploaded twice. The step
    // keeps the local id in its message, which is how it is found next time.
    const earlier = await priorVideo(db, adAccountId, id);
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
    if (!result.ok) return result;
    uploaded.set(id, { kind: 'video', ...result.value });
  }
  return { ok: true, uploaded };
}

/**
 * The creative one ad is made of, exactly as it is sent to Meta: page and
 * Instagram account, words, button, media, the destination without UTMs and
 * the standard `url_tags` that put them on every click. Exported so a
 * rehearsal validates the very same thing an execution would create.
 */
export function creativeSpecOf(input: {
  name: string;
  pageId: string;
  instagramActorId: string | null | undefined;
  destinationUrl: string;
  utms: CampaignDraft['utms'];
  variation: CopyVariation;
  position: number;
  mediaOf: (id: string | undefined) => CreativeMedia;
  /** Lead Ads: the instant form the button opens; the ad then links to the Page, not a site. */
  leadGenFormId?: string;
}) {
  const { variation, mediaOf } = input;
  if (input.leadGenFormId) {
    const link = pageLink(input.pageId);
    return {
      name: input.name,
      pageId: input.pageId,
      instagramUserId: input.instagramActorId ?? null,
      message: variation.primaryText,
      headline: variation.headline,
      callToAction: variation.callToAction,
      link,
      urlTags: META_URL_TAGS,
      leadGenFormId: input.leadGenFormId,
      body:
        variation.creativeType === 'carousel'
          ? {
              type: 'carousel' as const,
              cards: (variation.cards ?? []).map((card) => ({
                media: mediaOf(card.mediaType === 'video' ? card.videoId : card.creativeId),
                headline: card.headline,
                description: card.description,
                link,
              })),
            }
          : {
              type: 'single' as const,
              media: mediaOf(
                variation.creativeType === 'video' ? variation.videoId : variation.creativeId,
              ),
            },
    };
  }
  const ad = { creativeType: variation.creativeType, position: input.position };
  const body =
    variation.creativeType === 'carousel'
      ? {
          type: 'carousel' as const,
          cards: (variation.cards ?? []).map((card) => ({
            media: mediaOf(card.mediaType === 'video' ? card.videoId : card.creativeId),
            headline: card.headline,
            description: card.description,
            link: adDestination('meta', card.link, input.utms, ad) ?? card.link,
          })),
        }
      : {
          type: 'single' as const,
          media: mediaOf(
            variation.creativeType === 'video' ? variation.videoId : variation.creativeId,
          ),
        };
  return {
    name: input.name,
    pageId: input.pageId,
    instagramUserId: input.instagramActorId ?? null,
    message: variation.primaryText,
    headline: variation.headline,
    callToAction: variation.callToAction,
    // No UTM in the link: Meta appends `url_tags`, with the ad's own ids.
    link: adDestination('meta', input.destinationUrl, input.utms, ad) ?? input.destinationUrl,
    urlTags: META_URL_TAGS,
    body,
  };
}

/**
 * A creative and an ad per variation, in an ad set that exists. Each ad is
 * judged with its creative inline first (validate_only), and each carries the
 * standard url_tags, so Meta fills utm_content with the ad's own id. Ads are
 * born paused, like everything this system creates.
 */
async function createAds(
  writer: AdTreeWriter,
  step: Stepper,
  input: {
    adSetId: string;
    /** "<campaign name>": ads are named "<campaign name> — <label>". */
    name: string;
    /** How an ad is labelled in its name: `v1` for a new campaign, `video-1` for ads added later. */
    labelOf?: (ad: { creativeType: CopyVariation['creativeType']; position: number }) => string;
    pageId: string;
    instagramActorId: string | null | undefined;
    destinationUrl: string;
    utms: CampaignDraft['utms'];
    variations: CopyVariation[];
    uploaded: Map<string, CreativeMedia>;
    firstPosition: number;
    leadGenFormId?: string;
  },
): Promise<{ ok: true; adIds: string[] } | { ok: false; reason: string }> {
  const mediaOf = (id: string | undefined): CreativeMedia => {
    const media = id ? input.uploaded.get(id) : undefined;
    if (!media) throw new Error('unreachable: prepared media covers every variation');
    return media;
  };
  const adIds: string[] = [];
  for (const [index, variation] of input.variations.entries()) {
    const position = input.firstPosition + index;
    const ad = { creativeType: variation.creativeType, position };
    const label = input.labelOf ? input.labelOf(ad) : `v${position}`;
    const name = `${input.name} — ${label}`;
    const creativeSpec = creativeSpecOf({ ...input, name, variation, position, mediaOf });
    // Meta judges the ad with its creative inline first, creating nothing; a
    // refusal here is the same step failing, with nothing more on the platform.
    const creative = await step(
      'creative',
      `Criativo ${name}`,
      async () => {
        const checked = await writer.validateAd({
          name: `Anúncio ${name}`,
          adSetId: input.adSetId,
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
    if (!creative.ok) return creative;

    const created = await step(
      'ad',
      `Anúncio ${name}`,
      () => writer.createAd({ name, adSetId: input.adSetId, creativeId: creative.value.id }),
      (value) => value.id,
    );
    if (!created.ok) return created;
    adIds.push(created.value.id);
  }
  return { ok: true, adIds };
}

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
    /** Who clicked "executar": recorded as the form's and the funnel rule's author. */
    actorEmployeeId?: string | null;
  },
): Promise<BuildResult> {
  const { draft, prepared } = input;
  const step = stepperFor(db, input.executionId, input.startSeq);

  // 1. Media.
  const media = await uploadMedia(db, writer, step, input.adAccountId, prepared);
  if (!media.ok) return { status: 'incomplete', reason: media.reason };

  // 1b. The instant form, when the lead is captured on the ad. A form with
  // the same definition already on the Page is used again; a new one is
  // created on the Page and, the moment it exists, registered for the lead
  // intake with its funnel rule — so no lead of it falls into Formatação by
  // default, whatever happens to the steps after this one.
  let leadFormId: string | undefined;
  if (draft.leadCapture === 'instant_form' && draft.leadForm) {
    const form = draft.leadForm;
    const pageId = draft.identity.pageId;
    const name = `${draft.name} — formulário`;
    if (!isLeadFormWriter(writer)) {
      return {
        status: 'incomplete',
        reason: 'Formulário: este ambiente não cria formulários instantâneos.',
      };
    }
    const existing = await reusableLeadForm(db, { pageId, form });
    const created = await step(
      'lead_form',
      existing ? `Formulário ${existing.name} (reaproveitado)` : `Formulário ${name}`,
      () =>
        existing
          ? Promise.resolve({ status: 'created' as const, value: { id: existing.externalId } })
          : writer.createLeadForm(metaLeadFormSpecOf({ form, pageId, name })),
      (value) => value.id,
    );
    if (!created.ok) return { status: 'incomplete', reason: created.reason };
    leadFormId = created.value.id;
    await registerLeadFormIntake(db, {
      pageId,
      formExternalId: leadFormId,
      name: existing?.name ?? name,
      form,
      executionId: input.executionId,
      createdBy: input.actorEmployeeId ?? null,
    });
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

  // 3. One creative and one ad per variation, positions from 1.
  const ads = await createAds(writer, step, {
    adSetId: adSet.value.id,
    name: draft.name,
    pageId: draft.identity.pageId,
    instagramActorId: draft.identity.instagramActorId,
    destinationUrl: draft.destinationUrl,
    utms: draft.utms,
    variations: draft.variations,
    uploaded: media.uploaded,
    firstPosition: 1,
    ...(leadFormId ? { leadGenFormId: leadFormId } : {}),
  });
  if (!ads.ok) return { status: 'incomplete', reason: ads.reason };
  return {
    status: 'complete',
    adSetId: adSet.value.id,
    adIds: ads.adIds,
    ...(leadFormId ? { leadFormId } : {}),
  };
}

/**
 * New ads in an ad set that already runs (`add_ads`): media, then a creative
 * and an ad per creative, born paused. Nothing about the campaign or the ad set
 * is touched.
 */
export async function buildAdsInAdSet(
  db: Database,
  writer: AdTreeWriter,
  input: {
    executionId: string;
    adAccountId: string;
    adSetExternalId: string;
    campaignName: string;
    pageId: string;
    instagramActorId: string | null | undefined;
    destinationUrl: string;
    utms: CampaignDraft['utms'];
    variations: CopyVariation[];
    prepared: PreparedMedia;
    firstPosition: number;
  },
): Promise<BuildResult> {
  const step = stepperFor(db, input.executionId, 0);
  const media = await uploadMedia(db, writer, step, input.adAccountId, input.prepared);
  if (!media.ok) return { status: 'incomplete', reason: media.reason };
  const ads = await createAds(writer, step, {
    adSetId: input.adSetExternalId,
    name: input.campaignName,
    // Named by kind and position (video-1, imagem-2), so they never repeat the
    // names v1, v2 of the ads the campaign was created with.
    labelOf: adUtmContent,
    pageId: input.pageId,
    instagramActorId: input.instagramActorId,
    destinationUrl: input.destinationUrl,
    utms: input.utms,
    variations: input.variations,
    uploaded: media.uploaded,
    firstPosition: input.firstPosition,
  });
  if (!ads.ok) return { status: 'incomplete', reason: ads.reason };
  return { status: 'complete', adSetId: input.adSetExternalId, adIds: ads.adIds };
}
