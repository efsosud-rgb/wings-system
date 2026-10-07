import { eq } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { employees } from '../../db/schema/index.js';
import { writeAudit } from '../../lib/audit.js';
import { GoogleOAuthError } from './oauth.js';
import {
  completeConnect,
  disconnect,
  failConnect,
  googleWorkspaceDepsOf,
  startConnect,
  statusFor,
} from './service.js';

/**
 * A person's own Google Workspace connection (docs/integracoes/google-workspace.md):
 * status, start (the browser goes to Google), callback (Google brings it back,
 * a top-level GET so the session cookie comes along), disconnect. Only the
 * session's own employee: there is no route that touches someone else's.
 */

const ACCOUNT_PAGE = '/minha-conta';

const callbackQuery = z.object({
  code: z.string().min(1).optional(),
  state: z.string().min(1).optional(),
  error: z.string().optional(),
});

export const googleWorkspaceRoutes: FastifyPluginAsync = async (app) => {
  const { db } = app.wings;
  const deps = () => googleWorkspaceDepsOf(app.wings);
  const notConfigured = {
    error: 'google_not_configured',
    message:
      'O Google Workspace ainda não foi configurado no sistema (cliente OAuth e chave de integrações).',
  };

  app.get('/me/google', { preHandler: app.requireAuth }, async (request, reply) =>
    reply.send({ status: await statusFor(deps(), request.session.actor.employeeId) }),
  );

  /** Answers the address of Google's consent screen; the browser goes there on its own. */
  app.post('/me/google/connect', { preHandler: app.requireAuth }, async (request, reply) => {
    const d = deps();
    if (!d) return reply.status(503).send(notConfigured);
    const employeeId = request.session.actor.employeeId;
    const [me] = await db
      .select({ email: employees.email })
      .from(employees)
      .where(eq(employees.id, employeeId));
    const url = await startConnect(d, employeeId, me?.email ?? null);
    return reply.send({ url });
  });

  app.get('/me/google/callback', { preHandler: app.requireAuth }, async (request, reply) => {
    const d = deps();
    const employeeId = request.session.actor.employeeId;
    const query = callbackQuery.safeParse(request.query);
    const fail = async (reason: string) => {
      if (d) await failConnect(d, employeeId, reason);
      await writeAudit(db, {
        actorEmployeeId: employeeId,
        action: 'google_workspace.connect_failed',
        entity: 'google_workspace',
        entityId: employeeId,
        ip: request.ip,
        metadata: { reason },
      });
      return reply.redirect(`${ACCOUNT_PAGE}?google=erro&motivo=${encodeURIComponent(reason)}`);
    };
    if (!d) return fail('not_configured');
    if (!query.success || !query.data.code || !query.data.state) {
      return fail(query.success && query.data.error ? 'denied' : 'invalid_callback');
    }
    try {
      await completeConnect(d, employeeId, { code: query.data.code, state: query.data.state });
    } catch (error) {
      if (!(error instanceof GoogleOAuthError)) throw error;
      return fail(error.code);
    }
    await writeAudit(db, {
      actorEmployeeId: employeeId,
      action: 'google_workspace.connected',
      entity: 'google_workspace',
      entityId: employeeId,
      ip: request.ip,
    });
    return reply.redirect(`${ACCOUNT_PAGE}?google=ok`);
  });

  app.delete('/me/google', { preHandler: app.requireAuth }, async (request, reply) => {
    const d = deps();
    if (!d) return reply.status(503).send(notConfigured);
    const employeeId = request.session.actor.employeeId;
    await disconnect(d, employeeId);
    await writeAudit(db, {
      actorEmployeeId: employeeId,
      action: 'google_workspace.disconnected',
      entity: 'google_workspace',
      entityId: employeeId,
      ip: request.ip,
    });
    return reply.send({ status: await statusFor(d, employeeId) });
  });
};
