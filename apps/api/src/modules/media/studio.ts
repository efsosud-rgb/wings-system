import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  MEDIA_BILLING_RANK,
  MEDIA_REFUSAL_MESSAGE,
  MAX_IMAGES_PER_GENERATION,
  MAX_VIDEOS_PER_GENERATION,
  WINGS_CLIENT_ID,
  formatBrl,
  mentionsClient,
  modelsForImageUse,
  type MediaAlternative,
  type MediaEstimate,
  type MediaEstimateRequest,
  type MediaGeneration,
  type MediaModel,
  type MediaOrigin,
  type MediaProviderId,
  type MediaProviderStatus,
  type MediaRefusal,
  type MediaSpend,
  type MediaUsage,
} from '@wings/shared';
import { and, desc, eq, gte, inArray, isNotNull, lte, ne, or, sql } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import {
  agentProposals,
  clients,
  employees,
  mediaAssets,
  mediaCreditLedger,
  mediaGenerations,
  mediaPublicLinks,
} from '../../db/schema/index.js';
import type { Env } from '../../env.js';
import { storageOf, type ObjectStorage } from '../../lib/storage/index.js';
import { activeClient } from '../clients/routes.js';
import { mediaDirOf, readMedia, storeMedia } from './library.js';
import {
  DEFAULT_ANIMATION_MODEL,
  ProviderError,
  mediaProvidersOf,
  planOf,
  providerById,
  type MediaProvider,
  type ProviderContext,
  type ProviderOutput,
  type ResolvedRequest,
  type SourceAsset,
} from './providers/index.js';

export { clearModelCache, planOf, setPlan } from './providers/index.js';

/**
 * Spending on media, and everything that keeps it honest, whichever provider
 * runs the model.
 *
 * The order of things is fixed: estimate (the provider says the price, R$ 0
 * included) → a person clicks → ceilings, quota and balance are checked → the
 * ledger records the spend → only then is the provider called, ONCE → the
 * server follows until the files are in the library. No step is skipped and
 * none is repeated on its own.
 *
 * When the provider asked for cannot serve, a cheaper (or free) one that does
 * the same takes its place and the estimate says so; a costlier one is only
 * offered, and taking it is a click. The switch happens before the price is
 * shown, never after: what is generated is always what was priced.
 */

const ESTIMATE_TTL_MS = 10 * 60_000;
const LINK_TTL_MS = 15 * 60_000;
const GIVE_UP_AFTER_MS = 20 * 60_000;
const FIRST_POLL_MS = 5_000;
const MAX_POLL_MS = 30_000;
const MAX_DOWNLOAD_BYTES = 150 * 1024 * 1024;

export interface StudioDeps {
  db: Database;
  /** Every provider the system knows, in failover order. */
  providers: MediaProvider[];
  /** Where the library's files live: the Drive's storage. Null when this environment has none. */
  storage: ObjectStorage | null;
  /** The volume assets lived on before the Drive, read until the migration script has run. */
  mediaDir: string | null;
  dailyPerUser: number;
  monthly: number;
  /** The one ceiling over every provider, in cents of reais per month. */
  monthlyBrlCents: number;
  /** Where a provider can reach this API: APP_BASE_URL + /api. */
  publicApiBase: string;
  linkKey: Buffer | null;
  /** Downloads of finished outputs. Tests hand in the fakes'. */
  fetch: typeof fetch;
  /** False in tests: generations move only when somebody calls `advanceGeneration`. */
  autoPoll: boolean;
  now: () => Date;
}

export function studioDepsOf(
  wings: {
    db: Database;
    env: Env;
    kairogenFetch?: typeof fetch;
    mediaFetch?: typeof fetch;
    storageFetch?: typeof fetch;
    storage?: ObjectStorage;
  },
  log?: { info: (entry: object, message: string) => void },
): StudioDeps {
  const key = wings.env.INTEGRATIONS_ENCRYPTION_KEY;
  return {
    db: wings.db,
    providers: mediaProvidersOf(wings, log),
    storage: storageOf(wings),
    mediaDir: mediaDirOf(wings.env),
    dailyPerUser: wings.env.KAIROGEN_DAILY_CREDITS_PER_USER,
    monthly: wings.env.KAIROGEN_MONTHLY_CREDITS,
    monthlyBrlCents: Math.round(wings.env.MEDIA_MONTHLY_BRL * 100),
    publicApiBase: `${wings.env.APP_BASE_URL}/api`,
    // A key of its own, derived: signing links never reuses the key that encrypts tokens.
    linkKey: key
      ? createHmac('sha256', Buffer.from(key, 'base64')).update('wings-media-public-link').digest()
      : null,
    fetch: wings.mediaFetch ?? wings.kairogenFetch ?? fetch,
    autoPoll: wings.env.NODE_ENV !== 'test',
    now: () => new Date(),
  };
}

const ctxOf = (deps: StudioDeps): ProviderContext => ({ db: deps.db, now: deps.now });

export class StudioRefusal extends Error {
  constructor(
    readonly code:
      MediaRefusal | 'invalid_request' | 'cannot_estimate' | 'not_found' | 'provider_unreachable',
    message: string,
    /** For the few refusals that carry more than a message: a costlier model that could do it. */
    readonly extra: { alternative?: MediaAlternative } = {},
  ) {
    super(message);
    this.name = 'StudioRefusal';
  }
}
const refuse = (code: MediaRefusal) => new StudioRefusal(code, MEDIA_REFUSAL_MESSAGE[code]);

function providerOf(deps: StudioDeps, id: MediaProviderId): MediaProvider {
  const provider = providerById(deps.providers, id);
  if (!provider) throw new StudioRefusal('invalid_request', 'Provedor desconhecido.');
  return provider;
}

/** A provider said no before anything was spent: what that means for the person. */
function fromProvider(error: unknown): StudioRefusal {
  if (!(error instanceof ProviderError)) throw error;
  switch (error.code) {
    case 'unauthorized':
      return new StudioRefusal('not_connected', error.message);
    case 'rejected':
      return new StudioRefusal('cannot_estimate', error.message);
    case 'quota':
      return new StudioRefusal('provider_unavailable', error.message);
    default:
      return new StudioRefusal('provider_unreachable', error.message);
  }
}

// ---------------------------------------------------------------------------
// Catalog, providers, usage
// ---------------------------------------------------------------------------

/**
 * Every configured provider's models together. A provider that cannot be read
 * right now is named in `problems` and its models are simply absent; with no
 * provider available at all, the studio is not connected.
 */
export async function listModels(
  deps: StudioDeps,
  options: { priced?: 'image' | 'video' | 'all' } = {},
): Promise<{
  models: MediaModel[];
  cachedAt: string;
  problems: Partial<Record<MediaProviderId, string>>;
}> {
  const ctx = ctxOf(deps);
  const models: MediaModel[] = [];
  const problems: Partial<Record<MediaProviderId, string>> = {};
  for (const provider of deps.providers) {
    if (!provider.configured) continue;
    try {
      models.push(...(await provider.listModels(ctx, options)));
    } catch (error) {
      if (!(error instanceof ProviderError)) throw error;
      problems[provider.id] = error.message;
    }
  }
  if (models.length === 0) {
    const unreachable = Object.values(problems)[0];
    if (unreachable) throw new StudioRefusal('provider_unreachable', unreachable);
    throw refuse('not_connected');
  }
  return { models, cachedAt: deps.now().toISOString(), problems };
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
        eq(mediaCreditLedger.provider, 'kairogen'),
      ),
    );
  return Number(row?.total ?? 0);
}

async function brlCounted(db: Database, since: Date, provider?: MediaProviderId): Promise<number> {
  const [row] = await db
    .select({ total: sql<string>`coalesce(sum(${mediaCreditLedger.brlCentsDelta}), 0)` })
    .from(mediaCreditLedger)
    .where(
      and(
        gte(mediaCreditLedger.createdAt, since),
        provider ? eq(mediaCreditLedger.provider, provider) : undefined,
      ),
    );
  return Number(row?.total ?? 0);
}

/** What Kairogen's `get_credits` says right now, or null when it cannot be asked. */
async function readBalance(deps: StudioDeps): Promise<number | null> {
  const kairogen = providerById(deps.providers, 'kairogen');
  if (!kairogen?.configured) return null;
  return (await kairogen.balance(ctxOf(deps)))?.credits ?? null;
}

/**
 * Kairogen moves the balance for reasons of its own (a renewal, a bonus). Every
 * reading that differs from the last one on record becomes a ledger row of its
 * own, so a jump is dated and sits between the two generations it happened
 * between. Readings that repeat the last one add nothing and are not written.
 */
async function noteBalance(deps: StudioDeps, employeeId: string, balance: number): Promise<void> {
  const [last] = await deps.db
    .select({ balance: mediaCreditLedger.balanceReported })
    .from(mediaCreditLedger)
    .where(isNotNull(mediaCreditLedger.balanceReported))
    .orderBy(desc(mediaCreditLedger.createdAt))
    .limit(1);
  if (last?.balance === Math.floor(balance)) return;
  await deps.db.insert(mediaCreditLedger).values({
    generationId: null,
    employeeId,
    event: 'balance_changed',
    operation: 'get_credits',
    provider: 'kairogen',
    creditsEstimated: 0,
    creditsDelta: 0,
    balanceReported: Math.floor(balance),
    createdAt: deps.now(),
  });
}

export async function spendOf(deps: StudioDeps): Promise<MediaSpend> {
  return {
    usedThisMonthBrlCents: await brlCounted(deps.db, periodStarts(deps.now()).month),
    monthlyLimitBrlCents: deps.monthlyBrlCents,
  };
}

export async function usageOf(
  deps: StudioDeps,
  employeeId: string,
  options: { withBalance?: boolean } = {},
): Promise<MediaUsage> {
  const starts = periodStarts(deps.now());
  const balance = options.withBalance === false ? null : await readBalance(deps);
  if (balance !== null) await noteBalance(deps, employeeId, balance);
  return {
    plan: await planOf(deps.db),
    balance,
    usedTodayByYou: await creditsCounted(deps.db, starts.day, employeeId),
    dailyLimitPerUser: deps.dailyPerUser,
    usedThisMonth: await creditsCounted(deps.db, starts.month),
    monthlyLimit: deps.monthly,
    usedThisMonthBrlCents: await brlCounted(deps.db, starts.month),
    monthlyLimitBrlCents: deps.monthlyBrlCents,
  };
}

/** Every provider as the screens see it: what it is, whether it can serve, what it holds and spent. */
export async function providerStatuses(deps: StudioDeps): Promise<MediaProviderStatus[]> {
  const ctx = ctxOf(deps);
  const month = periodStarts(deps.now()).month;
  return Promise.all(
    deps.providers.map(async (provider): Promise<MediaProviderStatus> => {
      const availability = provider.configured
        ? await provider.availability(ctx)
        : { available: false, reason: null };
      return {
        id: provider.id,
        name: provider.name,
        billing: provider.billing,
        capabilities: [...provider.capabilities],
        configured: provider.configured,
        available: availability.available,
        reason: provider.configured ? availability.reason : 'Sem chave no ambiente.',
        balance: provider.configured ? await provider.balance(ctx) : null,
        quota: provider.configured ? await provider.quota(ctx) : null,
        usedThisMonthBrlCents: await brlCounted(deps.db, month, provider.id),
        verified: provider.verified,
      };
    }),
  );
}

/** The ceilings, with a sentence for the one that refuses. */
function blockedBy(
  usage: MediaUsage,
  quote: { providerId: MediaProviderId; credits: number; brlCents: number },
): { code: MediaRefusal; detail: string } | null {
  if (quote.providerId === 'kairogen') {
    if (usage.usedTodayByYou + quote.credits > usage.dailyLimitPerUser) {
      return { code: 'daily_limit', detail: MEDIA_REFUSAL_MESSAGE.daily_limit };
    }
    if (usage.usedThisMonth + quote.credits > usage.monthlyLimit) {
      return { code: 'monthly_limit', detail: MEDIA_REFUSAL_MESSAGE.monthly_limit };
    }
    if (usage.balance !== null && usage.balance < quote.credits) {
      return { code: 'insufficient_credits', detail: MEDIA_REFUSAL_MESSAGE.insufficient_credits };
    }
  }
  if (
    quote.brlCents > 0 &&
    usage.usedThisMonthBrlCents + quote.brlCents > usage.monthlyLimitBrlCents
  ) {
    return {
      code: 'monthly_brl_limit',
      detail: `O teto mensal de ${formatBrl(usage.monthlyLimitBrlCents)} em mídia seria ultrapassado: ${formatBrl(usage.usedThisMonthBrlCents)} já contados este mês e esta geração custa ${formatBrl(quote.brlCents)}.`,
    };
  }
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
 * A public address for ONE asset, good for fifteen minutes, so that a provider
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
  // In the bucket, the address is the bucket's own: pre-signed, for this one object, for
  // the same fifteen minutes. The row above is the record of it either way.
  const asset = await deps.db.query.mediaAssets.findFirst({
    where: eq(mediaAssets.id, input.assetId),
  });
  if (deps.storage?.kind === 's3' && asset?.storageKey.startsWith('drive/')) {
    return deps.storage.presignGet(asset.storageKey, {
      expiresSeconds: LINK_TTL_MS / 1000,
      disposition: 'inline',
      contentType: asset.mimeType,
    });
  }
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
  values: {
    creditsDelta: number;
    brlCentsDelta: number;
    creditsCharged?: number | null;
    brlCentsCharged?: number | null;
    /** What get_credits said around this step, when it was asked. */
    balance?: number | null;
    now: Date;
  },
): Promise<void> {
  await db.insert(mediaCreditLedger).values({
    generationId: row.id,
    employeeId: row.requestedBy,
    event,
    operation: row.operation,
    model: row.model,
    provider: row.provider,
    prompt: row.prompt,
    params: row.priceArgs,
    creditsEstimated: row.creditsEstimated,
    creditsCharged: values.creditsCharged ?? row.creditsCharged,
    creditsDelta: values.creditsDelta,
    brlCentsEstimated: row.brlCentsEstimated,
    brlCentsCharged: values.brlCentsCharged ?? row.brlCentsCharged,
    brlCentsDelta: values.brlCentsDelta,
    externalGenerationId: row.externalGenerationId,
    clientId: row.clientId,
    balanceReported:
      values.balance === null || values.balance === undefined ? null : Math.floor(values.balance),
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

interface Resolved extends ResolvedRequest {
  /** Filing only. Never part of `priceArgs` nor of any provider call. */
  clientId: string;
  campaign: string | null;
}

const asSource = (asset: typeof mediaAssets.$inferSelect): SourceAsset => ({
  id: asset.id,
  kind: asset.kind,
  mimeType: asset.mimeType,
  width: asset.width,
  height: asset.height,
  origin: asset.origin,
  externalGenerationId: asset.externalGenerationId,
  sourceUrl: asset.sourceUrl,
});

async function resolve(
  deps: StudioDeps,
  request: MediaEstimateRequest,
  models: MediaModel[],
): Promise<Resolved> {
  const assetOf = async (id: string) => {
    const asset = await deps.db.query.mediaAssets.findFirst({ where: eq(mediaAssets.id, id) });
    if (!asset) throw new StudioRefusal('not_found', 'Mídia não encontrada na biblioteca.');
    return asset;
  };

  if (request.operation === 'generate') {
    const client = await activeClient(deps.db, request.clientId);
    if (!client) throw new StudioRefusal('invalid_request', 'Cliente não encontrado ou inativo.');
    // Who the work is for stays here. Wings' own name is not a secret; a client's is.
    const written = `${request.prompt} ${request.negativePrompt ?? ''}`;
    if (client.id !== WINGS_CLIENT_ID && mentionsClient(written, client.name)) {
      throw new StudioRefusal(
        'invalid_request',
        'O prompt cita o nome do cliente, e o nome do cliente nunca é enviado ao provedor. Descreva a cena sem o nome; o texto da marca entra depois, no anúncio.',
      );
    }
    const model = models.find((item) => item.key === request.model && item.kind === request.kind);
    if (!model) {
      // A near miss ("seedance-v1.5-pro" for "seedance-v1-5-pro") names the right id.
      const squash = (key: string) => key.toLowerCase().replace(/[^a-z0-9]/g, '');
      const near = models.find(
        (item) => item.kind === request.kind && squash(item.key) === squash(request.model),
      );
      throw new StudioRefusal(
        'invalid_request',
        near
          ? `Modelo não encontrado no catálogo: "${request.model}". O id certo é "${near.key}".`
          : 'Modelo não encontrado no catálogo.',
      );
    }
    const cap = Math.min(
      model.maxOutputs,
      request.kind === 'video' ? MAX_VIDEOS_PER_GENERATION : MAX_IMAGES_PER_GENERATION,
    );
    if (request.quantity > cap) {
      throw new StudioRefusal('invalid_request', `No máximo ${cap} por geração neste modelo.`);
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
      if (!valid) {
        const accepted = model.priceParams
          .map((item) =>
            item.type === 'boolean'
              ? `${item.key} (true, false)`
              : `${item.key} (${item.options.join(', ')})`,
          )
          .join('; ');
        throw new StudioRefusal(
          'invalid_request',
          `Parâmetro "${key}" inválido para este modelo. ${accepted ? `Aceitos: ${accepted}.` : 'Este modelo não tem parâmetros de preço: mande params vazio.'}`,
        );
      }
    }
    let source: SourceAsset | null = null;
    if (request.referenceAssetId) {
      const asset = await assetOf(request.referenceAssetId);
      if (asset.kind !== 'image') {
        throw new StudioRefusal('invalid_request', 'Só imagens podem ser usadas aqui.');
      }
      if (request.kind === 'video' && !model.acceptsFirstFrame) {
        throw new StudioRefusal('invalid_request', 'Este modelo não aceita imagem de referência.');
      }
      // What is done with the picture has to be what THIS model does with one.
      if (request.kind === 'image' && model.imageUse !== request.referenceUse) {
        const able = modelsForImageUse(models, request.referenceUse)
          .slice(0, 4)
          .map((item) => item.name);
        const wanted =
          request.referenceUse === 'edit' ? 'não edita imagens' : 'não usa imagem de referência';
        const does =
          model.imageUse === 'edit'
            ? ' Ele só recebe uma imagem para editá-la.'
            : model.imageUse === 'reference'
              ? ' Ele só recebe uma imagem como referência.'
              : '';
        throw new StudioRefusal(
          'invalid_request',
          `${model.name} ${wanted}.${does}${able.length > 0 ? ` Modelos que fazem isso: ${able.join(', ')}.` : ''}`,
        );
      }
      source = asSource(asset);
    }
    return {
      operation: 'generate',
      clientId: client.id,
      campaign: request.campaign ?? null,
      kind: request.kind,
      model,
      prompt: request.prompt,
      negativePrompt: request.negativePrompt ?? null,
      aspect: request.aspect,
      quantity: request.quantity,
      durationSeconds: request.durationSeconds,
      params: request.params,
      scale: null,
      source,
    };
  }

  const asset = await assetOf(request.assetId);
  if (asset.kind !== 'image')
    throw new StudioRefusal('invalid_request', 'Só imagens podem ser usadas aqui.');

  if (request.operation === 'upscale') {
    if (!asset.width || !asset.height) {
      throw new StudioRefusal('invalid_request', 'Esta imagem não tem dimensões conhecidas.');
    }
    // The upscaler is priced like any other model, when a catalog lists it.
    const upscaler = models.find(
      (item) =>
        providerById(deps.providers, item.providerId)?.capabilities.includes('upscale') &&
        /topaz|upscal/i.test(`${item.key} ${item.name}`),
    );
    if (!upscaler) {
      throw new StudioRefusal(
        'cannot_estimate',
        'Nenhum catálogo informa o preço da ampliação, então ela não pode ser estimada. Sem estimativa, nada é gerado.',
      );
    }
    return {
      operation: 'upscale',
      clientId: asset.clientId,
      campaign: null,
      kind: 'image',
      model: upscaler,
      prompt: null,
      negativePrompt: null,
      aspect: null,
      quantity: 1,
      durationSeconds: undefined,
      params: {},
      scale: request.scale,
      source: asSource(asset),
    };
  }

  // Animating is done by the provider that generated the picture, from its own generation id.
  const animator = providerById(deps.providers, asset.origin as MediaProviderId);
  if (
    asset.origin === 'upload' ||
    !animator?.capabilities.includes('animate') ||
    !asset.externalGenerationId
  ) {
    throw new StudioRefusal(
      'invalid_request',
      'Só imagens geradas no Kairogen podem ser animadas.',
    );
  }
  const videoKey = request.videoModel ?? DEFAULT_ANIMATION_MODEL;
  const video = models.find(
    (item) => item.key === videoKey && item.kind === 'video' && item.providerId === animator.id,
  );
  if (!video)
    throw new StudioRefusal('invalid_request', 'Modelo de vídeo não encontrado no catálogo.');
  requireDuration(video, request.durationSeconds);
  return {
    operation: 'animate',
    clientId: asset.clientId,
    campaign: null,
    kind: 'video',
    model: video,
    prompt: request.prompt ?? asset.prompt,
    negativePrompt: null,
    aspect: null,
    quantity: 1,
    durationSeconds: request.durationSeconds,
    params: {},
    scale: null,
    source: asSource(asset),
  };
}

/** Cheaper first: free with quota, then credits, then per use; within a tier, by the price per output. */
const rankOf = (provider: MediaProvider, model: MediaModel): [number, number] => [
  MEDIA_BILLING_RANK[provider.billing],
  model.brlCentsPerOutput ?? Number.POSITIVE_INFINITY,
];
const cheaperOrEqual = (a: [number, number], b: [number, number]) =>
  a[0] < b[0] || (a[0] === b[0] && a[1] <= b[1]);

/**
 * Another model, on another provider, that could do this request now: same
 * kind, same use of the picture, same shape, available for this many outputs,
 * and able to price it. The cheapest of them.
 */
async function alternativeFor(
  deps: StudioDeps,
  models: MediaModel[],
  resolved: Resolved,
  request: MediaEstimateRequest,
): Promise<{
  model: MediaModel;
  provider: MediaProvider;
  quote: { credits: number; brlCents: number };
} | null> {
  if (resolved.operation !== 'generate' || request.operation !== 'generate') return null;
  const candidates = models
    .filter(
      (model) => model.kind === resolved.kind && model.providerId !== resolved.model.providerId,
    )
    .filter((model) => resolved.quantity <= model.maxOutputs)
    .filter(
      (model) =>
        !model.aspectRatios || !resolved.aspect || model.aspectRatios.includes(resolved.aspect),
    )
    .filter((model) =>
      resolved.source
        ? resolved.kind === 'image'
          ? model.imageUse === request.referenceUse
          : model.acceptsFirstFrame
        : true,
    )
    .filter(
      (model) =>
        resolved.durationSeconds === undefined ||
        model.supportedDurations.includes(resolved.durationSeconds),
    )
    .map((model) => ({ model, provider: providerOf(deps, model.providerId) }))
    .filter(({ provider }) => provider.configured)
    .sort((a, b) => {
      const [ra, rb] = [rankOf(a.provider, a.model), rankOf(b.provider, b.model)];
      return ra[0] - rb[0] || ra[1] - rb[1];
    });
  const ctx = ctxOf(deps);
  for (const candidate of candidates) {
    const availability = await candidate.provider.availability(ctx, { outputs: resolved.quantity });
    if (!availability.available) continue;
    try {
      const quote = await candidate.provider.estimate(ctx, {
        ...resolved,
        model: candidate.model,
        // Price-affecting parameters belong to the model they were chosen for.
        params: {},
      });
      return { ...candidate, quote };
    } catch (error) {
      if (!(error instanceof ProviderError)) throw error;
    }
  }
  return null;
}

/** The last model used for the same client (and campaign), when it is another one. */
async function mixWarning(deps: StudioDeps, resolved: Resolved): Promise<string | null> {
  if (resolved.operation !== 'generate') return null;
  const [last] = await deps.db
    .select({ model: mediaGenerations.model, provider: mediaGenerations.provider })
    .from(mediaGenerations)
    .where(
      and(
        eq(mediaGenerations.clientId, resolved.clientId),
        resolved.campaign ? eq(mediaGenerations.campaign, resolved.campaign) : undefined,
        eq(mediaGenerations.kind, resolved.kind),
        inArray(mediaGenerations.status, ['running', 'saving', 'succeeded']),
        ne(mediaGenerations.model, resolved.model.key),
      ),
    )
    .orderBy(desc(mediaGenerations.createdAt))
    .limit(1);
  if (!last?.model) return null;
  const where = resolved.campaign ? `A campanha "${resolved.campaign}"` : 'Este cliente';
  const provider =
    providerById(deps.providers, last.provider as MediaProviderId)?.name ?? last.provider;
  return `${where} já tem ${resolved.kind === 'video' ? 'vídeo' : 'imagem'} feita com ${last.model} (${provider}). Misturar modelos muda o estilo das peças; use o mesmo modelo se quiser que combinem.`;
}

export async function createEstimate(
  deps: StudioDeps,
  input: { employeeId: string; request: MediaEstimateRequest; proposalId?: string | null },
): Promise<MediaEstimate> {
  const ctx = ctxOf(deps);
  const { models } = await listModels(deps);
  let resolved = await resolve(deps, input.request, models);
  let provider = providerOf(deps, resolved.model.providerId);
  let routedFrom: MediaEstimate['routedFrom'] = null;
  const warnings: string[] = [];

  const availability = await provider.availability(ctx, { outputs: resolved.quantity });
  if (!availability.available) {
    const reason = availability.reason ?? MEDIA_REFUSAL_MESSAGE.provider_unavailable;
    const alternative = await alternativeFor(deps, models, resolved, input.request);
    if (!alternative) {
      throw new StudioRefusal(
        'provider_unavailable',
        `${provider.name}: ${reason} Nenhum outro provedor disponível faz isso agora.`,
      );
    }
    const asked = rankOf(provider, resolved.model);
    const offered = rankOf(alternative.provider, {
      ...alternative.model,
      brlCentsPerOutput: alternative.quote.brlCents / Math.max(resolved.quantity, 1),
    });
    const cost =
      alternative.quote.credits > 0
        ? `${alternative.quote.credits} créditos`
        : formatBrl(alternative.quote.brlCents);
    if (!cheaperOrEqual(offered, asked)) {
      // Up in price is a person's decision: the alternative is offered, not taken.
      throw new StudioRefusal(
        'provider_unavailable',
        `${provider.name}: ${reason} ${alternative.model.name} (${alternative.provider.name}) faz isso por ${cost}, mas trocar para um provedor mais caro é um clique seu.`,
        {
          alternative: {
            model: alternative.model.key,
            name: alternative.model.name,
            providerId: alternative.provider.id,
            credits: alternative.quote.credits,
            brlCents: alternative.quote.brlCents,
          },
        },
      );
    }
    routedFrom = { model: resolved.model.key, providerId: provider.id, reason };
    warnings.push(
      `${provider.name} não pôde atender: ${reason} Foi para ${alternative.model.name} (${alternative.provider.name}), por ${cost}.`,
    );
    resolved = { ...resolved, model: alternative.model, params: {} };
    provider = alternative.provider;
  }

  let quote;
  try {
    quote = await provider.estimate(ctx, resolved);
  } catch (error) {
    throw fromProvider(error);
  }
  if (!provider.verified) {
    warnings.push(
      `${provider.name} ainda não foi verificado com uma geração real: o formato das respostas vem da documentação pública.`,
    );
  }
  const mixed = await mixWarning(deps, resolved);
  if (mixed) warnings.push(mixed);

  const now = deps.now();
  const [row] = await deps.db
    .insert(mediaGenerations)
    .values({
      requestedBy: input.employeeId,
      operation: input.request.operation,
      kind: resolved.kind,
      model: resolved.model.key,
      provider: provider.id,
      prompt: resolved.prompt,
      request: input.request,
      priceArgs: quote.priceArgs,
      creditsEstimated: quote.credits,
      brlCentsEstimated: quote.brlCents,
      sourceAssetId: resolved.source?.id ?? null,
      proposalId: input.proposalId ?? null,
      clientId: resolved.clientId,
      campaign: resolved.campaign,
      routedFrom,
      estimateExpiresAt: new Date(now.getTime() + ESTIMATE_TTL_MS),
      createdAt: now,
    })
    .returning();
  if (!row) throw new Error('failed to record estimate');
  const usage = await usageOf(deps, input.employeeId, { withBalance: provider.id === 'kairogen' });
  await ledger(deps.db, row, 'estimated', {
    creditsDelta: 0,
    brlCentsDelta: 0,
    balance: usage.balance,
    now,
  });
  const blocked = blockedBy(usage, { providerId: provider.id, ...quote });
  if (blocked && blocked.code === 'monthly_brl_limit') warnings.push(blocked.detail);
  return {
    id: row.id,
    credits: quote.credits,
    brlCents: quote.brlCents,
    providerId: provider.id,
    expiresAt: row.estimateExpiresAt.toISOString(),
    request: input.request,
    blockedBy: blocked?.code ?? null,
    usage,
    routedFrom,
    warnings,
  };
}

/** Where an agent card's estimate stands, after "Estimar de novo". */
export interface ProposalEstimate {
  estimate: {
    id: string;
    credits: number;
    brlCents: number;
    providerId: MediaProviderId;
    expiresAt: string;
  } | null;
  generationId: string | null;
}

/**
 * "Estimar de novo" on an agent card: a fresh estimate for exactly the request
 * the card was priced with (the stored one, so estimate and generation carry
 * the same payload), without talking to the agent. A card whose estimate is
 * still open answers with that one, and a card whose generation is under way or
 * already done answers with the generation: nothing is ever priced twice to be
 * spent twice.
 */
export async function reestimateProposal(
  deps: StudioDeps,
  input: { employeeId: string; proposalId: string },
): Promise<ProposalEstimate> {
  const [last] = await deps.db
    .select()
    .from(mediaGenerations)
    .where(
      and(
        eq(mediaGenerations.proposalId, input.proposalId),
        eq(mediaGenerations.requestedBy, input.employeeId),
      ),
    )
    .orderBy(desc(mediaGenerations.createdAt))
    .limit(1);
  if (!last) throw new StudioRefusal('not_found', 'Proposta não encontrada.');
  const open = last.status === 'estimated' && last.estimateExpiresAt > deps.now();
  if (open) {
    return {
      estimate: {
        id: last.id,
        credits: last.creditsEstimated,
        brlCents: last.brlCentsEstimated,
        providerId: last.provider as MediaProviderId,
        expiresAt: last.estimateExpiresAt.toISOString(),
      },
      generationId: null,
    };
  }
  // Under way, done, or nobody knows: the card follows that generation instead.
  if (!['estimated', 'refused', 'failed'].includes(last.status)) {
    return { estimate: null, generationId: last.id };
  }
  const estimate = await createEstimate(deps, {
    employeeId: input.employeeId,
    proposalId: input.proposalId,
    request: last.request as MediaEstimateRequest,
  });
  if (estimate.blockedBy) {
    throw new StudioRefusal(estimate.blockedBy, MEDIA_REFUSAL_MESSAGE[estimate.blockedBy]);
  }
  await deps.db
    .update(agentProposals)
    .set({ status: 'open', actedBy: null, actedAt: null })
    .where(eq(agentProposals.id, input.proposalId));
  return {
    estimate: {
      id: estimate.id,
      credits: estimate.credits,
      brlCents: estimate.brlCents,
      providerId: estimate.providerId,
      expiresAt: estimate.expiresAt,
    },
    generationId: null,
  };
}

// ---------------------------------------------------------------------------
// Generating
// ---------------------------------------------------------------------------

async function sourceOf(deps: StudioDeps, row: GenerationRow) {
  return row.sourceAssetId
    ? ((await deps.db.query.mediaAssets.findFirst({
        where: eq(mediaAssets.id, row.sourceAssetId),
      })) ?? null)
    : null;
}

/**
 * Kairogen refused over the price and named the real one, with nothing generated
 * and nothing charged. A new estimate with that price and exactly the same
 * request and priced parameters goes on the record: the button shows it, and
 * spending it is a new click. Nothing is sent again from here.
 */
async function requote(
  deps: StudioDeps,
  refused: GenerationRow,
  credits: number,
): Promise<MediaEstimate> {
  const now = deps.now();
  const brlCents =
    refused.creditsEstimated > 0
      ? Math.round((refused.brlCentsEstimated * credits) / refused.creditsEstimated)
      : 0;
  const [row] = await deps.db
    .insert(mediaGenerations)
    .values({
      requestedBy: refused.requestedBy,
      operation: refused.operation,
      kind: refused.kind,
      model: refused.model,
      provider: refused.provider,
      prompt: refused.prompt,
      request: refused.request,
      priceArgs: refused.priceArgs,
      creditsEstimated: credits,
      brlCentsEstimated: brlCents,
      sourceAssetId: refused.sourceAssetId,
      proposalId: refused.proposalId,
      clientId: refused.clientId,
      campaign: refused.campaign,
      routedFrom: refused.routedFrom,
      estimateExpiresAt: new Date(now.getTime() + ESTIMATE_TTL_MS),
      createdAt: now,
    })
    .returning();
  if (!row) throw new Error('failed to record estimate');
  const usage = await usageOf(deps, refused.requestedBy, {
    withBalance: refused.provider === 'kairogen',
  });
  await ledger(deps.db, row, 'estimated', {
    creditsDelta: 0,
    brlCentsDelta: 0,
    balance: usage.balance,
    now,
  });
  const blocked = blockedBy(usage, {
    providerId: refused.provider as MediaProviderId,
    credits,
    brlCents,
  });
  return {
    id: row.id,
    credits,
    brlCents,
    providerId: refused.provider as MediaProviderId,
    expiresAt: row.estimateExpiresAt.toISOString(),
    request: refused.request as MediaEstimateRequest,
    blockedBy: blocked?.code ?? null,
    usage,
    routedFrom: null,
    warnings: [
      `O Kairogen cobra ${credits} créditos por esta geração, não os ${refused.creditsEstimated} da estimativa dele${refused.sourceAssetId ? ': ela não conta a imagem enviada' : ''}.`,
    ],
  };
}

export async function startGeneration(
  deps: StudioDeps,
  input: { employeeId: string; estimateId: string },
): Promise<GenerationRow & { requote?: MediaEstimate }> {
  if (!deps.storage) {
    throw new StudioRefusal(
      'invalid_request',
      'O armazenamento de mídia não está configurado neste ambiente.',
    );
  }
  const ctx = ctxOf(deps);
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
    const provider = providerById(deps.providers, row.provider as MediaProviderId);
    if (!provider?.configured) return refuse('provider_unavailable');

    const starts = periodStarts(now);
    const txDb = tx as unknown as Database;
    const fresh: MediaUsage = {
      ...usage,
      usedTodayByYou: await creditsCounted(txDb, starts.day, input.employeeId),
      usedThisMonth: await creditsCounted(txDb, starts.month),
      usedThisMonthBrlCents: await brlCounted(txDb, starts.month),
    };
    const blocked = blockedBy(fresh, {
      providerId: provider.id,
      credits: row.creditsEstimated,
      brlCents: row.brlCentsEstimated,
    });
    if (blocked) return new StudioRefusal(blocked.code, blocked.detail);
    // A free quota is counted from this same ledger: re-read under the lock, so two
    // clicks cannot both take the last picture of the day.
    if (provider.billing === 'free_quota') {
      const quantity = Number((row.priceArgs as { quantity?: unknown }).quantity ?? 1) || 1;
      const availability = await provider.availability(
        { db: txDb, now: deps.now },
        { outputs: quantity },
      );
      if (!availability.available) {
        return new StudioRefusal(
          'provider_unavailable',
          `${provider.name}: ${availability.reason}`,
        );
      }
    }

    // The spend is on the record BEFORE the provider hears of it: a crash between the
    // two leaves it counted but not spent, never the other way round.
    const [running] = await tx
      .update(mediaGenerations)
      .set({ status: 'running', startedAt: now })
      .where(eq(mediaGenerations.id, row.id))
      .returning();
    if (!running) throw new Error('failed to claim estimate');
    await ledger(txDb, running, 'started', {
      creditsDelta: running.creditsEstimated,
      brlCentsDelta: running.brlCentsEstimated,
      balance: usage.balance,
      now,
    });
    return running;
  });
  if (claimed instanceof StudioRefusal) throw claimed;
  const provider = providerOf(deps, claimed.provider as MediaProviderId);

  const finish = async (
    status: 'refused' | 'unknown',
    detail: string,
    givenBack: boolean,
  ): Promise<GenerationRow> => {
    const [row] = await deps.db
      .update(mediaGenerations)
      .set({ status, detail, finishedAt: deps.now() })
      .where(eq(mediaGenerations.id, claimed.id))
      .returning();
    if (!row) throw new Error('generation vanished');
    await ledger(deps.db, row, status, {
      creditsDelta: givenBack ? -claimed.creditsEstimated : 0,
      brlCentsDelta: givenBack ? -claimed.brlCentsEstimated : 0,
      now: deps.now(),
    });
    return row;
  };

  const source = await sourceOf(deps, claimed);
  let started;
  try {
    // Sent once. Whatever happens next, this call is never made again.
    started = await provider.start(ctx, {
      generationId: claimed.id,
      modelKey: claimed.model ?? '',
      request: claimed.request as MediaEstimateRequest,
      priceArgs: claimed.priceArgs as Record<string, unknown>,
      creditsEstimated: claimed.creditsEstimated,
      source: source ? asSource(source) : null,
      publicUrl: (purpose) =>
        source
          ? issuePublicLink(deps, {
              assetId: source.id,
              issuedBy: claimed.requestedBy,
              generationId: claimed.id,
              purpose,
            })
          : Promise.resolve(null),
      sourceBytes: () =>
        source
          ? readMedia({ storage: deps.storage, legacyDir: deps.mediaDir }, source)
          : Promise.resolve(null),
    });
  } catch (error) {
    if (error instanceof StudioRefusal) return finish('refused', error.message, true);
    if (!(error instanceof ProviderError)) throw error;
    if (error.code === 'rejected' && error.requotedCredits !== null) {
      const refused = await finish('refused', error.message, true);
      return { ...refused, requote: await requote(deps, refused, error.requotedCredits) };
    }
    // Nobody knows whether it arrived: the spend stays counted and nothing is sent again.
    if (error.code === 'outcome_unknown') return finish('unknown', error.message, false);
    return finish('refused', error.message, true);
  }

  if (started.done) {
    // The provider answered with the files in the same call: straight to the library.
    return settle(deps, claimed.id, {
      state: started.outputs.length > 0 ? 'succeeded' : 'failed',
      outputs: started.outputs,
      creditsCharged: started.creditsCharged,
      brlCentsCharged: started.brlCentsCharged,
      note:
        started.note ?? (started.outputs.length === 0 ? 'O provedor respondeu sem arquivo.' : null),
    });
  }

  const [row] = await deps.db
    .update(mediaGenerations)
    .set({
      externalGenerationId: started.externalId,
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

/** Closes a generation: its row, its ledger correction, and the balance after when Kairogen ran it. */
async function end(
  deps: StudioDeps,
  id: string,
  status: 'succeeded' | 'failed' | 'timed_out',
  detail: string | null,
  charged: { credits: number | null; brlCents: number | null },
): Promise<GenerationRow> {
  const [row] = await deps.db
    .update(mediaGenerations)
    .set({
      status,
      detail,
      creditsCharged: charged.credits,
      brlCentsCharged: charged.brlCents,
      finishedAt: deps.now(),
      nextPollAt: null,
    })
    .where(eq(mediaGenerations.id, id))
    .returning();
  if (!row) throw new Error('generation vanished');
  await ledger(deps.db, row, status, {
    // Once the real charge is known, the ledger is corrected by the difference.
    creditsDelta: charged.credits === null ? 0 : charged.credits - row.creditsEstimated,
    brlCentsDelta: charged.brlCents === null ? 0 : charged.brlCents - row.brlCentsEstimated,
    creditsCharged: charged.credits,
    brlCentsCharged: charged.brlCents,
    // The balance after: next to the one on the `started` row, it shows what really left.
    balance: row.provider === 'kairogen' ? await readBalance(deps) : null,
    now: deps.now(),
  });
  return row;
}

/** Every output into the library, then the row closed with what was saved. */
async function settle(
  deps: StudioDeps,
  id: string,
  result: {
    state: 'succeeded' | 'failed';
    outputs: ProviderOutput[];
    creditsCharged: number | null;
    brlCentsCharged: number | null;
    note: string | null;
  },
): Promise<GenerationRow> {
  const charged = { credits: result.creditsCharged, brlCents: result.brlCentsCharged };
  if (result.state === 'failed') {
    return end(
      deps,
      id,
      'failed',
      result.note ?? 'O provedor informou que a geração falhou.',
      charged,
    );
  }
  const current = await deps.db.query.mediaGenerations.findFirst({
    where: eq(mediaGenerations.id, id),
  });
  if (!current) throw new Error('generation vanished');
  const provider = providerById(deps.providers, current.provider as MediaProviderId);
  await deps.db
    .update(mediaGenerations)
    .set({ status: 'saving' })
    .where(eq(mediaGenerations.id, id));
  const request = current.request as MediaEstimateRequest;
  let saved = 0;
  for (const output of result.outputs) {
    const bytes = !deps.storage
      ? null
      : 'bytes' in output
        ? output.bytes
        : await download(deps, output.url);
    if (!bytes || !deps.storage) continue;
    const stored = await storeMedia(deps.db, deps.storage, {
      ownerId: current.requestedBy,
      origin: current.provider as MediaOrigin,
      bytes,
      prompt: current.prompt,
      model: current.model,
      credits: Math.round(current.creditsEstimated / Math.max(result.outputs.length, 1)),
      externalGenerationId: current.externalGenerationId,
      generationId: current.id,
      sourceAssetId: current.sourceAssetId,
      clientId: current.clientId,
      durationSeconds:
        'durationSeconds' in request && request.durationSeconds ? request.durationSeconds : null,
      now: deps.now(),
    });
    if (!stored.ok) continue;
    if ('url' in output) {
      await deps.db
        .update(mediaAssets)
        .set({ sourceUrl: output.url })
        .where(eq(mediaAssets.id, stored.id));
    }
    saved += 1;
  }
  const notes = [
    saved === result.outputs.length
      ? null
      : `${provider?.name ?? 'O provedor'} concluiu, mas ${result.outputs.length - saved} de ${result.outputs.length} arquivo(s) não puderam ser salvos.`,
    result.note,
  ].filter(Boolean);
  return end(
    deps,
    id,
    saved > 0 ? 'succeeded' : 'failed',
    notes.length > 0 ? notes.join(' ') : null,
    charged,
  );
}

/**
 * Moves one generation forward, if it is due: asks its provider once how it
 * stands, and when it is finished puts every output in the library. Safe to
 * call from a timer and from a request at the same time: the row is claimed by
 * pushing `next_poll_at` forward.
 */
export async function advanceGeneration(
  deps: StudioDeps,
  id: string,
): Promise<GenerationRow | null> {
  const now = deps.now();
  const current = await deps.db.query.mediaGenerations.findFirst({
    where: eq(mediaGenerations.id, id),
  });
  const provider = current
    ? providerById(deps.providers, current.provider as MediaProviderId)
    : undefined;
  if (
    !current ||
    current.status !== 'running' ||
    !current.externalGenerationId ||
    !provider?.configured
  ) {
    return current ?? null;
  }

  if (current.startedAt && now.getTime() - current.startedAt.getTime() > GIVE_UP_AFTER_MS) {
    return end(
      deps,
      id,
      'timed_out',
      `Passou de 20 minutos sem resposta final. Confira no ${provider.name}; o gasto continua contado.`,
      { credits: null, brlCents: null },
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
    state = await provider.poll(ctxOf(deps), current.externalGenerationId);
  } catch (error) {
    if (!(error instanceof ProviderError)) throw error;
    return claimed; // Unreachable for now: try again at the next interval.
  }
  if (state.state === 'running') return claimed;
  return settle(deps, id, {
    state: state.state,
    outputs: state.outputs,
    creditsCharged: state.creditsCharged,
    brlCentsCharged: state.brlCentsCharged,
    note: state.note,
  });
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
  const [requester, client, assets] = await Promise.all([
    db.query.employees.findFirst({ where: eq(employees.id, row.requestedBy) }),
    db.query.clients.findFirst({ where: eq(clients.id, row.clientId) }),
    // By our own id, or by the provider's for files saved before there was one.
    db
      .select({ id: mediaAssets.id })
      .from(mediaAssets)
      .where(
        or(
          eq(mediaAssets.generationId, row.id),
          row.externalGenerationId
            ? eq(mediaAssets.externalGenerationId, row.externalGenerationId)
            : undefined,
        ),
      ),
  ]);
  return {
    id: row.id,
    status: row.status,
    operation: row.operation as MediaGeneration['operation'],
    kind: row.kind,
    model: row.model,
    providerId: row.provider as MediaProviderId,
    prompt: row.prompt,
    creditsEstimated: row.creditsEstimated,
    creditsCharged: row.creditsCharged,
    brlCentsEstimated: row.brlCentsEstimated,
    detail: row.detail,
    requestedByName: requester?.fullName ?? null,
    createdAt: row.createdAt.toISOString(),
    finishedAt: row.finishedAt?.toISOString() ?? null,
    assetIds: assets.map((asset) => asset.id),
    clientId: row.clientId,
    clientName: client?.name ?? null,
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
