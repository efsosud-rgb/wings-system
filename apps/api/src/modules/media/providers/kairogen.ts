import {
  DEFAULT_KAIROGEN_PLAN,
  KAIROGEN_PLAN_LABEL,
  KAIROGEN_PLANS,
  MEDIA_REFUSAL_MESSAGE,
  kairogenMinimumPlan,
  kairogenPlanRank,
  type KairogenPlan,
  type MediaModel,
} from '@wings/shared';
import { and, eq, gte, sql } from 'drizzle-orm';
import type { Database } from '../../../db/client.js';
import {
  integrationConnections,
  mediaCreditLedger,
  mediaGenerations,
} from '../../../db/schema/index.js';
import { McpError, type McpToolResult } from '../../../lib/mcp-client/index.js';
import { scrubSensitive } from '../../agent/scrub.js';
import {
  callKairogen,
  creditsFrom,
  PROVIDER,
  type KairogenDeps,
} from '../../integrations/kairogen/service.js';
import {
  creditCostFrom,
  generationIdFrom,
  generationStateFrom,
  isCreditMismatch,
  modelsFrom,
  requotedCreditsFrom,
  shapeOf,
} from '../kairogen-adapter.js';
import { periodStarts } from './quota.js';
import {
  ProviderError,
  type MediaProvider,
  type ProviderContext,
  type ProviderOutput,
  type ShapeNoter,
  type StartInput,
} from './types.js';

/** Kairogen credits counted against the month, from the ledger. */
async function creditsCounted(db: Database, since: Date): Promise<number> {
  const [row] = await db
    .select({ total: sql<string>`coalesce(sum(${mediaCreditLedger.creditsDelta}), 0)` })
    .from(mediaCreditLedger)
    .where(and(gte(mediaCreditLedger.createdAt, since), eq(mediaCreditLedger.provider, PROVIDER)));
  return Number(row?.total ?? 0);
}

/**
 * Kairogen behind the provider contract: the first provider, and the one whose
 * formats were read from the real service (docs/integracoes/kairogen.md). What
 * it does did not change with the contract: `list_models` once an hour per
 * plan, `estimate_cost` for every price, one spending call with
 * `expected_credits`, `get_generation` to follow.
 */

const MODEL_CACHE_MS = 60 * 60_000;
const DEFAULT_ANIMATION_MODEL = 'seedance-v2-0-image-to-video';
/**
 * The top-level arguments each tool declares (docs/integracoes/kairogen-tools.json).
 * Anything else goes in `extra_params`: Kairogen drops an undeclared top-level
 * key, so `resolution` sent loose to `generate_image` was priced by
 * `estimate_cost` (which declares it) and then lost at generation, and the
 * charge no longer matched the quote (GENERATION_QUOTE_MISMATCH, 2026-09-24).
 */
const TOOL_ARGS = {
  estimate_cost: [
    'model',
    'plan_key',
    'quantity',
    'duration_seconds',
    'generate_audio',
    'quality',
    'resolution',
    'size',
    'sound',
    'turbo',
  ],
  generate_image: ['model', 'quantity', 'quality', 'size', 'seed'],
  generate_video: [
    'model',
    'quantity',
    'duration_seconds',
    'generate_audio',
    'quality',
    'resolution',
    'seed',
    'turbo',
  ],
} as const satisfies Record<string, readonly string[]>;

/**
 * The priced parameters of an estimate, laid out for `tool`: declared keys at the
 * top, every other one inside `extra_params`. The plan is only `estimate_cost`'s.
 */
export function pricedArgsFor(
  tool: keyof typeof TOOL_ARGS,
  priced: Record<string, unknown>,
): Record<string, unknown> {
  const declared: readonly string[] = TOOL_ARGS[tool];
  const top: Record<string, unknown> = {};
  const extra: Record<string, unknown> = {};
  const nested = priced.extra_params;
  if (nested !== null && typeof nested === 'object') Object.assign(extra, nested);
  for (const [key, value] of Object.entries(priced)) {
    if (key === 'extra_params' || value === undefined) continue;
    if (key === 'plan_key' && tool !== 'estimate_cost') continue;
    if (declared.includes(key)) top[key] = value;
    else extra[key] = value;
  }
  return Object.keys(extra).length > 0 ? { ...top, extra_params: extra } : top;
}

/**
 * Every priced parameter of a call, flattened the way Kairogen prices it (top
 * level and `extra_params` together), without the plan and the arguments that
 * do not change the price. Estimate and generation must agree on this, key by key.
 */
export function pricedParamsOf(args: Record<string, unknown>): Record<string, unknown> {
  const unpriced = new Set([
    'plan_key',
    'extra_params',
    'prompt',
    'negative_prompt',
    'aspect_ratio',
    'reference_image_urls',
    'first_frame_url',
    'last_frame_url',
    'expected_credits',
    'wait_for_completion',
    'timeout_seconds',
    'seed',
  ]);
  const nested =
    args.extra_params !== null && typeof args.extra_params === 'object'
      ? (args.extra_params as Record<string, unknown>)
      : {};
  return Object.fromEntries(
    Object.entries({ ...args, ...nested }).filter(([key]) => !unpriced.has(key)),
  );
}

/** Pricing the selector: a few `estimate_cost` at a time, and never holding the screen for long. */
const PRICING_CONCURRENCY = 4;
const PRICING_BUDGET_MS = 8_000;

export interface KairogenProviderConfig {
  /** Null without INTEGRATIONS_ENCRYPTION_KEY: the provider is then not configured. */
  kairogen: KairogenDeps | null;
  db: Database;
  /** Reais per credit for the one ceiling every provider counts against. Zero: credits are already paid for. */
  brlPerCredit: number;
  /** KAIROGEN_MONTHLY_CREDITS: with the month's credits gone, Kairogen cannot serve and the router moves on. */
  monthlyCredits: number;
  noteShape?: ShapeNoter;
}

// ---------------------------------------------------------------------------
// Plan and catalog cache
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

interface Catalog {
  at: number;
  models: MediaModel[];
  /** Models `estimate_cost` was already asked about, whatever it answered. */
  asked: Set<string>;
}
const modelCache = new Map<string, Catalog>();
export const clearModelCache = () => modelCache.clear();

/**
 * Models Kairogen itself refused on this plan (PLAN_UPGRADE_REQUIRED, kept in
 * the generation's detail). Its word beats the published table.
 */
async function refusedOnPlan(db: Database, plan: KairogenPlan): Promise<Set<string>> {
  const rows = await db
    .selectDistinct({ model: mediaGenerations.model })
    .from(mediaGenerations)
    .where(
      and(
        eq(mediaGenerations.provider, PROVIDER),
        eq(mediaGenerations.status, 'refused'),
        sql`${mediaGenerations.detail} like '%PLAN_UPGRADE_REQUIRED%'`,
        sql`${mediaGenerations.priceArgs}->>'plan_key' = ${plan}`,
      ),
    );
  return new Set(rows.flatMap((row) => (row.model ? [row.model] : [])));
}

/** The plan a model needs beyond the contracted one, or null when it is open. */
export function planRequiredFor(
  model: Pick<MediaModel, 'key' | 'kind'>,
  plan: KairogenPlan,
  refused: ReadonlySet<string>,
): KairogenPlan | null {
  const published = kairogenMinimumPlan(model.key, model.kind);
  if (kairogenPlanRank(published) > kairogenPlanRank(plan)) return published;
  if (!refused.has(model.key)) return null;
  // Kairogen said no on this plan although the table says yes: at least the next one.
  return KAIROGEN_PLANS[kairogenPlanRank(plan) + 1] ?? plan;
}

/** Kairogen said something went wrong: what that means for the person, never its raw words as orders. */
function fromMcp(error: unknown, spending = false): ProviderError {
  if (error instanceof McpError && error.code === 'unauthorized') {
    return new ProviderError(
      'unauthorized',
      'O Kairogen não está conectado. Peça a um Admin Master para conectar.',
    );
  }
  if (error instanceof McpError && error.outcomeUnknown) {
    return new ProviderError(
      'outcome_unknown',
      'Não sabemos se o Kairogen recebeu o pedido. Confira no Kairogen antes de gerar de novo.',
    );
  }
  if (error instanceof McpError && (error.code === 'tool_error' || error.code === 'rejected')) {
    return new ProviderError(
      'rejected',
      spending
        ? `O Kairogen recusou a geração. Resposta dele: ${scrubSensitive(error.message).slice(0, 300)}`
        : `O Kairogen não estimou o custo: ${scrubSensitive(error.message).slice(0, 300)}`,
    );
  }
  if (error instanceof McpError) {
    return new ProviderError('unavailable', 'O Kairogen não respondeu agora. Tente em instantes.');
  }
  throw error;
}

export function kairogenProvider(config: KairogenProviderConfig): MediaProvider {
  const configured = config.kairogen !== null;
  const brl = (credits: number | null) =>
    credits === null ? null : Math.ceil(credits * config.brlPerCredit * 100 - 1e-9);

  /**
   * Every call from the studio goes through here, so that the FORMAT of what
   * Kairogen answers is on record: key names, types and numbers, with every
   * string reduced to its length (`shapeOf`).
   */
  async function ask(
    tool: Parameters<typeof callKairogen>[1],
    args: Record<string, unknown> = {},
    options: { timeoutMs?: number } = {},
  ): Promise<McpToolResult> {
    if (!config.kairogen)
      throw new ProviderError('unauthorized', MEDIA_REFUSAL_MESSAGE.not_connected);
    const result = await callKairogen(config.kairogen, tool, args, options);
    if (config.noteShape) {
      const structured = result.data !== null && typeof result.data === 'object';
      config.noteShape({
        tool,
        shape: shapeOf(result.data),
        text: structured ? null : result.text.slice(0, 300).replace(/\p{L}/gu, 'a'),
      });
    }
    return result;
  }

  async function connectedState(db: Database): Promise<boolean> {
    if (!config.kairogen) return false;
    const row = await db.query.integrationConnections.findFirst({
      where: eq(integrationConnections.provider, PROVIDER),
    });
    return row?.state === 'connected';
  }

  /**
   * Kairogen's catalog prices in money (BRL plus a markup), not in credits, so
   * the only honest "credits per output" is what `estimate_cost` answers for the
   * model with its default parameters. It is a read: it spends nothing and leaves
   * no estimate behind. Asked once per model per hour; a model it cannot price
   * (a video that needs a duration, a supplier hiccup) stays "custo na estimativa".
   */
  async function priceCatalog(
    plan: KairogenPlan,
    catalog: Catalog,
    kind: 'image' | 'video' | undefined,
  ): Promise<void> {
    const queue = catalog.models.filter(
      (model) => (!kind || model.kind === kind) && !catalog.asked.has(model.key),
    );
    if (queue.length === 0) return;
    for (const model of queue) catalog.asked.add(model.key);
    const worker = async () => {
      for (let model = queue.shift(); model; model = queue.shift()) {
        try {
          const args = { model: model.key, plan_key: plan, quantity: 1 };
          model.creditsPerOutput = creditCostFrom(await ask('estimate_cost', args));
          model.brlCentsPerOutput = brl(model.creditsPerOutput);
        } catch {
          // No price for this one. The estimate the person asks for is what counts anyway.
        }
      }
    };
    const all = Promise.all(Array.from({ length: PRICING_CONCURRENCY }, worker));
    // Whatever is not priced within the budget keeps being priced, into the same cache.
    await Promise.race([all, new Promise((done) => setTimeout(done, PRICING_BUDGET_MS).unref())]);
  }

  /** The live catalog, kept for an hour per plan: prices are per plan. */
  async function listModels(
    ctx: ProviderContext,
    options: { priced?: 'image' | 'video' | 'all' } = {},
  ): Promise<MediaModel[]> {
    if (!configured || !(await connectedState(ctx.db))) return [];
    const plan = await planOf(ctx.db);
    const now = ctx.now().getTime();
    try {
      let catalog = modelCache.get(plan);
      if (!catalog || now - catalog.at >= MODEL_CACHE_MS) {
        const models = modelsFrom(await ask('list_models', {}));
        catalog = { at: now, models, asked: new Set() };
        modelCache.set(plan, catalog);
      }
      if (options.priced) {
        await priceCatalog(plan, catalog, options.priced === 'all' ? undefined : options.priced);
      }
      const refused = await refusedOnPlan(ctx.db, plan);
      return catalog.models.map((model) => ({
        ...model,
        planRequired: planRequiredFor(model, plan, refused),
      }));
    } catch (error) {
      throw fromMcp(error);
    }
  }

  /** What `get_credits` says right now, or null when it cannot be asked or has no number in it. */
  async function readCredits(ctx: ProviderContext): Promise<number | null> {
    if (!configured) return null;
    try {
      return creditsFrom(await ask('get_credits'), ctx.now()).balance;
    } catch (error) {
      if (error instanceof McpError) return null;
      throw error;
    }
  }

  /** The arguments of the spending call: the stored request, the stored price args, the quote. */
  async function toolCallFor(
    ctx: ProviderContext,
    input: StartInput,
  ): Promise<{
    tool: 'generate_image' | 'generate_video' | 'upscale_image' | 'animate_from_generation';
    args: Record<string, unknown>;
  }> {
    const request = input.request;
    const source = input.source;
    /** Kairogen's own address when the picture came from there; a signed link of ours otherwise. */
    const publicUrl = async (purpose: string) =>
      source ? (source.sourceUrl ?? (await input.publicUrl(purpose))) : null;

    if (request.operation === 'upscale') {
      if (!source) throw new ProviderError('rejected', 'A imagem de origem não existe mais.');
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
        throw new ProviderError('rejected', 'A imagem de origem não existe mais.');
      return {
        tool: 'animate_from_generation',
        args: {
          generation_id: source.externalGenerationId,
          video_model: input.modelKey,
          ...(request.prompt ? { prompt: request.prompt } : {}),
          ...(request.durationSeconds !== undefined
            ? { duration_seconds: request.durationSeconds }
            : {}),
          // Its default is to block for minutes. Like every other generation: an id now, polling after.
          wait_for_completion: false,
        },
      };
    }

    const reference = await publicUrl(request.kind === 'video' ? 'first_frame' : 'reference_image');
    const model = (await listModels(ctx)).find((item) => item.key === input.modelKey);
    const tool = request.kind === 'video' ? 'generate_video' : 'generate_image';
    return {
      tool,
      args: {
        // Exactly the priced parameters of the estimate, placed where this tool reads them.
        ...pricedArgsFor(tool, input.priceArgs),
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
        expected_credits: input.creditsEstimated,
        wait_for_completion: false,
      },
    };
  }

  return {
    id: 'kairogen',
    name: 'Kairogen',
    billing: 'credits',
    capabilities: ['generate_image', 'generate_video', 'animate', 'upscale'],
    verified: true,
    configured,

    async availability(ctx) {
      if (!configured) {
        return { available: false, reason: 'Sem INTEGRATIONS_ENCRYPTION_KEY no ambiente.' };
      }
      if (!(await connectedState(ctx.db))) {
        return {
          available: false,
          reason: 'O Kairogen não está conectado. Peça a um Admin Master para conectar.',
        };
      }
      // The month's credits are what this provider runs on: none left, nothing to serve with.
      const used = await creditsCounted(ctx.db, periodStarts(ctx.now()).month);
      if (used >= config.monthlyCredits) {
        return {
          available: false,
          reason: `O limite de créditos do mês no Kairogen foi atingido (${used} de ${config.monthlyCredits}).`,
        };
      }
      return { available: true, reason: null };
    },

    async balance(ctx) {
      if (!(await connectedState(ctx.db))) return null;
      const credits = await readCredits(ctx);
      return { credits, usd: null, brlCents: brl(credits) };
    },

    async quota() {
      return null;
    },

    listModels,

    async estimate(ctx, request) {
      const plan = await planOf(ctx.db);
      let priceArgs: Record<string, unknown>;
      if (request.operation === 'upscale') {
        priceArgs = {
          model: request.model.key,
          plan_key: plan,
          quantity: 1,
          extra_params: { scale: request.scale },
        };
      } else {
        priceArgs = pricedArgsFor('estimate_cost', {
          model: request.model.key,
          plan_key: plan,
          quantity: request.quantity,
          ...request.params,
          ...(request.durationSeconds !== undefined
            ? { duration_seconds: request.durationSeconds }
            : {}),
        });
      }
      let credits: number | null;
      try {
        credits = creditCostFrom(await ask('estimate_cost', priceArgs));
      } catch (error) {
        throw fromMcp(error);
      }
      if (credits === null || credits < 0) {
        throw new ProviderError(
          'rejected',
          'O Kairogen respondeu sem um custo em créditos. Sem estimativa, nada é gerado.',
        );
      }
      return { credits, brlCents: brl(credits) ?? 0, priceArgs };
    },

    async start(ctx, input) {
      const call = await toolCallFor(ctx, input);
      let externalId: string | null;
      try {
        // Sent once. `callKairogen` never retries a tool that spends.
        externalId = generationIdFrom(await ask(call.tool, call.args, { timeoutMs: 60_000 }));
      } catch (error) {
        const failure = fromMcp(error, true);
        if (failure.code === 'rejected' && /PLAN_UPGRADE_REQUIRED/.test(failure.message)) {
          const planKey = String(input.priceArgs.plan_key ?? '');
          const plan = KAIROGEN_PLANS.includes(planKey as KairogenPlan)
            ? (planKey as KairogenPlan)
            : await planOf(ctx.db);
          const model = {
            key: input.modelKey,
            kind:
              input.request.operation === 'generate' && input.request.kind === 'video'
                ? ('video' as const)
                : ('image' as const),
          };
          const needed = planRequiredFor(model, plan, new Set([input.modelKey])) ?? plan;
          // The code stays in the text: it is how the catalog learns this model is closed here.
          throw new ProviderError(
            'rejected',
            `O modelo ${input.modelKey} não está no plano ${KAIROGEN_PLAN_LABEL[plan]} do Kairogen: ele exige o plano ${KAIROGEN_PLAN_LABEL[needed]} ou superior (PLAN_UPGRADE_REQUIRED). Nada foi gerado nem cobrado. Escolha um modelo do plano contratado ou mude o plano em Integrações.`,
          );
        }
        if (failure.code === 'rejected' && isCreditMismatch(failure.message)) {
          const requoted = requotedCreditsFrom(failure.message);
          if (requoted !== null) {
            // Kairogen named the real price (an edit with a picture, which `estimate_cost`
            // cannot be told about, is how it happens). Nothing was generated or charged.
            throw new ProviderError(
              'rejected',
              `O Kairogen cobra ${requoted} créditos por esta geração, não os ${input.creditsEstimated} da estimativa${input.source ? ' (a estimativa dele não conta a imagem enviada)' : ''}. Nada foi gerado nem cobrado. O novo preço já está no botão.`,
              requoted,
            );
          }
          throw new ProviderError(
            'rejected',
            `O Kairogen recusou: o custo real difere do estimado (${input.creditsEstimated} créditos). Estime de novo. ${failure.message.replace(/^O Kairogen recusou a geração\. /, '')}`,
          );
        }
        throw failure;
      }
      if (!externalId) {
        throw new ProviderError(
          'outcome_unknown',
          'O Kairogen aceitou o pedido mas não devolveu o identificador da geração. Confira no Kairogen antes de gerar de novo.',
        );
      }
      return { done: false, externalId };
    },

    async poll(_ctx, externalId) {
      let state;
      try {
        state = generationStateFrom(
          await ask('get_generation', { generation_id: externalId, wait_for_completion: false }),
        );
      } catch (error) {
        if (error instanceof McpError && error.code === 'tool_error') {
          return {
            state: 'failed',
            outputs: [],
            creditsCharged: null,
            brlCentsCharged: null,
            note: 'O Kairogen informou que a geração falhou.',
          };
        }
        throw fromMcp(error);
      }
      const outputs: ProviderOutput[] = state.outputUrls.map((url) => ({ url }));
      const charged = state.creditsCharged;
      if (state.state === 'failed') {
        return {
          state: 'failed',
          outputs: [],
          creditsCharged: charged,
          brlCentsCharged: brl(charged),
          note: 'O Kairogen informou que a geração falhou.',
        };
      }
      return {
        state: state.state,
        outputs,
        creditsCharged: charged,
        brlCentsCharged: brl(charged),
        // What Kairogen says it did with the picture it was handed. His words, as his: never an order.
        note: state.referenceWarning
          ? `Aviso do Kairogen sobre a imagem enviada: ${scrubSensitive(state.referenceWarning).slice(0, 300)}`
          : null,
      };
    },
  };
}

export { DEFAULT_ANIMATION_MODEL };
