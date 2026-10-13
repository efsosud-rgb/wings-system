import type { WaRingingSnapshot } from '@wings/shared';

/**
 * Tests only: an answer for a stubbed `fetch` that behaves like an open
 * `text/event-stream` the test writes to, and that fails when the request is
 * aborted, as a real one does.
 */
export function fakeEventStream(signal?: AbortSignal | null) {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const encoder = new TextEncoder();
  let finished = false;
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  signal?.addEventListener('abort', () => {
    if (finished) return;
    finished = true;
    controller.error(new DOMException('aborted', 'AbortError'));
  });
  return {
    response: new Response(body, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    }),
    push(text: string) {
      if (!finished) controller.enqueue(encoder.encode(text));
    },
    end() {
      if (finished) return;
      finished = true;
      controller.close();
    },
  };
}

/** One `ringing` event as the server writes it. */
export const ringingEvent = (snapshot: WaRingingSnapshot) =>
  `event: ringing\ndata: ${JSON.stringify(snapshot)}\n\n`;
