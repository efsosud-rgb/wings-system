import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  DEFAULT_KAIROGEN_PLAN,
  KAIROGEN_PLANS,
  MAX_IMAGES_PER_GENERATION,
  MAX_VIDEOS_PER_GENERATION,
  MEDIA_REFUSAL_MESSAGE,
  type KairogenPlan,
  type MediaEstimate,
  type MediaEstimateRequest,
  type MediaGeneration,
  type MediaModel,
  type MediaRefusal,
  type MediaUsage,
} from '@wings/shared';
import { and, desc, eq, gte, inArray, lte, sql } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import {
  employees,
  integrationConnections,
  mediaAssets,
  mediaCreditLedger,
  mediaGenerations,
  mediaPublicLinks,
} from '../../db/schema/index.js';
import type { Env } from '../../env.js';
import { McpError } from '../../lib/mcp-client/index.js';
import { scrubSensitive } from '../agent/scrub.js';
import {
  callKairogen,
  creditsFrom,
  kairogenDepsOf,
  PROVIDER,
  type KairogenDeps,
} from '../integrations/kairogen/service.js';
import {
  creditCostFrom,
  generationIdFrom,
  generationStateFrom,
  isCreditMismatch,
  modelsFrom,
} from './kairogen-adapter.js';
import { mediaDirOf, storeMedia } from './library.js';

/**
 * Spending Kairogen credits, and everything that keeps it honest.
 *
 * The order of things is fixed: estimate (Kairogen says the price) → a person
 * clicks → ceilings and balance are checked → the ledger records the spend →
 * only then is Kairogen called, ONCE, with `expected_credits` so that it
 * refuses if the charge would differ → the server polls until the files are in
 * the library. No step is skipped and none is repeated on its own.
 */

const ESTIMATE_TTL_MS = 10 * 60_000;
const LINK_TTL_MS = 15 * 60_000;
const MODEL_CACHE_MS = 60 * 60_000;
const GIVE_UP_AFTER_MS = 20 * 60_000;
const FIRST_POLL_MS = 5_000;
const MAX_POLL_MS = 30_000;
const DEFAULT_ANIMATION_MODEL = 'seedance-v2-0-image-to-video';
const MAX_DOWNLOAD_BYTES = 150 * 1024 * 1024;

export interface StudioDeps {
  db: Database;
  kairogen: KairogenDeps | null;
  mediaDir: string | null;
  dailyPerUser: number;
  monthly: number;
  /** Where Kairogen can reach this API: APP_BASE_URL + /api. */
  publicApiBase: string;
  linkKey: Buffer | null;
  /** Downloads of finished outputs. Tests hand in the fake's. */
  fetch: typeof fetch;
  /** False in tests: generations move only when somebody calls `advanceGeneration`. */
  autoPoll: boolean;
  now: () => Date;
}

export function studioDepsOf(wings: {
  db: Database;
  env: Env;
  kairogenFetch?: typeof fetch;
}): StudioDeps {
  const key = wings.env.INTEGRATIONS_ENCRYPTION_KEY;
  return {
    db: wings.db,
    kairogen: kairogenDepsOf(wings),
    mediaDir: mediaDirOf(wings.env),
    dailyPerUser: wings.env.KAIROGEN_DAILY_CREDITS_PER_USER,
    monthly: wings.env.KAIROGEN_MONTHLY_CREDITS,
    publicApiBase: `${wings.env.APP_BASE_URL}/api`,
    // A key of its own, derived: signing links never reuses the key that encrypts tokens.
    linkKey: key
      ? createHmac('sha256', Buffer.from(key, 'base64')).update('wings-media-public-link').digest()
      : null,
    fetch: wings.kairogenFetch ?? fetch,
    autoPoll: wings.env.NODE_ENV !== 'test',
    now: () => new Date(),
  };
}

export class StudioRefusal extends Error {
  constructor(
    readonly code:
      MediaRefusal | 'invalid_request' | 'cannot_estimate' | 'not_found' | 'kairogen_unavailable',
    message: string,
  ) {
    super(message);
    this.name = 'StudioRefusal';
  }
}
const refuse = (code: MediaRefusal) => new StudioRefusal(code, MEDIA_REFUSAL_MESSAGE[code]);

function connected(deps: StudioDeps): KairogenDeps {
  if (!deps.kairogen) throw refuse('not_connected');
  return deps.kairogen;
}

/** Kairogen said something went wrong: what that means for the person, never its raw words as orders. */
function fromMcp(error: unknown): StudioRefusal {
  if (error instanceof McpError && error.code === 'unauthorized') return refuse('not_connected');
  if (error instanceof McpError) {
    return new StudioRefusal(
      'kairogen_unavailable',
      'O Kairogen não respondeu agora. Tente em instantes.',
    );
  }
  throw error;
}

// ---------------------------------------------------------------------------
// Plan, catalog, usage
// ---------------------------------------------------------------------------

export async function planOf(db: Database): Promise<KairogenPlan> {
  const row = await db.query.integrationConnections.findFirst({
    where: eq(integrationConnections.provider, PROVIDER),
  });
  const plan = row?.plan as KairogenPlan | undefined;
  return plan && KAIROGEN_PLANS.includes(plan) ? plan : DEFAULT_KAIROGEN_PLAN;
}

export async function setPlan(db: Database, plan: KairogenPlan, now: Date): Promise<void> {
  await db
    .insert(integrationConnections)
    .values({ provider: PROVIDER, plan, updatedAt: now })
    .onConflictDoUpdate({
      target: [integrationConnections.tenantId, integrationConnections.provider],
      set: { plan, updatedAt: now },
    });
  modelCache.clear();
}

const modelCache = new Map<string, { at: number; models: MediaModel[] }>();
export const clearModelCache = () => modelCache.clear();

/** The live catalog, kept for an hour per plan: prices are per plan. */
export async function listModels(
  deps: StudioDeps,
): Promise<{ models: MediaModel[]; cachedAt: string }> {
  const kairogen = connected(deps);
  const plan = await planOf(deps.db);
  const now = deps.now().getTime();
  const cached = modelCache.get(plan);
  if (cached && now - cached.at < MODEL_CACHE_MS) {
    return { models: cached.models, cachedAt: new Date(cached.at).toISOString() };
  }
  try {
    const models = modelsFrom(await callKairogen(kairogen, 'list_models', {}), plan);
    modelCache.set(plan, { at: now, models });
    return { models, cachedAt: new Date(now).toISOString() };
  } catch (error) {
    throw fromMcp(error);
  }
}

/** Midnight today, and the first of this month, in São Paulo (UTC-3 all year since 2019). */
function periodStarts(now: Date): { day: Date; month: Date } {
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(now);
  return {
    day: new Date(`${day}T00:00:00-03:00`),
    month: new Date(`${day.slice(0, 7)}-01T00:00:00-03:00`),
  };
}

async function creditsCounted(db: Database, since: Date, employeeId?: string): Promise<number> {
  const [row] = await db
    .select({ total: sql<string>`coalesce(sum(${mediaCreditLedger.creditsDelta}), 0)` })
    .from(mediaCreditLedger)
    .where(
      and(
        gte(mediaCreditLedger.createdAt, since),
        employeeId ? eq(mediaCreditLedger.employeeId, employeeId) : undefined,
      ),
    );
  return Number(row?.total ?? 0);
}

export async function usageOf(
  deps: StudioDeps,
  employeeId: string,
  options: { withBalance?: boolean } = {},
): Promise<MediaUsage> {
  const starts = periodStarts(deps.now());
  let balance: number | null = null;
  if (options.withBalance !== false && deps.kairogen) {
    try {
      balance = creditsFrom(await callKairogen(deps.kairogen, 'get_credits'), deps.now()).balance;
    } catch (error) {
      if (!(error instanceof McpError)) throw error;
    }
  }
  return {
    plan: await planOf(deps.db),
    balance,
    usedTodayByYou: await creditsCounted(deps.db, starts.day, employeeId),
    dailyLimitPerUser: deps.dailyPerUser,
    usedThisMonth: await creditsCounted(deps.db, starts.month),
    monthlyLimit: deps.monthly,
  };
}

function blockedBy(usage: MediaUsage, credits: number): MediaRefusal | null {
  if (usage.usedTodayByYou + credits > usage.dailyLimitPerUser) return 'daily_limit';
  if (usage.usedThisMonth + credits > usage.monthlyLimit) return 'monthly_limit';
  if (usage.balance !== null && usage.balance < credits) return 'insufficient_credits';
  return null;
}

// ---------------------------------------------------------------------------
// Signed public links
// ---------------------------------------------------------------------------

const sign = (key: Buffer, linkId: string, assetId: string, expiresAt: Date) =>
  createHmac('sha256', key)
    .update(`${linkId}.${assetId}.${expiresAt.getTime()}`)
    .digest('base64url');

/**
 * A public address for ONE asset, good for fifteen minutes, so that Kairogen
 * can read a reference image. Every link issued leaves a row; the address
 * carries an id and a signature, never a path on the volume.
 */
export async function issuePublicLink(
  deps: StudioDeps,
  input: { assetId: string; issuedBy: string; generationId: string | null; purpose: string },
): Promise<string> {
  if (!deps.linkKey) throw refuse('not_connected');
  const expiresAt = new Date(deps.now().getTime() + LINK_TTL_MS);
  const [row] = await deps.db
    .insert(mediaPublicLinks)
    .values({ ...input, expiresAt, createdAt: deps.now() })
    .returning({ id: mediaPublicLinks.id });
  if (!row) throw new Error('failed to record public link');
  return `${deps.publicApiBase}/media/public/${row.id}?sig=${sign(deps.linkKey, row.id, input.assetId, expiresAt)}`;
}

/** The asset a link points at, when the signature holds and the fifteen minutes have not passed. */
export async function resolvePublicLink(deps: StudioDeps, linkId: string, signature: string) {
  if (!deps.linkKey) return null;
  const [row] = await deps.db
    .select({ link: mediaPublicLinks, asset: mediaAssets })
    .from(mediaPublicLinks)
    .innerJoin(mediaAssets, eq(mediaAssets.id, mediaPublicLinks.assetId))
    .where(eq(mediaPublicLinks.id, linkId));
  if (!row || row.link.expiresAt <= deps.now()) return null;
  const expected = Buffer.from(
    sign(deps.linkKey, row.link.id, row.link.assetId, row.link.expiresAt),
  );
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  return row.asset;
}

// ---------------------------------------------------------------------------
// Estimating
// ---------------------------------------------------------------------------

type GenerationRow = typeof mediaGenerations.$inferSelect;

async function ledger(
  db: Database,
  row: GenerationRow,
  event: string,
  values: { creditsDelta: number; creditsCharged?: number | null; now: Date },
): Promise<void> {
  await db.insert(mediaCreditLedger).values({
    generationId: row.id,
    employeeId: row.requestedBy,
    event,
    operation: row.operation,
    model: row.model,
    prompt: row.prompt,
    params: row.priceArgs,
    creditsEstimated: row.creditsEstimated,
    creditsCharged: values.creditsCharged ?? row.creditsCharged,
    creditsDelta: values.creditsDelta,
    externalGenerationId: row.externalGenerationId,
    createdAt: values.now,
  });
}

function requireDuration(model: MediaModel, duration: number | undefined): void {
  if (duration === undefined) return;
  if (!model.supportedDurations.includes(duration)) {
    throw new StudioRefusal(
      'invalid_request',
      model.supportedDurations.length > 0
        ? `Este modelo só gera vídeos de ${model.supportedDurations.join(', ')} segundos.`
        : 'Este modelo não informa durações. Deixe a duração em branco.',
    );
  }
}

interface Resolved {
  kind: 'image' | 'video';
  model: string | null;
  prompt: string | null;
  sourceAssetId: string | null;
  /** What estimate_cost is asked: the price-affecting arguments and nothing else. */
  priceArgs: Record<string, unknown>;
}

async function resolve(deps: StudioDeps, request: MediaEstimateRequest): Promise<Resolved> {
  const plan = await planOf(deps.db);
  const { models } = await listModels(deps);
  const assetOf = async (id: string) => {
    const asset = await deps.db.query.mediaAssets.findFirst({ where: eq(mediaAssets.id, id) });
    if (!asset) throw new StudioRefusal('not_found', 'Mídia não encontrada na biblioteca.');
    return asset;
  };

  if (request.operation === 'generate') {
    const model = models.find((item) => item.key === request.model && item.kind === request.kind);
    if (!model)
      throw new StudioRefusal('invalid_request', 'Modelo não encontrado no catálogo do Kairogen.');
    const cap = request.kind === 'video' ? MAX_VIDEOS_PER_GENERATION : MAX_IMAGES_PER_GENERATION;
    if (request.quantity > cap) {
      throw new StudioRefusal('invalid_request', `No máximo ${cap} por geração.`);
    }
    if (model.aspectRatios && !model.aspectRatios.includes(request.aspect)) {
      throw new StudioRefusal(
        'invalid_request',
        `Este modelo não gera no formato ${request.aspect}.`,
      );
    }
    if (request.kind === 'video') requireDuration(model, request.durationSeconds);
    for (const [key, value] of Object.entries(request.params)) {
      const param = model.priceParams.find((item) => item.key === key);
      const valid =
        param !== undefined &&
        (param.type === 'boolean'
          ? typeof value === 'boolean'
          : param.options.includes(String(value)));
      if (!valid)
        throw new StudioRefusal('invalid_request', `Parâmetro "${key}" inválido para este modelo.`);
    }
    if (request.referenceAssetId) {
      const asset = await assetOf(request.referenceAssetId);
      if (asset.kind !== 'image' || !(model.acceptsReferenceImage || model.acceptsFirstFrame)) {
        throw new StudioRefusal('invalid_request', 'Este modelo não aceita imagem de referência.');
      }
    }
    return {
      kind: request.kind,
      model: model.key,
      prompt: request.prompt,
      sourceAssetId: request.referenceAssetId ?? null,
      priceArgs: {
        model: model.key,
        plan_key: plan,
        quantity: request.quantity,
        ...request.params,
        ...(request.durationSeconds !== undefined
          ? { duration_seconds: request.durationSeconds }
          : {}),
      },
    };
  }

  const asset = await assetOf(request.assetId);
  if (asset.kind !== 'image')
    throw new StudioRefusal('invalid_request', 'Só imagens podem ser usadas aqui.');

  if (request.operation === 'upscale') {
    if (!asset.width || !asset.height) {
      throw new StudioRefusal('invalid_request', 'Esta imagem não tem dimensões conhecidas.');
    }
    // The upscaler is priced like any other model, when the catalog lists it.
    const upscaler = models.find((item) => /topaz|upscal/i.test(`${item.key} ${item.name}`));
    if (!upscaler) {
      throw new StudioRefusal(
        'cannot_estimate',
        'O catálogo do Kairogen não informa o preço da ampliação, então ela não pode ser estimada. Sem estimativa, nada é gerado.',
      );
    }
    return {
      kind: 'image',
      model: upscaler.key,
      prompt: null,
      sourceAssetId: asset.id,
      priceArgs: {
        model: upscaler.key,
        plan_key: plan,
        quantity: 1,
        extra_params: { scale: request.scale },
      },
    };
  }

  if (asset.origin !== 'kairogen' || !asset.externalGenerationId) {
    throw new StudioRefusal(
      'invalid_request',
      'Só imagens geradas no Kairogen podem ser animadas.',
    );
  }
  const videoKey = request.videoModel ?? DEFAULT_ANIMATION_MODEL;
  const video = models.find((item) => item.key === videoKey && item.kind === 'video');
  if (!video)
    throw new StudioRefusal('invalid_request', 'Modelo de vídeo não encontrado no catálogo.');
  requireDuration(video, request.durationSeconds);
  return {
    kind: 'video',
    model: video.key,
    prompt: request.prompt ?? asset.prompt,
    sourceAssetId: asset.id,
    priceArgs: {
      model: video.key,
      plan_key: plan,
      quantity: 1,
      ...(request.durationSeconds !== undefined
        ? { duration_seconds: request.durationSeconds }
        : {}),
    },
  };
}

export async function createEstimate(
  deps: StudioDeps,
  input: { employeeId: string; request: MediaEstimateRequest; proposalId?: string | null },
): Promise<MediaEstimate> {
  const kairogen = connected(deps);
  const resolved = await resolve(deps, input.request);

  let credits: number | null;
  try {
    credits = creditCostFrom(await callKairogen(kairogen, 'estimate_cost', resolved.priceArgs));
  } catch (error) {
    if (error instanceof McpError && (error.code === 'tool_error' || error.code === 'rejected')) {
      throw new StudioRefusal(
        'cannot_estimate',
        `O Kairogen não estimou o custo: ${scrubSensitive(error.message).slice(0, 300)}`,
      );
    }
    throw fromMcp(error);
  }
  if (credits === null || credits < 0) {
    throw new StudioRefusal(
      'cannot_estimate',
      'O Kairogen respondeu sem um custo em créditos. Sem estimativa, nada é gerado.',
    );
  }

  const now = deps.now();
  const [row] = await deps.db
    .insert(mediaGenerations)
    .values({
      requestedBy: input.employeeId,
      operation: input.request.operation,
      kind: resolved.kind,
      model: resolved.model,
      prompt: resolved.prompt,
      request: input.request,
      priceArgs: resolved.priceArgs,
      creditsEstimated: credits,
      sourceAssetId: resolved.sourceAssetId,
      proposalId: input.proposalId ?? null,
      estimateExpiresAt: new Date(now.getTime() + ESTIMATE_TTL_MS),
      createdAt: now,
    })
    .returning();
  if (!row) throw new Error('failed to record estimate');
  await ledger(deps.db, row, 'estimated', { creditsDelta: 0, now });

  const usage = await usageOf(deps, input.employeeId);
  return {
    id: row.id,
    credits,
    expiresAt: row.estimateExpiresAt.toISOString(),
    request: input.request,
    blockedBy: blockedBy(usage, credits),
    usage,
  };
}

// ---------------------------------------------------------------------------
// Generating
// ---------------------------------------------------------------------------

/** The arguments of the spending call: the stored request, the stored price args, the quote. */
async function toolCallFor(
  deps: StudioDeps,
  row: GenerationRow,
): Promise<{
  tool: 'generate_image' | 'generate_video' | 'upscale_image' | 'animate_from_generation';
  args: Record<string, unknown>;
}> {
  const request = row.request as MediaEstimateRequest;
  // What the spending tool takes of the priced arguments: all but the plan (only
  // `estimate_cost` has it) and the estimate-only `extra_params`.
  const price = Object.fromEntries(
    Object.entries(row.priceArgs as Record<string, unknown>).filter(
      ([key]) => key !== 'plan_key' && key !== 'extra_params',
    ),
  );
  const source = row.sourceAssetId
    ? await deps.db.query.mediaAssets.findFirst({ where: eq(mediaAssets.id, row.sourceAssetId) })
    : undefined;
  /** Kairogen's own address when the picture came from there; a signed link of ours otherwise. */
  const publicUrl = async (purpose: string) =>
    source
      ? (source.sourceUrl ??
        (await issuePublicLink(deps, {
          assetId: source.id,
          issuedBy: row.requestedBy,
          generationId: row.id,
          purpose,
        })))
      : null;

  if (request.operation === 'upscale') {
    if (!source) throw new StudioRefusal('not_found', 'A imagem de origem não existe mais.');
    return {
      tool: 'upscale_image',
      args: {
        scale: request.scale,
        image_url: await publicUrl('upscale'),
        input_width: source.width,
        input_height: source.height,
        output_format: source.mimeType === 'image/png' ? 'png' : 'jpeg',
        wait_for_completion: false,
      },
    };
  }
  if (request.operation === 'animate') {
    if (!source?.externalGenerationId)
      throw new StudioRefusal('not_found', 'A imagem de origem não existe mais.');
    return {
      tool: 'animate_from_generation',
      args: {
        generation_id: source.externalGenerationId,
        video_model: row.model,
        ...(row.prompt ? { prompt: row.prompt } : {}),
        ...(request.durationSeconds !== undefined
          ? { duration_seconds: request.durationSeconds }
          : {}),
        // Its default is to block for minutes. Like every other generation: an id now, polling after.
        wait_for_completion: false,
      },
    };
  }

  const reference = await publicUrl(request.kind === 'video' ? 'first_frame' : 'reference_image');
  const model = (await listModels(deps)).models.find((item) => item.key === row.model);
  return {
    tool: request.kind === 'video' ? 'generate_video' : 'generate_image',
    args: {
      ...price,
      prompt: request.prompt,
      aspect_ratio: request.aspect,
      ...(request.negativePrompt && request.kind === 'image'
        ? { negative_prompt: request.negativePrompt }
        : {}),
      ...(reference
        ? request.kind === 'video' && model?.acceptsFirstFrame
          ? { first_frame_url: reference }
          : { reference_image_urls: [reference] }
        : {}),
      // Kairogen refuses the generation if the real charge differs from the quote.
      expected_credits: row.creditsEstimated,
      wait_for_completion: false,
    },
  };
}

export async function startGeneration(
  deps: StudioDeps,
  input: { employeeId: string; estimateId: string },
): Promise<GenerationRow> {
  const kairogen = connected(deps);
  if (!deps.mediaDir) {
    throw new StudioRefusal(
      'invalid_request',
      'O armazenamento de mídia não está configurado neste ambiente.',
    );
  }
  // Read before the lock: a network call has no place inside it.
  const usage = await usageOf(deps, input.employeeId);
  const now = deps.now();

  const claimed = await deps.db.transaction(async (tx): Promise<GenerationRow | StudioRefusal> => {
    // One generation is judged at a time, so two clicks cannot both fit under a ceiling.
    await tx.execute(sql`select pg_advisory_xact_lock(7201, 1)`);
    const [row] = await tx
      .select()
      .from(mediaGenerations)
      .where(
        and(
          eq(mediaGenerations.id, input.estimateId),
          eq(mediaGenerations.requestedBy, input.employeeId),
        ),
      )
      .for('update');
    if (!row) return new StudioRefusal('not_found', 'Estimativa não encontrada.');
    if (row.status !== 'estimated') return refuse('estimate_used');
    if (row.estimateExpiresAt <= now) return refuse('estimate_expired');

    const starts = periodStarts(now);
    const fresh: MediaUsage = {
      ...usage,
      usedTodayByYou: await creditsCounted(tx as unknown as Database, starts.day, input.employeeId),
      usedThisMonth: await creditsCounted(tx as unknown as Database, starts.month),
    };
    const blocked = blockedBy(fresh, row.creditsEstimated);
    if (blocked) return refuse(blocked);

    // The spend is on the record BEFORE Kairogen hears of it: a crash between the
    // two leaves credits counted that were not spent, never the other way round.
    const [running] = await tx
      .update(mediaGenerations)
      .set({ status: 'running', startedAt: now })
      .where(eq(mediaGenerations.id, row.id))
      .returning();
    if (!running) throw new Error('failed to claim estimate');
    await ledger(tx as unknown as Database, running, 'started', {
      creditsDelta: running.creditsEstimated,
      now,
    });
    return running;
  });
  if (claimed instanceof StudioRefusal) throw claimed;

  const finish = async (
    status: 'refused' | 'unknown',
    detail: string,
    creditsDelta: number,
  ): Promise<GenerationRow> => {
    const [row] = await deps.db
      .update(mediaGenerations)
      .set({ status, detail, finishedAt: deps.now() })
      .where(eq(mediaGenerations.id, claimed.id))
      .returning();
    if (!row) throw new Error('generation vanished');
    await ledger(deps.db, row, status, { creditsDelta, now: deps.now() });
    return row;
  };

  let externalId: string | null;
  try {
    const call = await toolCallFor(deps, claimed);
    // Sent once. `callKairogen` never retries a tool that spends.
    externalId = generationIdFrom(
      await callKairogen(kairogen, call.tool, call.args, { timeoutMs: 60_000 }),
    );
  } catch (error) {
    if (error instanceof StudioRefusal)
      return finish('refused', error.message, -claimed.creditsEstimated);
    if (!(error instanceof McpError)) throw error;
    if (error.outcomeUnknown) {
      // Nobody knows whether it arrived. The credits stay counted and nothing is sent again.
      return finish(
        'unknown',
        'Não sabemos se o Kairogen recebeu o pedido. Confira no Kairogen antes de gerar de novo.',
        0,
      );
    }
    const said = scrubSensitive(error.message).slice(0, 300);
    return finish(
      'refused',
      error.code === 'unauthorized'
        ? MEDIA_REFUSAL_MESSAGE.not_connected
        : isCreditMismatch(said)
          ? `O Kairogen recusou: o custo real difere do estimado (${claimed.creditsEstimated} créditos). Estime de novo. Resposta dele: ${said}`
          : `O Kairogen recusou a geração. Resposta dele: ${said}`,
      -claimed.creditsEstimated,
    );
  }
  if (!externalId) {
    return finish(
      'unknown',
      'O Kairogen aceitou o pedido mas não devolveu o identificador da geração. Confira no Kairogen antes de gerar de novo.',
      0,
    );
  }

  const [row] = await deps.db
    .update(mediaGenerations)
    .set({
      externalGenerationId: externalId,
      nextPollAt: new Date(deps.now().getTime() + FIRST_POLL_MS),
    })
    .where(eq(mediaGenerations.id, claimed.id))
    .returning();
  if (!row) throw new Error('generation vanished');
  if (deps.autoPoll) schedule(deps, row.id, FIRST_POLL_MS);
  return row;
}

// ---------------------------------------------------------------------------
// Following a generation to its end
// ---------------------------------------------------------------------------

async function download(deps: StudioDeps, url: string): Promise<Buffer | null> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  // An output address is data from a third party: https, a real host name, nothing local.
  if (
    parsed.protocol !== 'https:' ||
    /^(localhost|\d+\.\d+\.\d+\.\d+|\[.*\])$/i.test(parsed.hostname)
  ) {
    return null;
  }
  try {
    const response = await deps.fetch(url, { signal: AbortSignal.timeout(120_000) });
    if (!response.ok) return null;
    if (Number(response.headers.get('content-length') ?? 0) > MAX_DOWNLOAD_BYTES) return null;
    const bytes = Buffer.from(await response.arrayBuffer());
    return bytes.length > 0 && bytes.length <= MAX_DOWNLOAD_BYTES ? bytes : null;
  } catch {
    return null;
  }
}

/**
 * Moves one generation forward, if it is due: asks Kairogen once for its state
 * (`wait_for_completion: false`), and when it is finished downloads every
 * output into the library. Safe to call from a timer and from a request at the
 * same time: the row is claimed by pushing `next_poll_at` forward.
 */
export async function advanceGeneration(
  deps: StudioDeps,
  id: string,
): Promise<GenerationRow | null> {
  const now = deps.now();
  const current = await deps.db.query.mediaGenerations.findFirst({
    where: eq(mediaGenerations.id, id),
  });
  if (!current || current.status !== 'running' || !current.externalGenerationId || !deps.kairogen) {
    return current ?? null;
  }

  const end = async (
    status: 'succeeded' | 'failed' | 'timed_out',
    detail: string | null,
    charged: number | null,
  ) => {
    const [row] = await deps.db
      .update(mediaGenerations)
      .set({ status, detail, creditsCharged: charged, finishedAt: deps.now(), nextPollAt: null })
      .where(eq(mediaGenerations.id, id))
      .returning();
    if (!row) throw new Error('generation vanished');
    await ledger(deps.db, row, status, {
      // Once the real charge is known, the ledger is corrected by the difference.
      creditsDelta: charged === null ? 0 : charged - row.creditsEstimated,
      creditsCharged: charged,
      now: deps.now(),
    });
    return row;
  };

  if (current.startedAt && now.getTime() - current.startedAt.getTime() > GIVE_UP_AFTER_MS) {
    return end(
      'timed_out',
      'Passou de 20 minutos sem resposta final. Confira no Kairogen; os créditos continuam contados.',
      null,
    );
  }

  // 5 s, 10 s, 15 s… up to 30 s between checks.
  const wait = Math.min(MAX_POLL_MS, FIRST_POLL_MS * (current.pollCount + 2));
  const [claimed] = await deps.db
    .update(mediaGenerations)
    .set({ nextPollAt: new Date(now.getTime() + wait), pollCount: current.pollCount + 1 })
    .where(
      and(
        eq(mediaGenerations.id, id),
        eq(mediaGenerations.status, 'running'),
        lte(mediaGenerations.nextPollAt, now),
      ),
    )
    .returning();
  if (!claimed) return current;

  let state;
  try {
    state = generationStateFrom(
      await callKairogen(deps.kairogen, 'get_generation', {
        generation_id: current.externalGenerationId,
        wait_for_completion: false,
      }),
    );
  } catch (error) {
    if (!(error instanceof McpError)) throw error;
    if (error.code === 'tool_error')
      return end('failed', 'O Kairogen informou que a geração falhou.', null);
    return claimed; // Unreachable for now: try again at the next interval.
  }

  if (state.state === 'running') return claimed;
  if (state.state === 'failed') {
    return end('failed', 'O Kairogen informou que a geração falhou.', state.creditsCharged);
  }

  await deps.db
    .update(mediaGenerations)
    .set({ status: 'saving' })
    .where(eq(mediaGenerations.id, id));
  const request = current.request as MediaEstimateRequest;
  let saved = 0;
  for (const url of state.outputUrls) {
    const bytes = deps.mediaDir ? await download(deps, url) : null;
    if (!bytes || !deps.mediaDir) continue;
    const stored = await storeMedia(deps.db, deps.mediaDir, {
      ownerId: current.requestedBy,
      origin: 'kairogen',
      bytes,
      prompt: current.prompt,
      model: current.model,
      credits: Math.round(current.creditsEstimated / Math.max(state.outputUrls.length, 1)),
      externalGenerationId: current.externalGenerationId,
      sourceAssetId: current.sourceAssetId,
      durationSeconds:
        'durationSeconds' in request && request.durationSeconds ? request.durationSeconds : null,
      now: deps.now(),
    });
    if (!stored.ok) continue;
    await deps.db.update(mediaAssets).set({ sourceUrl: url }).where(eq(mediaAssets.id, stored.id));
    saved += 1;
  }
  return end(
    saved > 0 ? 'succeeded' : 'failed',
    saved === state.outputUrls.length
      ? null
      : `O Kairogen concluiu, mas ${state.outputUrls.length - saved} de ${state.outputUrls.length} arquivo(s) não puderam ser salvos. Eles continuam no Kairogen.`,
    state.creditsCharged,
  );
}

function schedule(deps: StudioDeps, id: string, delayMs: number): void {
  const timer = setTimeout(() => {
    void advanceGeneration(deps, id)
      .then((row) => {
        if (row?.status === 'running') {
          const due = row.nextPollAt ? row.nextPollAt.getTime() - Date.now() : FIRST_POLL_MS;
          schedule(deps, id, Math.max(1_000, due));
        }
      })
      .catch(() => schedule(deps, id, MAX_POLL_MS));
  }, delayMs);
  timer.unref();
}

/** After a restart: generations that were being followed are followed again. */
export async function resumeGenerations(deps: StudioDeps): Promise<number> {
  if (!deps.autoPoll) return 0;
  const running = await deps.db
    .select({ id: mediaGenerations.id })
    .from(mediaGenerations)
    .where(eq(mediaGenerations.status, 'running'));
  running.forEach((row, index) => schedule(deps, row.id, 1_000 + index * 500));
  return running.length;
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export async function toGeneration(db: Database, row: GenerationRow): Promise<MediaGeneration> {
  const [requester, assets] = await Promise.all([
    db.query.employees.findFirst({ where: eq(employees.id, row.requestedBy) }),
    row.externalGenerationId
      ? db
          .select({ id: mediaAssets.id })
          .from(mediaAssets)
          .where(eq(mediaAssets.externalGenerationId, row.externalGenerationId))
      : Promise.resolve([]),
  ]);
  return {
    id: row.id,
    status: row.status,
    operation: row.operation as MediaGeneration['operation'],
    kind: row.kind,
    model: row.model,
    prompt: row.prompt,
    creditsEstimated: row.creditsEstimated,
    creditsCharged: row.creditsCharged,
    detail: row.detail,
    requestedByName: requester?.fullName ?? null,
    createdAt: row.createdAt.toISOString(),
    finishedAt: row.finishedAt?.toISOString() ?? null,
    assetIds: assets.map((asset) => asset.id),
  };
}

export async function recentGenerations(db: Database): Promise<GenerationRow[]> {
  return db
    .select()
    .from(mediaGenerations)
    .where(
      inArray(mediaGenerations.status, [
        'running',
        'saving',
        'succeeded',
        'failed',
        'refused',
        'unknown',
        'timed_out',
      ]),
    )
    .orderBy(desc(mediaGenerations.createdAt))
    .limit(30);
}
