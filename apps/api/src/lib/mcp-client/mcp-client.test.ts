import { describe, expect, it } from 'vitest';
import { fakeKairogen } from '../../modules/integrations/kairogen/fake-kairogen.js';
import { McpClient, McpError } from './index.js';

const ENDPOINT = 'https://mcp.kairogen.ai/mcp';

function connected(options: Parameters<typeof fakeKairogen>[0] = {}) {
  const fake = fakeKairogen(options);
  fake.state.accessTokens.add('token-abc');
  const client = new McpClient({
    endpoint: ENDPOINT,
    fetch: fake.fetch,
    getAccessToken: async () => 'token-abc',
    retryDelayMs: 1,
  });
  return { fake, client };
}
const mcpCalls = (fake: ReturnType<typeof fakeKairogen>) =>
  fake.calls.filter((call) => call.url === ENDPOINT);

describe('the MCP client', () => {
  it('initializes once, keeps the session and the version the server settled on', async () => {
    const { fake, client } = connected();
    const tools = await client.listTools();
    await client.callTool('get_credits', {});

    const methods = mcpCalls(fake).map(
      (call) => (JSON.parse(call.body) as { method: string }).method,
    );
    expect(methods).toEqual([
      'initialize',
      'notifications/initialized',
      'tools/list',
      'tools/call',
    ]);
    // The fake answers with an older version than we asked for: that one is used.
    expect(client.protocolVersion).toBe('2025-03-26');
    expect(tools.map((tool) => tool.name)).toContain('generate_image');

    const [first, , third] = mcpCalls(fake);
    expect(first?.headers).toMatchObject({
      authorization: 'Bearer token-abc',
      accept: 'application/json, text/event-stream',
    });
    expect(first?.headers).not.toHaveProperty('mcp-session-id');
    expect(third?.headers).toMatchObject({
      'mcp-session-id': 'session-1',
      'mcp-protocol-version': '2025-03-26',
    });
  });

  it('reads a tool result from structured content, and from an event stream', async () => {
    const plain = connected({ credits: 77 });
    expect((await plain.client.callTool('get_credits', {})).data).toMatchObject({ credits_remaining: 77 });

    const streamed = connected({ credits: 12, streamResponses: true });
    const result = await streamed.client.callTool('get_credits', {});
    expect(result.data).toMatchObject({ credits_remaining: 12 });
    expect(result.text).toContain('12');
  });

  it('retries a read that failed in transit, and never a call that spends credits', async () => {
    const reading = connected();
    await reading.client.initialize();
    reading.fake.state.mcpScript = [503, 503];
    await expect(reading.client.callTool('get_credits', {}, { retry: true })).resolves.toBeTruthy();

    const spending = connected();
    await spending.client.initialize();
    spending.fake.state.mcpScript = [503];
    const error = await spending.client
      .callTool('generate_image', { prompt: 'x' })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(McpError);
    expect((error as McpError).code).toBe('unavailable');
    // Nobody knows whether it arrived: that is said, and it is not sent again.
    expect((error as McpError).outcomeUnknown).toBe(true);
    expect(spending.fake.state.toolCalls).toHaveLength(0);
    expect(spending.fake.state.mcpScript).toHaveLength(0);
  });

  it('reports a refused token as such, without ever quoting it', async () => {
    const { fake, client } = connected();
    fake.expireAccessTokens();
    const error = await client.listTools().catch((caught: unknown) => caught);
    expect((error as McpError).code).toBe('unauthorized');
    expect((error as McpError).message).not.toContain('token-abc');
  });

  it('turns a tool error and a transport failure into errors that carry no secret', async () => {
    const { client } = connected();
    await expect(client.callTool('not_a_tool', {})).rejects.toMatchObject({ code: 'tool_error' });

    const offline = new McpClient({
      endpoint: ENDPOINT,
      getAccessToken: async () => 'token-secret-xyz',
      fetch: (async () => {
        throw new TypeError('fetch failed: Bearer token-secret-xyz');
      }) as unknown as typeof fetch,
      retries: 0,
    });
    const error = await offline.initialize().catch((caught: unknown) => caught);
    expect((error as McpError).code).toBe('unavailable');
    expect((error as McpError).message).not.toContain('token-secret-xyz');
  });

  it('gives up on a server that does not answer in time', async () => {
    const slow = new McpClient({
      endpoint: ENDPOINT,
      getAccessToken: async () => 't',
      timeoutMs: 20,
      retries: 0,
      fetch: ((_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () =>
            reject(Object.assign(new Error('timed out'), { name: 'TimeoutError' })),
          );
        })) as unknown as typeof fetch,
    });
    await expect(slow.initialize()).rejects.toMatchObject({ code: 'timeout' });
  });
});
