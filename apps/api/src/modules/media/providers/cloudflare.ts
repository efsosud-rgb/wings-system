import type { MediaModel } from '@wings/shared';
import { bytesFromBase64, find, http, said } from './http.js';
import { outputsStarted, periodStarts } from './quota.js';
import {
  ProviderError,
  type MediaProvider,
  type ProviderContext,
  type ProviderOutput,
  type ShapeNoter,
} from './types.js';

/**
 * Cloudflare Workers AI: FLUX.1 [schnell] for images, on the free daily
 * allowance. The allowance is counted HERE, from our ledger; Cloudflare is
 * never asked how much is left, and a day's ceiling is CF_WORKERS_AI_DAILY_IMAGES.
 *
 * NOT VERIFIED against the real service (docs/integracoes/cloudflare-workers-ai.md):
 * the request is `POST /accounts/{id}/ai/run/@cf/black-forest-labs/flux-1-schnell`
 * with `{ prompt, steps }`, and the answer is read as `{ result: { image: <base64> } }`
 * or as raw image bytes, whichever comes. Whether the model takes a width and
 * a height is not known, so every picture is asked for at its default square.
 */

export const CLOUDFLARE_MODEL_KEY = 'cloudflare/flux-1-schnell';
const CF_MODEL_PATH = '@cf/black-forest-labs/flux-1-schnell';
const STEPS = 4;
const TIMEOUT_MS = 90_000;

export interface CloudflareConfig {
  accountId: string | undefined;
  token: string | undefined;
  dailyImages: number;
  fetch: typeof fetch;
  noteShape?: ShapeNoter;
}

const MODEL: MediaModel = {
  key: CLOUDFLARE_MODEL_KEY,
  name: 'FLUX.1 schnell',
  providerId: 'cloudflare',
  provider: 'Black Forest Labs',
  kind: 'image',
  creditsPerOutput: 0,
  brlCentsPerOutput: 0,
  maxOutputs: 4,
  supportedDurations: [],
  aspectRatios: ['1:1'],
  priceParams: [],
  imageUse: null,
  acceptsReferenceImage: false,
  acceptsFirstFrame: false,
};

export function cloudflareProvider(config: CloudflareConfig): MediaProvider {
  const configured = Boolean(config.accountId && config.token);
  const quota = async (ctx: ProviderContext) => ({
    usedToday: await outputsStarted(ctx.db, 'cloudflare', periodStarts(ctx.now()).day),
    dailyLimit: config.dailyImages,
    usedThisMinute: null,
    perMinuteLimit: null,
  });

  return {
    id: 'cloudflare',
    name: 'Cloudflare Workers AI',
    billing: 'free_quota',
    capabilities: ['generate_image'],
    verified: false,
    configured,

    async availability(ctx, need = { outputs: 1 }) {
      if (!configured) {
        return { available: false, reason: 'Sem CF_ACCOUNT_ID e CF_WORKERS_AI_TOKEN no ambiente.' };
      }
      const today = await quota(ctx);
      if (today.usedToday + need.outputs > today.dailyLimit) {
        return {
          available: false,
          reason: `Cota grátis do dia esgotada (${today.usedToday} de ${today.dailyLimit} imagens).`,
        };
      }
      return { available: true, reason: null };
    },

    async balance() {
      return null;
    },

    quota,

    async listModels() {
      return configured ? [{ ...MODEL }] : [];
    },

    async estimate(_ctx, request) {
      if (request.operation !== 'generate' || request.kind !== 'image') {
        throw new ProviderError('rejected', 'A Cloudflare só gera imagens aqui.');
      }
      return {
        credits: 0,
        brlCents: 0,
        priceArgs: { model: request.model.key, quantity: request.quantity, steps: STEPS },
      };
    },

    async start(_ctx, input) {
      if (input.request.operation !== 'generate') {
        throw new ProviderError('rejected', 'A Cloudflare só gera imagens aqui.');
      }
      const url = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(
        config.accountId ?? '',
      )}/ai/run/${CF_MODEL_PATH}`;
      const outputs: ProviderOutput[] = [];
      let note: string | null = null;
      // One call per picture, each sent once. A failure after the first keeps what came.
      for (let index = 0; index < input.request.quantity; index += 1) {
        try {
          const answer = await http(
            config.fetch,
            {
              method: 'POST',
              url,
              headers: { Authorization: `Bearer ${config.token ?? ''}` },
              body: { prompt: input.request.prompt, steps: STEPS },
              timeoutMs: TIMEOUT_MS,
              label: 'cloudflare.run',
              spends: true,
            },
            config.noteShape,
          );
          const bytes =
            bytesFromBase64(find(answer.json, ['image', 'image_base64', 'data'])) ??
            (/^image\//i.test(answer.contentType) ? answer.bytes : null);
          if (!bytes) {
            const words = said(
              asWords(find(answer.json, ['errors', 'messages', 'message'])) ?? null,
            );
            throw new ProviderError(
              'rejected',
              `A Cloudflare respondeu sem imagem.${words ? ` Resposta dela: ${words}` : ''}`,
            );
          }
          outputs.push({ bytes });
        } catch (error) {
          if (outputs.length === 0 || !(error instanceof ProviderError)) throw error;
          note = `A Cloudflare gerou ${outputs.length} de ${input.request.quantity}. ${error.message}`;
          break;
        }
      }
      return {
        done: true,
        externalId: null,
        outputs,
        creditsCharged: 0,
        brlCentsCharged: 0,
        note,
      };
    },

    async poll() {
      return {
        state: 'failed',
        outputs: [],
        creditsCharged: null,
        brlCentsCharged: null,
        note: 'A Cloudflare responde na mesma chamada; não há o que acompanhar.',
      };
    },
  };
}

/** Cloudflare's `errors` and `messages` are lists of `{ code, message }`; one line of them, or the text itself. */
function asWords(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return null;
  const lines = value
    .map((item) => (typeof item === 'string' ? item : find(item, ['message'])))
    .filter((item): item is string => typeof item === 'string');
  return lines.length > 0 ? lines.join('; ') : null;
}
