import { z } from 'zod';
import { checkCopyCompliance, COMPLIANCE_RULE_LABEL } from '../ads/campaign-builder.js';
import { WINGS_CLIENT_ID } from '../clients.js';

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

export interface MediaModel {
  key: string;
  name: string;
  provider: string | null;
  kind: 'image' | 'video';
  /** Credits for one output on the account's plan; null when the catalog does not say. */
  creditsPerOutput: number | null;
  /** Video only. Empty when the catalog does not list them: the duration is then left out. */
  supportedDurations: number[];
  /** Null when the catalog does not restrict them. */
  aspectRatios: string[] | null;
  priceParams: MediaPriceParam[];
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
    /** A library image used as style reference (image) or as first frame (video). */
    referenceAssetId: z.uuid().optional(),
    /**
     * Who it is for. Filing only: it is stored with the generation, the ledger
     * and the asset, and is never part of what Kairogen is sent.
     */
    clientId: z.uuid().default(WINGS_CLIENT_ID),
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
}

export interface MediaEstimate {
  id: string;
  credits: number;
  /** After this the estimate is stale and "Gerar" asks for a new one. */
  expiresAt: string;
  request: MediaEstimateRequest;
  /** Why this estimate cannot be generated right now, when it cannot. */
  blockedBy: MediaRefusal | null;
  usage: MediaUsage;
}

export const MEDIA_REFUSALS = [
  'daily_limit',
  'monthly_limit',
  'insufficient_credits',
  'estimate_expired',
  'estimate_used',
  'not_connected',
] as const;
export type MediaRefusal = (typeof MEDIA_REFUSALS)[number];

export const MEDIA_REFUSAL_MESSAGE: Record<MediaRefusal, string> = {
  daily_limit: 'Você atingiu o seu limite de créditos de hoje.',
  monthly_limit: 'O limite de créditos do mês foi atingido.',
  insufficient_credits: 'O saldo da conta no Kairogen não cobre esta geração.',
  estimate_expired: 'A estimativa venceu. Estime o custo de novo.',
  estimate_used: 'Esta estimativa já foi usada. Estime o custo de novo.',
  not_connected: 'O Kairogen não está conectado. Peça a um Admin Master para conectar.',
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
  running: 'Gerando no Kairogen',
  saving: 'Salvando na biblioteca',
  succeeded: 'Concluída',
  failed: 'Falhou',
  refused: 'Recusada pelo Kairogen',
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
  prompt: string | null;
  creditsEstimated: number;
  /** What Kairogen says it charged, when it says. */
  creditsCharged: number | null;
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

//   GET  /media/studio                 -> { usage, connected, storageAvailable }   marketing.media.read
//   GET  /media/models?kind=           -> { models: MediaModel[], cachedAt }       marketing.media.read
//        `creditsPerOutput` is null when the catalog gives no price: the screen then
//        says "custo na estimativa", and the estimate is where the price comes from.
//   POST /media/estimates              -> { estimate: MediaEstimate }              marketing.media.generate
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
