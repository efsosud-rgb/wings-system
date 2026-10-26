import type { WaInboxSummary, WaRingingSnapshot } from '@wings/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeEventStream, ringingEvent } from './fake-event-stream.js';
import { useRingingCalls, useWhatsAppInbox } from './whatsapp.js';
import { useInboxSummary } from './whatsapp-inbox.js';

/**
 * The inbox by the stream every screen keeps open: the menu's count comes with it,
 * a moved stamp makes the list fetch again at once, and only while the stream is
 * down is the count asked for. `fetch` is a stub; the stream is written by the test.
 */

const quiet: WaRingingSnapshot = { calling: true, calls: [] };
const inboxEvent = (summary: WaInboxSummary) =>
  `event: inbox\ndata: ${JSON.stringify(summary)}\n\n`;

const server = {
  streamOpen: true,
  stream: null as ReturnType<typeof fakeEventStream> | null,
  summary: { unread: 0, stamp: 'a' } as WaInboxSummary,
  summaryAsked: 0,
  listAsked: 0,
};

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(Math, 'random').mockReturnValue(0.5);
  server.streamOpen = true;
  server.stream = null;
  server.summary = { unread: 0, stamp: 'a' };
  server.summaryAsked = 0;
  server.listAsked = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input).replace(/^\/api/, '');
      if (path === '/whatsapp/calls/stream') {
        if (!server.streamOpen) return json({ error: 'down' }, 503);
        server.stream = fakeEventStream(init?.signal);
        return server.stream.response;
      }
      if (path === '/whatsapp/calls/ringing') return json(quiet);
      if (path === '/whatsapp/inbox/summary') {
        server.summaryAsked += 1;
        return json(server.summary);
      }
      if (path.startsWith('/whatsapp/conversations?')) {
        server.listAsked += 1;
        return json({ conversations: [] });
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

/** The call center's stream (always on in the app), the menu's count and the inbox list. */
function mount() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return renderHook(
    () => {
      useRingingCalls(true);
      return { summary: useInboxSummary(), list: useWhatsAppInbox('all', '') };
    },
    { wrapper },
  );
}

describe('with the stream up', () => {
  it('shows the count the stream brings and stops asking for it', async () => {
    const view = mount();
    await settle(10);
    server.stream!.push(ringingEvent(quiet) + inboxEvent({ unread: 2, stamp: 'b' }));
    await settle(10);
    expect(view.result.current.summary.data).toMatchObject({ unread: 2, stamp: 'b' });

    const asked = server.summaryAsked;
    await settleAlive(5 * 60_000);
    expect(server.summaryAsked).toBe(asked);
  });

  it('fetches the list again the moment the stamp moves, and not when it stays', async () => {
    mount();
    await settle(10);
    server.stream!.push(ringingEvent(quiet) + inboxEvent({ unread: 0, stamp: 'a' }));
    await settle(10);
    const listed = server.listAsked;

    server.stream!.push(inboxEvent({ unread: 1, stamp: 'b' }));
    await settle(10);
    expect(server.listAsked).toBe(listed + 1);

    // The same stamp again (a reconnect, a status that moved nothing): nothing to fetch.
    server.stream!.push(inboxEvent({ unread: 1, stamp: 'b' }));
    await settle(10);
    expect(server.listAsked).toBe(listed + 1);
  });
});

describe('with the stream down', () => {
  it('asks for the count every half minute', async () => {
    server.streamOpen = false;
    server.summary = { unread: 3, stamp: 'c' };
    const view = mount();
    await settle(10);
    expect(server.summaryAsked).toBe(1);
    expect(view.result.current.summary.data).toMatchObject({ unread: 3 });
    await settle(30_100);
    expect(server.summaryAsked).toBe(2);
  });

  it('asks again once the stream drops, and stops when it is back', async () => {
    const view = mount();
    await settle(10);
    server.stream!.push(ringingEvent(quiet) + inboxEvent({ unread: 1, stamp: 'b' }));
    await settle(10);
    const asked = server.summaryAsked;

    server.streamOpen = false;
    server.summary = { unread: 4, stamp: 'd' };
    act(() => server.stream!.end());
    await settle(31_000);
    expect(server.summaryAsked).toBeGreaterThan(asked);
    expect(view.result.current.summary.data).toMatchObject({ unread: 4 });

    server.streamOpen = true;
    await settle(30_000);
    server.stream!.push(ringingEvent(quiet) + inboxEvent({ unread: 0, stamp: 'e' }));
    await settle(10);
    expect(view.result.current.summary.data).toMatchObject({ unread: 0, stamp: 'e' });
    const after = server.summaryAsked;
    await settleAlive(3 * 60_000);
    expect(server.summaryAsked).toBe(after);
  });
});
