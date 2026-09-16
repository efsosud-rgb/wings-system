import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Database } from './db/client.js';
import type { Env } from './env.js';
import { authRoutes } from './modules/auth/routes.js';
import { authPlugin } from './plugins/auth.js';

declare module 'fastify' {
  interface FastifyInstance {
    wings: { env: Env; db: Database };
  }
}

const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export async function buildApp(deps: { env: Env; db: Database }): Promise<FastifyInstance> {
  const app = Fastify({
    // Personal data must never reach the logs (LGPD), so request bodies are
    // never logged and only a minimal request line is kept.
    logger: {
      level: deps.env.NODE_ENV === 'test' ? 'silent' : 'info',
      redact: ['req.headers.cookie', 'req.headers.authorization'],
      serializers: {
        req(request) {
          return { method: request.method, url: request.url, ip: request.ip };
        },
      },
    },
    // Behind Traefik: needed for real client IPs in the audit log.
    trustProxy: true,
  });

  app.decorate('wings', deps);

  await app.register(cookie, { secret: deps.env.SESSION_SECRET });
  await app.register(rateLimit, { global: false });
  await app.register(authPlugin);

  /**
   * CSRF defence. SameSite=Lax already blocks cross-site cookie sends for these
   * methods; this rejects anything that still arrives with a foreign Origin.
   * Requests without a session cookie are left alone (login itself needs to work
   * from the login page, which does send an Origin).
   */
  app.addHook('onRequest', async (request, reply) => {
    if (!UNSAFE_METHODS.has(request.method)) return;
    const origin = request.headers.origin;
    if (!origin) return;

    const host =
      (request.headers['x-forwarded-host'] as string | undefined) ?? request.headers.host;
    let originHost: string;
    try {
      originHost = new URL(origin).host;
    } catch {
      return reply.status(403).send({ error: 'bad_origin', message: 'Origem inválida' });
    }
    if (host && originHost !== host) {
      return reply.status(403).send({ error: 'bad_origin', message: 'Origem inválida' });
    }
  });

  // Routes are registered WITHOUT the /api prefix: Traefik strips it before
  // forwarding and the Vite dev proxy rewrites the same way.
  app.get('/health', async () => ({
    status: 'ok',
    service: 'wings-system-api',
    time: new Date().toISOString(),
  }));

  await app.register(authRoutes);

  return app;
}
