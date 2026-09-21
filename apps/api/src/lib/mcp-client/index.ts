/**
 * A small MCP client over Streamable HTTP.
 *
 * What it speaks: JSON-RPC 2.0 by POST to one endpoint, `Authorization: Bearer`,
 * an answer that is either `application/json` or a `text/event-stream` carrying
 * the JSON-RPC response, the `Mcp-Session-Id` the server may hand out at
 * `initialize`, and the `MCP-Protocol-Version` header on every call after it.
 * What it does not: server-initiated requests, resumable streams, sampling.
 * A tool server that only answers tool calls needs none of that.
 *
 * The token never appears in an error, a log line or a return value.
 */

export const MCP_PROTOCOL_VERSION = '2025-06-18';

export type McpErrorCode =
  'unauthorized' | 'timeout' | 'unavailable' | 'protocol' | 'tool_error' | 'rejected';

export class McpError extends Error {
  constructor(
    readonly code: McpErrorCode,
    message: string,
    /** True when the request may have reached the server and taken effect. */
    readonly outcomeUnknown = false,
  ) {
    super(message);
    this.name = 'McpError';
  }
}

export interface McpTool {
  name: string;
  description: string | null;
  inputSchema: Record<string, unknown> | null;
}

export interface McpToolResult {
  /** `structuredContent` when the server sends one; else the first text block parsed as JSON. */
  data: unknown;
  /** Every text block joined: what a person could read. */
  text: string;
}

export interface McpClientOptions {
  endpoint: string;
  /** Asked for on every request, so a refreshed token is picked up at once. */
  getAccessToken: () => Promise<string>;
  fetch?: typeof fetch;
  clientName?: string;
  clientVersion?: string;
  timeoutMs?: number;
  /** Extra attempts for calls marked `retry`. Writes are never retried. */
  retries?: number;
  retryDelayMs?: number;
}

interface JsonRpcResponse {
  jsonrpc?: string;
  id?: number | string | null;
  result?: unknown;
  error?: { code?: number; message?: string };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class McpClient {
  private readonly transport: typeof fetch;
  private readonly timeoutMs: number;
  private readonly retries: number;
  private readonly retryDelayMs: number;
  private sessionId: string | null = null;
  private negotiated: string | null = null;
  private nextId = 1;

  constructor(private readonly options: McpClientOptions) {
    this.transport = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.retries = options.retries ?? 2;
    this.retryDelayMs = options.retryDelayMs ?? 400;
  }

  /** The protocol version the server settled on. Null before `initialize`. */
  get protocolVersion(): string | null {
    return this.negotiated;
  }

  async initialize(): Promise<{ protocolVersion: string }> {
    const result = (await this.request(
      'initialize',
      {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: {
          name: this.options.clientName ?? 'wings-system',
          version: this.options.clientVersion ?? '1.0.0',
        },
      },
      { retry: true },
    )) as { protocolVersion?: unknown };
    // The server may answer with an older version it supports; that one is used from here on.
    this.negotiated =
      typeof result?.protocolVersion === 'string' ? result.protocolVersion : MCP_PROTOCOL_VERSION;
    await this.notify('notifications/initialized');
    return { protocolVersion: this.negotiated };
  }

  async listTools(): Promise<McpTool[]> {
    await this.ready();
    const tools: McpTool[] = [];
    let cursor: string | undefined;
    // Bounded: a server that keeps returning a cursor must not hold us forever.
    for (let page = 0; page < 20; page += 1) {
      const result = (await this.request('tools/list', cursor ? { cursor } : {}, {
        retry: true,
      })) as { tools?: unknown; nextCursor?: unknown };
      for (const item of Array.isArray(result?.tools) ? result.tools : []) {
        const tool = item as { name?: unknown; description?: unknown; inputSchema?: unknown };
        if (typeof tool.name !== 'string') continue;
        tools.push({
          name: tool.name,
          description: typeof tool.description === 'string' ? tool.description : null,
          inputSchema:
            tool.inputSchema !== null && typeof tool.inputSchema === 'object'
              ? (tool.inputSchema as Record<string, unknown>)
              : null,
        });
      }
      if (typeof result?.nextCursor !== 'string' || result.nextCursor === '') break;
      cursor = result.nextCursor;
    }
    return tools;
  }

  /**
   * Calls one tool. `retry` is for tools that only read: a call that spends
   * credits is sent once, and when nobody knows whether it arrived the error
   * says so (`outcomeUnknown`) instead of trying again.
   */
  async callTool(
    name: string,
    args: Record<string, unknown>,
    options: { retry?: boolean; timeoutMs?: number } = {},
  ): Promise<McpToolResult> {
    await this.ready();
    const result = (await this.request('tools/call', { name, arguments: args }, options)) as {
      content?: unknown;
      structuredContent?: unknown;
      isError?: unknown;
    };

    const text = (Array.isArray(result?.content) ? result.content : [])
      .flatMap((block) => {
        const item = block as { type?: unknown; text?: unknown };
        return item.type === 'text' && typeof item.text === 'string' ? [item.text] : [];
      })
      .join('\n');

    if (result?.isError === true) {
      throw new McpError('tool_error', text.slice(0, 500) || `a ferramenta ${name} recusou`);
    }

    let data: unknown = result?.structuredContent ?? null;
    if (data === null && text !== '') {
      try {
        data = JSON.parse(text);
      } catch {
        data = null;
      }
    }
    return { data, text };
  }

  private async ready(): Promise<void> {
    if (this.negotiated === null) await this.initialize();
  }

  private async notify(method: string): Promise<void> {
    await this.send({ jsonrpc: '2.0', method }, this.timeoutMs).catch(() => undefined);
  }

  private async request(
    method: string,
    params: Record<string, unknown>,
    options: { retry?: boolean; timeoutMs?: number },
  ): Promise<unknown> {
    const attempts = options.retry ? this.retries + 1 : 1;
    let last: McpError | null = null;

    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (attempt > 0) await sleep(this.retryDelayMs * attempt);
      const id = this.nextId++;
      try {
        const response = await this.send(
          { jsonrpc: '2.0', id, method, params },
          options.timeoutMs ?? this.timeoutMs,
        );
        if (!response) throw new McpError('protocol', 'resposta vazia do servidor MCP');
        if (response.error) {
          throw new McpError(
            'rejected',
            `o servidor MCP recusou ${method} (${response.error.code ?? 'sem código'})`,
          );
        }
        return response.result;
      } catch (error) {
        const failure =
          error instanceof McpError ? error : new McpError('unavailable', 'falha de transporte');
        // Only what may succeed on a second try is tried again.
        if (failure.code !== 'timeout' && failure.code !== 'unavailable') throw failure;
        last = failure;
      }
    }
    throw last ?? new McpError('unavailable', 'falha de transporte');
  }

  private async send(
    body: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<JsonRpcResponse | null> {
    const token = await this.options.getAccessToken();
    const isRequest = 'id' in body;
    let response: Response;
    try {
      response = await this.transport(this.options.endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          ...(this.negotiated ? { 'MCP-Protocol-Version': this.negotiated } : {}),
          ...(this.sessionId ? { 'Mcp-Session-Id': this.sessionId } : {}),
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      const timedOut = error instanceof Error && error.name === 'TimeoutError';
      // The error's own text is dropped: it can quote the request, headers included.
      throw new McpError(
        timedOut ? 'timeout' : 'unavailable',
        timedOut ? 'o servidor MCP não respondeu a tempo' : 'falha de transporte',
        true,
      );
    }

    const session = response.headers.get('mcp-session-id');
    if (session) this.sessionId = session;

    if (response.status === 401) throw new McpError('unauthorized', 'token recusado');
    if (response.status === 404 && this.sessionId) {
      // The server forgot the session: the next call starts a new one.
      this.sessionId = null;
      this.negotiated = null;
      throw new McpError('unavailable', 'sessão MCP expirada');
    }
    if (response.status >= 500 || response.status === 429) {
      throw new McpError('unavailable', `o servidor MCP respondeu ${response.status}`, true);
    }
    if (!response.ok) throw new McpError('rejected', `o servidor MCP respondeu ${response.status}`);
    if (!isRequest || response.status === 202) return null;

    const type = response.headers.get('content-type') ?? '';
    const text = await response.text();
    const parsed = type.includes('text/event-stream')
      ? fromEventStream(text, body.id)
      : tryJson(text);
    if (!parsed) throw new McpError('protocol', 'resposta que não é JSON-RPC');
    return parsed;
  }
}

function tryJson(text: string): JsonRpcResponse | null {
  try {
    const value = JSON.parse(text) as JsonRpcResponse | JsonRpcResponse[];
    return Array.isArray(value) ? (value[0] ?? null) : value;
  } catch {
    return null;
  }
}

/** The JSON-RPC response to `id` inside an SSE body; other events (progress, logs) are skipped. */
function fromEventStream(body: string, id: unknown): JsonRpcResponse | null {
  for (const block of body.replace(/\r\n/g, '\n').split('\n\n')) {
    const data = block
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).replace(/^ /, ''))
      .join('\n');
    if (data === '') continue;
    const message = tryJson(data);
    if (message && message.id === id && ('result' in message || 'error' in message)) return message;
  }
  return null;
}
