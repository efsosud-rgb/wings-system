import type { MediaModel } from '@wings/shared';
import { asNumber, asText, find, http, memo, said } from './http.js';
import { usdToBrlCents } from './quota.js';
import {
  ProviderError,
  type MediaProvider,
  type ProviderContext,
  type ProviderOutput,
  type ShapeNoter,
} from './types.js';

/**
 * Higgsfield: images (Soul) and image-to-video (DoP), paid per use in US
 * dollars. What an output costs is NOT published in a form this system can
 * read, so the price shown before the click is the configured expectation
 * (HIGGSFIELD_USD_PER_IMAGE, HIGGSFIELD_USD_PER_VIDEO_SECOND) converted by
 * BRL_PER_USD; when the provider reports a charge, the ledger is corrected.
 *
 * NOT VERIFIED against the real service (docs/integracoes/higgsfield.md): the
 * base is `https://platform.higgsfield.ai`, the key goes in `hf-api-key` (and
 * a secret in `hf-secret` when there is one), a job is `POST /v1/text2image/soul`
 * or `POST /v1/image2video/dop` with `{ params: {…} }` and answers `{ id, status }`,
 * and `GET /v1/requests/{id}` answers `{ status, results: { raw: { url } } }`.
 * The balance is looked for at `GET /v1/credits`, by field name, and shown as
 * "não informado" when the answer has no number the reader recognises.
 */

const BASE_URL = 'https://platform.higgsfield.ai';
const TIMEOUT_MS = 60_000;
const BALANCE_TTL_MS = 5 * 60_000;
const DEFAULT_VIDEO_SECONDS = 5;
const DONE = ['completed', 'succeeded', 'success', 'done', 'finished'];
const FAILED = ['failed', 'error', 'errored', 'nsfw', 'canceled', 'cancelled', 'rejected'];

export const HIGGSFIELD_IMAGE_MODEL_KEY = 'higgsfield/soul';
export const HIGGSFIELD_VIDEO_MODEL_KEY = 'higgsfield/dop';

export interface HiggsfieldConfig {
  apiKey: string | undefined;
  apiSecret: string | undefined;
  usdPerImage: number;
  usdPerVideoSecond: number;
  brlPerUsd: number;
  fetch: typeof fetch;
  noteShape?: ShapeNoter;
}

export function higgsfieldProvider(config: HiggsfieldConfig): MediaProvider {
  const configured = Boolean(config.apiKey);
  const headers = () => ({
    'hf-api-key': config.apiKey ?? '',
    ...(config.apiSecret ? { 'hf-secret': config.apiSecret } : {}),
  });
  const brl = (usd: number) => usdToBrlCents(usd, config.brlPerUsd);

  const models = (): MediaModel[] => [
    {
      key: HIGGSFIELD_IMAGE_MODEL_KEY,
      name: 'Higgsfield Soul',
      providerId: 'higgsfield',
      provider: 'Higgsfield',
      kind: 'image',
      creditsPerOutput: 0,
      brlCentsPerOutput: brl(config.usdPerImage),
      maxOutputs: 1,
      supportedDurations: [],
      aspectRatios: ['1:1', '4:5', '9:16', '16:9'],
      priceParams: [],
      imageUse: null,
      acceptsReferenceImage: false,
      acceptsFirstFrame: false,
    },
    {
      key: HIGGSFIELD_VIDEO_MODEL_KEY,
      name: 'Higgsfield DoP (imagem para vídeo)',
      providerId: 'higgsfield',
      provider: 'Higgsfield',
      kind: 'video',
      creditsPerOutput: 0,
      brlCentsPerOutput: brl(config.usdPerVideoSecond * DEFAULT_VIDEO_SECONDS),
      maxOutputs: 1,
      supportedDurations: [5, 10],
      aspectRatios: ['9:16', '16:9', '1:1'],
      priceParams: [],
      imageUse: null,
      acceptsReferenceImage: false,
      acceptsFirstFrame: true,
    },
  ];

  /** Dollars the account holds, as the provider says, or null when it cannot be read. */
  const readBalance = memo(BALANCE_TTL_MS, async (): Promise<number | null> => {
    const answer = await http(
      config.fetch,
      {
        method: 'GET',
        url: `${BASE_URL}/v1/credits`,
        headers: headers(),
        timeoutMs: 15_000,
        label: 'higgsfield.credits',
      },
      config.noteShape,
    );
    return asNumber(
      find(answer.json, [
        'balance_usd',
        'usd',
        'balance',
        'credits',
        'credit_balance',
        'remaining',
      ]),
    );
  });
  const balance = async (ctx: ProviderContext) => {
    if (!configured) return null;
    try {
      const usd = await readBalance(ctx.now);
      return { credits: null, usd, brlCents: usd === null ? null : brl(usd) };
    } catch {
      return { credits: null, usd: null, brlCents: null };
    }
  };

  const usdOf = (request: {
    kind: 'image' | 'video';
    quantity: number;
    durationSeconds?: number;
  }) =>
    request.kind === 'video'
      ? config.usdPerVideoSecond *
        (request.durationSeconds ?? DEFAULT_VIDEO_SECONDS) *
        request.quantity
      : config.usdPerImage * request.quantity;

  return {
    id: 'higgsfield',
    name: 'Higgsfield',
    billing: 'per_use',
    capabilities: ['generate_image', 'generate_video'],
    verified: false,
    configured,

    async availability(ctx) {
      if (!configured) return { available: false, reason: 'Sem HIGGSFIELD_API_KEY no ambiente.' };
      const held = await balance(ctx);
      if (held?.usd !== null && held?.usd !== undefined && held.usd <= 0) {
        return { available: false, reason: 'Saldo zerado no Higgsfield.' };
      }
      return { available: true, reason: null };
    },

    balance,

    async quota() {
      return null;
    },

    async listModels() {
      return configured ? models() : [];
    },

    async estimate(_ctx, request) {
      if (request.operation !== 'generate') {
        throw new ProviderError('rejected', 'O Higgsfield não amplia nem anima imagens aqui.');
      }
      if (request.kind === 'video' && !request.source) {
        throw new ProviderError(
          'rejected',
          'O Higgsfield DoP parte de uma imagem: escolha o primeiro quadro.',
        );
      }
      const usd = usdOf(request);
      return {
        credits: 0,
        brlCents: brl(usd),
        priceArgs: {
          model: request.model.key,
          quantity: request.quantity,
          aspect_ratio: request.aspect,
          ...(request.durationSeconds !== undefined ? { duration: request.durationSeconds } : {}),
          expected_usd: Number(usd.toFixed(4)),
        },
      };
    },

    async start(_ctx, input) {
      const request = input.request;
      if (request.operation !== 'generate') {
        throw new ProviderError('rejected', 'O Higgsfield não amplia nem anima imagens aqui.');
      }
      let path: string;
      let params: Record<string, unknown>;
      if (request.kind === 'video') {
        const imageUrl = await input.publicUrl('first_frame');
        if (!imageUrl) throw new ProviderError('rejected', 'A imagem de origem não existe mais.');
        path = '/v1/image2video/dop';
        params = {
          prompt: request.prompt,
          input_image: { type: 'image_url', image_url: imageUrl },
          duration: request.durationSeconds ?? DEFAULT_VIDEO_SECONDS,
        };
      } else {
        path = '/v1/text2image/soul';
        params = {
          prompt: request.prompt,
          aspect_ratio: request.aspect,
          quality: 'basic',
          ...(request.negativePrompt ? { negative_prompt: request.negativePrompt } : {}),
        };
      }
      const answer = await http(
        config.fetch,
        {
          method: 'POST',
          url: `${BASE_URL}${path}`,
          headers: headers(),
          body: { params },
          timeoutMs: TIMEOUT_MS,
          label: `higgsfield.${request.kind === 'video' ? 'dop' : 'soul'}`,
          spends: true,
        },
        config.noteShape,
      );
      const outputs = outputsFrom(answer.json);
      if (outputs.length > 0) {
        return {
          done: true,
          externalId: asText(find(answer.json, ['id', 'request_id'])),
          outputs,
          creditsCharged: null,
          brlCentsCharged: chargeFrom(answer.json, config.brlPerUsd),
          note: null,
        };
      }
      const id = asText(find(answer.json, ['id', 'request_id', 'job_id']));
      if (!id) {
        throw new ProviderError(
          'outcome_unknown',
          'O Higgsfield aceitou o pedido mas não devolveu o identificador. Confira lá antes de gerar de novo.',
        );
      }
      return { done: false, externalId: id.slice(0, 200) };
    },

    async poll(_ctx, externalId) {
      const answer = await http(
        config.fetch,
        {
          method: 'GET',
          url: `${BASE_URL}/v1/requests/${encodeURIComponent(externalId)}`,
          headers: headers(),
          timeoutMs: 30_000,
          label: 'higgsfield.request',
        },
        config.noteShape,
      );
      const status = asText(find(answer.json, ['status', 'state']))?.toLowerCase() ?? null;
      const outputs = outputsFrom(answer.json);
      const charged = chargeFrom(answer.json, config.brlPerUsd);
      if (status !== null && DONE.includes(status) && outputs.length > 0) {
        return {
          state: 'succeeded',
          outputs,
          creditsCharged: null,
          brlCentsCharged: charged,
          note: null,
        };
      }
      if (
        status !== null &&
        (FAILED.includes(status) || (DONE.includes(status) && outputs.length === 0))
      ) {
        return {
          state: 'failed',
          outputs: [],
          creditsCharged: null,
          brlCentsCharged: charged,
          note: said(asText(find(answer.json, ['error', 'message', 'reason']))),
        };
      }
      return {
        state: 'running',
        outputs: [],
        creditsCharged: null,
        brlCentsCharged: null,
        note: null,
      };
    },
  };
}

/** Every https address under `results` (raw/min/…), `output`, `url`, `video_url` or `image_url`. */
function outputsFrom(json: unknown): ProviderOutput[] {
  const urls = new Set<string>();
  const walk = (value: unknown, depth: number) => {
    if (depth > 6) return;
    if (typeof value === 'string') {
      if (/^https:\/\/\S+$/i.test(value)) urls.add(value);
      return;
    }
    if (Array.isArray(value)) value.slice(0, 16).forEach((item) => walk(item, depth + 1));
    else if (value !== null && typeof value === 'object') {
      for (const [key, inner] of Object.entries(value)) {
        if (/url|results?|outputs?|video|image|raw|min/i.test(key)) walk(inner, depth + 1);
      }
    }
  };
  const results = find(json, [
    'results',
    'result',
    'output',
    'outputs',
    'url',
    'video_url',
    'image_url',
  ]);
  walk(results, 0);
  // The full-size file first, when both a raw and a preview came.
  return [...urls]
    .sort(
      (a, b) => Number(/\/min\b|preview|thumb/i.test(a)) - Number(/\/min\b|preview|thumb/i.test(b)),
    )
    .slice(0, 1)
    .map((url) => ({ url }));
}

/** A charge in dollars, when the answer names one, as cents of reais. */
function chargeFrom(json: unknown, brlPerUsd: number): number | null {
  const usd = asNumber(find(json, ['cost_usd', 'cost', 'price', 'charged', 'credits_used']));
  return usd === null || usd < 0 ? null : usdToBrlCents(usd, brlPerUsd);
}
