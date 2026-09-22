import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  SESSION_COOKIE,
  WINGS_CLIENT_ID,
  formatBrl,
  type AgentStreamEvent,
  type MediaEstimate,
  type MediaGeneration,
  type MediaModel,
  type MediaProviderStatus,
} from '@wings/shared';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../app.js';
import type { Database } from '../../db/client.js';
import {
  integrationConnections,
  mediaAssets,
  mediaCreditLedger,
  mediaGenerations,
  mediaPublicLinks,
} from '../../db/schema/index.js';
import { loadEnv, type Env } from '../../env.js';
import { createSecretBox } from '../../lib/secret-box.js';
import { createTestDatabase, type TestDatabase } from '../../test/db.js';
import { createEmployee, TEST_CPF_KEY, TEST_INDEX_KEY } from '../../test/factories.js';
import type { AgentLlm, LlmMessage, LlmRequest, LlmTurn } from '../agent/llm.js';
import { fakeKairogen, fakePng } from '../integrations/kairogen/fake-kairogen.js';
import { storeMedia } from './library.js';
import {
  FAKE_PROVIDER_ENV,
  fakeProviders,
  type FakeProvidersOptions,
} from './providers/fake-providers.js';
import { clearModelCache } from './studio.js';

/**
 * Media providers beyond Kairogen: the same order of things for every one of
 * them (estimate → click → ledger → one call → follow → save), R$ 0 shown as a
 * price, local quotas, the one ceiling in reais, and failover that only goes
 * DOWN in price on its own. Every service is scripted; the keys the fakes
 * accept never appear in an answer.
 */

const KEY = randomBytes(32).toString('base64');
let harness: TestDatabase;
let db: Database;
let app: FastifyInstance;
let mediaDir: string;
let kairogen = fakeKairogen();
let providers = fakeProviders();

/** One transport: Kairogen's hosts to its fake, everything else to the providers'. */
const transport = ((input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input : input.url);
  return /kairogen\.ai$/.test(url.host) ? kairogen.fetch(input, init) : providers.fetch(input, init);
}) as typeof fetch;

type Step = (request: LlmRequest) => Partial<LlmTurn>;
let script: Step[] = [];
let seen: { messages: LlmMessage[] }[] = [];
const scriptedLlm: AgentLlm = {
  async complete(request) {
    seen.push({ messages: structuredClone(request.messages) });
    const step = script.shift();
    if (!step) throw new Error('the script ended before the conversation did');
    const turn = step(request);
    if (turn.text) request.onText?.(turn.text);
    return {
      text: turn.text ?? '',
      toolCalls: turn.toolCalls ?? [],
      usage: { inputTokens: 100, outputTokens: 10, costUsd: 0.0001 },
      finishReason: turn.toolCalls?.length ? 'tool_calls' : 'stop',
    };
  },
};
const call = (name: string, args: unknown = {}) => ({
  id: `call_${randomBytes(3).toString('hex')}`,
  name,
  arguments: JSON.stringify(args),
});

const envOf = (extra: Record<string, string> = {}): Env =>
  loadEnv({
    NODE_ENV: 'test',
    DATABASE_URL: harness.url,
    SESSION_SECRET: randomBytes(48).toString('base64'),
    CPF_ENCRYPTION_KEY: TEST_CPF_KEY,
    CPF_INDEX_KEY: TEST_INDEX_KEY,
    APP_BASE_URL: 'https://staging.wingssystem.online',
    INTEGRATIONS_ENCRYPTION_KEY: KEY,
    MEDIA_DIR: mediaDir,
    KAIROGEN_DAILY_CREDITS_PER_USER: '30',
    KAIROGEN_MONTHLY_CREDITS: '60',
    KAIROGEN_BRL_PER_CREDIT: '0.25',
    ...FAKE_PROVIDER_ENV,
    ...extra,
  });

async function build(extra: Record<string, string> = {}) {
  return buildApp({
    env: envOf(extra),
    db,
    kairogenFetch: transport,
    mediaFetch: transport,
    agentLlm: scriptedLlm,
  });
}

beforeAll(async () => {
  harness = await createTestDatabase();
  db = harness.db;
  mediaDir = await mkdtemp(join(tmpdir(), 'wings-providers-'));
  app = await build();
}, 60_000);

afterAll(async () => {
  await app?.close();
  await harness?.drop();
  await rm(mediaDir, { recursive: true, force: true });
});

/** A connected Kairogen account and clean tables, with the fakes re-scripted. */
async function reset(options: {
  kairogen?: Parameters<typeof fakeKairogen>[0];
  providers?: FakeProvidersOptions;
  connected?: boolean;
} = {}) {
  kairogen = fakeKairogen(options.kairogen);
  providers = fakeProviders(options.providers);
  clearModelCache();
  kairogen.state.accessTokens.add('at_test');
  const box = createSecretBox(KEY);
  await db.delete(mediaPublicLinks);
  await db.delete(mediaCreditLedger);
  await db.update(mediaAssets).set({ sourceAssetId: null });
  await db.delete(mediaGenerations);
  await db.delete(integrationConnections);
  if (options.connected !== false) {
    await db.insert(integrationConnections).values({
      provider: 'kairogen',
      state: 'connected',
      clientId: 'client_test',
      accessTokenEnc: box.seal('at_test'),
      accessExpiresAt: new Date(Date.now() + 3_600_000),
      scopes: ['kairogen:read', 'kairogen:generate'],
    });
  }
}

beforeEach(async () => {
  script = [];
  seen = [];
  await reset();
});

async function sessionFor(role: 'admin_master' | 'marketing' = 'marketing') {
  const employee = await createEmployee(db, {
    role,
    sector: role === 'marketing' ? 'marketing' : 'diretoria',
  });
  const login = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { email: employee.email, password: employee.password },
  });
  const token = login.cookies.find((c) => c.name === SESSION_COOKIE)?.value;
  if (!token) throw new Error('login failed in setup');
  return { employeeId: employee.id, cookies: { [SESSION_COOKIE]: token } };
}

const image = (overrides: Record<string, unknown> = {}) => ({
  operation: 'generate',
  kind: 'image',
  model: 'cloudflare/flux-1-schnell',
  prompt: 'Storefront of a small bakery at golden hour, advertising photography, 35mm, no text',
  aspect: '1:1',
  quantity: 1,
  params: {},
  ...overrides,
});

const estimate = (
  target: FastifyInstance,
  cookies: Record<string, string>,
  payload: Record<string, unknown>,
) => target.inject({ method: 'POST', url: '/media/estimates', cookies, payload });
const generate = (
  target: FastifyInstance,
  cookies: Record<string, string>,
  payload: Record<string, unknown>,
) => target.inject({ method: 'POST', url: '/media/generations', cookies, payload });

async function due(id: string) {
  await db
    .update(mediaGenerations)
    .set({ nextPollAt: new Date(0) })
    .where(eq(mediaGenerations.id, id));
}
async function follow(
  target: FastifyInstance,
  cookies: Record<string, string>,
  id: string,
  times: number,
) {
  let generation: MediaGeneration | undefined;
  for (let index = 0; index < times; index += 1) {
    await due(id);
    generation = (await target.inject({ url: `/media/generations/${id}`, cookies })).json<{
      generation: MediaGeneration;
    }>().generation;
  }
  return generation;
}

const ledgerOf = (generationId: string) =>
  db.select().from(mediaCreditLedger).where(eq(mediaCreditLedger.generationId, generationId));

const SECRETS = ['cf_token_test', 'gemini_key_test', 'hf_key_test'];

describe('the registry', () => {
  it('lists every provider with whether its key is present, never the key', async () => {
    const { cookies } = await sessionFor();
    const response = await app.inject({ url: '/media/providers', cookies });
    expect(response.statusCode).toBe(200);
    const body = response.json<{ providers: MediaProviderStatus[]; spend: unknown }>();
    expect(body.providers.map((item) => [item.id, item.configured, item.available])).toEqual([
      ['kairogen', true, true],
      ['cloudflare', true, true],
      ['gemini', true, true],
      ['higgsfield', true, true],
      ['mpt', true, true],
    ]);
    const cloudflare = body.providers.find((item) => item.id === 'cloudflare');
    expect(cloudflare).toMatchObject({
      billing: 'free_quota',
      quota: { usedToday: 0, dailyLimit: 50, usedThisMinute: null, perMinuteLimit: null },
      verified: false,
    });
    expect(body.providers.find((item) => item.id === 'gemini')?.quota).toMatchObject({
      perMinuteLimit: 5,
    });
    // Higgsfield's balance in dollars, converted at BRL_PER_USD (5.5 unless set).
    expect(body.providers.find((item) => item.id === 'higgsfield')?.balance).toEqual({
      credits: null,
      usd: 12.5,
      brlCents: 6875,
    });
    expect(body.spend).toEqual({ usedThisMonthBrlCents: 0, monthlyLimitBrlCents: 30_000 });
    for (const secret of SECRETS) expect(response.body).not.toContain(secret);
  });

  it('lists a provider without its variables as not configured, and Kairogen as it was', async () => {
    const bare = await build({
      CF_ACCOUNT_ID: '',
      CF_WORKERS_AI_TOKEN: '',
      GEMINI_API_KEY: '',
      HIGGSFIELD_API_KEY: '',
      MPT_BASE_URL: '',
    });
    try {
      const { cookies } = await sessionFor();
      const body = (await bare.inject({ url: '/media/providers', cookies })).json<{
        providers: MediaProviderStatus[];
      }>();
      expect(body.providers.map((item) => [item.id, item.configured, item.reason])).toEqual([
        ['kairogen', true, null],
        ['cloudflare', false, 'Sem chave no ambiente.'],
        ['gemini', false, 'Sem chave no ambiente.'],
        ['higgsfield', false, 'Sem chave no ambiente.'],
        ['mpt', false, 'Sem chave no ambiente.'],
      ]);
      const models = (await bare.inject({ url: '/media/models', cookies })).json<{
        models: MediaModel[];
      }>().models;
      expect(new Set(models.map((model) => model.providerId))).toEqual(new Set(['kairogen']));
      expect(providers.state.calls).toHaveLength(0);
    } finally {
      await bare.close();
    }
  });

  it('puts every provider’s models in one catalog, each with its price per output', async () => {
    const { cookies } = await sessionFor();
    const models = (await app.inject({ url: '/media/models', cookies })).json<{
      models: MediaModel[];
    }>().models;
    const priced = Object.fromEntries(
      models.map((model) => [model.key, [model.providerId, model.creditsPerOutput, model.brlCentsPerOutput]]),
    );
    expect(priced).toMatchObject({
      // Kairogen: credits from estimate_cost, reais at KAIROGEN_BRL_PER_CREDIT.
      'seedream-v4': ['kairogen', 4, 100],
      'cloudflare/flux-1-schnell': ['cloudflare', 0, 0],
      'gemini/gemini-2.5-flash-image': ['gemini', 0, 0],
      // USD 0.05 at 5.5 = R$ 0.275, rounded up.
      'higgsfield/soul': ['higgsfield', 0, 28],
      // USD 0.10 a second, five seconds unless said otherwise.
      'higgsfield/dop': ['higgsfield', 0, 275],
      'mpt/short-video': ['mpt', 0, 0],
    });
    expect(models.find((model) => model.key === 'higgsfield/soul')?.maxOutputs).toBe(1);
  });
});

describe('Cloudflare Workers AI', () => {
  it('shows R$ 0 before the click, generates in one call, files the picture and counts the quota', async () => {
    const { cookies, employeeId } = await sessionFor();
    const quoted = await estimate(app, cookies, image());
    expect(quoted.statusCode).toBe(201);
    const { estimate: quote } = quoted.json<{ estimate: MediaEstimate }>();
    expect(quote).toMatchObject({
      providerId: 'cloudflare',
      credits: 0,
      brlCents: 0,
      blockedBy: null,
      routedFrom: null,
    });
    expect(quote.warnings.join(' ')).toContain('ainda não foi verificado');
    // Nothing was sent to Cloudflare for the estimate.
    expect(providers.state.calls.filter((item) => item.provider === 'cloudflare')).toHaveLength(0);

    const started = await generate(app, cookies, { estimateId: quote.id });
    expect(started.statusCode).toBe(201);
    const generation = started.json<{ generation: MediaGeneration }>().generation;
    // The answer carried the picture: done in the same request.
    expect(generation).toMatchObject({
      status: 'succeeded',
      providerId: 'cloudflare',
      brlCentsEstimated: 0,
    });
    expect(generation.assetIds).toHaveLength(1);
    const runs = providers.state.calls.filter((item) => item.provider === 'cloudflare');
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      method: 'POST',
      url: 'https://api.cloudflare.com/client/v4/accounts/acc_test/ai/run/@cf/black-forest-labs/flux-1-schnell',
      headers: { authorization: 'Bearer cf_token_test' },
      body: { prompt: image().prompt, steps: 4 },
    });

    const asset = await db.query.mediaAssets.findFirst({
      where: eq(mediaAssets.id, generation.assetIds[0] ?? ''),
    });
    expect(asset).toMatchObject({
      origin: 'cloudflare',
      kind: 'image',
      width: 1024,
      ownerId: employeeId,
      generationId: generation.id,
      credits: 0,
      clientId: WINGS_CLIENT_ID,
    });
    expect(asset?.sourceUrl).toBeNull();

    const rows = await ledgerOf(generation.id);
    expect(rows.map((row) => [row.event, row.provider, row.brlCentsDelta, row.creditsDelta])).toEqual([
      ['estimated', 'cloudflare', 0, 0],
      ['started', 'cloudflare', 0, 0],
      ['succeeded', 'cloudflare', 0, 0],
    ]);
    const status = (await app.inject({ url: '/media/providers', cookies })).json<{
      providers: MediaProviderStatus[];
    }>();
    expect(status.providers.find((item) => item.id === 'cloudflare')?.quota).toMatchObject({
      usedToday: 1,
    });
    expect(started.body).not.toContain('cf_token_test');
  });

  it('marks the outcome unknown when the connection drops mid-call, and never sends again', async () => {
    await reset({ providers: { cloudflare: { drop: true } } });
    const { cookies } = await sessionFor();
    const quote = (await estimate(app, cookies, image())).json<{ estimate: MediaEstimate }>().estimate;
    const generation = (await generate(app, cookies, { estimateId: quote.id })).json<{
      generation: MediaGeneration;
    }>().generation;
    expect(generation.status).toBe('unknown');
    expect(generation.detail).toContain('Não sabemos se o pedido chegou');
    expect(providers.state.calls.filter((item) => item.provider === 'cloudflare')).toHaveLength(1);
    // Clicking the same estimate again is refused: it was used.
    const again = await generate(app, cookies, { estimateId: quote.id });
    expect(again.json()).toMatchObject({ error: 'estimate_used' });
  });

  it('takes a raw image answer as well as a base64 one', async () => {
    await reset({ providers: { cloudflare: { rawImage: true } } });
    const { cookies } = await sessionFor();
    const quote = (await estimate(app, cookies, image())).json<{ estimate: MediaEstimate }>().estimate;
    const generation = (await generate(app, cookies, { estimateId: quote.id })).json<{
      generation: MediaGeneration;
    }>().generation;
    expect(generation.status).toBe('succeeded');
    expect(generation.assetIds).toHaveLength(1);
  });

  it('refuses a shape the model does not draw instead of guessing a size', async () => {
    const { cookies } = await sessionFor();
    const refused = await estimate(app, cookies, image({ aspect: '9:16' }));
    expect(refused.statusCode).toBe(400);
    expect(refused.json()).toMatchObject({
      error: 'invalid_request',
      message: 'Este modelo não gera no formato 9:16.',
    });
  });
});

describe('Gemini', () => {
  it('generates in the shape asked, edits a library picture handed over inline, and counts per minute', async () => {
    const { cookies, employeeId } = await sessionFor();
    const stored = await storeMedia(db, mediaDir, {
      ownerId: employeeId,
      origin: 'upload',
      bytes: fakePng(1200, 800),
    });
    if (!stored.ok) throw new Error('expected an upload');

    const quoted = await estimate(
      app,
      cookies,
      image({
        model: 'gemini/gemini-2.5-flash-image',
        aspect: '9:16',
        referenceAssetId: stored.id,
        referenceUse: 'edit',
        negativePrompt: 'text, watermark',
      }),
    );
    expect(quoted.statusCode).toBe(201);
    const quote = quoted.json<{ estimate: MediaEstimate }>().estimate;
    expect(quote).toMatchObject({ providerId: 'gemini', brlCents: 0, credits: 0 });

    const generation = (await generate(app, cookies, { estimateId: quote.id })).json<{
      generation: MediaGeneration;
    }>().generation;
    expect(generation.status).toBe('succeeded');
    const calls = providers.state.calls.filter((item) => item.provider === 'gemini');
    expect(calls).toHaveLength(1);
    const body = calls[0]?.body as {
      contents: { parts: Record<string, unknown>[] }[];
      generationConfig: Record<string, unknown>;
    };
    expect(calls[0]?.headers['x-goog-api-key']).toBe('gemini_key_test');
    expect(body.generationConfig).toEqual({
      responseModalities: ['IMAGE'],
      imageConfig: { aspectRatio: '9:16' },
    });
    expect(body.contents[0]?.parts[0]?.text).toContain('Do not include: text, watermark');
    // The picture itself went along, base64, with its type: no link of ours was published.
    expect(body.contents[0]?.parts[1]).toMatchObject({ inlineData: { mimeType: 'image/png' } });
    expect(await db.select().from(mediaPublicLinks)).toHaveLength(0);

    const asset = await db.query.mediaAssets.findFirst({
      where: eq(mediaAssets.id, generation.assetIds[0] ?? ''),
    });
    expect(asset).toMatchObject({ origin: 'gemini', width: 576, height: 1024, sourceAssetId: stored.id });

    const status = (await app.inject({ url: '/media/providers', cookies })).json<{
      providers: MediaProviderStatus[];
    }>();
    expect(status.providers.find((item) => item.id === 'gemini')?.quota).toEqual({
      usedToday: 1,
      dailyLimit: 50,
      usedThisMinute: 1,
      perMinuteLimit: 5,
    });
  });

  it('records a refusal in words as refused, with its words as its own, and gives the quota back nothing', async () => {
    await reset({ providers: { gemini: { refuseWithText: true } } });
    const { cookies } = await sessionFor();
    const quote = (
      await estimate(app, cookies, image({ model: 'gemini/gemini-2.5-flash-image' }))
    ).json<{ estimate: MediaEstimate }>().estimate;
    const generation = (await generate(app, cookies, { estimateId: quote.id })).json<{
      generation: MediaGeneration;
    }>().generation;
    expect(generation.status).toBe('refused');
    expect(generation.detail).toContain('O Gemini respondeu sem imagem. Resposta dele: I cannot create that image.');
    expect(generation.assetIds).toHaveLength(0);
  });
});

describe('Higgsfield', () => {
  it('prices in dollars converted to reais, is followed like Kairogen, and is corrected by the real charge', async () => {
    await reset({ providers: { higgsfield: { pollsUntilDone: 2, chargeUsd: 0.04 } } });
    const { cookies } = await sessionFor();
    const quoted = await estimate(app, cookies, image({ model: 'higgsfield/soul', aspect: '4:5' }));
    expect(quoted.statusCode).toBe(201);
    const quote = quoted.json<{ estimate: MediaEstimate }>().estimate;
    expect(quote).toMatchObject({ providerId: 'higgsfield', credits: 0, brlCents: 28, blockedBy: null });

    const started = (await generate(app, cookies, { estimateId: quote.id })).json<{
      generation: MediaGeneration;
    }>().generation;
    expect(started.status).toBe('running');
    const posted = providers.state.calls.filter(
      (item) => item.provider === 'higgsfield' && item.method === 'POST',
    );
    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({
      url: 'https://platform.higgsfield.ai/v1/text2image/soul',
      headers: { 'hf-api-key': 'hf_key_test' },
      body: { params: { prompt: image().prompt, aspect_ratio: '4:5' } },
    });

    expect((await follow(app, cookies, started.id, 1))?.status).toBe('running');
    expect((await follow(app, cookies, started.id, 1))?.status).toBe('running');
    const finished = await follow(app, cookies, started.id, 1);
    expect(finished?.status).toBe('succeeded');
    expect(finished?.assetIds).toHaveLength(1);
    // Still one POST: following never sends the job again.
    expect(
      providers.state.calls.filter((item) => item.provider === 'higgsfield' && item.method === 'POST'),
    ).toHaveLength(1);

    const asset = await db.query.mediaAssets.findFirst({
      where: eq(mediaAssets.id, finished?.assetIds[0] ?? ''),
    });
    expect(asset).toMatchObject({ origin: 'higgsfield' });
    expect(asset?.sourceUrl).toMatch(/^https:\/\/cdn\.higgsfield\.test\//);

    // USD 0.04 at 5.5 = 22 cents: the ledger is corrected by the 6 cents of difference.
    const rows = await ledgerOf(started.id);
    expect(rows.map((row) => [row.event, row.brlCentsDelta, row.brlCentsCharged])).toEqual([
      ['estimated', 0, null],
      ['started', 28, null],
      ['succeeded', -6, 22],
    ]);
    const spend = (await app.inject({ url: '/media/providers', cookies })).json<{
      spend: { usedThisMonthBrlCents: number };
      providers: MediaProviderStatus[];
    }>();
    expect(spend.spend.usedThisMonthBrlCents).toBe(22);
    expect(spend.providers.find((item) => item.id === 'higgsfield')?.usedThisMonthBrlCents).toBe(22);
  });

  it('needs a first frame for a video, and reads it through a signed link of ours', async () => {
    const { cookies, employeeId } = await sessionFor();
    const refused = await estimate(
      app,
      cookies,
      image({ model: 'higgsfield/dop', kind: 'video', aspect: '9:16', durationSeconds: 5 }),
    );
    expect(refused.statusCode).toBe(422);
    expect(refused.json().message).toContain('parte de uma imagem');

    const stored = await storeMedia(db, mediaDir, {
      ownerId: employeeId,
      origin: 'upload',
      bytes: fakePng(1080, 1920),
    });
    if (!stored.ok) throw new Error('expected an upload');
    const quote = (
      await estimate(
        app,
        cookies,
        image({
          model: 'higgsfield/dop',
          kind: 'video',
          aspect: '9:16',
          durationSeconds: 10,
          referenceAssetId: stored.id,
        }),
      )
    ).json<{ estimate: MediaEstimate }>().estimate;
    // USD 0.10 × 10 s = 1.00 → R$ 5,50.
    expect(quote).toMatchObject({ providerId: 'higgsfield', brlCents: 550 });
    const started = (await generate(app, cookies, { estimateId: quote.id })).json<{
      generation: MediaGeneration;
    }>().generation;
    expect(started.status).toBe('running');
    const posted = providers.state.calls.find(
      (item) => item.provider === 'higgsfield' && item.method === 'POST',
    );
    expect(posted?.url).toBe('https://platform.higgsfield.ai/v1/image2video/dop');
    const params = (posted?.body as { params: { input_image: { image_url: string }; duration: number } }).params;
    expect(params.duration).toBe(10);
    expect(params.input_image.image_url).toMatch(
      /^https:\/\/staging\.wingssystem\.online\/api\/media\/public\/[0-9a-f-]+\?sig=/,
    );
    expect(await db.select().from(mediaPublicLinks)).toHaveLength(1);
  });

  it('keeps the spend counted and never resends when nobody knows whether the job arrived', async () => {
    await reset({ providers: { higgsfield: { drop: true } } });
    const { cookies } = await sessionFor();
    const quote = (await estimate(app, cookies, image({ model: 'higgsfield/soul' }))).json<{
      estimate: MediaEstimate;
    }>().estimate;
    const generation = (await generate(app, cookies, { estimateId: quote.id })).json<{
      generation: MediaGeneration;
    }>().generation;
    expect(generation.status).toBe('unknown');
    const rows = await ledgerOf(generation.id);
    expect(rows.map((row) => [row.event, row.brlCentsDelta])).toEqual([
      ['estimated', 0],
      ['started', 28],
      ['unknown', 0],
    ]);
  });
});

describe('MoneyPrinterTurbo', () => {
  it('makes a short video for R$ 0, followed until the file is fetched from our own service', async () => {
    await reset({ providers: { mpt: { pollsUntilDone: 1 } } });
    const { cookies } = await sessionFor();
    const quoted = await estimate(
      app,
      cookies,
      image({ model: 'mpt/short-video', kind: 'video', aspect: '9:16' }),
    );
    expect(quoted.statusCode).toBe(201);
    const quote = quoted.json<{ estimate: MediaEstimate }>().estimate;
    expect(quote).toMatchObject({ providerId: 'mpt', brlCents: 0, credits: 0 });

    const started = (await generate(app, cookies, { estimateId: quote.id })).json<{
      generation: MediaGeneration;
    }>().generation;
    expect(started.status).toBe('running');
    expect((await follow(app, cookies, started.id, 1))?.status).toBe('running');
    const finished = await follow(app, cookies, started.id, 1);
    expect(finished?.status).toBe('succeeded');
    const asset = await db.query.mediaAssets.findFirst({
      where: eq(mediaAssets.id, finished?.assetIds[0] ?? ''),
    });
    expect(asset).toMatchObject({ origin: 'mpt', kind: 'video', mimeType: 'video/mp4' });

    // The ping is remembered for a minute, so it may or may not show here.
    const calls = providers.state.calls.filter(
      (item) => item.provider === 'mpt' && !item.url.endsWith('/ping'),
    );
    expect(calls.map((item) => [item.method, new URL(item.url).pathname])).toEqual([
      ['POST', '/api/v1/videos'],
      ['GET', expect.stringMatching(/^\/api\/v1\/tasks\//)],
      ['GET', expect.stringMatching(/^\/api\/v1\/tasks\//)],
      ['GET', expect.stringMatching(/^\/tasks\/.+\/final-1\.mp4$/)],
    ]);
    expect(calls[0]?.body).toMatchObject({
      video_subject: image().prompt,
      video_aspect: '9:16',
      video_count: 1,
    });
    // Nothing left the machine for any other host.
    expect(providers.state.calls.filter((item) => item.provider === 'other')).toHaveLength(0);
  });

  it('is unavailable when the service is down, and says so before any price', async () => {
    await reset({ providers: { mpt: { down: true } } });
    // A fresh app: the ping of a running service is remembered for a minute.
    const fresh = await build();
    try {
      const { cookies } = await sessionFor();
      const status = (await fresh.inject({ url: '/media/providers', cookies })).json<{
        providers: MediaProviderStatus[];
      }>();
      expect(status.providers.find((item) => item.id === 'mpt')).toMatchObject({
        configured: true,
        available: false,
        reason: 'O serviço MoneyPrinterTurbo não respondeu.',
      });
      const refused = await estimate(
        fresh,
        cookies,
        image({ model: 'mpt/short-video', kind: 'video', aspect: '9:16' }),
      );
      expect(refused.statusCode).toBe(409);
      expect(refused.json()).toMatchObject({ error: 'provider_unavailable' });
      expect(refused.json().message).toContain(
        'MoneyPrinterTurbo: O serviço MoneyPrinterTurbo não respondeu.',
      );
    } finally {
      await fresh.close();
    }
  });
});

describe('routing with failover', () => {
  let tight: FastifyInstance;
  beforeAll(async () => {
    // One free picture per provider, four Kairogen credits already paid for
    // (R$ 0 a credit, the default), thirty cents a month over everything.
    tight = await build({
      CF_WORKERS_AI_DAILY_IMAGES: '1',
      GEMINI_DAILY_IMAGES: '1',
      KAIROGEN_MONTHLY_CREDITS: '4',
      KAIROGEN_BRL_PER_CREDIT: '',
      MEDIA_MONTHLY_BRL: '0.30',
    });
  });
  afterAll(async () => {
    await tight?.close();
  });

  it('goes down in price on its own and only offers a way up, until the one ceiling in reais refuses', async () => {
    const { cookies } = await sessionFor();

    // 1. Kairogen's month is spent by one Seedream picture (4 credits).
    const seedream = (await estimate(tight, cookies, image({ model: 'seedream-v4', aspect: '1:1' }))).json<{
      estimate: MediaEstimate;
    }>().estimate;
    expect(seedream).toMatchObject({ providerId: 'kairogen', credits: 4, brlCents: 0, routedFrom: null });
    const first = (await generate(tight, cookies, { estimateId: seedream.id })).json<{
      generation: MediaGeneration;
    }>().generation;
    expect(first.status).toBe('running');

    // 2. Kairogen cannot serve now: the same request goes to the free provider, and says so.
    const routed = await estimate(tight, cookies, image({ model: 'seedream-v4', aspect: '1:1' }));
    expect(routed.statusCode).toBe(201);
    const down = routed.json<{ estimate: MediaEstimate }>().estimate;
    expect(down).toMatchObject({
      providerId: 'cloudflare',
      brlCents: 0,
      routedFrom: {
        model: 'seedream-v4',
        providerId: 'kairogen',
        reason: 'O limite de créditos do mês no Kairogen foi atingido (4 de 4).',
      },
    });
    expect(down.warnings.join(' ')).toContain(
      `Foi para FLUX.1 schnell (Cloudflare Workers AI), por ${formatBrl(0)}.`,
    );
    const row = await db.query.mediaGenerations.findFirst({ where: eq(mediaGenerations.id, down.id) });
    expect(row).toMatchObject({ provider: 'cloudflare', model: 'cloudflare/flux-1-schnell' });
    expect((await generate(tight, cookies, { estimateId: down.id })).json().generation.status).toBe(
      'succeeded',
    );

    // 3. Cloudflare's one picture is gone: an equal tier (Gemini, free) still takes over on its own.
    const sideways = (await estimate(tight, cookies, image())).json<{ estimate: MediaEstimate }>().estimate;
    expect(sideways).toMatchObject({
      providerId: 'gemini',
      routedFrom: { providerId: 'cloudflare', reason: 'Cota grátis do dia esgotada (1 de 1 imagens).' },
    });
    expect((await generate(tight, cookies, { estimateId: sideways.id })).json().generation.status).toBe(
      'succeeded',
    );

    // 4. Every free quota and the month's credits are gone: paying more is offered, never taken.
    const offered = await estimate(tight, cookies, image());
    expect(offered.statusCode).toBe(409);
    expect(offered.json()).toMatchObject({
      error: 'provider_unavailable',
      alternative: {
        model: 'higgsfield/soul',
        name: 'Higgsfield Soul',
        providerId: 'higgsfield',
        credits: 0,
        brlCents: 28,
      },
    });
    expect(offered.json().message).toContain('trocar para um provedor mais caro é um clique seu');
    expect(await db.select().from(mediaGenerations)).toHaveLength(3);

    // 5. The click on the alternative: an estimate on the costlier provider, made by the person.
    const paid = (await estimate(tight, cookies, image({ model: 'higgsfield/soul' }))).json<{
      estimate: MediaEstimate;
    }>().estimate;
    expect(paid).toMatchObject({ providerId: 'higgsfield', brlCents: 28, routedFrom: null, blockedBy: null });
    const job = (await generate(tight, cookies, { estimateId: paid.id })).json<{
      generation: MediaGeneration;
    }>().generation;
    expect(job.status).toBe('running');

    // 6. R$ 0,28 of the R$ 0,30 are counted: the next one would cross the ceiling, and the refusal says the numbers.
    const over = (await estimate(tight, cookies, image({ model: 'higgsfield/soul' }))).json<{
      estimate: MediaEstimate;
    }>().estimate;
    expect(over.blockedBy).toBe('monthly_brl_limit');
    expect(over.warnings.join(' ')).toContain(
      `O teto mensal de ${formatBrl(30)} em mídia seria ultrapassado: ${formatBrl(28)} já contados este mês e esta geração custa ${formatBrl(28)}.`,
    );
    const refused = await generate(tight, cookies, { estimateId: over.id });
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ error: 'monthly_brl_limit' });
    expect(refused.json().message).toContain(formatBrl(30));
    // A free generation still fits under a spent ceiling: the ceiling is about money.
    expect(
      providers.state.calls.filter((item) => item.provider === 'higgsfield' && item.method === 'POST'),
    ).toHaveLength(1);
  });

  it('warns when a campaign mixes models, and stays quiet within one', async () => {
    const { cookies } = await sessionFor();
    const quote = (await estimate(app, cookies, image({ campaign: 'Expansão 2027' }))).json<{
      estimate: MediaEstimate;
    }>().estimate;
    expect(quote.warnings.filter((item) => item.includes('Misturar'))).toEqual([]);
    expect((await generate(app, cookies, { estimateId: quote.id })).json().generation.status).toBe(
      'succeeded',
    );
    const same = (await estimate(app, cookies, image({ campaign: 'Expansão 2027' }))).json<{
      estimate: MediaEstimate;
    }>().estimate;
    expect(same.warnings.filter((item) => item.includes('Misturar'))).toEqual([]);
    const other = (
      await estimate(
        app,
        cookies,
        image({ model: 'gemini/gemini-2.5-flash-image', campaign: 'Expansão 2027' }),
      )
    ).json<{ estimate: MediaEstimate }>().estimate;
    expect(other.warnings.join(' ')).toContain(
      'A campanha "Expansão 2027" já tem imagem feita com cloudflare/flux-1-schnell (Cloudflare Workers AI). Misturar modelos muda o estilo',
    );
    const elsewhere = (
      await estimate(
        app,
        cookies,
        image({ model: 'gemini/gemini-2.5-flash-image', campaign: 'Outra campanha' }),
      )
    ).json<{ estimate: MediaEstimate }>().estimate;
    expect(elsewhere.warnings.filter((item) => item.includes('Misturar'))).toEqual([]);
  });
});

describe('the editing agent across providers', () => {
  const proposal = (overrides: Record<string, unknown> = {}) => ({
    kind: 'image',
    provider: 'cloudflare',
    model: 'cloudflare/flux-1-schnell',
    prompt:
      'Owner of a small bakery standing behind the counter, warm window light, 35mm, shallow depth of field, advertising photography, clean space at the top for headline, no text, no logos',
    explanation: 'Dona de padaria atrás do balcão, luz de janela. Para o feed, de graça na Cloudflare.',
    aspect: '1:1',
    quantity: 1,
    params: {},
    clientId: WINGS_CLIENT_ID,
    ...overrides,
  });

  async function talk(cookies: Record<string, string>, message: string) {
    const response = await app.inject({
      method: 'POST',
      url: '/agent/messages',
      cookies,
      payload: { scope: 'media', message },
    });
    const events = response.body
      .split('\n\n')
      .filter((block) => block.startsWith('data: '))
      .map((block) => JSON.parse(block.slice(6)) as AgentStreamEvent);
    const done = events.find((event) => event.type === 'done');
    return { response, message: done?.type === 'done' ? done.message : null };
  }

  it('lists providers, refuses a provider that does not match the model, and proposes with the price', async () => {
    const { cookies } = await sessionFor();
    script = [
      () => ({ toolCalls: [call('listar_provedores'), call('listar_modelos', { tipo: 'image' })] }),
      () => ({ toolCalls: [call('propor_geracao', proposal({ provider: 'gemini' }))] }),
      () => ({ toolCalls: [call('propor_geracao', proposal())] }),
      () => ({ text: 'Proposta na Cloudflare, de graça, 1:1.' }),
    ];
    const { message } = await talk(cookies, 'Uma imagem de padaria para o feed da Wings, a mais barata.');
    const results = (seen[1]?.messages ?? []).filter((item) => item.role === 'tool');
    expect(results[0]?.content).toContain('"provedor":"cloudflare"');
    expect(results[0]?.content).toContain('"cota_do_dia":{"usadas":0,"limite":50');
    expect(results[0]?.content).toContain('"gasto_no_mes_reais":0');
    expect(results[1]?.content).toContain('"reais_por_saida":0');
    expect(results[1]?.content).toContain('"gratis":true');
    // Cheapest first: the free ones before Kairogen, Kairogen before Higgsfield.
    const order = [...(results[1]?.content.matchAll(/"provedor":"([a-z]+)"/g) ?? [])].map((m) => m[1]);
    expect(order.indexOf('cloudflare')).toBeLessThan(order.indexOf('kairogen'));
    expect(order.indexOf('kairogen')).toBeLessThan(order.indexOf('higgsfield'));
    for (const secret of SECRETS) expect(JSON.stringify(seen)).not.toContain(secret);

    const mismatch = (seen[2]?.messages ?? []).filter((item) => item.role === 'tool').at(-1);
    expect(mismatch?.content).toContain('é do provedor \\"cloudflare\\", não de \\"gemini\\"');

    expect(message?.consulted.map((item) => item.label)).toEqual([
      'Provedores de mídia, saldo e cota',
      'Modelos e preços por provedor',
      'Proposta de geração',
      'Proposta de geração',
    ]);
    const card = message?.proposals[0];
    expect(card?.kind).toBe('generation');
    if (card?.kind !== 'generation' || !card.estimate) throw new Error('expected a priced card');
    expect(card.estimate).toMatchObject({ providerId: 'cloudflare', credits: 0, brlCents: 0 });
    expect(card.payload.provider).toBe('cloudflare');
    // Nothing was generated by proposing.
    expect(providers.state.calls.filter((item) => item.provider === 'cloudflare')).toHaveLength(0);
  });
});
