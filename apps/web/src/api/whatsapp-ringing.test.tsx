import type { WaCall, WaRingingSnapshot } from '@wings/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeEventStream, ringingEvent } from './fake-event-stream.js';
import { useRingingCalls } from './whatsapp.js';

/**
 * How the call center gets its ringing calls: by the stream when it is up, and by
 * asking, slowly, only while it is down. `fetch` is a stub; the stream is written
 * to by the test.
 */

const call = (id: string): WaCall => ({
  id,
  direction: 'in',
  status: 'ringing',
  leadId: null,
  name: 'Pessoa',
  phone: '5521900000000',
  answerSdp: null,
  error: null,
  startedAt: '2026-10-13T12:00:00.000Z',
  connectedAt: null,
  endedAt: null,
  durationSeconds: null,
});
const quiet: WaRingingSnapshot = { calling: true, calls: [] };
const ringing: WaRingingSnapshot = { calling: true, calls: [call('c1')] };
const off: WaRingingSnapshot = { calling: false, calls: [] };

const server = {
  streamOpen: true,
  stream: null as ReturnType<typeof fakeEventStream> | null,
  streams: 0,
  answer: quiet as WaRingingSnapshot,
  /** When set, the next ask waits for the test before it answers. */
  hold: null as null | { release: () => void },
  asked: [] as number[],
};

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(Math, 'random').mockReturnValue(0.5);
  server.streamOpen = true;
  server.stream = null;
  server.streams = 0;
  server.answer = quiet;
  server.hold = null;
  server.asked = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input).replace(/^\/api/, '');
      if (path === '/whatsapp/calls/stream') {
        if (!server.streamOpen) return json({ error: 'down' }, 503);
        server.streams += 1;
        server.stream = fakeEventStream(init?.signal);
        return server.stream.response;
      }
      if (path === '/whatsapp/calls/ringing') {
        server.asked.push(Date.now());
        const answer = server.answer;
        if (server.hold) {
          await new Promise<void>((resolve) => {
            server.hold!.release = resolve;
          });
        }
        return json(answer);
      }
      return json({ error: 'not_found' }, 404);
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const settle = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });

/** Time passing with the stream alive: the server writes a ping line every 15 seconds. */
async function settleAlive(ms: number) {
  for (let left = ms; left > 0; left -= 15_000) {
    server.stream?.push(': ping\n\n');
    await settle(Math.min(left, 15_000));
  }
}

function mount(enabled = true) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return renderHook(({ on }) => useRingingCalls(on), { wrapper, initialProps: { on: enabled } });
}

describe('with the stream up', () => {
  it('shows what the stream pushes, and stops asking for it', async () => {
    const view = mount();
    await settle(10);
    server.stream!.push(ringingEvent(ringing));
    await settle(10);
    expect(view.result.current.data).toEqual(ringing);

    const askedByNow = server.asked.length;
    await settleAlive(10 * 60_000);
    expect(server.asked).toHaveLength(askedByNow);
    expect(server.streams).toBe(1);

    server.stream!.push(ringingEvent(quiet));
    await settle(10);
    expect(view.result.current.data).toEqual(quiet);
  });

  it('does not let an ask that was still on its way take over from the stream', async () => {
    server.answer = quiet;
    server.hold = { release: () => {} };
    const view = mount();
    await settle(10);
    // The first ask has not been answered; the stream already has the call.
    server.stream!.push(ringingEvent(ringing));
    await settle(10);
    server.hold.release();
    await settle(10);
    expect(view.result.current.data).toEqual(ringing);
  });
});

describe('with the stream down', () => {
  it('asks every ten seconds while calling is on', async () => {
    server.streamOpen = false;
    mount();
    await settle(10);
    expect(server.asked).toHaveLength(1);
    await settle(9_000);
    expect(server.asked).toHaveLength(1);
    await settle(1_100);
    expect(server.asked).toHaveLength(2);
    await settle(10_000);
    expect(server.asked).toHaveLength(3);
  });

  it('asks once a minute while calling is off, as before', async () => {
    server.streamOpen = false;
    server.answer = off;
    mount();
    await settle(10);
    expect(server.asked).toHaveLength(1);
    await settle(59_000);
    expect(server.asked).toHaveLength(1);
    await settle(1_100);
    expect(server.asked).toHaveLength(2);
  });

  it('asks at once when the stream drops, and stops again when it is back', async () => {
    const view = mount();
    await settle(10);
    server.stream!.push(ringingEvent(quiet));
    await settle(10);
    const before = server.asked.length;

    server.answer = ringing;
    act(() => server.stream!.end());
    // The ask and the reading of its answer take a few turns of the fake clock.
    await settle(100);
    await settle(100);
    expect(server.asked.length).toBe(before + 1);
    expect(view.result.current.data).toEqual(ringing);

    // The stream comes back after a second and says what it knows.
    await settle(1_000);
    expect(server.streams).toBe(2);
    server.stream!.push(ringingEvent(quiet));
    await settle(10);
    expect(view.result.current.data).toEqual(quiet);
    const after = server.asked.length;
    await settleAlive(5 * 60_000);
    expect(server.asked).toHaveLength(after);
  });
});

describe('not allowed to call', () => {
  it('opens nothing and asks nothing', async () => {
    mount(false);
    await settle(60_000);
    expect(server.streams).toBe(0);
    expect(server.asked).toHaveLength(0);
  });

  it('closes the stream when the permission goes away', async () => {
    const view = mount(true);
    await settle(10);
    expect(server.streams).toBe(1);
    view.rerender({ on: false });
    await settle(60_000);
    expect(server.streams).toBe(1);
    expect(server.asked.length).toBeLessThanOrEqual(1);
  });
});

describe('leaving the screen', () => {
  it('closes the stream and never opens another', async () => {
    const view = mount();
    await settle(10);
    expect(server.streams).toBe(1);
    view.unmount();
    await settle(10 * 60_000);
    expect(server.streams).toBe(1);
  });
});
