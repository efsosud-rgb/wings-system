import type { WaRingingSnapshot } from '@wings/shared';
import { noteUnauthorized } from './client.js';
import { reportUnauthorized } from './session-expiry.js';

/**
 * The ringing-call stream (`GET /whatsapp/calls/stream`, docs/whatsapp/cloud-api.md).
 *
 * Read with `fetch`, not `EventSource`, for two reasons: the request must carry
 * `x-wings-passive` (the stream is never the person's activity), and the status
 * must be visible — an `EventSource` hides a 401 and reconnects in a loop, while
 * here a 401 goes where every other 401 goes (`noteUnauthorized`, one rule for
 * the whole app) and the stream is not opened again.
 *
 * It reconnects by itself, with a growing wait, and tells the screen whether it is
 * live so the screen can ask the slow way (`GET /whatsapp/calls/ringing`) while it is not.
 */

const PATH = '/whatsapp/calls/stream';
/** The server sends a line every 15 s; three missed and the connection is taken as dead (a sleeping laptop, a cut cable). */
const SILENCE_MS = 45_000;
const RETRY_FIRST_MS = 1_000;
const RETRY_LAST_MS = 30_000;
/** The server refuses a person's ninth stream: wait long, they are not a good reason to hurry. */
const RETRY_TOO_MANY_MS = 60_000;
/** A stream that held less than this did not work: its next wait keeps growing. */
const STABLE_MS = 10_000;

export interface RingingStreamHandlers {
  /** The whole answer: on connect and every time it changed. */
  onSnapshot(snapshot: WaRingingSnapshot): void;
  /** True once an answer has arrived on a connection, false when that connection ends. */
  onLive(live: boolean): void;
}

/**
 * Splits a `text/event-stream` body into named events. Chunks end anywhere, so text
 * is held until a blank line closes the event; comment lines (`: ping`) carry no event.
 */
export function createEventParser(onEvent: (name: string, data: string) => void) {
  let buffer = '';
  const flush = (block: string) => {
    let name = 'message';
    const data: string[] = [];
    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) name = line.slice(6).trim();
      else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
    }
    if (data.length > 0) onEvent(name, data.join('\n'));
  };
  return {
    push(chunk: string) {
      buffer += chunk.replace(/\r\n/g, '\n');
      let end = buffer.indexOf('\n\n');
      while (end !== -1) {
        flush(buffer.slice(0, end));
        buffer = buffer.slice(end + 2);
        end = buffer.indexOf('\n\n');
      }
    },
  };
}

const isSnapshot = (value: unknown): value is WaRingingSnapshot =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as WaRingingSnapshot).calling === 'boolean' &&
  Array.isArray((value as WaRingingSnapshot).calls);

/** Opens the stream and keeps it open. Returns the function that closes it for good. */
export function openRingingStream(handlers: RingingStreamHandlers): () => void {
  /** The screen closed it: nothing more is reported. */
  let closed = false;
  /** The session behind the tab is gone: nothing is opened again. */
  let halted = false;
  let failures = 0;
  let connection: AbortController | null = null;
  let retry: ReturnType<typeof setTimeout> | undefined;

  const wait = (tooMany: boolean) => {
    if (tooMany) return RETRY_TOO_MANY_MS;
    const base = Math.min(RETRY_FIRST_MS * 2 ** failures, RETRY_LAST_MS);
    // Tabs that lost the server together do not come back together.
    return base * (0.8 + Math.random() * 0.4);
  };

  const connect = async () => {
    if (closed || halted) return;
    const mine = new AbortController();
    connection = mine;
    let live = false;
    let liveSince = 0;
    let tooMany = false;
    let silence: ReturnType<typeof setTimeout> | undefined;
    const listen = () => {
      clearTimeout(silence);
      silence = setTimeout(() => mine.abort(), SILENCE_MS);
    };
    const parser = createEventParser((name, data) => {
      if (name === 'session_ended') {
        // The server closed the session behind this tab: the same as a 401.
        halted = true;
        reportUnauthorized();
        mine.abort();
        return;
      }
      if (name !== 'ringing') return;
      let snapshot: unknown;
      try {
        snapshot = JSON.parse(data);
      } catch {
        return;
      }
      if (!isSnapshot(snapshot)) return;
      if (closed) return;
      if (!live) {
        live = true;
        liveSince = Date.now();
        handlers.onLive(true);
      }
      handlers.onSnapshot(snapshot);
    });

    try {
      listen();
      const response = await fetch(`/api${PATH}`, {
        credentials: 'include',
        headers: { Accept: 'text/event-stream', 'x-wings-passive': '1' },
        signal: mine.signal,
      });
      if (response.status === 401) {
        halted = true;
        noteUnauthorized(401, PATH);
        return;
      }
      tooMany = response.status === 429;
      if (!response.ok || !response.body) throw new Error(`stream ${response.status}`);
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        listen();
        parser.push(decoder.decode(value, { stream: true }));
      }
    } catch {
      // Cut, refused or silent: the wait below decides when to try again.
    } finally {
      clearTimeout(silence);
      mine.abort();
      if (live) {
        if (!closed) handlers.onLive(false);
        if (Date.now() - liveSince >= STABLE_MS) failures = 0;
      }
    }
    if (closed || halted) return;
    const delay = wait(tooMany);
    failures += 1;
    retry = setTimeout(() => {
      retry = undefined;
      void connect();
    }, delay);
  };

  /** The network came back (a laptop woke up): no reason to wait out the last delay. */
  const online = () => {
    if (closed || halted || !retry) return;
    clearTimeout(retry);
    retry = undefined;
    void connect();
  };
  window.addEventListener('online', online);
  void connect();

  return () => {
    closed = true;
    clearTimeout(retry);
    connection?.abort();
    window.removeEventListener('online', online);
  };
}
