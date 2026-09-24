import type { MediaModel } from '@wings/shared';
import { asText, bytesFromBase64, find, http, isObject, pick, said } from './http.js';
import { outputsStarted, periodStarts, usdToBrlCents } from './quota.js';
import {
  ProviderError,
  type MediaProvider,
  type ProviderContext,
  type ProviderOutput,
  type ShapeNoter,
} from './types.js';

/**
 * Gemini API image generation (gemini-2.5-flash-image), PAID PER USE.
 *
 * Google's pricing page (read 2026-09-24, "last updated 2026-09-24") lists image
 * output as "Not available" on the free tier for every image model, and
 * gemini-2.5-flash-image at US$ 0.039 per image on the paid tier. Staging saw it:
 * the first call of the day answered 429 "You exceeded your current quota". So
 * this provider is pay-per-use, priced at GEMINI_USD_PER_IMAGE, and stays off
 * until the Google project has billing and GEMINI_BILLING_ENABLED is true. The
 * daily and per-minute ceilings (GEMINI_DAILY_IMAGES, GEMINI_IMAGES_PER_MINUTE)
 * stay as our own brakes, counted from the ledger.
 *
 * NOT VERIFIED against the real service (docs/integracoes/gemini.md): the
 * request is `POST /v1beta/models/<model>:generateContent` with the key in
 * `x-goog-api-key`, `responseModalities: ['IMAGE']` and an `imageConfig.aspectRatio`;
 * the picture is read from the first part with `inlineData.data` (base64). A
 * picture handed over goes inline in the same request: the model then edits it.
 */

export const GEMINI_MODEL_KEY = 'gemini/gemini-2.5-flash-image';
const GEMINI_MODEL = 'gemini-2.5-flash-image';
const TIMEOUT_MS = 120_000;

export interface GeminiConfig {
  apiKey: string | undefined;
  /** GEMINI_BILLING_ENABLED: the Google project pays for images. Off: the provider serves nothing. */
  billingEnabled: boolean;
  usdPerImage: number;
  brlPerUsd: number;
  dailyImages: number;
  imagesPerMinute: number;
  fetch: typeof fetch;
  noteShape?: ShapeNoter;
}

const MODEL: MediaModel = {
  key: GEMINI_MODEL_KEY,
  name: 'Gemini 2.5 Flash Image',
  providerId: 'gemini',
  provider: 'Google',
  kind: 'image',
  creditsPerOutput: 0,
  // Set from GEMINI_USD_PER_IMAGE when the provider is built.
  brlCentsPerOutput: null,
  maxOutputs: 4,
  supportedDurations: [],
  aspectRatios: ['1:1', '4:5', '9:16', '16:9'],
  priceParams: [],
  // Handing it a picture is editing that picture, in the same call as the prompt.
  imageUse: 'edit',
  acceptsReferenceImage: true,
  acceptsFirstFrame: false,
};

export const GEMINI_NO_FREE_TIER =
  'A imagem do Gemini não tem cota grátis na API (tabela do Google, 2026-09-24): é paga por uso. Fica desativada até o projeto do Google ter faturamento e GEMINI_BILLING_ENABLED=true.';

export function geminiProvider(config: GeminiConfig): MediaProvider {
  const configured = Boolean(config.apiKey);
  const perImage = usdToBrlCents(config.usdPerImage, config.brlPerUsd);
  const quota = async (ctx: ProviderContext) => {
    const starts = periodStarts(ctx.now());
    return {
      usedToday: await outputsStarted(ctx.db, 'gemini', starts.day),
      dailyLimit: config.dailyImages,
      usedThisMinute: await outputsStarted(ctx.db, 'gemini', starts.minute),
      perMinuteLimit: config.imagesPerMinute,
    };
  };

  return {
    id: 'gemini',
    name: 'Gemini',
    billing: 'per_use',
    capabilities: ['generate_image'],
    verified: false,
    configured,

    async availability(ctx, need = { outputs: 1 }) {
      if (!configured) return { available: false, reason: 'Sem GEMINI_API_KEY no ambiente.' };
      if (!config.billingEnabled) return { available: false, reason: GEMINI_NO_FREE_TIER };
      const now = await quota(ctx);
      if (now.usedToday + need.outputs > now.dailyLimit) {
        return {
          available: false,
          reason: `Limite do dia no Gemini atingido (${now.usedToday} de ${now.dailyLimit} imagens).`,
        };
      }
      if ((now.usedThisMinute ?? 0) + need.outputs > (now.perMinuteLimit ?? Infinity)) {
        return {
          available: false,
          reason: `Limite por minuto no Gemini atingido (${now.usedThisMinute} de ${now.perMinuteLimit}). Espere um minuto.`,
        };
      }
      return { available: true, reason: null };
    },

    async balance() {
      return null;
    },

    quota,

    async listModels() {
      return configured ? [{ ...MODEL, brlCentsPerOutput: perImage }] : [];
    },

    async estimate(_ctx, request) {
      if (request.operation !== 'generate' || request.kind !== 'image') {
        throw new ProviderError('rejected', 'O Gemini só gera imagens aqui.');
      }
      return {
        credits: 0,
        brlCents: perImage * request.quantity,
        priceArgs: {
          model: request.model.key,
          quantity: request.quantity,
          aspect_ratio: request.aspect,
        },
      };
    },

    async start(_ctx, input) {
      const request = input.request;
      if (request.operation !== 'generate') {
        throw new ProviderError('rejected', 'O Gemini só gera imagens aqui.');
      }
      const parts: Record<string, unknown>[] = [
        {
          text: request.negativePrompt
            ? `${request.prompt}\n\nDo not include: ${request.negativePrompt}`
            : request.prompt,
        },
      ];
      if (input.source) {
        const bytes = await input.sourceBytes();
        if (!bytes) throw new ProviderError('rejected', 'A imagem de origem não pôde ser lida.');
        parts.push({
          inlineData: { mimeType: input.source.mimeType, data: bytes.toString('base64') },
        });
      }
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;
      const outputs: ProviderOutput[] = [];
      let note: string | null = null;
      for (let index = 0; index < request.quantity; index += 1) {
        try {
          const answer = await http(
            config.fetch,
            {
              method: 'POST',
              url,
              headers: { 'x-goog-api-key': config.apiKey ?? '' },
              body: {
                contents: [{ parts }],
                generationConfig: {
                  responseModalities: ['IMAGE'],
                  imageConfig: { aspectRatio: request.aspect },
                },
              },
              timeoutMs: TIMEOUT_MS,
              label: 'gemini.generateContent',
              spends: true,
            },
            config.noteShape,
          );
          const bytes = imageFrom(answer.json);
          if (!bytes) {
            // No picture: the model answered in words (a refusal, a safety block). Its words, as its.
            const words = said(
              asText(find(answer.json, ['text'])) ??
                asText(find(answer.json, ['finishReason', 'blockReason'])),
            );
            throw new ProviderError(
              'rejected',
              `O Gemini respondeu sem imagem.${words ? ` Resposta dele: ${words}` : ''}`,
            );
          }
          outputs.push({ bytes });
        } catch (error) {
          if (outputs.length === 0 || !(error instanceof ProviderError)) throw error;
          note = `O Gemini gerou ${outputs.length} de ${request.quantity}. ${error.message}`;
          break;
        }
      }
      // Google charges its published price per picture; it does not say so in the answer.
      return {
        done: true,
        externalId: null,
        outputs,
        creditsCharged: 0,
        brlCentsCharged: perImage * outputs.length,
        note,
      };
    },

    async poll() {
      return {
        state: 'failed',
        outputs: [],
        creditsCharged: null,
        brlCentsCharged: null,
        note: 'O Gemini responde na mesma chamada; não há o que acompanhar.',
      };
    },
  };
}

/** The first inline picture in `candidates[].content.parts[]`, wherever the answer keeps it. */
function imageFrom(json: unknown): Buffer | null {
  const parts = find(json, ['parts']);
  const list = Array.isArray(parts) ? parts : [];
  for (const part of list) {
    const inline = pick(part, 'inlineData', 'inline_data');
    const bytes = isObject(inline) ? bytesFromBase64(pick(inline, 'data')) : null;
    if (bytes) return bytes;
  }
  return null;
}
