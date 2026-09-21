import { describe, expect, it } from 'vitest';
import { createOpenRouterLlm, LlmError } from './llm.js';

/** No test reaches OpenRouter: the transport is a function that answers from a script. */
function streamOf(pieces: string[]): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const piece of pieces) controller.enqueue(encoder.encode(piece));
        controller.close();
      },
    }),
    { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
  );
}

const event = (payload: unknown) => `data: ${JSON.stringify(payload)}\n\n`;
const KEY = 'sk-or-v1-test-key-that-must-never-leak';

function client(respond: (body: Record<string, unknown>, init: RequestInit) => Response) {
  const calls: { url: string; body: Record<string, unknown>; headers: Record<string, string> }[] =
    [];
  const llm = createOpenRouterLlm({
    apiKey: KEY,
    fetch: (async (url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      calls.push({ url, body, headers: init.headers as Record<string, string> });
      return respond(body, init);
    }) as unknown as typeof fetch,
  });
  return { llm, calls };
}

const request = {
  model: 'anthropic/claude-sonnet-5' as const,
  messages: [
    { role: 'system' as const, content: 'regras' },
    { role: 'user' as const, content: 'como está a conta?' },
  ],
  tools: [{ name: 'estado_da_conta', description: 'x', parameters: { type: 'object' } }],
  maxOutputTokens: 500,
};

describe('the OpenRouter client', () => {
  it('streams text as it arrives and reports tokens and the real cost', async () => {
    const { llm, calls } = client(() =>
      streamOf([
        ': OPENROUTER PROCESSING\n\n',
        event({ choices: [{ delta: { content: 'Gasto de ' } }] }),
        event({ choices: [{ delta: { content: 'R$ 120,00.' } }] }),
        event({ choices: [], usage: { prompt_tokens: 1800, completion_tokens: 40, cost: 0.0041 } }),
        'data: [DONE]\n\n',
      ]),
    );
    const seen: string[] = [];
    const turn = await llm.complete({ ...request, onText: (delta) => seen.push(delta) });

    expect(seen).toEqual(['Gasto de ', 'R$ 120,00.']);
    expect(turn.text).toBe('Gasto de R$ 120,00.');
    expect(turn.toolCalls).toEqual([]);
    expect(turn.usage).toEqual({ inputTokens: 1800, outputTokens: 40, costUsd: 0.0041 });

    expect(calls[0]?.url).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(calls[0]?.headers.Authorization).toBe(`Bearer ${KEY}`);
    expect(calls[0]?.body).toMatchObject({
      model: 'anthropic/claude-sonnet-5',
      stream: true,
      max_tokens: 500,
      usage: { include: true },
    });
  });

  it('gives the model no way to the internet: no plugins, no online model, only our tools', async () => {
    const { llm, calls } = client(() => streamOf(['data: [DONE]\n\n']));
    await llm.complete(request);
    const body = calls[0]?.body ?? {};
    expect(body).not.toHaveProperty('plugins');
    expect(body).not.toHaveProperty('web_search_options');
    expect(String(body.model)).not.toContain(':online');
    expect((body.tools as { function: { name: string } }[]).map((t) => t.function.name)).toEqual([
      'estado_da_conta',
    ]);
  });

  it('marks the system prompt cacheable and leaves the rest as plain messages', async () => {
    const { llm, calls } = client(() => streamOf(['data: [DONE]\n\n']));
    await llm.complete(request);
    const messages = calls[0]?.body.messages as Record<string, unknown>[];
    expect(messages[0]).toEqual({
      role: 'system',
      content: [{ type: 'text', text: 'regras', cache_control: { type: 'ephemeral' } }],
    });
    expect(messages[1]).toEqual({ role: 'user', content: 'como está a conta?' });
  });

  it('assembles a tool call that arrives in pieces, even split inside a line', async () => {
    const whole =
      event({
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: 'call_1',
                  function: { name: 'desempenho_campanhas', arguments: '' },
                },
              ],
            },
          },
        ],
      }) +
      event({
        choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"di' } }] } }],
      }) +
      event({
        choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'as":30}' } }] } }],
      });
    const cut = Math.floor(whole.length / 2);
    const { llm } = client(() =>
      streamOf([whole.slice(0, cut), whole.slice(cut), 'data: [DONE]\n\n']),
    );

    const turn = await llm.complete(request);
    expect(turn.toolCalls).toEqual([
      { id: 'call_1', name: 'desempenho_campanhas', arguments: '{"dias":30}' },
    ]);
    expect(turn.usage.costUsd).toBeNull();
  });

  it('sends earlier tool calls and their results back in the wire format', async () => {
    const { llm, calls } = client(() => streamOf(['data: [DONE]\n\n']));
    await llm.complete({
      ...request,
      messages: [
        ...request.messages,
        {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'call_1', name: 'estado_da_conta', arguments: '{}' }],
        },
        { role: 'tool', toolCallId: 'call_1', content: '{"dados":{}}' },
      ],
    });
    const messages = calls[0]?.body.messages as Record<string, unknown>[];
    expect(messages[2]).toEqual({
      role: 'assistant',
      content: '',
      tool_calls: [
        { id: 'call_1', type: 'function', function: { name: 'estado_da_conta', arguments: '{}' } },
      ],
    });
    expect(messages[3]).toEqual({ role: 'tool', tool_call_id: 'call_1', content: '{"dados":{}}' });
  });

  it('turns provider failures into errors that never carry the key', async () => {
    const down = client(() => new Response('upstream', { status: 502 }));
    const refused = client(() => new Response('{"error":"bad"}', { status: 400 }));
    const broken = client(() => streamOf([event({ error: { message: 'overloaded', code: 529 } })]));
    const offline = createOpenRouterLlm({
      apiKey: KEY,
      fetch: (async () => {
        throw new TypeError(`fetch failed for Bearer ${KEY}`);
      }) as unknown as typeof fetch,
    });

    for (const [llm, code] of [
      [down.llm, 'provider_unavailable'],
      [refused.llm, 'provider_refused'],
      [broken.llm, 'provider_unavailable'],
      [offline, 'provider_unavailable'],
    ] as const) {
      const error = await llm.complete(request).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(LlmError);
      expect((error as LlmError).code).toBe(code);
      expect((error as LlmError).message).not.toContain(KEY);
    }
  });
});
