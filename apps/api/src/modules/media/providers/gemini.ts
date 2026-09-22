import type { MediaModel } from '@wings/shared';
import { asText, bytesFromBase64, find, http, isObject, pick, said } from './http.js';
import { outputsStarted, periodStarts } from './quota.js';
import {
  ProviderError,
  type MediaProvider,
  type ProviderContext,
  type ProviderOutput,
  type ShapeNoter,
} from './types.js';

/**
 * Gemini API image generation (gemini-2.5-flash-image), on the free tier.
 * Google's free tier has limits per minute and per day that it does not
 * report; this system keeps its own, lower ones (GEMINI_IMAGES_PER_MINUTE,
 * GEMINI_DAILY_IMAGES), counted from the ledger, and refuses before Google can.
 *
 * NOT VERIFIED against the real service (docs/integracoes/gemini.md): the
 * request is `POST /v1beta/models/<model>:generateContent` with the key in
 * `x-goog-api-key`, `responseModalities: ['IMAGE']` and an `imageConfig.aspectRatio`;
 * the picture is read from the first part with `inlineData.data` (base64). A
 * picture handed over goes inline in the same request: the model then edits it.
 *
 * If the Google project has billing turned on, a picture is charged by Google
 * at its published price; this system shows R$ 0 because it treats the key as
 * a free-tier key. The doc says so, in the section on the account.
 */

export const GEMINI_MODEL_KEY = 'gemini/gemini-2.5-flash-image';
const GEMINI_MODEL = 'gemini-2.5-flash-image';
const TIMEOUT_MS = 120_000;

export interface GeminiConfig {
  apiKey: string | undefined;
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
  brlCentsPerOutput: 0,
  maxOutputs: 4,
  supportedDurations: [],
  aspectRatios: ['1:1', '4:5', '9:16', '16:9'],
  priceParams: [],
  // Handing it a picture is editing that picture, in the same call as the prompt.
  imageUse: 'edit',
  acceptsReferenceImage: true,
  acceptsFirstFrame: false,
};

export function geminiProvider(config: GeminiConfig): MediaProvider {
  const configured = Boolean(config.apiKey);
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
    billing: 'free_quota',
    capabilities: ['generate_image'],
    verified: false,
    configured,

    async availability(ctx, need = { outputs: 1 }) {
      if (!configured) return { available: false, reason: 'Sem GEMINI_API_KEY no ambiente.' };
      const now = await quota(ctx);
      if (now.usedToday + need.outputs > now.dailyLimit) {
        return {
          available: false,
          reason: `Cota grátis do dia esgotada (${now.usedToday} de ${now.dailyLimit} imagens).`,
        };
      }
      if ((now.usedThisMinute ?? 0) + need.outputs > (now.perMinuteLimit ?? Infinity)) {
        return {
          available: false,
          reason: `Cota por minuto esgotada (${now.usedThisMinute} de ${now.perMinuteLimit}). Espere um minuto.`,
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
        throw new ProviderError('rejected', 'O Gemini só gera imagens aqui.');
      }
      return {
        credits: 0,
        brlCents: 0,
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
        parts.push({ inlineData: { mimeType: input.source.mimeType, data: bytes.toString('base64') } });
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
      return { done: true, externalId: null, outputs, creditsCharged: 0, brlCentsCharged: 0, note };
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
