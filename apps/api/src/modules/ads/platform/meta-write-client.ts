import { open } from 'node:fs/promises';
import { MetaApiError, MetaReadOnlyClient, type MetaClientOptions } from './meta-client.js';
import type { Cents } from './money.js';
import type {
  AdSetSpec,
  AdTreeWriter,
  CreateCampaignSpec,
  CreativeMedia,
  CreativeSpec,
  LeadFormWriter,
  MetaLeadFormSpec,
  MutationOutcome,
  ResumeCompanions,
  StepOutcome,
  UploadedVideo,
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
/** Threads only has one placement on the Marketing API (`threads_stream`). */
const THREADS_POSITION = { feed: 'threads_stream' } as const;

/** Narrows a write failure to the step shape; `post` never reports success. */
function asStepFailure(failure: MutationOutcome): StepOutcome<never> {
  if (failure.status === 'rejected') return failure;
  if (failure.status === 'unknown') return failure;
  return { status: 'unknown', reason: 'unexpected outcome' };
}

export class MetaWriteClient extends MetaReadOnlyClient implements AdTreeWriter, LeadFormWriter {
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
    /** A Page token for the one edge that needs it (`leadgen_forms`); the account token otherwise. */
    token = this.writeToken,
  ): Promise<{ failure: MutationOutcome } | { body: string }> {
    const url = `https://graph.facebook.com/${this.writeVersion}/${path}`;
    const multipart = params instanceof FormData;

    let response: Response;
    try {
      response = await this.writeFetch(url, {
        method: 'POST',
        // For multipart, fetch sets the content type itself, boundary included.
        headers: multipart
          ? { Authorization: `Bearer ${token}` }
          : {
              Authorization: `Bearer ${token}`,
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
      let parsed: {
        error?: {
          message?: string;
          code?: number;
          error_subcode?: number;
          error_user_title?: string;
          error_user_msg?: string;
          fbtrace_id?: string;
        };
      } = {};
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
      // Everything Meta says about why, kept: "100: Invalid parameter" alone
      // once left a failed creative with nothing to diagnose (2026-09-25).
      const error = parsed.error ?? {};
      const detail: Record<string, unknown> = {
        ...(error.error_subcode !== undefined ? { subcode: error.error_subcode } : {}),
        ...(error.error_user_title ? { userTitle: error.error_user_title } : {}),
        ...(error.error_user_msg ? { userMessage: error.error_user_msg } : {}),
        ...(error.fbtrace_id ? { fbtraceId: error.fbtrace_id } : {}),
      };
      const parts = [error.message ?? `Meta rejected the change (${response.status})`];
      if (error.error_user_title || error.error_user_msg) {
        parts.push([error.error_user_title, error.error_user_msg].filter(Boolean).join(': '));
      }
      const tags = [
        ...(error.error_subcode !== undefined ? [`subcode ${error.error_subcode}`] : []),
        ...(error.fbtrace_id ? [`fbtrace ${error.fbtrace_id}`] : []),
      ];
      return {
        failure: {
          status: 'rejected',
          code: String(code),
          message: `${parts.join(' — ')}${tags.length > 0 ? ` [${tags.join(', ')}]` : ''}`,
          ...(Object.keys(detail).length > 0 ? { detail } : {}),
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

  /**
   * Switches the campaign on together with the ad sets and ads this system
   * created paused under it (`enableWith`, from the create_campaign's own
   * execution steps; nothing a person made by hand is ever listed).
   *
   * Meta has no transaction, so the order is what keeps a half-done resume
   * harmless: ads first, then ad sets, the campaign last. Until the campaign
   * is ACTIVE nothing delivers, so a failure part-way leaves the children on
   * under a paused campaign and nothing spending. Afterwards every object is
   * read back and its status kept (`statusesAfter`) for the approval screen,
   * like the Google client does.
   */
  override async resumeCampaign(
    campaignId: string,
    enableWith?: ResumeCompanions,
  ): Promise<MutationOutcome> {
    const children = [
      ...(enableWith?.adIds ?? []).map((id) => ({ kind: 'ad' as const, id })),
      ...(enableWith?.adGroupIds ?? []).map((id) => ({ kind: 'adSet' as const, id })),
    ].filter((child) => /^\d+$/.test(child.id));
    const enabled: string[] = [];

    for (const child of children) {
      const failure = await this.post(child.id, { status: 'ACTIVE' });
      if (failure) {
        const note = `${child.kind} ${child.id}: a campanha não foi ligada (${enabled.length} objeto(s) já ligados sob ela, sem entregar)`;
        if (failure.status === 'rejected') {
          return {
            ...failure,
            message: `${failure.message} — ${note}`,
            detail: { ...(failure.detail ?? {}), enabledBeforeFailure: enabled },
          };
        }
        if (failure.status === 'unknown')
          return { ...failure, reason: `${failure.reason} — ${note}` };
        return failure;
      }
      enabled.push(`${child.kind}:${child.id}`);
    }

    const failure = await this.post(campaignId, { status: 'ACTIVE' });
    if (failure) return failure;
    const campaign = await this.getCampaign(campaignId);
    if (!campaign) return { status: 'unknown', reason: 'campaign unreadable after the change' };
    if (children.length === 0) return { status: 'applied', campaign };
    return {
      status: 'applied',
      campaign,
      detail: { enabled, statusesAfter: await this.statusesOf(children) },
    };
  }

  /** Each object's status as Meta reports it now; a read that fails says so instead of guessing. */
  private async statusesOf(
    objects: { kind: 'ad' | 'adSet'; id: string }[],
  ): Promise<Record<string, string>> {
    const statuses: Record<string, string> = {};
    for (const object of objects) {
      try {
        const read = await this.get<{ status?: string; effective_status?: string }>(object.id, {
          fields: 'status,effective_status',
        });
        statuses[`${object.kind}:${object.id}`] = read.effective_status ?? read.status ?? '?';
      } catch {
        statuses[`${object.kind}:${object.id}`] = 'ilegível';
      }
    }
    return statuses;
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
    token?: string,
  ): Promise<StepOutcome<string>> {
    const result = await this.send(path, params, timeoutMs, token);
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
  }): Promise<StepOutcome<UploadedVideo>> {
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

    // A video ad needs a still; Meta generates them during processing. The
    // still becomes an ad image of its own (see `videoStill`).
    const still = await this.videoStill(videoId, input.name);
    if (still.status !== 'created') {
      return orphan(still.status === 'rejected' ? still.message : still.reason);
    }
    return { status: 'created', value: { videoId, ...still.value } };
  }

  /**
   * A video already in the account, put there by an earlier execution. Reads
   * that Meta still has it and that it is ready, then makes its still an ad
   * image (the same bytes give the same hash, so nothing is duplicated).
   */
  async reuseVideo(videoId: string, name: string): Promise<StepOutcome<UploadedVideo>> {
    let status: string | undefined;
    try {
      const body = await this.get<{ status?: { video_status?: string } }>(videoId, {
        fields: 'status',
      });
      status = body.status?.video_status;
    } catch {
      return {
        status: 'rejected',
        code: 'video_unreadable',
        message: `O vídeo ${videoId} não pôde ser lido na Meta.`,
      };
    }
    if (status !== 'ready') {
      return {
        status: 'rejected',
        code: 'video_not_ready',
        message: `O vídeo ${videoId} não está pronto na Meta (${status ?? 'sem status'}).`,
      };
    }
    const still = await this.videoStill(videoId, name);
    if (still.status !== 'created') return still;
    return { status: 'created', value: { videoId, ...still.value } };
  }

  /**
   * The video's preferred thumbnail, downloaded and uploaded as an ad image.
   * Meta's signed CDN address was refused as `video_data.image_url` on the
   * first real write ("100: Invalid parameter", 2026-09-25); an `image_hash`
   * from `adimages` is the documented, stable way to give a video ad its
   * picture.
   */
  private async videoStill(
    videoId: string,
    name: string,
  ): Promise<StepOutcome<{ thumbnailUrl: string; imageHash: string }>> {
    let thumbnailUrl: string | undefined;
    try {
      const thumbnails = await this.get<{ data?: { uri?: string; is_preferred?: boolean }[] }>(
        `${videoId}/thumbnails`,
      );
      const rows = thumbnails.data ?? [];
      thumbnailUrl = (rows.find((row) => row.is_preferred) ?? rows[0])?.uri;
    } catch {
      return { status: 'unknown', reason: 'não foi possível ler a capa do vídeo' };
    }
    if (!thumbnailUrl) {
      return { status: 'unknown', reason: 'a Meta não gerou uma capa para o vídeo' };
    }

    let bytes: Buffer;
    try {
      const response = await this.writeFetch(thumbnailUrl, {
        signal: AbortSignal.timeout(this.writeTimeoutMs),
      });
      if (!response.ok) {
        return {
          status: 'unknown',
          reason: `a capa do vídeo não pôde ser baixada (${response.status})`,
        };
      }
      bytes = Buffer.from(await response.arrayBuffer());
    } catch {
      return { status: 'unknown', reason: 'a capa do vídeo não pôde ser baixada' };
    }
    if (bytes.length === 0) return { status: 'unknown', reason: 'a capa do vídeo veio vazia' };

    const image = await this.uploadImage({ bytes, name: `${name}-capa.jpg` });
    if (image.status !== 'created') return image;
    return { status: 'created', value: { thumbnailUrl, imageHash: image.value.imageHash } };
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
        ...(spec.placements.threads.length > 0 ? ['threads'] : []),
      ];
      targeting.publisher_platforms = publishers;
      if (spec.placements.facebook.length > 0) {
        targeting.facebook_positions = spec.placements.facebook.map((p) => FACEBOOK_POSITION[p]);
      }
      if (spec.placements.instagram.length > 0) {
        targeting.instagram_positions = spec.placements.instagram.map((p) => INSTAGRAM_POSITION[p]);
      }
      if (spec.placements.threads.length > 0) {
        targeting.threads_positions = spec.placements.threads.map((p) => THREADS_POSITION[p]);
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
        // Lead Ads: the form is on the ad itself; the promoted object is the Page.
        destination_type: spec.optimization.goal === 'LEAD_GENERATION' ? 'ON_AD' : 'WEBSITE',
        ...(spec.optimization.goal === 'OFFSITE_CONVERSIONS'
          ? {
              promoted_object: JSON.stringify({
                pixel_id: spec.optimization.pixelId,
                custom_event_type: spec.optimization.event,
              }),
            }
          : spec.optimization.goal === 'LEAD_GENERATION'
            ? { promoted_object: JSON.stringify({ page_id: spec.optimization.pageId }) }
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

  /**
   * Meta's own check of an ad with its creative inline and nothing created
   * (`execution_options: ["validate_only"]`): the creative's fields, the
   * page, the Instagram account and the media are all judged here, before the
   * creative is written. NOT yet verified against the live API: that a refused
   * creative answers here with the same error it would give on the write.
   */
  async validateAd(spec: {
    name: string;
    adSetId: string;
    creative: CreativeSpec;
  }): Promise<StepOutcome<true>> {
    const result = await this.send(`${this.accountPath()}/ads`, {
      name: spec.name,
      adset_id: spec.adSetId,
      status: 'PAUSED',
      creative: JSON.stringify({
        name: spec.creative.name,
        object_story_spec: this.objectStorySpec(spec.creative),
        url_tags: spec.creative.urlTags,
      }),
      execution_options: '["validate_only"]',
    });
    if ('failure' in result) return asStepFailure(result.failure);
    return { status: 'created', value: true };
  }

  private objectStorySpec(spec: CreativeSpec): Record<string, unknown> {
    // Lead Ads: the button opens the instant form, not a link. NOT verified live.
    const callToAction = (link: string) =>
      spec.leadGenFormId
        ? { type: spec.callToAction, value: { lead_gen_form_id: spec.leadGenFormId } }
        : { type: spec.callToAction, value: { link } };
    // A video's picture is the ad image made from its still, never the CDN
    // address (refused live on 2026-09-25). Carousel video cards: NOT verified live.
    const mediaFields = (media: CreativeMedia) =>
      media.kind === 'image'
        ? { image_hash: media.imageHash }
        : { video_id: media.videoId, image_hash: media.imageHash };

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
          image_hash: spec.body.media.imageHash,
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

    return {
      page_id: spec.pageId,
      // `instagram_actor_id` was retired in v22; this is its replacement.
      ...(spec.instagramUserId ? { instagram_user_id: spec.instagramUserId } : {}),
      ...story,
    };
  }

  async createCreative(spec: CreativeSpec): Promise<StepOutcome<{ id: string }>> {
    const outcome = await this.create(
      `${this.accountPath()}/adcreatives`,
      {
        name: spec.name,
        object_story_spec: JSON.stringify(this.objectStorySpec(spec)),
        // Meta appends these to every link of the ad, carousel cards included.
        url_tags: spec.urlTags,
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

  /**
   * The instant form, on the Page: `POST /{page_id}/leadgen_forms` with the
   * Page's own token, read from the Page with the account token and used for
   * this one call. The token is never stored, logged or returned. A system
   * user without `pages_manage_ads` on the Page gets `rejected` here, before
   * anything is written.
   *
   * NOT yet verified against the live API (2026-10-06).
   */
  async createLeadForm(spec: MetaLeadFormSpec): Promise<StepOutcome<{ id: string }>> {
    const access = await this.pageToken(spec.pageId);
    if (!access.token) {
      return {
        status: 'rejected',
        code: access.reason ?? 'no_page_token',
        message:
          'O token não administra a Página: falta pages_manage_ads (e a Página como ativo do usuário de sistema).',
      };
    }
    const outcome = await this.create(
      `${spec.pageId}/leadgen_forms`,
      {
        name: spec.name,
        locale: spec.locale,
        questions: JSON.stringify(
          spec.questions.map((question) =>
            question.type === 'CUSTOM'
              ? {
                  type: 'CUSTOM',
                  key: question.key,
                  label: question.label,
                  ...(question.options ? { options: question.options } : {}),
                }
              : { type: question.type, key: question.key },
          ),
        ),
        privacy_policy: JSON.stringify({
          url: spec.privacyPolicy.url,
          link_text: spec.privacyPolicy.linkText,
        }),
        thank_you_page: JSON.stringify({
          title: spec.thankYou.title,
          body: spec.thankYou.body,
          button_type: 'VIEW_WEBSITE',
          button_text: spec.thankYou.buttonText,
          website_url: spec.thankYou.buttonUrl,
        }),
      },
      (body) => body.id,
      this.writeTimeoutMs,
      access.token,
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
