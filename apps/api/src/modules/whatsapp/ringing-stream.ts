import { SESSION_COOKIE, type WaRingingSnapshot } from '@wings/shared';
import type { FastifyPluginAsync } from 'fastify';
import { onSessionsEnded } from '../../lib/session-events.js';
import { PASSIVE_HEADER } from '../../plugins/auth.js';
import { resolveSession } from '../auth/service.js';
import { onCallsChanged } from './call-signal.js';
import { RING_MS, ringingFor } from './ringing.js';

/**
 * The ringing calls, pushed. `GET /whatsapp/calls/stream` is a `text/event-stream`
 * the call center keeps open instead of asking `GET /whatsapp/calls/ringing`
 * every few seconds:
 *
 * - `event: ringing` carries the whole answer (what the poll route returns) once on
 *   connect and again only when it changed. Whole, never a delta, so a missed
 *   event costs nothing and the screen has no state to get out of step.
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
  const perPerson = new Map<string, number>();

  // A restart must not wait for tabs to hang up: close them, they reconnect to the new process.
  app.addHook('onClose', async () => {
    for (const end of [...open]) end('shutdown');
  });

  app.get(
    '/whatsapp/calls/stream',
    {
      // Whatever the client sends, a stream is never counted as activity.
      onRequest: async (request) => {
        request.headers[PASSIVE_HEADER] = '1';
      },
      preHandler: app.requirePermission('leads.whatsapp'),
    },
    async (request, reply) => {
      const actor = request.session.actor;
      const token = request.cookies[SESSION_COOKIE];
      if (!token) return reply.status(401).send({ error: 'unauthenticated' });
      if ((perPerson.get(actor.employeeId) ?? 0) >= MAX_STREAMS_PER_PERSON) {
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
      raw.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        // Tells nginx-style proxies not to hold the reply back.
        'X-Accel-Buffering': 'no',
      });
      raw.flushHeaders();
      // Optional calls: the socket of an injected test request has none of them.
      const socket = request.raw.socket as Partial<typeof request.raw.socket> | undefined;
      socket?.setNoDelay?.(true);
      socket?.setTimeout?.(0);
      socket?.setKeepAlive?.(true, 30_000);

      let closed = false;
      let last: string | null = null;
      let busy = false;
      let again = false;
      let beat: NodeJS.Timeout | undefined;
      let expiry: NodeJS.Timeout | undefined;
      perPerson.set(actor.employeeId, (perPerson.get(actor.employeeId) ?? 0) + 1);

      const write = (text: string) => {
        if (closed || raw.writableEnded) return;
        raw.write(text);
        if (raw.writableLength > MAX_BUFFERED_BYTES) end('closed');
      };

      const end = (reason: EndReason) => {
        if (closed) return;
        closed = true;
        clearTimeout(beat);
        clearTimeout(expiry);
        offCalls();
        offEnded();
        open.delete(end);
        const left = (perPerson.get(actor.employeeId) ?? 1) - 1;
        if (left > 0) perPerson.set(actor.employeeId, left);
        else perPerson.delete(actor.employeeId);
        if (raw.writableEnded) return;
        if (reason === 'session_ended') raw.write('event: session_ended\ndata: {}\n\n');
        if (reason === 'closed') raw.destroy();
        else raw.end();
      };
      open.add(end);

      /** Looks at the calls and sends the answer when it differs from the last one sent. */
      const look = async () => {
        if (closed) return;
        if (busy) {
          again = true;
          return;
        }
        busy = true;
        try {
          do {
            again = false;
            const snapshot = await ringingFor(db, env, fetchImpl(), actor, now());
            if (closed) return;
            const text = JSON.stringify(snapshot);
            if (text !== last) {
              last = text;
              write(`event: ringing\ndata: ${text}\n\n`);
            }
            watchRingEnd(snapshot);
          } while (again && !closed);
        } catch (error) {
          // The calls and their people never reach the log; the screen keeps its last answer.
          request.log.error(
            { err: error instanceof Error ? error.name : 'unknown' },
            'ringing look',
          );
        } finally {
          busy = false;
        }
      };

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
        } catch (error) {
          request.log.error(
            { err: error instanceof Error ? error.name : 'unknown' },
            'ringing session',
          );
        }
        write(': ping\n\n');
        await look();
        if (!closed) beat = setTimeout(() => void heartbeat(), tickMs);
      };

      const offCalls = onCallsChanged(() => void look());
      const offEnded = onSessionsEnded((ended) => {
        if (
          ('sessionId' in ended && ended.sessionId === sessionId) ||
          ('employeeId' in ended && ended.employeeId === actor.employeeId)
        )
          end('session_ended');
      });
      raw.on('close', () => end('closed'));

      // Headers and a first byte leave at once, so every proxy on the way knows this is a stream.
      write(': stream\n\n');
      beat = setTimeout(() => void heartbeat(), tickMs);
      await look();
    },
  );
};
