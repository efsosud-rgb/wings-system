import { z } from 'zod';
import { checkCopyCompliance, COMPLIANCE_RULE_LABEL } from '../ads/campaign-builder.js';
import { WINGS_CLIENT_ID } from '../clients.js';
import { MEDIA_PROVIDERS, type MediaProviderId } from './media-providers.js';

/**
 * Marketing → Edição de Fotos e Vídeos: what the studio, its agent and the API
 * agree on.
 *
 * The rule the whole contract is built around: nothing is generated without a
 * person's click, and the click always comes AFTER the cost in credits was
 * shown. So a generation cannot be asked for by its parameters — only by the
 * id of an estimate the server made a moment ago with those exact parameters.
 */

export const KAIROGEN_PLANS = ['free', 'essential', 'pro', 'precision', 'creator'] as const;
export type KairogenPlan = (typeof KAIROGEN_PLANS)[number];
export const DEFAULT_KAIROGEN_PLAN: KairogenPlan = 'free';
export const KAIROGEN_PLAN_LABEL: Record<KairogenPlan, string> = {
  free: 'Free',
  essential: 'Essential',
  pro: 'Pro',
  precision: 'Precision',
  creator: 'Creator',
};

export const DEFAULT_KAIROGEN_DAILY_CREDITS_PER_USER = 30;
export const DEFAULT_KAIROGEN_MONTHLY_CREDITS = 500;

/** Kairogen's own limits per call, from its published tool schemas. */
export const MAX_IMAGES_PER_GENERATION = 4;
export const MAX_VIDEOS_PER_GENERATION = 2;

/** The ad shapes the studio offers. Whether a model takes one is the model's business. */
export const GENERATION_ASPECTS = ['1:1', '4:5', '9:16', '16:9'] as const;
export type GenerationAspect = (typeof GENERATION_ASPECTS)[number];

export const PROMPT_MAX = 2000;

// ---------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------

/** A parameter of a model that changes the price, as its `param_schema` describes it. */
export interface MediaPriceParam {
  /** The key Kairogen expects: size, quality, resolution, turbo, generate_audio, sound… */
  key: string;
  label: string;
  type: 'choice' | 'boolean';
  options: string[];
  defaultValue: string | boolean | null;
}

export const MEDIA_IMAGE_USES = ['reference', 'edit'] as const;
export type MediaImageUse = (typeof MEDIA_IMAGE_USES)[number];
export const MEDIA_IMAGE_USE_LABEL: Record<MediaImageUse, string> = {
  reference: 'Como referência para uma imagem nova',
  edit: 'Editar esta imagem',
};

/** The models that can do `use` with a picture, cheapest first, for "try one of these". */
export function modelsForImageUse(models: MediaModel[], use: MediaImageUse): MediaModel[] {
  return models
    .filter((model) => model.kind === 'image' && model.imageUse === use)
    .sort((a, b) => (a.creditsPerOutput ?? 9e9) - (b.creditsPerOutput ?? 9e9));
}

export interface MediaModel {
  /** Unique across providers: Kairogen's keys are bare, every other provider's start with its id. */
  key: string;
  name: string;
  /** The service that runs it for us. */
  providerId: MediaProviderId;
  /** Who made the model (ByteDance, OpenAI…), when the provider says. Not the provider. */
  provider: string | null;
  kind: 'image' | 'video';
  /**
   * Credits for one output with the model's default parameters, on the account's
   * plan. Kairogen's catalog prices in money, not credits, so this is what
   * `estimate_cost` answered for the model; null while that is not known.
   * Zero on every provider that does not count in credits.
   */
  creditsPerOutput: number | null;
  /**
   * What one output costs in reais, estimated: 0 on a free quota or our own
   * service, the provider's price converted for pay-per-use, credits times the
   * configured value on Kairogen. Null while it is not known.
   */
  brlCentsPerOutput: number | null;
  /** How many outputs one generation may ask for. */
  maxOutputs: number;
  /** Video only. Empty when the catalog does not list them: the duration is then left out. */
  supportedDurations: number[];
  /** Null when the catalog does not restrict them. */
  aspectRatios: string[] | null;
  priceParams: MediaPriceParam[];
  /**
   * Image models: what the model does with a picture it is handed. `reference`:
   * it inspires a new picture. `edit`: the picture itself is changed (the model
   * only takes one in its edit mode). Null: it takes none.
   */
  imageUse: MediaImageUse | null;
  /** `imageUse !== null`, kept for the callers that only ask yes or no. */
  acceptsReferenceImage: boolean;
  /** Video: needs (or takes) a first frame, i.e. image-to-video. */
  acceptsFirstFrame: boolean;
}

// ---------------------------------------------------------------------------
// Asking for an estimate
// ---------------------------------------------------------------------------

const paramValue = z.union([z.string().trim().min(1).max(60), z.boolean(), z.number()]);

function refuseBlocked(ctx: z.RefinementCtx, text: string): void {
  for (const finding of checkCopyCompliance(text)) {
    ctx.addIssue({
      code: 'custom',
      path: ['prompt'],
      message: `${COMPLIANCE_RULE_LABEL[finding.rule]}: "${finding.excerpt}"`,
    });
  }
}

const generateSpec = z
  .object({
    operation: z.literal('generate'),
    kind: z.enum(['image', 'video']),
    model: z.string().trim().min(1).max(120),
    prompt: z.string().trim().min(3, 'Escreva o prompt').max(PROMPT_MAX),
    negativePrompt: z.string().trim().max(600).optional(),
    aspect: z.enum(GENERATION_ASPECTS),
    quantity: z.number().int().min(1).max(MAX_IMAGES_PER_GENERATION).default(1),
    /** Video only, and only one of the model's supported durations. */
    durationSeconds: z.number().positive().max(120).optional(),
    /** Price-affecting parameters, by the model's own keys. */
    params: z.record(z.string().regex(/^[a-z][a-z0-9_]{0,40}$/), paramValue).default({}),
    /** A library image used as reference or edited (image), or as first frame (video). */
    referenceAssetId: z.uuid().optional(),
    /** Image only: what is done with `referenceAssetId`. The model has to be one that does it. */
    referenceUse: z.enum(MEDIA_IMAGE_USES).default('reference'),
    /**
     * Who it is for. Filing only: it is stored with the generation, the ledger
     * and the asset, and is never part of what Kairogen is sent.
     */
    clientId: z.uuid().default(WINGS_CLIENT_ID),
    /**
     * The campaign this is for, when one is open in the builder. Filing only:
     * with it, "same model within the same campaign" is checked per campaign,
     * not per client.
     */
    campaign: z.string().trim().min(1).max(120).optional(),
  })
  .superRefine((spec, ctx) => {
    if (spec.kind === 'video' && spec.quantity > MAX_VIDEOS_PER_GENERATION) {
      ctx.addIssue({
        code: 'custom',
        path: ['quantity'],
        message: `No máximo ${MAX_VIDEOS_PER_GENERATION} vídeos por geração`,
      });
    }
    if (spec.kind === 'image' && spec.durationSeconds !== undefined) {
      ctx.addIssue({ code: 'custom', path: ['durationSeconds'], message: 'Duração é só de vídeo' });
    }
    // Text that ends up inside an ad is held to the ad rules here too.
    refuseBlocked(ctx, spec.prompt);
  });

const upscaleSpec = z.object({
  operation: z.literal('upscale'),
  assetId: z.uuid(),
  scale: z.union([z.literal(2), z.literal(4)]),
});

const animateSpec = z.object({
  operation: z.literal('animate'),
  /** Must be an image generated at Kairogen: it is animated by its generation id. */
  assetId: z.uuid(),
  prompt: z.string().trim().max(PROMPT_MAX).optional(),
  videoModel: z.string().trim().min(1).max(120).optional(),
  durationSeconds: z.number().positive().max(120).optional(),
});

export const mediaEstimateRequestSchema = z.union([generateSpec, upscaleSpec, animateSpec]);
export type MediaEstimateRequest = z.output<typeof mediaEstimateRequestSchema>;
export type MediaGenerateSpec = z.output<typeof generateSpec>;
export const mediaGenerateSpecSchema = generateSpec;

// ---------------------------------------------------------------------------
// Estimates, generations, usage
// ---------------------------------------------------------------------------

export interface MediaUsage {
  plan: KairogenPlan;
  /** Null when Kairogen's answer had no number in it. */
  balance: number | null;
  usedTodayByYou: number;
  dailyLimitPerUser: number;
  usedThisMonth: number;
  monthlyLimit: number;
  /** Every provider together, in reais estimated, against MEDIA_MONTHLY_BRL. */
  usedThisMonthBrlCents: number;
  monthlyLimitBrlCents: number;
}

/** Another model that can do the same, offered when the chosen provider cannot right now. */
export interface MediaAlternative {
  model: string;
  name: string;
  providerId: MediaProviderId;
  credits: number | null;
  brlCents: number | null;
}

export interface MediaEstimate {
  id: string;
  /** Kairogen credits. Zero on every other provider. */
  credits: number;
  /** In reais estimated, whatever the provider: what "Gerar" will show. R$ 0 is a price too. */
  brlCents: number;
  providerId: MediaProviderId;
  /** After this the estimate is stale and "Gerar" asks for a new one. */
  expiresAt: string;
  request: MediaEstimateRequest;
  /** Why this estimate cannot be generated right now, when it cannot. */
  blockedBy: MediaRefusal | null;
  usage: MediaUsage;
  /**
   * Set when the model asked for could not be served and a cheaper (or free)
   * one took its place without asking: the switch is said, never silent.
   */
  routedFrom: { model: string; providerId: MediaProviderId; reason: string } | null;
  /** Things worth knowing before the click: mixing models in one campaign, an unverified provider. */
  warnings: string[];
}

export const MEDIA_REFUSALS = [
  'daily_limit',
  'monthly_limit',
  'monthly_brl_limit',
  'insufficient_credits',
  'estimate_expired',
  'estimate_used',
  'not_connected',
  'provider_unavailable',
] as const;
export type MediaRefusal = (typeof MEDIA_REFUSALS)[number];

export const MEDIA_REFUSAL_MESSAGE: Record<MediaRefusal, string> = {
  daily_limit: 'Você atingiu o seu limite de créditos de hoje.',
  monthly_limit: 'O limite de créditos do mês foi atingido.',
  monthly_brl_limit: 'O teto mensal em reais de todos os provedores de mídia seria ultrapassado.',
  insufficient_credits: 'O saldo da conta no Kairogen não cobre esta geração.',
  estimate_expired: 'A estimativa venceu. Estime o custo de novo.',
  estimate_used: 'Esta estimativa já foi usada. Estime o custo de novo.',
  not_connected: 'Nenhum provedor de mídia está disponível. Peça a um Admin Master para conectar.',
  provider_unavailable: 'Este provedor não pode atender agora.',
};

export const GENERATION_STATUSES = [
  'estimated',
  'running',
  'saving',
  'succeeded',
  'failed',
  'refused',
  'unknown',
  'timed_out',
] as const;
export type GenerationStatus = (typeof GENERATION_STATUSES)[number];

export const GENERATION_STATUS_LABEL: Record<GenerationStatus, string> = {
  estimated: 'Estimada',
  running: 'Gerando',
  saving: 'Salvando na biblioteca',
  succeeded: 'Concluída',
  failed: 'Falhou',
  refused: 'Recusada pelo provedor',
  unknown: 'Resultado desconhecido',
  timed_out: 'Passou de 20 minutos',
};

export const isGenerationOver = (status: GenerationStatus) =>
  !['estimated', 'running', 'saving'].includes(status);

export interface MediaGeneration {
  id: string;
  status: GenerationStatus;
  operation: 'generate' | 'upscale' | 'animate';
  kind: 'image' | 'video';
  model: string | null;
  providerId: MediaProviderId;
  prompt: string | null;
  creditsEstimated: number;
  /** What Kairogen says it charged, when it says. */
  creditsCharged: number | null;
  /** In reais estimated, for the record and the monthly ceiling. */
  brlCentsEstimated: number;
  /** In words for the screen. Never a provider message that could hold a secret. */
  detail: string | null;
  requestedByName: string | null;
  createdAt: string;
  finishedAt: string | null;
  /** Library assets this generation produced, once saved. */
  assetIds: string[];
  clientId: string;
  clientName: string | null;
}

//   GET  /media/studio                 -> { usage, connected, anyAvailable, storageAvailable }   marketing.media.read
//   GET  /media/models?kind=           -> { models: MediaModel[], cachedAt }       marketing.media.read
//        every provider's models together; `brlCentsPerOutput` null (and `creditsPerOutput`
//        null) when the price is only known at the estimate: the screen then says so.
//   POST /media/estimates              -> { estimate: MediaEstimate }              marketing.media.generate
//        409 provider_unavailable may carry `alternative: MediaAlternative` when a costlier
//        model elsewhere could do it: switching up is a click, never automatic.
//   POST /media/generations            -> { generation }  body { estimateId }      marketing.media.generate
//   GET  /media/generations            -> { generations } the latest, newest first marketing.media.read
//   GET  /media/generations/:id        -> { generation }  (also moves it forward)  marketing.media.read
//   POST /media/assets/:id/use-in-builder -> MediaBridgeResponse                   ads.request
//   GET  /media/public/:linkId?sig=    -> the file, NO login: a signed link for Kairogen, 15 minutes

export const generationStartSchema = z.object({
  estimateId: z.uuid(),
  /** When the click was on an agent's card. */
  proposalId: z.uuid().optional(),
});

/** A library asset made usable by the campaign builder. */
export interface MediaBridgeResponse {
  mediaAssetId: string;
  creative: {
    id: string;
    mimeType: 'image/png' | 'image/jpeg';
    width: number;
    height: number;
    byteSize: number;
  } | null;
  video: { id: string; mimeType: string; byteSize: number } | null;
}

// ---------------------------------------------------------------------------
// The editing agent's proposal
// ---------------------------------------------------------------------------

/**
 * What `propor_geracao` must carry. The prompt goes to the model in English;
 * the person reads the explanation in Portuguese. Completeness is enforced: a
 * proposal is a finished brief, not a suggestion to be filled in later.
 */
export const agentGenerationProposalSchema = z
  .object({
    kind: z.enum(['image', 'video']),
    /** The provider the model belongs to, as `listar_modelos` says. Checked against the model. */
    provider: z.enum(
      MEDIA_PROVIDERS,
      'Diga o provedor: use o valor de "provedor" que listar_modelos devolve para o modelo escolhido.',
    ),
    model: z.string().trim().min(1).max(120),
    /** English, for the generation model. */
    prompt: z
      .string()
      .trim()
      .min(40, 'O prompt precisa descrever cena, luz, enquadramento e estilo')
      .max(PROMPT_MAX),
    negativePrompt: z.string().trim().max(600).optional(),
    /** Portuguese, for the person: what the picture will show and why. */
    explanation: z.string().trim().min(20).max(800),
    aspect: z.enum(GENERATION_ASPECTS),
    quantity: z.number().int().min(1).max(MAX_IMAGES_PER_GENERATION),
    durationSeconds: z.number().positive().max(120).optional(),
    params: z.record(z.string().regex(/^[a-z][a-z0-9_]{0,40}$/), paramValue).default({}),
    referenceAssetId: z.uuid().optional(),
    /** With `referenceAssetId`: `reference` or `edit`, as `listar_modelos` says the model does. */
    referenceUse: z.enum(MEDIA_IMAGE_USES).default('reference'),
    /**
     * Who it is for, by the id `listar_clientes` gave. Required: when the request
     * does not say, the agent asks instead of assuming.
     */
    clientId: z.uuid(
      'Diga para qual cliente é: use o id que listar_clientes devolve. Se o pedido não disse, pergunte "Para qual cliente?"',
    ),
    /** Whether the picture carries written words. Only when the person asked for them. */
    textInImage: z.string().trim().max(120).nullable().default(null),
  })
  .superRefine((proposal, ctx) => {
    if (proposal.kind === 'video' && proposal.quantity > MAX_VIDEOS_PER_GENERATION) {
      ctx.addIssue({
        code: 'custom',
        path: ['quantity'],
        message: 'No máximo 2 vídeos por geração',
      });
    }
    refuseBlocked(ctx, proposal.prompt);
    if (proposal.textInImage) refuseBlocked(ctx, proposal.textInImage);
  });
export type AgentGenerationProposal = z.output<typeof agentGenerationProposalSchema>;
