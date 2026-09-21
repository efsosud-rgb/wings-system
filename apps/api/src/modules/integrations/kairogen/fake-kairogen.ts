import { createHash, randomBytes } from 'node:crypto';

/**
 * A scripted Kairogen for tests: its authorization server and its MCP server,
 * behind one `fetch`. No test in this repository reaches the real thing.
 *
 * The OAuth half follows Kairogen's published metadata. The tools' ARGUMENTS
 * AND RESULTS ARE ASSUMPTIONS: `tools/list` needs a token, so their real shape
 * was unknown when this was written (docs/integracoes/kairogen.md). What the
 * tests prove is the client, the transport and the rules around them — not
 * that these shapes match Kairogen's.
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
    mcpSessions: 0,
    toolCalls: [] as { name: string; args: Record<string, unknown> }[],
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

  function toolResult(name: string, args: Record<string, unknown>) {
    state.toolCalls.push({ name, args });
    const structured: Record<string, unknown> =
      name === 'get_credits'
        ? { credits: state.credits }
        : name === 'list_models'
          ? { models: [{ id: 'fake-image-1', type: 'image' }] }
          : name === 'estimate_cost'
            ? { credits: 4 }
            : { id: 'gen_1', status: 'queued' };
    return {
      content: [{ type: 'text', text: JSON.stringify(structured) }],
      structuredContent: structured,
    };
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
        : { isError: true, content: [{ type: 'text', text: `unknown tool ${name}` }] };
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
