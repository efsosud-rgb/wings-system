import { SESSION_COOKIE, type WaRingingSnapshot } from '@wings/shared';
import type { FastifyPluginAsync } from 'fastify';
import { onSessionsEnded } from '../../lib/session-events.js';
import { PASSIVE_HEADER } from '../../plugins/auth.js';
import { resolveSession } from '../auth/service.js';
import { onCallsChanged } from './call-signal.js';
import { inboxSummaryOf } from './inbox.js';
import { onInboxChanged } from './inbox-signal.js';
import { RING_MS, ringingFor } from './ringing.js';

/**
 * The ringing calls and the inbox, pushed. `GET /whatsapp/calls/stream` is a
 * `text/event-stream` every screen keeps open instead of asking
 * `GET /whatsapp/calls/ringing` and `GET /whatsapp/inbox/summary` every few seconds:
 *
 * - `event: ringing` carries the whole answer (what the poll route returns) once on
 *   connect and again only when it changed. Whole, never a delta, so a missed
 *   event costs nothing and the screen has no state to get out of step.
 * - `event: inbox` does the same with the reader's inbox summary (`inbox.ts`): the
 *   menu's unread count and the stamp that tells the screens to fetch their lists
 *   and the open conversation again. It looks again on every message signal
 *   (`inbox-signal.ts`) and at each beat.
 * - `event: session_ended` says the session behind the stream is gone (idle,
 *   12 hours, logout, deactivation, a changed role) and the reply closes. The
 *   screen treats it as a 401.
 * - `: ping` lines every beat keep Traefik and any other proxy from closing a quiet
 *   reply, and tell the screen the stream is alive.
 *
 * The stream is not the person's activity: the route is forced passive, so an open
 * stream never keeps an idle session alive. Each beat looks at the session without
 * touching it (an idle one closes here exactly as it would on a passive poll, with
 * the clock-out at the last real activity) and looks at the calls again, which also
 * covers a ring that ran out (nobody writes anything then) and another process.
 * Who sees which call is `ringingFor`'s rule, the same as the poll route's.
 */

let tickMs = 15_000;
/** Tests only: a shorter beat (null: the real one). */
export function setRingingStreamBeat(ms: number | null) {
  tickMs = ms ?? 15_000;
}

/** More streams than this for one person are refused: a tab that reconnects in a loop, not a user. */
const MAX_STREAMS_PER_PERSON = 8;
/** A reader that stopped taking bytes is cut instead of buffered without end. */
const MAX_BUFFERED_BYTES = 16 * 1024;

type EndReason = 'session_ended' | 'shutdown' | 'closed';

export const whatsappRingingStreamRoutes: FastifyPluginAsync = async (app) => {
  const { db, env } = app.wings;
  const now = () => app.wings.now?.() ?? new Date();
  const fetchImpl = () => app.wings.whatsappFetch ?? fetch;

  const open = new Set<(reason: EndReason) => void>();
  /** Requests whose connection closed before the handler got to listen for it. */
  const hungUp = new WeakSet<object>();
  const perPerson = new Map<string, number>();

  // A restart must not wait for tabs to hang up: close them, they reconnect to the new process.
  app.addHook('onClose', async () => {
    for (const end of [...open]) end('shutdown');
  });

  app.get(
    '/whatsapp/calls/stream',
    {
      // Whatever the client sends, a stream is never counted as activity.
      onRequest: async (request, reply) => {
        request.headers[PASSIVE_HEADER] = '1';
        // The session is checked before the handler runs, and a tab that reloads meanwhile
        // closes the connection in that gap: 'close' is heard here, where it cannot be missed.
        reply.raw.once('close', () => hungUp.add(request));
      },
      preHandler: app.requirePermission('leads.whatsapp'),
    },
    async (request, reply) => {
      // Re-read at every beat, so a change of the person's reach is never older than one.
      let actor = request.session.actor;
      const employeeId = actor.employeeId;
      const token = request.cookies[SESSION_COOKIE];
      if (!token) return reply.status(401).send({ error: 'unauthenticated' });
      if ((perPerson.get(employeeId) ?? 0) >= MAX_STREAMS_PER_PERSON) {
        return reply.status(429).send({
          error: 'too_many_streams',
          message: 'Há abas demais com o aviso de ligação aberto.',
          retryAfterSeconds: 60,
        });
      }
      const sessionId = request.session.sessionId;
      const sessionContext = {
        ip: request.ip,
        userAgent: request.headers['user-agent'] ?? null,
        passive: true,
      };

      reply.hijack();
      const raw = reply.raw;
      // Optional calls: the socket of an injected test request has none of them.
      const socket = request.raw.socket as Partial<typeof request.raw.socket> | undefined;
      // The person hung up while the session was being checked: nothing would ever free what follows.
      if (hungUp.has(request) || socket?.destroyed) return;
      raw.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        // Tells nginx-style proxies not to hold the reply back.
        'X-Accel-Buffering': 'no',
      });
      raw.flushHeaders();
      socket?.setNoDelay?.(true);
      socket?.setTimeout?.(0);
      socket?.setKeepAlive?.(true, 30_000);

      let closed = false;
      let beat: NodeJS.Timeout | undefined;
      let expiry: NodeJS.Timeout | undefined;
      perPerson.set(employeeId, (perPerson.get(employeeId) ?? 0) + 1);

      const write = (text: string) => {
        if (closed || raw.writableEnded) return;
        // A connection that died without 'close' (nobody told us) is found out at the next write.
        if (socket?.destroyed) return end('closed');
        raw.write(text);
        if (raw.writableLength > MAX_BUFFERED_BYTES) end('closed');
      };

      const end = (reason: EndReason) => {
        if (closed) return;
        closed = true;
        clearTimeout(beat);
        clearTimeout(expiry);
        offCalls();
        offInbox();
        offEnded();
        open.delete(end);
        const left = (perPerson.get(employeeId) ?? 1) - 1;
        if (left > 0) perPerson.set(employeeId, left);
        else perPerson.delete(employeeId);
        if (raw.writableEnded) return;
        if (reason === 'session_ended') raw.write('event: session_ended\ndata: {}\n\n');
        if (reason === 'closed') raw.destroy();
        else raw.end();
      };
      open.add(end);

      /**
       * Looks at one answer and sends it as `event` when it differs from the last one sent.
       * A look asked for while one runs makes one more after it, never two side by side.
       */
      const looker = <T>(event: string, answer: () => Promise<T>, then?: (value: T) => void) => {
        let last: string | null = null;
        let busy = false;
        let again = false;
        return async () => {
          if (closed) return;
          if (busy) {
            again = true;
            return;
          }
          busy = true;
          try {
            do {
              again = false;
              const value = await answer();
              if (closed) return;
              const text = JSON.stringify(value);
              if (text !== last) {
                last = text;
                write(`event: ${event}\ndata: ${text}\n\n`);
              }
              if (closed) return;
              then?.(value);
            } while (again && !closed);
          } catch (error) {
            // The calls, messages and their people never reach the log; the screen keeps its last answer.
            request.log.error(
              { err: error instanceof Error ? error.name : 'unknown' },
              `${event} look`,
            );
          } finally {
            busy = false;
          }
        };
      };

      const look = looker(
        'ringing',
        () => ringingFor(db, env, fetchImpl(), actor, now()),
        (snapshot) => watchRingEnd(snapshot),
      );
      const lookInbox = looker('inbox', () => inboxSummaryOf(db, actor));

      /** A ring that runs out changes the answer with nobody writing anything: look then. */
      const watchRingEnd = (snapshot: WaRingingSnapshot) => {
        clearTimeout(expiry);
        const starts = snapshot.calls.map((c) => Date.parse(c.startedAt));
        if (starts.length === 0) return;
        const wait = Math.min(...starts) + RING_MS - now().getTime();
        expiry = setTimeout(() => void look(), Math.max(wait, 0) + 100);
      };

      const heartbeat = async () => {
        if (closed) return;
        try {
          const session = await resolveSession(db, token, sessionContext);
          if (!session) return end('session_ended');
          actor = session.actor;
        } catch (error) {
          request.log.error(
            { err: error instanceof Error ? error.name : 'unknown' },
            'ringing session',
          );
        }
        write(': ping\n\n');
        // Armed before the look: a slow look (Meta's settings, a stalled query) must not
        // delay the next ping, or the screen cuts a stream that is only slow.
        if (!closed) beat = setTimeout(() => void heartbeat(), tickMs);
        await look();
        await lookInbox();
      };

      const offCalls = onCallsChanged(() => void look());
      const offInbox = onInboxChanged(() => void lookInbox());
      const offEnded = onSessionsEnded((ended) => {
        if (
          ('sessionId' in ended && ended.sessionId === sessionId) ||
          ('employeeId' in ended && ended.employeeId === employeeId)
        )
          end('session_ended');
      });
      raw.on('close', () => end('closed'));

      // Headers and a first byte leave at once, so every proxy on the way knows this is a stream.
      write(': stream\n\n');
      beat = setTimeout(() => void heartbeat(), tickMs);
      await look();
      await lookInbox();
    },
  );
};
