import { SESSION_COOKIE, can, type PermissionKey, type Target } from '@wings/shared';
import type {
  FastifyPluginAsync,
  FastifyReply,
  FastifyRequest,
  preHandlerHookHandler,
  RouteOptions,
} from 'fastify';
import fp from 'fastify-plugin';
import { resolveSession, type ResolvedSession } from '../modules/auth/service.js';

/** Sent by a screen's own refresh: answered, not counted as the person's activity. */
export const PASSIVE_HEADER = 'x-wings-passive';

/**
 * What a route declares about who may call it. Every route declares exactly
 * one, through its preHandler:
 *  - `permission` — `app.requirePermission(...)` or `app.requireAnyPermission(...)`:
 *    the module permission from the matrix in `@wings/shared` (rbac/permissions.ts);
 *  - `session` — `app.requireSession`: any person who is logged in (their own
 *    account, their own notices). Kept to a short list the access test pins;
 *  - `public` — `app.publicRoute(reason)`: no login (login itself, webhooks that
 *    carry their own secret, the landing page form).
 * A route that declares none is refused with 403 `route_not_declared`, and the
 * access test fails, so nothing reaches production undeclared.
 */
export type RouteAccess =
  | { kind: 'permission'; permissions: readonly PermissionKey[] }
  | { kind: 'session' }
  | { kind: 'public'; reason: string };

const ACCESS = Symbol('wings.routeAccess');

type TaggedHandler = preHandlerHookHandler & { [ACCESS]?: RouteAccess };

function tag(handler: preHandlerHookHandler, access: RouteAccess): preHandlerHookHandler {
  (handler as TaggedHandler)[ACCESS] = access;
  return handler;
}

/** The access a route declared, read from its preHandlers; null when it declared none. */
export function routeAccessOf(route: Pick<RouteOptions, 'preHandler'>): RouteAccess | null {
  const handlers = route.preHandler
    ? Array.isArray(route.preHandler)
      ? route.preHandler
      : [route.preHandler]
    : [];
  for (const handler of handlers) {
    const access = (handler as TaggedHandler)[ACCESS];
    if (access) return access;
  }
  return null;
}

/** One registered route and what it declared, for the access test. */
export interface DeclaredRoute {
  method: string;
  url: string;
  access: RouteAccess | null;
}

declare module 'fastify' {
  interface FastifyRequest {
    /** Present only after requireAuth has run. */
    session: ResolvedSession;
  }
  interface FastifyInstance {
    /**
     * Authentication only. It declares nothing about access: a route that has it
     * alone is refused as undeclared. Use requirePermission, or requireSession
     * for the few routes every login may call.
     */
    requireAuth: preHandlerHookHandler;
    /** Any logged-in person. Only for a person's own account and notices. */
    requireSession: preHandlerHookHandler;
    /** No login. The reason is mandatory and the access test lists every one. */
    publicRoute: (reason: string) => preHandlerHookHandler;
    /** Permission check for an already-authenticated request. */
    can: (request: FastifyRequest, permission: PermissionKey, target?: Target) => boolean;
    requirePermission: (
      permission: PermissionKey,
      target?: (request: FastifyRequest) => Target,
    ) => preHandlerHookHandler;
    /** The module gate for a route several modules share: any one of them opens it. */
    requireAnyPermission: (permissions: readonly PermissionKey[]) => preHandlerHookHandler;
    /** Every route registered so far and its declared access (read by the access test). */
    declaredRoutes: () => readonly DeclaredRoute[];
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
    // Already resolved by an earlier preHandler of the same request.
    if (request.session) return;

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
    'requireSession',
    tag(async (request, reply) => requireAuth.call(app, request, reply, () => {}), {
      kind: 'session',
    }),
  );

  app.decorate('publicRoute', (reason: string) => tag(async () => {}, { kind: 'public', reason }));

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
      return tag(handler, { kind: 'permission', permissions: [permission] });
    },
  );

  app.decorate('requireAnyPermission', (permissions: readonly PermissionKey[]) => {
    const handler: preHandlerHookHandler = async (request, reply) => {
      await requireAuth.call(app, request, reply, () => {});
      if (reply.sent) return;

      const actor = request.session.actor;
      if (!permissions.some((permission) => can(actor, permission).allowed)) {
        return reply
          .status(403)
          .send({ error: 'forbidden', reason: 'no_permission', message: 'Acesso negado' });
      }
    };
    return tag(handler, { kind: 'permission', permissions });
  });

  /**
   * Deny by default. A route registered without a declared access still exists,
   * but answers 403 to everyone until it declares one.
   */
  const declared: DeclaredRoute[] = [];
  const refuseUndeclared: preHandlerHookHandler = async (_request, reply) =>
    reply.status(403).send({
      error: 'forbidden',
      reason: 'route_not_declared',
      message: 'Acesso negado',
    });

  app.addHook('onRoute', (route) => {
    const access = routeAccessOf(route);
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    for (const method of methods) declared.push({ method, url: route.url, access });
    if (access) return;

    app.log.warn({ method: route.method, url: route.url }, 'route without declared access');
    const own = route.preHandler
      ? Array.isArray(route.preHandler)
        ? route.preHandler
        : [route.preHandler]
      : [];
    route.preHandler = [refuseUndeclared, ...own];
  });

  app.decorate('declaredRoutes', () => declared);
};

export const authPlugin = fp(plugin, { name: 'wings-auth' });
