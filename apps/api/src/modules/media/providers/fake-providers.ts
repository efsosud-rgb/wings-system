import { randomBytes } from 'node:crypto';
import { fakePng } from '../../integrations/kairogen/fake-kairogen.js';

/**
 * Scripted Cloudflare Workers AI, Gemini, Higgsfield and MoneyPrinterTurbo
 * behind one `fetch`, told apart by host. No test in this repository reaches
 * any of the real services; what these prove is the order of things around
 * them (estimate, click, ledger, quota, failover), not their real formats,
 * which are marked "não verificado" in the docs.
 */

export interface FakeProviderCall {
  provider: 'cloudflare' | 'gemini' | 'higgsfield' | 'mpt' | 'other';
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

export interface FakeProvidersOptions {
  /** Cloudflare: answer every run with this HTTP status, or drop the connection. */
  cloudflare?: { status?: number; drop?: boolean; rawImage?: boolean };
  /** Gemini: answer in words instead of a picture (a safety refusal). */
  gemini?: { status?: number; refuseWithText?: boolean };
  higgsfield?: {
    balanceUsd?: number | null;
    /** `GET /v1/requests/{id}` answers in_progress this many times before finishing. */
    pollsUntilDone?: number;
    fail?: boolean;
    /** What the provider says it charged, in dollars, on the finished request. */
    chargeUsd?: number;
    status?: number;
    drop?: boolean;
  };
  mpt?: { down?: boolean; pollsUntilDone?: number; fail?: boolean; baseUrl?: string };
}

/** The smallest thing the header reader accepts as an MP4. */
export function fakeMp4(): Buffer {
  const bytes = Buffer.alloc(32);
  bytes.writeUInt32BE(32, 0);
  bytes.write('ftyp', 4, 'latin1');
  bytes.write('isom', 8, 'latin1');
  randomBytes(8).copy(bytes, 16);
  return bytes;
}

export const FAKE_MPT_BASE_URL = 'http://mpt.internal:8080';
export const FAKE_HIGGSFIELD_OUTPUT_HOST = 'cdn.higgsfield.test';

export function fakeProviders(options: FakeProvidersOptions = {}) {
  const state = {
    calls: [] as FakeProviderCall[],
    higgsfieldJobs: new Map<string, { polls: number; kind: 'image' | 'video' }>(),
    mptTasks: new Map<string, { polls: number }>(),
    /** Files served from the fake CDNs, by address. */
    files: new Map<string, Buffer>(),
  };
  const mptBase = new URL(options.mpt?.baseUrl ?? FAKE_MPT_BASE_URL);

  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  const file = (bytes: Buffer, type: string) =>
    new Response(new Uint8Array(bytes), { status: 200, headers: { 'Content-Type': type } });

  const record = (
    provider: FakeProviderCall['provider'],
    url: URL,
    init: RequestInit | undefined,
  ): FakeProviderCall => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => {
      headers[key.toLowerCase()] = value;
    });
    let body: unknown = null;
    if (typeof init?.body === 'string') {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    const call = { provider, method: init?.method ?? 'GET', url: url.toString(), headers, body };
    state.calls.push(call);
    return call;
  };

  const cloudflare = (url: URL, init?: RequestInit): Response => {
    const call = record('cloudflare', url, init);
    if (options.cloudflare?.drop) throw new TypeError('fetch failed');
    if (call.headers.authorization !== 'Bearer cf_token_test') {
      return json(403, {
        success: false,
        errors: [{ code: 10000, message: 'Authentication error' }],
      });
    }
    if (options.cloudflare?.status && options.cloudflare.status !== 200) {
      return json(options.cloudflare.status, {
        success: false,
        errors: [{ code: 5000, message: `status ${options.cloudflare.status}` }],
      });
    }
    const bytes = fakePng(1024, 1024);
    if (options.cloudflare?.rawImage) return file(bytes, 'image/png');
    return json(200, {
      result: { image: bytes.toString('base64') },
      success: true,
      errors: [],
      messages: [],
    });
  };

  const gemini = (url: URL, init?: RequestInit): Response => {
    const call = record('gemini', url, init);
    if (call.headers['x-goog-api-key'] !== 'gemini_key_test') {
      return json(403, {
        error: { code: 403, message: 'API key not valid', status: 'PERMISSION_DENIED' },
      });
    }
    if (options.gemini?.status && options.gemini.status !== 200) {
      return json(options.gemini.status, { error: { message: `status ${options.gemini.status}` } });
    }
    if (options.gemini?.refuseWithText) {
      return json(200, {
        candidates: [
          {
            content: { parts: [{ text: 'I cannot create that image.' }], role: 'model' },
            finishReason: 'STOP',
          },
        ],
      });
    }
    const ratio = (call.body as { generationConfig?: { imageConfig?: { aspectRatio?: string } } })
      .generationConfig?.imageConfig?.aspectRatio;
    const [w, h] =
      ratio === '9:16'
        ? [576, 1024]
        : ratio === '16:9'
          ? [1024, 576]
          : ratio === '4:5'
            ? [832, 1040]
            : [1024, 1024];
    return json(200, {
      candidates: [
        {
          content: {
            parts: [
              { inlineData: { mimeType: 'image/png', data: fakePng(w, h).toString('base64') } },
            ],
            role: 'model',
          },
          finishReason: 'STOP',
        },
      ],
      usageMetadata: { promptTokenCount: 12, totalTokenCount: 1302 },
    });
  };

  const higgsfield = (url: URL, init?: RequestInit): Response => {
    const call = record('higgsfield', url, init);
    if (options.higgsfield?.drop) throw new TypeError('fetch failed');
    if (call.headers['hf-api-key'] !== 'hf_key_test') {
      return json(401, { detail: 'Invalid API key' });
    }
    if (url.pathname === '/v1/credits') {
      const usd = options.higgsfield?.balanceUsd;
      return usd === null
        ? json(200, { plan: 'pay_as_you_go' })
        : json(200, { balance_usd: usd ?? 12.5 });
    }
    if (options.higgsfield?.status && options.higgsfield.status !== 200) {
      return json(options.higgsfield.status, { detail: `status ${options.higgsfield.status}` });
    }
    if (call.method === 'POST' && /^\/v1\/(text2image|image2video)\//.test(url.pathname)) {
      const id = `hf_${randomBytes(6).toString('hex')}`;
      state.higgsfieldJobs.set(id, {
        polls: 0,
        kind: url.pathname.includes('image2video') ? 'video' : 'image',
      });
      return json(200, { id, status: 'queued' });
    }
    const match = url.pathname.match(/^\/v1\/requests\/(.+)$/);
    if (match) {
      const job = state.higgsfieldJobs.get(match[1] ?? '');
      if (!job) return json(404, { detail: 'Not found' });
      job.polls += 1;
      if (job.polls <= (options.higgsfield?.pollsUntilDone ?? 1)) {
        return json(200, { id: match[1], status: 'in_progress' });
      }
      if (options.higgsfield?.fail)
        return json(200, { id: match[1], status: 'failed', error: 'nsfw' });
      const address = `https://${FAKE_HIGGSFIELD_OUTPUT_HOST}/${match[1]}.${job.kind === 'video' ? 'mp4' : 'png'}`;
      state.files.set(address, job.kind === 'video' ? fakeMp4() : fakePng(1024, 1024));
      return json(200, {
        id: match[1],
        status: 'completed',
        results: { raw: { url: address }, min: { url: `${address}?preview=1` } },
        ...(options.higgsfield?.chargeUsd !== undefined
          ? { cost_usd: options.higgsfield.chargeUsd }
          : {}),
      });
    }
    return json(404, { detail: 'Not found' });
  };

  const mpt = (url: URL, init?: RequestInit): Response => {
    record('mpt', url, init);
    if (options.mpt?.down) throw new TypeError('fetch failed');
    if (url.pathname === '/ping') return json(200, { message: 'pong' });
    if (url.pathname === '/api/v1/videos' && init?.method === 'POST') {
      const id = randomBytes(8).toString('hex');
      state.mptTasks.set(id, { polls: 0 });
      return json(200, { status: 200, message: 'success', data: { task_id: id } });
    }
    const match = url.pathname.match(/^\/api\/v1\/tasks\/(.+)$/);
    if (match) {
      const task = state.mptTasks.get(match[1] ?? '');
      if (!task) return json(404, { status: 404, message: 'task not found' });
      task.polls += 1;
      if (task.polls <= (options.mpt?.pollsUntilDone ?? 1)) {
        return json(200, { status: 200, data: { state: 4, progress: 40 } });
      }
      if (options.mpt?.fail)
        return json(200, { status: 200, data: { state: -1, error: 'no footage' } });
      const address = `${mptBase.origin}/tasks/${match[1]}/final-1.mp4`;
      state.files.set(address, fakeMp4());
      return json(200, { status: 200, data: { state: 1, progress: 100, videos: [address] } });
    }
    const served = state.files.get(url.toString());
    if (served) return file(served, 'video/mp4');
    return json(404, { status: 404 });
  };

  const fetchFn = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input : input.url,
    );
    if (url.host === 'api.cloudflare.com') return cloudflare(url, init);
    if (url.host === 'generativelanguage.googleapis.com') return gemini(url, init);
    if (url.host === 'platform.higgsfield.ai') return higgsfield(url, init);
    if (url.host === mptBase.host) return mpt(url, init);
    if (url.host === FAKE_HIGGSFIELD_OUTPUT_HOST) {
      record('other', url, init);
      const served = state.files.get(url.toString().replace(/\?preview=1$/, ''));
      return served
        ? file(served, url.pathname.endsWith('.mp4') ? 'video/mp4' : 'image/png')
        : new Response('not found', { status: 404 });
    }
    record('other', url, init);
    return new Response('unknown host', { status: 502 });
  };

  return { fetch: fetchFn as typeof fetch, state };
}

/** The environment that turns every fake provider on, with the keys the fakes accept. */
export const FAKE_PROVIDER_ENV = {
  CF_ACCOUNT_ID: 'acc_test',
  CF_WORKERS_AI_TOKEN: 'cf_token_test',
  GEMINI_API_KEY: 'gemini_key_test',
  HIGGSFIELD_API_KEY: 'hf_key_test',
  MPT_BASE_URL: FAKE_MPT_BASE_URL,
};
