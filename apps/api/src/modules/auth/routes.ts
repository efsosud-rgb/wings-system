import {
  SESSION_COOKIE,
  forgotPasswordSchema,
  loginSchema,
  setPasswordSchema,
} from '@wings/shared';
import { z } from 'zod';
import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { getEmployee } from '../employees/service.js';
import { requestPasswordReset, sendInvite, setPasswordWithToken } from './credentials-service.js';
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

/** Transactional e-mail is required for these routes; say so plainly. */
function mailerUnavailable(app: FastifyInstance, reply: FastifyReply): boolean {
  if (app.wings.mailer.enabled) return false;
  reply.status(503).send({
    error: 'email_not_configured',
    message: 'Envio de e-mail indisponível. Procure o administrador do sistema.',
  });
  return true;
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

  /**
   * Self-service password reset. Always answers 202, whether or not the address
   * exists — an anonymous caller must not be able to probe for accounts.
   */
  app.post(
    '/auth/forgot-password',
    {
      config: {
        rateLimit: {
          max: app.wings.env.NODE_ENV === 'test' ? 10_000 : 5,
          timeWindow: '1 hour',
        },
      },
    },
    async (request, reply) => {
      if (mailerUnavailable(app, reply)) return reply;
      const parsed = forgotPasswordSchema.safeParse(request.body);
      if (parsed.success) {
        await requestPasswordReset(app.wings.db, app.wings.mailer, {
          email: parsed.data.email,
          baseUrl: app.wings.env.APP_BASE_URL,
          ctx: requestContext(request),
        });
      }
      return reply.status(202).send({
        message: 'Se o e-mail estiver cadastrado, enviaremos as instruções em instantes.',
      });
    },
  );

  /** Consumes an invite or reset link and sets the password. */
  app.post(
    '/auth/set-password',
    {
      config: {
        rateLimit: {
          max: app.wings.env.NODE_ENV === 'test' ? 10_000 : 20,
          timeWindow: '1 hour',
        },
      },
    },
    async (request, reply) => {
      const parsed = setPasswordSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          error: 'invalid_request',
          message: parsed.error.issues[0]?.message ?? 'Dados inválidos',
        });
      }

      const result = await setPasswordWithToken(app.wings.db, {
        ...parsed.data,
        ctx: requestContext(request),
      });

      if (!result.ok) {
        const status = result.reason === 'weak_password' ? 400 : 410;
        const message =
          result.reason === 'weak_password'
            ? 'Escolha uma senha mais forte, sem partes do seu e-mail.'
            : 'Link inválido ou expirado. Solicite um novo.';
        return reply.status(status).send({ error: result.reason, message });
      }

      return reply.send({ ok: true, purpose: result.purpose });
    },
  );

  /**
   * Re-sends (or sends) the invite for an employee. Requires the same
   * permission as creating employees, so sector managers can invite inside
   * their own sector once the employee module hands over the target's sector.
   */
  app.post(
    '/auth/invite',
    { preHandler: app.requirePermission('employees.create') },
    async (request, reply) => {
      if (mailerUnavailable(app, reply)) return reply;
      const parsed = z.object({ employeeId: z.string().uuid() }).safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: 'invalid_request', message: 'Dados inválidos' });
      }

      // Same check as POST /employees/:id/invite: the target must be in the
      // caller's scope and in a sector where they may create employees. The
      // route permission alone passes vacuously for a sector manager.
      const target = await getEmployee(
        app.wings.db,
        request.session.actor,
        app.wings.cpfCrypto,
        parsed.data.employeeId,
      );
      if (!target.ok) {
        return reply
          .status(404)
          .send({ error: 'not_found', message: 'Funcionário não encontrado ou inativo' });
      }
      if (!app.can(request, 'employees.create', { sector: target.value.sector })) {
        return reply
          .status(403)
          .send({ error: 'forbidden', message: 'Você não tem permissão para esta ação.' });
      }

      const result = await sendInvite(app.wings.db, app.wings.mailer, {
        employeeId: parsed.data.employeeId,
        baseUrl: app.wings.env.APP_BASE_URL,
        actorId: request.session.actor.employeeId,
        ctx: requestContext(request),
      });

      if (!result.sent) {
        return reply
          .status(404)
          .send({ error: 'not_found', message: 'Funcionário não encontrado ou inativo' });
      }
      return reply.send({ ok: true });
    },
  );
};
