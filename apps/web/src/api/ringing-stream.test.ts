import type { WaCall, WaRingingSnapshot } from '@wings/shared';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { fakeEventStream, ringingEvent } from './fake-event-stream.js';
import { createEventParser, openRingingStream } from './ringing-stream.js';
import { onUnauthorized } from './session-expiry.js';

/**
 * The browser end of `GET /whatsapp/calls/stream`: what it asks, what it does with
 * each event, and how it comes back when the connection is lost. No network: `fetch`
 * is a stub the test writes the stream through.
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
const none: WaRingingSnapshot = { calling: true, calls: [] };
const one: WaRingingSnapshot = { calling: true, calls: [call('c1')] };

interface Connection {
  init: RequestInit;
  stream?: ReturnType<typeof fakeEventStream>;
}
let connections: Connection[];
/** What the next connection gets: a status to refuse with, or an open stream. */
let nextStatus: number | null;
let handlers: {
  onSnapshot: Mock<(snapshot: WaRingingSnapshot) => void>;
  onLive: Mock<(live: boolean) => void>;
};
let close: (() => void) | undefined;

const settle = (ms: number) => vi.advanceTimersByTimeAsync(ms);

beforeEach(() => {
  vi.useFakeTimers();
  // No jitter: a wait is exactly the base.
  vi.spyOn(Math, 'random').mockReturnValue(0.5);
  connections = [];
  nextStatus = null;
  handlers = {
    onSnapshot: vi.fn<(snapshot: WaRingingSnapshot) => void>(),
    onLive: vi.fn<(live: boolean) => void>(),
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const connection: Connection = { init: init ?? {} };
      connections.push(connection);
      if (nextStatus !== null) return new Response('{}', { status: nextStatus });
      connection.stream = fakeEventStream(init?.signal);
      return connection.stream.response;
    }),
  );
});

afterEach(() => {
  close?.();
  close = undefined;
  onUnauthorized(null);
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const open = () => {
  close = openRingingStream(handlers);
};

describe('reading the stream', () => {
  it('asks passively, with the cookie, for an event stream', async () => {
    open();
    await settle(10);
    expect(connections).toHaveLength(1);
    expect(connections[0]!.init.credentials).toBe('include');
    expect(connections[0]!.init.headers).toMatchObject({
      Accept: 'text/event-stream',
      'x-wings-passive': '1',
    });
  });

  it('hands over each whole answer, and says it is live from the first one', async () => {
    open();
    await settle(10);
    expect(handlers.onLive).not.toHaveBeenCalled();
    connections[0]!.stream!.push(': stream\n\n' + ringingEvent(none));
    await settle(10);
    expect(handlers.onLive).toHaveBeenCalledTimes(1);
    expect(handlers.onLive).toHaveBeenCalledWith(true);
    connections[0]!.stream!.push(ringingEvent(one));
    await settle(10);
    expect(handlers.onSnapshot.mock.calls.map(([s]) => s)).toEqual([none, one]);
    expect(handlers.onLive).toHaveBeenCalledTimes(1);
  });

  it('ignores pings, events it does not know and answers that are not one', async () => {
    open();
    await settle(10);
    const stream = connections[0]!.stream!;
    stream.push(': ping\n\nevent: other\ndata: {"calling":true,"calls":[]}\n\n');
    stream.push('event: ringing\ndata: not json\n\n');
    stream.push('event: ringing\ndata: {"calling":"yes"}\n\n');
    await settle(10);
    expect(handlers.onSnapshot).not.toHaveBeenCalled();
    expect(handlers.onLive).not.toHaveBeenCalled();
  });

  it('puts together an event the network cut in pieces', () => {
    const seen: Array<[string, string]> = [];
    const parser = createEventParser((name, data) => seen.push([name, data]));
    const text = ringingEvent(one);
    parser.push(text.slice(0, 20));
    parser.push(text.slice(20, text.length - 1));
    expect(seen).toEqual([]);
    parser.push(text.slice(text.length - 1));
    expect(seen).toEqual([['ringing', JSON.stringify(one)]]);
  });
});

describe('when the session is gone', () => {
  it('takes a 401 as every other 401 and never asks again', async () => {
    const guard = vi.fn();
    onUnauthorized(guard);
    nextStatus = 401;
    open();
    await settle(10);
    expect(guard).toHaveBeenCalledTimes(1);
    await settle(10 * 60_000);
    expect(connections).toHaveLength(1);
    expect(handlers.onLive).not.toHaveBeenCalled();
  });

  it('takes the server saying so as a 401 too, and closes', async () => {
    const guard = vi.fn();
    onUnauthorized(guard);
    open();
    await settle(10);
    const stream = connections[0]!.stream!;
    stream.push(ringingEvent(none));
    stream.push('event: session_ended\ndata: {}\n\n');
    await settle(10);
    expect(guard).toHaveBeenCalledTimes(1);
    await settle(10 * 60_000);
    expect(connections).toHaveLength(1);
  });
});

describe('when the connection is lost', () => {
  it('says it is no longer live and comes back after a second', async () => {
    open();
    await settle(10);
    connections[0]!.stream!.push(ringingEvent(one));
    await settle(10);
    connections[0]!.stream!.end();
    await settle(10);
    expect(handlers.onLive.mock.calls.map(([live]) => live)).toEqual([true, false]);
    expect(connections).toHaveLength(1);

    await settle(1_000);
    expect(connections).toHaveLength(2);
    connections[1]!.stream!.push(ringingEvent(none));
    await settle(10);
    expect(handlers.onLive.mock.calls.map(([live]) => live)).toEqual([true, false, true]);
  });

  it('waits longer after each refusal, up to half a minute', async () => {
    nextStatus = 503;
    open();
    await settle(10);
    const waits: number[] = [];
    for (let i = 0; i < 7; i++) {
      const before = connections.length;
      let waited = 0;
      while (connections.length === before && waited < 40_000) {
        await settle(500);
        waited += 500;
      }
      waits.push(waited);
    }
    expect(waits).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000]);
  });

  it('waits a minute when the server says there are too many streams', async () => {
    nextStatus = 429;
    open();
    await settle(10);
    await settle(59_000);
    expect(connections).toHaveLength(1);
    await settle(1_100);
    expect(connections).toHaveLength(2);
  });

  it('does not take a stream that dies at once for a good one', async () => {
    open();
    for (let round = 0; round < 3; round++) {
      await settle(10);
      const stream = connections.at(-1)!.stream!;
      stream.push(ringingEvent(none));
      await settle(10);
      stream.end();
      await settle(10);
      // Up for a moment only: the next wait is longer than the last.
      await settle(1_000 * 2 ** round);
    }
    expect(connections).toHaveLength(4);
  });

  it('drops a connection that went silent and comes back', async () => {
    open();
    await settle(10);
    connections[0]!.stream!.push(ringingEvent(none));
    await settle(10);
    // A ping at 15 s keeps it alive...
    await settle(15_000);
    connections[0]!.stream!.push(': ping\n\n');
    await settle(40_000);
    expect(connections).toHaveLength(1);
    // ...and three missed ones do not.
    await settle(6_000);
    expect(handlers.onLive).toHaveBeenLastCalledWith(false);
    await settle(1_000);
    expect(connections).toHaveLength(2);
  });

  it('does not wait out the delay when the network comes back', async () => {
    nextStatus = 503;
    open();
    await settle(10);
    await settle(1_000);
    await settle(2_000);
    expect(connections).toHaveLength(3);
    nextStatus = null;
    window.dispatchEvent(new Event('online'));
    await settle(10);
    expect(connections).toHaveLength(4);
    // Not twice: the wait that was pending is gone.
    await settle(10_000);
    expect(connections).toHaveLength(4);
  });
});

describe('closing', () => {
  it('stops for good: aborts the request, reports nothing more, never comes back', async () => {
    open();
    await settle(10);
    connections[0]!.stream!.push(ringingEvent(none));
    await settle(10);
    const signal = connections[0]!.init.signal as AbortSignal;
    expect(signal.aborted).toBe(false);

    close!();
    await settle(10);
    expect(signal.aborted).toBe(true);
    expect(handlers.onLive.mock.calls.map(([live]) => live)).toEqual([true]);
    await settle(10 * 60_000);
    expect(connections).toHaveLength(1);
  });

  it('stops while waiting to retry', async () => {
    nextStatus = 503;
    open();
    await settle(10);
    close!();
    await settle(60_000);
    expect(connections).toHaveLength(1);
  });
});
