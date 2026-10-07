import { SESSION_COOKIE, can, type PermissionKey, type Target } from '@wings/shared';
import type {
  FastifyPluginAsync,
  FastifyReply,
  FastifyRequest,
  preHandlerHookHandler,
} from 'fastify';
import fp from 'fastify-plugin';
import { resolveSession, type ResolvedSession } from '../modules/auth/service.js';

/** Sent by a screen's own refresh: answered, not counted as the person's activity. */
export const PASSIVE_HEADER = 'x-wings-passive';

declare module 'fastify' {
  interface FastifyRequest {
    /** Present only after requireAuth has run. */
    session: ResolvedSession;
  }
  interface FastifyInstance {
    requireAuth: preHandlerHookHandler;
    /** Permission check for an already-authenticated request. */
    can: (request: FastifyRequest, permission: PermissionKey, target?: Target) => boolean;
    requirePermission: (
      permission: PermissionKey,
      target?: (request: FastifyRequest) => Target,
    ) => preHandlerHookHandler;
  }
}

const plugin: FastifyPluginAsync = async (app) => {
  // Placeholder so the property exists on every request object; requireAuth
  // replaces it with the real session before any handler runs.
  app.decorateRequest('session', null as unknown as ResolvedSession);

  const requireAuth: preHandlerHookHandler = async (
    request: FastifyRequest,
    reply: FastifyReply,
  ) => {
    const token = request.cookies[SESSION_COOKIE];
    if (!token) {
      return reply.status(401).send({ error: 'unauthenticated', message: 'Sessão não encontrada' });
    }

    const session = await resolveSession(app.wings.db, token, {
      ip: request.ip,
      userAgent: request.headers['user-agent'] ?? null,
      passive: request.headers[PASSIVE_HEADER] === '1',
    });

    if (!session) {
      reply.clearCookie(SESSION_COOKIE, { path: '/' });
      return reply.status(401).send({ error: 'session_expired', message: 'Sessão expirada' });
    }

    request.session = session;
  };

  app.decorate('requireAuth', requireAuth);

  app.decorate(
    'can',
    (request: FastifyRequest, permission: PermissionKey, target: Target = {}) =>
      can(request.session.actor, permission, target).allowed,
  );

  /**
   * Authorization for a route. Every check goes through can() in @wings/shared;
   * routes must never re-implement permission logic.
   */
  app.decorate(
    'requirePermission',
    (permission: PermissionKey, target?: (request: FastifyRequest) => Target) => {
      const handler: preHandlerHookHandler = async (request, reply) => {
        await requireAuth.call(app, request, reply, () => {});
        if (reply.sent) return;

        const decision = can(request.session.actor, permission, target ? target(request) : {});
        if (!decision.allowed) {
          return reply
            .status(403)
            .send({ error: 'forbidden', reason: decision.reason, message: 'Acesso negado' });
        }
      };
      return handler;
    },
  );
};

export const authPlugin = fp(plugin, { name: 'wings-auth' });
