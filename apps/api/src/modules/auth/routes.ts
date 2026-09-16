import { SESSION_COOKIE, loginSchema } from '@wings/shared';
import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { login, logout } from './service.js';

function requestContext(request: FastifyRequest) {
  return {
    ip: request.ip,
    userAgent: request.headers['user-agent'] ?? null,
  };
}

function setSessionCookie(
  app: FastifyInstance,
  reply: FastifyReply,
  token: string,
  expiresAt: Date,
): void {
  reply.setCookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: app.wings.env.NODE_ENV === 'production',
    path: '/',
    expires: expiresAt,
  });
}

export const authRoutes: FastifyPluginAsync = async (app) => {
  app.post(
    '/auth/login',
    {
      config: {
        // Brute-force guard per IP; the per-account lockout lives in the service.
        // Tests share one IP across many cases, so the IP guard is relaxed there
        // — the lockout behaviour is still exercised for real.
        rateLimit: {
          max: app.wings.env.NODE_ENV === 'test' ? 10_000 : 10,
          timeWindow: '15 minutes',
        },
      },
    },
    async (request, reply) => {
      const parsed = loginSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: 'invalid_request', message: 'Dados inválidos' });
      }

      const result = await login(app.wings.db, parsed.data, requestContext(request));

      if (!result.ok) {
        if (result.reason === 'account_locked') {
          return reply.status(429).send({
            error: result.reason,
            message: 'Conta temporariamente bloqueada. Tente novamente mais tarde.',
            retryAfterSeconds: result.retryAfterSeconds,
          });
        }
        if (result.reason === 'account_inactive') {
          return reply
            .status(403)
            .send({ error: result.reason, message: 'Acesso desativado. Procure o RH.' });
        }
        // Same message for unknown e-mail and wrong password.
        return reply
          .status(401)
          .send({ error: 'invalid_credentials', message: 'E-mail ou senha incorretos' });
      }

      setSessionCookie(app, reply, result.token, result.expiresAt);
      return reply.send({ user: result.user });
    },
  );

  app.post('/auth/logout', async (request, reply) => {
    const token = request.cookies[SESSION_COOKIE];
    if (token) await logout(app.wings.db, token, requestContext(request));
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return reply.send({ ok: true });
  });

  app.get('/auth/me', { preHandler: app.requireAuth }, async (request, reply) => {
    return reply.send({ user: request.session.user });
  });
};
