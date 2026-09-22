import type { MediaModel } from '@wings/shared';
import { asNumber, asText, find, http, memo, said } from './http.js';
import {
  ProviderError,
  type MediaProvider,
  type ProviderOutput,
  type ShapeNoter,
} from './types.js';

/**
 * MoneyPrinterTurbo: a service of OURS (MPT_BASE_URL) that turns a subject
 * into a short narrated video from stock footage — "vídeo sem câmera". It
 * costs nothing per output here; what it spends on its own side (its
 * language-model and stock keys) is that server's business, and the address
 * is ours, so the ledger counts R$ 0.
 *
 * NOT VERIFIED against a running instance (docs/integracoes/moneyprinterturbo.md):
 * the request is `POST /api/v1/videos` with `video_subject`, `video_aspect` and
 * `video_count`, answering `{ data: { task_id } }`; `GET /api/v1/tasks/{id}`
 * answers `{ data: { state, progress, videos: [url] } }` where state 1 is done
 * and -1 failed. The finished file is fetched from the service's own address
 * and never from anywhere else.
 */

export const MPT_MODEL_KEY = 'mpt/short-video';
const TIMEOUT_MS = 30_000;
const PING_TTL_MS = 60_000;
const MAX_VIDEO_BYTES = 150 * 1024 * 1024;
const STATE_DONE = 1;
const STATE_FAILED = -1;

export interface MptConfig {
  baseUrl: string | undefined;
  apiKey: string | undefined;
  fetch: typeof fetch;
  noteShape?: ShapeNoter;
}

export function mptProvider(config: MptConfig): MediaProvider {
  const base = config.baseUrl?.replace(/\/+$/, '');
  const configured = Boolean(base);
  const headers = (): Record<string, string> =>
    config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {};

  const model: MediaModel = {
    key: MPT_MODEL_KEY,
    name: 'Vídeo curto sem câmera',
    providerId: 'mpt',
    provider: 'MoneyPrinterTurbo',
    kind: 'video',
    creditsPerOutput: 0,
    brlCentsPerOutput: 0,
    maxOutputs: 1,
    supportedDurations: [],
    aspectRatios: ['9:16', '16:9', '1:1'],
    priceParams: [],
    imageUse: null,
    acceptsReferenceImage: false,
    acceptsFirstFrame: false,
  };

  /** Reachable: it answered at all, with something other than a server error. */
  const ping = memo(PING_TTL_MS, async (): Promise<boolean> => {
    try {
      await http(
        config.fetch,
        { method: 'GET', url: `${base}/ping`, headers: headers(), timeoutMs: 10_000, label: 'mpt.ping' },
        config.noteShape,
      );
      return true;
    } catch (error) {
      return error instanceof ProviderError && error.code === 'rejected';
    }
  });

  return {
    id: 'mpt',
    name: 'MoneyPrinterTurbo',
    billing: 'own_service',
    capabilities: ['generate_video'],
    verified: false,
    configured,

    async availability(ctx) {
      if (!configured) return { available: false, reason: 'Sem MPT_BASE_URL no ambiente.' };
      return (await ping(ctx.now))
        ? { available: true, reason: null }
        : { available: false, reason: 'O serviço MoneyPrinterTurbo não respondeu.' };
    },

    async balance() {
      return null;
    },

    async quota() {
      return null;
    },

    async listModels() {
      return configured ? [{ ...model }] : [];
    },

    async estimate(_ctx, request) {
      if (request.operation !== 'generate' || request.kind !== 'video') {
        throw new ProviderError('rejected', 'O MoneyPrinterTurbo só faz vídeos curtos.');
      }
      return {
        credits: 0,
        brlCents: 0,
        priceArgs: { model: request.model.key, quantity: 1, video_aspect: request.aspect },
      };
    },

    async start(_ctx, input) {
      const request = input.request;
      if (request.operation !== 'generate') {
        throw new ProviderError('rejected', 'O MoneyPrinterTurbo só faz vídeos curtos.');
      }
      const answer = await http(
        config.fetch,
        {
          method: 'POST',
          url: `${base}/api/v1/videos`,
          headers: headers(),
          body: {
            video_subject: request.prompt,
            video_aspect: request.aspect,
            video_count: 1,
            video_source: 'pexels',
            video_concat_mode: 'random',
            video_clip_duration: 5,
            subtitle_enabled: true,
          },
          timeoutMs: TIMEOUT_MS,
          label: 'mpt.videos',
          spends: true,
        },
        config.noteShape,
      );
      const id = asText(find(answer.json, ['task_id', 'taskId', 'id']));
      if (!id) {
        throw new ProviderError(
          'outcome_unknown',
          'O MoneyPrinterTurbo aceitou o pedido mas não devolveu o identificador da tarefa.',
        );
      }
      return { done: false, externalId: id.slice(0, 200) };
    },

    async poll(_ctx, externalId) {
      const answer = await http(
        config.fetch,
        {
          method: 'GET',
          url: `${base}/api/v1/tasks/${encodeURIComponent(externalId)}`,
          headers: headers(),
          timeoutMs: TIMEOUT_MS,
          label: 'mpt.task',
        },
        config.noteShape,
      );
      const state = asNumber(find(answer.json, ['state']));
      if (state === STATE_FAILED) {
        return {
          state: 'failed',
          outputs: [],
          creditsCharged: null,
          brlCentsCharged: 0,
          note: said(asText(find(answer.json, ['error', 'message']))),
        };
      }
      const videos = find(answer.json, ['videos', 'combined_videos']);
      const urls = (Array.isArray(videos) ? videos : []).filter(
        (item): item is string => typeof item === 'string' && item.length > 0,
      );
      if (state !== STATE_DONE || urls.length === 0) {
        return { state: 'running', outputs: [], creditsCharged: null, brlCentsCharged: null, note: null };
      }
      // The file is fetched from the service itself: an address it gives is only
      // followed when it is its own, or a path under it.
      const outputs: ProviderOutput[] = [];
      for (const given of urls.slice(0, 1)) {
        const url = own(base ?? '', given);
        if (!url) continue;
        const file = await http(
          config.fetch,
          { method: 'GET', url, headers: headers(), timeoutMs: 120_000, label: 'mpt.download' },
          config.noteShape,
        );
        if (file.bytes.length > 0 && file.bytes.length <= MAX_VIDEO_BYTES) {
          outputs.push({ bytes: file.bytes });
        }
      }
      return outputs.length > 0
        ? { state: 'succeeded', outputs, creditsCharged: 0, brlCentsCharged: 0, note: null }
        : {
            state: 'failed',
            outputs: [],
            creditsCharged: 0,
            brlCentsCharged: 0,
            note: 'O vídeo ficou pronto mas não pôde ser baixado do serviço.',
          };
    },
  };
}

/** The address to fetch a finished file from: under our own base, or nothing. */
function own(base: string, given: string): string | null {
  try {
    const root = new URL(base);
    const url = new URL(given, root);
    return url.host === root.host ? url.toString() : null;
  } catch {
    return null;
  }
}
