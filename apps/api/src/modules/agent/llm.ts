import type { AgentModel } from '@wings/shared';

/**
 * The one door to the language model.
 *
 * An interface, so that tests script a model turn by turn and no test ever
 * reaches OpenRouter. The real client speaks OpenRouter's chat completions
 * (OpenAI's wire format), streaming, with function calling. It is given no web
 * plugin, no `:online` model and no server-side tool: the model can read what
 * our own tools hand it and nothing else.
 */

export interface LlmToolDefinition {
  name: string;
  description: string;
  /** JSON Schema of the arguments. */
  parameters: Record<string, unknown>;
}

export interface LlmToolCall {
  id: string;
  name: string;
  /** Raw JSON as the model wrote it. Parsed and validated by the caller. */
  arguments: string;
}

export type LlmMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string; toolCalls?: LlmToolCall[] }
  | { role: 'tool'; toolCallId: string; content: string };

export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
  /** What the provider says the call cost, in US dollars. Null when it does not say. */
  costUsd: number | null;
}

export interface LlmTurn {
  text: string;
  toolCalls: LlmToolCall[];
  usage: LlmUsage;
  /**
   * Why the model stopped, as the provider names it: `stop`, `tool_calls`,
   * `length` when it ran into the output cap mid-sentence or mid-tool-call.
   * Ignoring this is how a reply gets cut with nobody told.
   */
  finishReason: string | null;
}

export interface LlmRequest {
  model: AgentModel;
  messages: LlmMessage[];
  tools: LlmToolDefinition[];
  maxOutputTokens: number;
  signal?: AbortSignal;
  /** Called with each piece of visible text as it arrives. */
  onText?: (delta: string) => void;
}

export interface AgentLlm {
  complete(request: LlmRequest): Promise<LlmTurn>;
}

export class LlmError extends Error {
  constructor(
    readonly code: 'provider_unavailable' | 'provider_refused' | 'aborted',
    message: string,
  ) {
    super(message);
    this.name = 'LlmError';
  }
}

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

interface StreamChunk {
  error?: { message?: string; code?: number | string };
  choices?: {
    finish_reason?: string | null;
    native_finish_reason?: string | null;
    delta?: {
      content?: string | null;
      tool_calls?: {
        index?: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      }[];
    };
  }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number | null };
}

function wireMessage(message: LlmMessage, isLastOfPrefix: boolean): Record<string, unknown> {
  if (message.role === 'tool') {
    return { role: 'tool', tool_call_id: message.toolCallId, content: message.content };
  }
  if (message.role === 'assistant') {
    return {
      role: 'assistant',
      content: message.content,
      ...(message.toolCalls && message.toolCalls.length > 0
        ? {
            tool_calls: message.toolCalls.map((call) => ({
              id: call.id,
              type: 'function',
              function: { name: call.name, arguments: call.arguments },
            })),
          }
        : {}),
    };
  }
  // The system prompt never changes between calls, so it is marked cacheable:
  // Anthropic models behind OpenRouter then bill the repeated prefix at a
  // fraction of the price.
  if (message.role === 'system' && isLastOfPrefix) {
    return {
      role: 'system',
      content: [{ type: 'text', text: message.content, cache_control: { type: 'ephemeral' } }],
    };
  }
  return { role: message.role, content: message.content };
}

export function createOpenRouterLlm(options: {
  apiKey: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}): AgentLlm {
  const transport = options.fetch ?? fetch;
  // One call may think, then write a whole proposal: slow, not stuck.
  const timeoutMs = options.timeoutMs ?? 180_000;

  return {
    async complete(request) {
      const signals = [AbortSignal.timeout(timeoutMs)];
      if (request.signal) signals.push(request.signal);

      let response: Response;
      try {
        response = await transport(OPENROUTER_URL, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${options.apiKey}`,
            'Content-Type': 'application/json',
            'X-Title': 'Wings System',
          },
          body: JSON.stringify({
            model: request.model,
            stream: true,
            max_tokens: request.maxOutputTokens,
            // Asks OpenRouter to report tokens and the real cost of this call.
            usage: { include: true },
            messages: request.messages.map((message, index) => wireMessage(message, index === 0)),
            tools: request.tools.map((tool) => ({
              type: 'function',
              function: {
                name: tool.name,
                description: tool.description,
                parameters: tool.parameters,
              },
            })),
          }),
          signal: AbortSignal.any(signals),
        });
      } catch (error) {
        if (request.signal?.aborted) throw new LlmError('aborted', 'cancelado');
        // Never the error's own text: it can quote the request, headers included.
        throw new LlmError(
          'provider_unavailable',
          `transport failure: ${error instanceof Error ? error.name : 'unknown'}`,
        );
      }

      if (!response.ok || !response.body) {
        throw new LlmError(
          response.status >= 500 || response.status === 429
            ? 'provider_unavailable'
            : 'provider_refused',
          `OpenRouter answered ${response.status}`,
        );
      }

      let text = '';
      const calls = new Map<number, LlmToolCall>();
      const usage: LlmUsage = { inputTokens: 0, outputTokens: 0, costUsd: null };
      let finishReason: string | null = null;

      const handle = (chunk: StreamChunk) => {
        if (chunk.error) {
          throw new LlmError('provider_unavailable', 'OpenRouter reported an error mid-stream');
        }
        const choice = chunk.choices?.[0];
        if (choice?.finish_reason) {
          // Anthropic's own word for the output cap is `max_tokens`.
          finishReason =
            choice.native_finish_reason === 'max_tokens' ? 'length' : choice.finish_reason;
        }
        const delta = choice?.delta;
        if (delta?.content) {
          text += delta.content;
          request.onText?.(delta.content);
        }
        for (const piece of delta?.tool_calls ?? []) {
          const index = piece.index ?? 0;
          const call = calls.get(index) ?? { id: '', name: '', arguments: '' };
          if (piece.id) call.id = piece.id;
          if (piece.function?.name) call.name += piece.function.name;
          if (piece.function?.arguments) call.arguments += piece.function.arguments;
          calls.set(index, call);
        }
        if (chunk.usage) {
          usage.inputTokens = chunk.usage.prompt_tokens ?? usage.inputTokens;
          usage.outputTokens = chunk.usage.completion_tokens ?? usage.outputTokens;
          if (typeof chunk.usage.cost === 'number') usage.costUsd = chunk.usage.cost;
        }
      };

      const decoder = new TextDecoder();
      let buffer = '';
      try {
        for await (const bytes of response.body as unknown as AsyncIterable<Uint8Array>) {
          buffer += decoder.decode(bytes, { stream: true });
          let newline = buffer.indexOf('\n');
          while (newline !== -1) {
            const line = buffer.slice(0, newline).trim();
            buffer = buffer.slice(newline + 1);
            newline = buffer.indexOf('\n');
            // Blank lines separate events; lines starting with ':' are keep-alives.
            if (!line.startsWith('data:')) continue;
            const data = line.slice(5).trim();
            if (data === '[DONE]') continue;
            let chunk: StreamChunk;
            try {
              chunk = JSON.parse(data) as StreamChunk;
            } catch {
              continue;
            }
            handle(chunk);
          }
        }
      } catch (error) {
        if (error instanceof LlmError) throw error;
        if (request.signal?.aborted) throw new LlmError('aborted', 'cancelado');
        throw new LlmError('provider_unavailable', 'the reply stream broke');
      }

      return {
        text,
        toolCalls: [...calls.entries()]
          .sort(([a], [b]) => a - b)
          .map(([index, call]) => ({ ...call, id: call.id || `call_${index}` }))
          .filter((call) => call.name !== ''),
        usage,
        finishReason,
      };
    },
  };
}
