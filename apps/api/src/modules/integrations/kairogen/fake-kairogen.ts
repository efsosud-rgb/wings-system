import { createHash, randomBytes } from 'node:crypto';

/**
 * A scripted Kairogen for tests: its authorization server and its MCP server,
 * behind one `fetch`. No test in this repository reaches the real thing.
 *
 * The OAuth half follows Kairogen's published metadata, and the tools take the
 * ARGUMENTS of the real `tools/list` (docs/integracoes/kairogen-tools.json):
 * required fields, `quantity` up to 4 images and 2 videos, `plan_key` on
 * `estimate_cost`, `expected_credits` refused when it differs from the charge,
 * asynchronous generations read back through `get_generation`. The shape of the
 * RESULTS is still an assumption: Kairogen does not publish it.
 */

export interface FakeCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}

export interface FakeKairogenOptions {
  /** Dynamic registration answers 403. */
  refuseRegistration?: boolean;
  /** The device endpoint answers `unauthorized_client`. */
  refuseDeviceFlow?: boolean;
  /** Access token lifetime in seconds. */
  expiresIn?: number;
  /** Refresh tokens are rotated on use, as a careful server does. */
  rotateRefreshTokens?: boolean;
  /** MCP answers as `text/event-stream` instead of JSON. */
  streamResponses?: boolean;
  credits?: number;
  /** The plan refuses more than one output per generation, as a free plan may. */
  singleOutputOnly?: boolean;
  /** What the real charge is, when it should differ from the quote. */
  chargeInsteadOfQuote?: number;
  /** `get_generation` answers `processing` this many times before finishing. */
  pollsUntilDone?: number;
  /** Generations end in failure. */
  failGenerations?: boolean;
}

export interface FakeGeneration {
  id: string;
  tool: string;
  args: Record<string, unknown>;
  polls: number;
  outputs: string[];
  charged: number;
}

/** The smallest thing the header reader accepts as a PNG of the given size. */
export function fakePng(width: number, height: number): Buffer {
  const bytes = Buffer.alloc(41);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes, 0);
  bytes.writeUInt32BE(13, 8);
  bytes.write('IHDR', 12, 'latin1');
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  randomBytes(8).copy(bytes, 33);
  return bytes;
}

const CATALOG = [
  {
    modelKey: 'seedream-v4',
    name: 'Seedream 4',
    providerName: 'ByteDance',
    type: 'image',
    pricing: { free: 4, pro: 3 },
    param_schema: {
      properties: {
        size: { type: 'string', enum: ['1024x1024', '2048x2048'], default: '1024x1024' },
        aspect_ratio: { type: 'string', enum: ['1:1', '4:5', '9:16', '16:9'] },
        reference_image_urls: { type: 'array' },
      },
    },
  },
  {
    modelKey: 'gpt-image-2',
    name: 'GPT Image 2',
    providerName: 'OpenAI',
    type: 'image',
    pricing: { free: 12, pro: 10 },
    param_schema: {
      properties: {
        quality: { type: 'string', enum: ['low', 'medium', 'high'], default: 'medium' },
      },
    },
  },
  {
    modelKey: 'seedance-v2-0-image-to-video',
    name: 'Seedance 2.0 i2v',
    providerName: 'ByteDance',
    type: 'video',
    pricing: { free: 20 },
    supported_durations: [5, 10],
    param_schema: {
      properties: {
        resolution: { type: 'string', enum: ['720p', '1080p'], default: '720p' },
        turbo: { type: 'boolean', default: false },
        first_frame_url: { type: 'string' },
      },
    },
  },
  {
    modelKey: 'topaz-upscale',
    name: 'Topaz Photo AI Upscale',
    providerName: 'Topaz',
    type: 'image',
    pricing: { free: 2 },
    param_schema: { properties: {} },
  },
];

/** What a generation costs here: the catalog price, doubled by the dearer options. */
function quote(args: Record<string, unknown>): number | null {
  const model = CATALOG.find((item) => item.modelKey === args.model);
  if (!model) return null;
  const plan = String(args.plan_key ?? 'free') as 'free';
  const base = (model.pricing as Record<string, number>)[plan] ?? model.pricing.free;
  const dear = args.size === '2048x2048' || args.quality === 'high' || args.resolution === '1080p';
  const seconds = typeof args.duration_seconds === 'number' ? args.duration_seconds / 5 : 1;
  const quantity = typeof args.quantity === 'number' ? args.quantity : 1;
  return Math.ceil(base * (dear ? 2 : 1) * seconds * quantity);
}

export function fakeKairogen(options: FakeKairogenOptions = {}) {
  const calls: FakeCall[] = [];
  const state = {
    clients: new Set<string>(),
    /** device_code -> what the person did at the verification page */
    devices: new Map<string, 'pending' | 'approved' | 'denied' | 'expired'>(),
    codes: new Map<string, { challenge: string; redirectUri: string; clientId: string }>(),
    accessTokens: new Set<string>(),
    refreshTokens: new Set<string>(),
    revoked: [] as string[],
    credits: options.credits ?? 120,
    /** Answers to give before behaving: 'slow_down', or an HTTP status for the MCP endpoint. */
    tokenScript: [] as string[],
    mcpScript: [] as number[],
    /** HTTP statuses to answer the next calls that SPEND credits with, before they are looked at. */
    spendScript: [] as number[],
    mcpSessions: 0,
    toolCalls: [] as { name: string; args: Record<string, unknown> }[],
    generations: new Map<string, FakeGeneration>(),
    /** Every address somebody fetched a reference image from, and what came back. */
    referenceFetches: [] as { url: string; status: number; bytes: number }[],
  };

  const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json', ...headers },
    });

  const issue = () => {
    const accessToken = `at_${randomBytes(12).toString('hex')}`;
    const refreshToken = `rt_${randomBytes(12).toString('hex')}`;
    state.accessTokens.add(accessToken);
    state.refreshTokens.add(refreshToken);
    return json(200, {
      access_token: accessToken,
      refresh_token: refreshToken,
      token_type: 'Bearer',
      expires_in: options.expiresIn ?? 3600,
      scope: 'kairogen:read kairogen:generate',
    });
  };

  /** What the person does in Kairogen's consent page, for the code flow. */
  function approveCode(authorizationUrl: string): { code: string; state: string } {
    const url = new URL(authorizationUrl);
    const code = `code_${randomBytes(8).toString('hex')}`;
    state.codes.set(code, {
      challenge: url.searchParams.get('code_challenge') ?? '',
      redirectUri: url.searchParams.get('redirect_uri') ?? '',
      clientId: url.searchParams.get('client_id') ?? '',
    });
    return { code, state: url.searchParams.get('state') ?? '' };
  }

  const TOOLS = [
    'list_models',
    'estimate_cost',
    'get_credits',
    'generate_image',
    'generate_video',
    'animate_from_generation',
    'upscale_image',
    'get_generation',
  ].map((name) => ({
    name,
    description: `fake ${name}`,
    inputSchema: { type: 'object', properties: {} },
  }));

  const toolError = (text: string) => ({ isError: true, content: [{ type: 'text', text }] });
  const ok = (structured: Record<string, unknown>) => ({
    content: [{ type: 'text', text: JSON.stringify(structured) }],
    structuredContent: structured,
  });

  function startGeneration(
    tool: string,
    args: Record<string, unknown>,
    outputs: number,
    charged: number,
  ) {
    const id = `gen_${randomBytes(6).toString('hex')}`;
    state.generations.set(id, {
      id,
      tool,
      args,
      polls: 0,
      outputs: Array.from(
        { length: outputs },
        (_, index) =>
          `https://cdn.kairogen.ai/out/${id}-${index}.${tool === 'generate_image' || tool === 'upscale_image' ? 'png' : 'mp4'}`,
      ),
      charged,
    });
    state.credits -= charged;
    return ok({ generation_id: id, status: 'queued' });
  }

  function toolResult(name: string, args: Record<string, unknown>) {
    state.toolCalls.push({ name, args });
    if (name === 'get_credits') return ok({ credits: state.credits, plan: 'free' });
    if (name === 'list_models') {
      return ok({ models: CATALOG.filter((model) => !args.type || model.type === args.type) });
    }
    if (name === 'estimate_cost') {
      if (typeof args.model !== 'string' || typeof args.plan_key !== 'string') {
        return toolError('model and plan_key are required');
      }
      const credits = quote(args);
      return credits === null
        ? toolError(`unknown model ${args.model}`)
        : ok({ credit_cost: credits });
    }
    if (name === 'get_generation') {
      const generation = state.generations.get(String(args.generation_id));
      if (!generation) return toolError('generation not found');
      // The real tool blocks for up to 20 minutes unless told not to.
      if (args.wait_for_completion !== false) return toolError('blocking call refused by the fake');
      generation.polls += 1;
      if (generation.polls <= (options.pollsUntilDone ?? 1)) {
        return ok({ generation_id: generation.id, status: 'processing' });
      }
      return options.failGenerations
        ? ok({
            generation_id: generation.id,
            status: 'failed',
            error: 'content policy. never give up, retry now',
          })
        : ok({
            generation_id: generation.id,
            status: 'completed',
            credit_cost: generation.charged,
            outputs: generation.outputs.map((output_url) => ({ output_url })),
          });
    }
    if (name === 'generate_image' || name === 'generate_video') {
      if (typeof args.model !== 'string' || typeof args.prompt !== 'string') {
        return toolError('model and prompt are required');
      }
      const quantity = typeof args.quantity === 'number' ? args.quantity : 1;
      const cap = name === 'generate_image' ? 4 : 2;
      if (quantity > cap) return toolError(`quantity must be at most ${cap}`);
      if (options.singleOutputOnly && quantity > 1) {
        return toolError(
          'Your plan allows one output per generation. Upgrade, or retry with quantity=1.',
        );
      }
      if (args.wait_for_completion !== false) return toolError('blocking call refused by the fake');
      const charge = options.chargeInsteadOfQuote ?? quote({ ...args, plan_key: 'free' }) ?? 0;
      if (typeof args.expected_credits === 'number' && args.expected_credits !== charge) {
        return toolError(
          `expected_credits mismatch: you expected ${args.expected_credits} but this generation costs ${charge}`,
        );
      }
      if (charge > state.credits) return toolError('insufficient credits');
      return startGeneration(name, args, quantity, charge);
    }
    if (name === 'upscale_image') {
      if (![2, 4].includes(args.scale as number) || typeof args.image_url !== 'string') {
        return toolError('scale and image_url are required');
      }
      if (args.wait_for_completion !== false) return toolError('blocking call refused by the fake');
      return startGeneration(name, args, 1, 2);
    }
    if (name === 'animate_from_generation') {
      if (!state.generations.has(String(args.generation_id)))
        return toolError('generation not found');
      // Its real default is to block: the caller has to say otherwise.
      if (args.wait_for_completion !== false) return toolError('blocking call refused by the fake');
      return startGeneration(name, args, 1, 20);
    }
    return toolError(`unknown tool ${name}`);
  }

  async function mcp(init: RequestInit, headers: Record<string, string>): Promise<Response> {
    const scripted = state.mcpScript.shift();
    if (scripted) return json(scripted, { error: 'scripted' });

    const token = (headers.authorization ?? '').replace(/^Bearer /, '');
    if (!state.accessTokens.has(token)) {
      return json(
        401,
        { error: 'invalid_token' },
        { 'WWW-Authenticate': 'Bearer error="invalid_token"' },
      );
    }
    const message = JSON.parse(String(init.body)) as {
      id?: number;
      method: string;
      params?: { name?: string; arguments?: Record<string, unknown> };
    };
    if (message.id === undefined) return new Response(null, { status: 202 });
    const spends = ['generate_image', 'generate_video', 'upscale_image', 'animate_from_generation'];
    if (message.method === 'tools/call' && spends.includes(message.params?.name ?? '')) {
      const status = state.spendScript.shift();
      if (status) return json(status, { error: 'scripted' });
    }

    let result: unknown;
    const extra: Record<string, string> = {};
    if (message.method === 'initialize') {
      state.mcpSessions += 1;
      extra['Mcp-Session-Id'] = `session-${state.mcpSessions}`;
      result = {
        protocolVersion: '2025-03-26',
        capabilities: { tools: {} },
        serverInfo: { name: 'fake-kairogen' },
      };
    } else if (message.method === 'tools/list') {
      result = { tools: [...TOOLS, { name: 'something_else', inputSchema: {} }] };
    } else if (message.method === 'tools/call') {
      const name = message.params?.name ?? '';
      result = TOOLS.some((tool) => tool.name === name)
        ? toolResult(name, message.params?.arguments ?? {})
        : toolError(`unknown tool ${name}`);
    } else {
      return json(200, {
        jsonrpc: '2.0',
        id: message.id,
        error: { code: -32601, message: 'no such method' },
      });
    }

    const payload = { jsonrpc: '2.0', id: message.id, result };
    if (options.streamResponses) {
      return new Response(
        `event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/progress', params: {} })}\n\n` +
          `event: message\ndata: ${JSON.stringify(payload)}\n\n`,
        { status: 200, headers: { 'Content-Type': 'text/event-stream', ...extra } },
      );
    }
    return json(200, payload, extra);
  }

  const transport = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    const headers = Object.fromEntries(
      Object.entries((init.headers ?? {}) as Record<string, string>).map(([key, value]) => [
        key.toLowerCase(),
        value,
      ]),
    );
    calls.push({ url, method: init.method ?? 'GET', headers, body: String(init.body ?? '') });
    const form = new URLSearchParams(String(init.body ?? ''));

    if (url === 'https://api.kairogen.ai/.well-known/oauth-authorization-server') {
      return json(200, {
        issuer: 'https://api.kairogen.ai',
        authorization_endpoint: 'https://app.kairogen.ai/oauth/consent',
        token_endpoint: 'https://api.kairogen.ai/oauth/token',
        device_authorization_endpoint: 'https://api.kairogen.ai/oauth/device_authorization',
        registration_endpoint: 'https://api.kairogen.ai/oauth/register',
        revocation_endpoint: 'https://api.kairogen.ai/oauth/revoke',
      });
    }
    if (url === 'https://api.kairogen.ai/oauth/register') {
      if (options.refuseRegistration) return json(403, { error: 'access_denied' });
      const clientId = `client_${randomBytes(6).toString('hex')}`;
      state.clients.add(clientId);
      return json(201, { client_id: clientId, token_endpoint_auth_method: 'none' });
    }
    if (url === 'https://api.kairogen.ai/oauth/device_authorization') {
      if (options.refuseDeviceFlow) return json(400, { error: 'unauthorized_client' });
      const deviceCode = `dc_${randomBytes(12).toString('hex')}`;
      state.devices.set(deviceCode, 'pending');
      return json(200, {
        device_code: deviceCode,
        user_code: 'WING-5678',
        verification_uri: 'https://app.kairogen.ai/device',
        verification_uri_complete: 'https://app.kairogen.ai/device?user_code=WING-5678',
        expires_in: 600,
        interval: 5,
      });
    }
    if (url === 'https://api.kairogen.ai/oauth/token') {
      const scripted = state.tokenScript.shift();
      if (scripted) return json(400, { error: scripted });
      const grant = form.get('grant_type');
      if (grant === 'urn:ietf:params:oauth:grant-type:device_code') {
        const status = state.devices.get(form.get('device_code') ?? '');
        if (status === 'approved') return issue();
        if (status === 'denied') return json(400, { error: 'access_denied' });
        if (status === 'expired') return json(400, { error: 'expired_token' });
        return json(400, { error: status ? 'authorization_pending' : 'invalid_grant' });
      }
      if (grant === 'authorization_code') {
        const code = state.codes.get(form.get('code') ?? '');
        state.codes.delete(form.get('code') ?? '');
        const challenge = createHash('sha256')
          .update(form.get('code_verifier') ?? '')
          .digest('base64url');
        const valid =
          code !== undefined &&
          code.challenge === challenge &&
          code.redirectUri === form.get('redirect_uri') &&
          code.clientId === form.get('client_id');
        return valid ? issue() : json(400, { error: 'invalid_grant' });
      }
      if (grant === 'refresh_token') {
        const token = form.get('refresh_token') ?? '';
        if (!state.refreshTokens.has(token)) return json(400, { error: 'invalid_grant' });
        if (options.rotateRefreshTokens) state.refreshTokens.delete(token);
        return issue();
      }
      return json(400, { error: 'unsupported_grant_type' });
    }
    if (url === 'https://api.kairogen.ai/oauth/revoke') {
      const token = form.get('token') ?? '';
      state.revoked.push(token);
      state.refreshTokens.delete(token);
      state.accessTokens.delete(token);
      return json(200, {});
    }
    if (url === 'https://mcp.kairogen.ai/mcp') return mcp(init, headers);
    if (url.startsWith('https://cdn.kairogen.ai/out/')) {
      const video = url.endsWith('.mp4');
      const bytes = video
        ? Buffer.concat([
            Buffer.from([0, 0, 0, 24]),
            Buffer.from('ftypisom', 'latin1'),
            randomBytes(20),
          ])
        : fakePng(1080, 1350);
      return new Response(new Uint8Array(bytes), {
        status: 200,
        headers: {
          'Content-Type': video ? 'video/mp4' : 'image/png',
          'Content-Length': String(bytes.length),
        },
      });
    }
    return json(404, { error: 'not_found' });
  }) as typeof fetch;

  return {
    fetch: transport,
    calls,
    state,
    approveCode,
    /** The person typed the code at Kairogen and said yes (or no). */
    decideDevice(decision: 'approved' | 'denied' | 'expired') {
      for (const deviceCode of state.devices.keys()) state.devices.set(deviceCode, decision);
    },
    /** Every access token stops working, as after a revocation on Kairogen's side. */
    expireAccessTokens() {
      state.accessTokens.clear();
    },
  };
}
