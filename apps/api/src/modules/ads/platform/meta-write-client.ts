import { open } from 'node:fs/promises';
import { MetaApiError, MetaReadOnlyClient, type MetaClientOptions } from './meta-client.js';
import type { Cents } from './money.js';
import type {
  AdSetSpec,
  AdTreeWriter,
  CreateCampaignSpec,
  CreativeMedia,
  CreativeSpec,
  MutationOutcome,
  StepOutcome,
} from './types.js';

/**
 * Meta client that can actually change things.
 *
 * Writing is opt-in twice over: this class must be chosen deliberately *and*
 * constructed with `confirmWrites: true`. The read-only client remains the
 * default everywhere else, so no code path acquires the ability to spend money
 * by accident.
 *
 * Only the executor may use this class, and only for a change that a person
 * has approved.
 */

export interface MetaWriteClientOptions extends MetaClientOptions {
  /** Must be true. Exists so enabling writes is a visible, deliberate act. */
  confirmWrites: true;
  /** How long to wait for Meta to process a video, and how often to ask. */
  videoProcessingTimeoutMs?: number;
  videoPollIntervalMs?: number;
}

const FACEBOOK_POSITION = { feed: 'feed', stories: 'story', reels: 'facebook_reels' } as const;
const INSTAGRAM_POSITION = { feed: 'stream', stories: 'story', reels: 'reels' } as const;

/** Narrows a write failure to the step shape; `post` never reports success. */
function asStepFailure(failure: MutationOutcome): StepOutcome<never> {
  if (failure.status === 'rejected') return failure;
  if (failure.status === 'unknown') return failure;
  return { status: 'unknown', reason: 'unexpected outcome' };
}

export class MetaWriteClient extends MetaReadOnlyClient implements AdTreeWriter {
  private readonly writeToken: string;
  private readonly writeVersion: string;
  private readonly writeTimeoutMs: number;
  private readonly writeFetch: typeof fetch;
  private readonly videoProcessingTimeoutMs: number;
  private readonly videoPollIntervalMs: number;

  constructor(options: MetaWriteClientOptions) {
    super(options);
    if (options.confirmWrites !== true) {
      throw new Error('MetaWriteClient requires confirmWrites: true');
    }
    this.writeToken = options.accessToken;
    this.writeVersion = options.apiVersion ?? 'v23.0';
    this.writeTimeoutMs = options.timeoutMs ?? 20_000;
    this.writeFetch = options.fetchImpl ?? fetch;
    this.videoProcessingTimeoutMs = options.videoProcessingTimeoutMs ?? 15 * 60_000;
    this.videoPollIntervalMs = options.videoPollIntervalMs ?? 5_000;
  }

  /**
   * POSTs to the Graph API.
   *
   * A timeout or transport failure returns `unknown`, never a throw: the change
   * may well have been applied, so the caller must reconcile rather than retry.
   */
  private async post(
    path: string,
    params: Record<string, string>,
  ): Promise<MutationOutcome | null> {
    const result = await this.send(path, params);
    return 'failure' in result ? result.failure : null; // success; the caller re-reads the entity
  }

  /** As `post`, but hands back the response body — a create needs the new id. */
  private async send(
    path: string,
    params: Record<string, string> | FormData,
    timeoutMs = this.writeTimeoutMs,
  ): Promise<{ failure: MutationOutcome } | { body: string }> {
    const url = `https://graph.facebook.com/${this.writeVersion}/${path}`;
    const multipart = params instanceof FormData;

    let response: Response;
    try {
      response = await this.writeFetch(url, {
        method: 'POST',
        // For multipart, fetch sets the content type itself, boundary included.
        headers: multipart
          ? { Authorization: `Bearer ${this.writeToken}` }
          : {
              Authorization: `Bearer ${this.writeToken}`,
              'Content-Type': 'application/x-www-form-urlencoded',
            },
        body: multipart ? params : new URLSearchParams(params).toString(),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      return {
        failure: {
          status: 'unknown',
          reason: `transport failure: ${error instanceof Error ? error.name : 'unknown'}`,
        },
      };
    }

    const text = await response.text();
    if (!response.ok) {
      let parsed: { error?: { message?: string; code?: number } } = {};
      try {
        parsed = JSON.parse(text) as typeof parsed;
      } catch {
        // Non-JSON error body; fall through with the status code.
      }
      const code = parsed.error?.code ?? response.status;
      // 5xx means the request may or may not have taken effect.
      if (response.status >= 500) {
        return { failure: { status: 'unknown', reason: `platform error ${response.status}` } };
      }
      return {
        failure: {
          status: 'rejected',
          code: String(code),
          message: parsed.error?.message ?? `Meta rejected the change (${response.status})`,
        },
      };
    }

    return { body: text };
  }

  override async setDailyBudget(
    campaignId: string,
    dailyBudgetCents: Cents,
  ): Promise<MutationOutcome> {
    // Budgets are integer cents in Meta's API — verified in the Stage 1 spike.
    const failure = await this.post(campaignId, { daily_budget: String(dailyBudgetCents) });
    if (failure) return failure;

    const campaign = await this.getCampaign(campaignId);
    if (!campaign) return { status: 'unknown', reason: 'campaign unreadable after the change' };
    return { status: 'applied', campaign };
  }

  override async pauseCampaign(campaignId: string): Promise<MutationOutcome> {
    const failure = await this.post(campaignId, { status: 'PAUSED' });
    if (failure) return failure;
    const campaign = await this.getCampaign(campaignId);
    if (!campaign) return { status: 'unknown', reason: 'campaign unreadable after the change' };
    return { status: 'applied', campaign };
  }

  override async resumeCampaign(campaignId: string): Promise<MutationOutcome> {
    const failure = await this.post(campaignId, { status: 'ACTIVE' });
    if (failure) return failure;
    const campaign = await this.getCampaign(campaignId);
    if (!campaign) return { status: 'unknown', reason: 'campaign unreadable after the change' };
    return { status: 'applied', campaign };
  }

  /**
   * Creates an empty campaign — the object only, nothing under it.
   *
   * One POST, so an `unknown` outcome leaves exactly one thing to look for.
   * Without an ad set a campaign cannot deliver whatever its status, which is
   * what makes a paused one safe to use as the first real write.
   *
   * NOT yet verified against the live API: that campaign-level `daily_budget`
   * is accepted with no ad set, and the account's real minimum budget. The
   * sacrifice-campaign test is where both get answered.
   */
  override async createCampaign(spec: CreateCampaignSpec): Promise<MutationOutcome> {
    const result = await this.send(`${this.accountPath()}/campaigns`, {
      name: spec.name,
      objective: spec.objective,
      status: spec.status,
      // Required by Meta on every campaign. Franchising is none of the special
      // categories (credit, employment, housing, politics).
      special_ad_categories: '[]',
      daily_budget: String(spec.dailyBudgetCents),
      bid_strategy: 'LOWEST_COST_WITHOUT_CAP',
    });
    if ('failure' in result) return result.failure;

    let id: unknown;
    try {
      id = (JSON.parse(result.body) as { id?: unknown }).id;
    } catch {
      id = undefined;
    }
    // Meta said yes but we cannot tell what it made: it exists, id unknown.
    if (typeof id !== 'string' || id === '') {
      return { status: 'unknown', reason: 'campaign created but the response carried no id' };
    }

    const campaign = await this.getCampaign(id);
    if (!campaign) return { status: 'unknown', reason: 'campaign unreadable after creation' };
    return { status: 'applied', campaign };
  }

  // --- the rest of the tree: media, ad set, creative, ad -----------------------

  /** POSTs and reads one string field out of the answer; no id means unknown. */
  private async create(
    path: string,
    params: Record<string, string> | FormData,
    pick: (body: Record<string, unknown>) => unknown,
    timeoutMs?: number,
  ): Promise<StepOutcome<string>> {
    const result = await this.send(path, params, timeoutMs);
    if ('failure' in result) return asStepFailure(result.failure);

    let value: unknown;
    try {
      value = pick(JSON.parse(result.body) as Record<string, unknown>);
    } catch {
      value = undefined;
    }
    // Meta said yes but we cannot tell what it made: it exists, id unknown.
    if (typeof value !== 'string' || value === '') {
      return { status: 'unknown', reason: 'created, but the response carried no id' };
    }
    return { status: 'created', value };
  }

  async uploadImage(input: {
    bytes: Buffer;
    name: string;
  }): Promise<StepOutcome<{ imageHash: string }>> {
    const outcome = await this.create(
      `${this.accountPath()}/adimages`,
      { bytes: input.bytes.toString('base64'), name: input.name },
      (body) => {
        const images = (body.images ?? {}) as Record<string, { hash?: string }>;
        return Object.values(images)[0]?.hash;
      },
      // A few megabytes of base64 can take longer than a field update.
      60_000,
    );
    return outcome.status === 'created'
      ? { status: 'created', value: { imageHash: outcome.value } }
      : outcome;
  }

  /**
   * Meta's chunked upload: start, transfer until the offsets meet, finish —
   * then wait for processing, because an ad cannot use a video that is not
   * ready. The file is read a chunk at a time; 4 GB never sits in memory.
   *
   * Once `start` has answered, a video object exists on Meta. Any failure
   * after that is therefore `unknown`, never `rejected`.
   */
  async uploadVideo(input: {
    filePath: string;
    byteSize: number;
    name: string;
  }): Promise<StepOutcome<{ videoId: string; thumbnailUrl: string }>> {
    const path = `${this.accountPath()}/advideos`;
    const started = await this.send(path, {
      upload_phase: 'start',
      file_size: String(input.byteSize),
    });
    if ('failure' in started) return asStepFailure(started.failure);

    let session: {
      upload_session_id?: string;
      video_id?: string;
      start_offset?: string;
      end_offset?: string;
    };
    try {
      session = JSON.parse(started.body) as typeof session;
    } catch {
      session = {};
    }
    const { upload_session_id: sessionId, video_id: videoId } = session;
    if (!sessionId || !videoId) {
      return { status: 'unknown', reason: 'video upload started, but Meta sent no session' };
    }
    const orphan = (reason: string): StepOutcome<never> => ({
      status: 'unknown',
      reason: `${reason} (vídeo ${videoId} já existe na Meta)`,
    });

    const file = await open(input.filePath, 'r');
    try {
      let start = Number(session.start_offset ?? 0);
      let end = Number(session.end_offset ?? 0);
      // Bounded: a server that never advances the offsets must not loop forever.
      for (let round = 0; start < end && round < 10_000; round += 1) {
        const chunk = Buffer.alloc(end - start);
        await file.read(chunk, 0, chunk.length, start);

        const form = new FormData();
        form.set('upload_phase', 'transfer');
        form.set('upload_session_id', sessionId);
        form.set('start_offset', String(start));
        form.set('video_file_chunk', new Blob([chunk]), 'chunk');
        const sent = await this.send(path, form, 5 * 60_000);
        if ('failure' in sent) return orphan('falha ao enviar um bloco do vídeo');

        let next: { start_offset?: string; end_offset?: string };
        try {
          next = JSON.parse(sent.body) as typeof next;
        } catch {
          return orphan('resposta ilegível ao enviar um bloco do vídeo');
        }
        const nextStart = Number(next.start_offset);
        if (!Number.isFinite(nextStart) || nextStart <= start) {
          return orphan('a Meta não avançou o envio do vídeo');
        }
        start = nextStart;
        end = Number(next.end_offset);
      }
      if (start < end) return orphan('envio do vídeo não terminou');
    } finally {
      await file.close();
    }

    const finished = await this.send(path, {
      upload_phase: 'finish',
      upload_session_id: sessionId,
      title: input.name,
    });
    if ('failure' in finished) return orphan('falha ao concluir o envio do vídeo');

    // Processing. Reads only, but the video is already there: still `unknown`.
    const deadline = Date.now() + this.videoProcessingTimeoutMs;
    for (;;) {
      let status: string | undefined;
      try {
        const body = await this.get<{ status?: { video_status?: string } }>(videoId, {
          fields: 'status',
        });
        status = body.status?.video_status;
      } catch {
        return orphan('não foi possível ler o processamento do vídeo');
      }
      if (status === 'ready') break;
      if (status === 'error') return orphan('a Meta não conseguiu processar o vídeo');
      if (Date.now() >= deadline) return orphan('o processamento do vídeo não terminou a tempo');
      await new Promise((resolve) => setTimeout(resolve, this.videoPollIntervalMs));
    }

    // A video ad needs a still; Meta generates them during processing.
    try {
      const thumbnails = await this.get<{ data?: { uri?: string; is_preferred?: boolean }[] }>(
        `${videoId}/thumbnails`,
      );
      const rows = thumbnails.data ?? [];
      const thumbnailUrl = (rows.find((row) => row.is_preferred) ?? rows[0])?.uri;
      if (!thumbnailUrl) return orphan('a Meta não gerou uma capa para o vídeo');
      return { status: 'created', value: { videoId, thumbnailUrl } };
    } catch {
      return orphan('não foi possível ler a capa do vídeo');
    }
  }

  /**
   * One ad set, PAUSED, under a campaign that owns the budget (CBO) — so no
   * budget here. `advantage_audience: 0` keeps the age range a limit rather
   * than a suggestion. Omitting every placement field is what Advantage+
   * placements means.
   */
  async createAdSet(spec: AdSetSpec): Promise<StepOutcome<{ id: string }>> {
    const targeting: Record<string, unknown> = {
      geo_locations: metaGeoLocations(spec.targeting, spec.customLocations),
      age_min: spec.ageMin,
      age_max: spec.ageMax,
      locales: [spec.targeting.localeKey],
      targeting_automation: { advantage_audience: 0 },
    };
    if (spec.placements) {
      const publishers = [
        ...(spec.placements.facebook.length > 0 ? ['facebook'] : []),
        ...(spec.placements.instagram.length > 0 ? ['instagram'] : []),
      ];
      targeting.publisher_platforms = publishers;
      if (spec.placements.facebook.length > 0) {
        targeting.facebook_positions = spec.placements.facebook.map((p) => FACEBOOK_POSITION[p]);
      }
      if (spec.placements.instagram.length > 0) {
        targeting.instagram_positions = spec.placements.instagram.map((p) => INSTAGRAM_POSITION[p]);
      }
    }

    const outcome = await this.create(
      `${this.accountPath()}/adsets`,
      {
        name: spec.name,
        campaign_id: spec.campaignId,
        status: 'PAUSED',
        billing_event: 'IMPRESSIONS',
        optimization_goal: spec.optimization.goal,
        destination_type: 'WEBSITE',
        ...(spec.optimization.goal === 'OFFSITE_CONVERSIONS'
          ? {
              promoted_object: JSON.stringify({
                pixel_id: spec.optimization.pixelId,
                custom_event_type: spec.optimization.event,
              }),
            }
          : {}),
        targeting: JSON.stringify(targeting),
        // The account runs on America/Sao_Paulo, which has no daylight saving.
        start_time: `${spec.startDate}T00:00:00-0300`,
        end_time: `${spec.endDate}T23:59:59-0300`,
      },
      (body) => body.id,
    );
    return outcome.status === 'created'
      ? { status: 'created', value: { id: outcome.value } }
      : outcome;
  }

  async createCreative(spec: CreativeSpec): Promise<StepOutcome<{ id: string }>> {
    const callToAction = (link: string) => ({ type: spec.callToAction, value: { link } });
    const mediaFields = (media: CreativeMedia) =>
      media.kind === 'image'
        ? { image_hash: media.imageHash }
        : { video_id: media.videoId, picture: media.thumbnailUrl };

    let story: Record<string, unknown>;
    if (spec.body.type === 'carousel') {
      story = {
        link_data: {
          link: spec.link,
          message: spec.message,
          name: spec.headline,
          call_to_action: callToAction(spec.link),
          // Cards stay in the order the approver saw them.
          multi_share_optimized: false,
          child_attachments: spec.body.cards.map((card) => ({
            link: card.link,
            name: card.headline,
            description: card.description,
            call_to_action: callToAction(card.link),
            ...mediaFields(card.media),
          })),
        },
      };
    } else if (spec.body.media.kind === 'video') {
      story = {
        video_data: {
          video_id: spec.body.media.videoId,
          image_url: spec.body.media.thumbnailUrl,
          title: spec.headline,
          message: spec.message,
          call_to_action: callToAction(spec.link),
        },
      };
    } else {
      story = {
        link_data: {
          link: spec.link,
          message: spec.message,
          name: spec.headline,
          image_hash: spec.body.media.imageHash,
          call_to_action: callToAction(spec.link),
        },
      };
    }

    const outcome = await this.create(
      `${this.accountPath()}/adcreatives`,
      {
        name: spec.name,
        object_story_spec: JSON.stringify({
          page_id: spec.pageId,
          // `instagram_actor_id` was retired in v22; this is its replacement.
          ...(spec.instagramUserId ? { instagram_user_id: spec.instagramUserId } : {}),
          ...story,
        }),
      },
      (body) => body.id,
    );
    return outcome.status === 'created'
      ? { status: 'created', value: { id: outcome.value } }
      : outcome;
  }

  async createAd(spec: {
    name: string;
    adSetId: string;
    creativeId: string;
  }): Promise<StepOutcome<{ id: string }>> {
    const outcome = await this.create(
      `${this.accountPath()}/ads`,
      {
        name: spec.name,
        adset_id: spec.adSetId,
        creative: JSON.stringify({ creative_id: spec.creativeId }),
        status: 'PAUSED',
      },
      (body) => body.id,
    );
    return outcome.status === 'created'
      ? { status: 'created', value: { id: outcome.value } }
      : outcome;
  }

  override async setAccountSpendCap(
    capCents: Cents,
  ): Promise<{ status: 'applied' | 'rejected'; message?: string }> {
    const accountPath = this.accountPath();
    const failure = await this.post(accountPath, { spend_cap: String(capCents) });
    if (!failure) return { status: 'applied' };
    if (failure.status === 'rejected') return { status: 'rejected', message: failure.message };
    return { status: 'rejected', message: 'resultado desconhecido; verifique na plataforma' };
  }

  /** The account path, exposed by the base class for reuse here. */
  private accountPath(): string {
    return this.adAccountPath;
  }
}

export { MetaApiError };

/**
 * Meta's translation of a draft's reach: states are `regions`, cities are
 * `cities` (both by the keys Meta resolved them to) and each radius is a
 * `custom_locations` entry in kilometres. Google's counterpart is
 * `googleLocationCriteria`; a new platform brings its own.
 */
export function metaGeoLocations(
  resolved: Pick<AdSetSpec['targeting'], 'regions' | 'cities'>,
  radii: AdSetSpec['customLocations'],
): Record<string, unknown> {
  return {
    ...(resolved.regions.length > 0
      ? { regions: resolved.regions.map((region) => ({ key: region.key })) }
      : {}),
    ...(resolved.cities.length > 0
      ? { cities: resolved.cities.map((city) => ({ key: city.key })) }
      : {}),
    ...(radii.length > 0
      ? {
          custom_locations: radii.map((location) => ({
            latitude: location.latitude,
            longitude: location.longitude,
            radius: location.radiusKm,
            distance_unit: 'kilometer',
          })),
        }
      : {}),
    location_types: ['home', 'recent'],
  };
}
