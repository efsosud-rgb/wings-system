import { DEFAULT_KAIROGEN_PLAN, KAIROGEN_PLANS, type KairogenStatus } from '@wings/shared';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { writeAudit } from '../../../lib/audit.js';
import { setPlan } from '../../media/studio.js';
import { OAuthError } from './oauth.js';
import {
  completeCodeFlow,
  disconnect,
  getStatus,
  pollConnection,
  startConnection,
  kairogenDepsOf,
} from './service.js';

const connectBody = z.object({ flow: z.enum(['device', 'code']).default('device') });
const callbackQuery = z.object({
  code: z.string().min(1).max(2048).optional(),
  state: z.string().min(1).max(512).optional(),
  iss: z.string().max(512).optional(),
  error: z.string().max(200).optional(),
});

/**
 * Configurações → Integrações → Kairogen. One connection for the whole system,
 * made and undone by whoever holds `integrations.manage` (Admin Master).
 *
 * No route here returns a token, a device code or a verifier. What the browser
 * gets is a state and, for the device flow, the code a person types at Kairogen.
 */
export const kairogenRoutes: FastifyPluginAsync = async (app) => {
  const { db, env } = app.wings;
  const SETTINGS_PAGE = `${env.APP_BASE_URL}/administracao/integracoes`;

  const deps = kairogenDepsOf(app.wings);

  const notConfigured: KairogenStatus = {
    state: 'not_configured',
    detail: 'Falta a chave INTEGRATIONS_ENCRYPTION_KEY neste ambiente.',
    connectedAt: null,
    connectedByName: null,
    scopes: [],
    pending: null,
    credits: null,
    plan: DEFAULT_KAIROGEN_PLAN,
    protocolVersion: null,
    tools: [],
  };

  app.get(
    '/integrations/kairogen',
    { preHandler: app.requirePermission('integrations.manage') },
    async (_request, reply) =>
      reply.send({ status: deps ? await getStatus(deps, { withCredits: true }) : notConfigured }),
  );

  app.post(
    '/integrations/kairogen/connect',
    { preHandler: app.requirePermission('integrations.manage') },
    async (request, reply) => {
      if (!deps)
        return reply.status(503).send({ error: 'not_configured', message: notConfigured.detail });
      const body = connectBody.safeParse(request.body ?? {});
      if (!body.success) {
        return reply.status(400).send({ error: 'invalid_request', message: 'Fluxo inválido.' });
      }
      const employeeId = request.session.actor.employeeId;
      try {
        await startConnection(deps, { flow: body.data.flow, employeeId });
      } catch (error) {
        if (!(error instanceof OAuthError)) throw error;
        await writeAudit(db, {
          actorEmployeeId: employeeId,
          action: 'integrations.kairogen_connect_failed',
          entity: 'integration',
          entityId: 'kairogen',
          ip: request.ip,
          metadata: { flow: body.data.flow, reason: error.code },
        });
        return reply.status(502).send({ error: error.code, message: error.message });
      }
      await writeAudit(db, {
        actorEmployeeId: employeeId,
        action: 'integrations.kairogen_connect_started',
        entity: 'integration',
        entityId: 'kairogen',
        ip: request.ip,
        metadata: { flow: body.data.flow },
      });
      return reply.send({ status: await getStatus(deps) });
    },
  );

  /** Device flow: the open settings page asks, the server checks — at the server's own pace. */
  app.post(
    '/integrations/kairogen/poll',
    { preHandler: app.requirePermission('integrations.manage') },
    async (request, reply) => {
      if (!deps)
        return reply.status(503).send({ error: 'not_configured', message: notConfigured.detail });
      let outcome;
      try {
        outcome = await pollConnection(deps);
      } catch (error) {
        if (!(error instanceof OAuthError)) throw error;
        return reply.status(502).send({ error: error.code, message: error.message });
      }
      if (outcome === 'connected' || outcome === 'denied' || outcome === 'expired') {
        await writeAudit(db, {
          actorEmployeeId: request.session.actor.employeeId,
          action:
            outcome === 'connected'
              ? 'integrations.kairogen_connected'
              : 'integrations.kairogen_connect_failed',
          entity: 'integration',
          entityId: 'kairogen',
          ip: request.ip,
          metadata: { flow: 'device', ...(outcome === 'connected' ? {} : { reason: outcome }) },
        });
      }
      return reply.send({
        status: await getStatus(deps, { withCredits: outcome === 'connected' }),
      });
    },
  );

  /**
   * Code flow: Kairogen sends the browser back here. It is a top-level GET, so
   * the session cookie (SameSite=Lax) comes along and the same permission
   * applies; `state` ties the answer to the request this system made.
   */
  app.get(
    '/integrations/kairogen/callback',
    { preHandler: app.requirePermission('integrations.manage') },
    async (request, reply) => {
      const query = callbackQuery.safeParse(request.query);
      const employeeId = request.session.actor.employeeId;
      const fail = async (reason: string) => {
        await writeAudit(db, {
          actorEmployeeId: employeeId,
          action: 'integrations.kairogen_connect_failed',
          entity: 'integration',
          entityId: 'kairogen',
          ip: request.ip,
          metadata: { flow: 'code', reason },
        });
        return reply.redirect(`${SETTINGS_PAGE}?kairogen=erro`);
      };
      if (!deps) return fail('not_configured');
      if (!query.success || !query.data.code || !query.data.state) {
        return fail(query.success && query.data.error ? 'denied' : 'invalid_callback');
      }
      try {
        await completeCodeFlow(deps, {
          code: query.data.code,
          state: query.data.state,
          issuer: query.data.iss,
        });
      } catch (error) {
        if (!(error instanceof OAuthError)) throw error;
        return fail(error.code);
      }
      await writeAudit(db, {
        actorEmployeeId: employeeId,
        action: 'integrations.kairogen_connected',
        entity: 'integration',
        entityId: 'kairogen',
        ip: request.ip,
        metadata: { flow: 'code' },
      });
      return reply.redirect(`${SETTINGS_PAGE}?kairogen=ok`);
    },
  );

  /** The plan the account is on: what `estimate_cost` is asked against. */
  app.put(
    '/integrations/kairogen/plan',
    { preHandler: app.requirePermission('integrations.manage') },
    async (request, reply) => {
      if (!deps)
        return reply.status(503).send({ error: 'not_configured', message: notConfigured.detail });
      const body = z.object({ plan: z.enum(KAIROGEN_PLANS) }).safeParse(request.body);
      if (!body.success) {
        return reply.status(400).send({ error: 'invalid_request', message: 'Plano inválido.' });
      }
      await setPlan(db, body.data.plan, new Date());
      await writeAudit(db, {
        actorEmployeeId: request.session.actor.employeeId,
        action: 'integrations.kairogen_plan_changed',
        entity: 'integration',
        entityId: 'kairogen',
        ip: request.ip,
        metadata: { plan: body.data.plan },
      });
      return reply.send({ status: await getStatus(deps) });
    },
  );

  app.post(
    '/integrations/kairogen/disconnect',
    { preHandler: app.requirePermission('integrations.manage') },
    async (request, reply) => {
      if (!deps)
        return reply.status(503).send({ error: 'not_configured', message: notConfigured.detail });
      const { revoked } = await disconnect(deps);
      await writeAudit(db, {
        actorEmployeeId: request.session.actor.employeeId,
        action: 'integrations.kairogen_disconnected',
        entity: 'integration',
        entityId: 'kairogen',
        ip: request.ip,
        metadata: { revokedAtKairogen: revoked },
      });
      return reply.send({ status: await getStatus(deps) });
    },
  );
};
