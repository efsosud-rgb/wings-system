import {
  DASHBOARD_WINDOWS,
  setAccountCplTargetSchema,
  setCplTargetSchema,
  type DashboardSettings,
  type DashboardWindow,
} from '@wings/shared';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { writeAudit } from '../../../lib/audit.js';
import { funnel, site } from './funnel.js';
import { activeAccounts, audience, campaigns, creatives, overview, platforms } from './queries.js';
import {
  dashboardAccountTargets,
  dashboardTargets,
  setAccountTarget,
  setTarget,
} from './targets.js';

/**
 * HTTP surface of Dashboard → Marketing. Reads only: every figure comes from
 * what the ingest job mirrored, so opening a tab calls no platform, spends
 * nothing and changes nothing. Alerts are acknowledged through the cockpit
 * route that already exists.
 */

const windowSchema = z.object({
  days: z.coerce
    .number()
    .refine((value): value is DashboardWindow =>
      DASHBOARD_WINDOWS.includes(value as DashboardWindow),
    )
    .default(7),
});

function windowOrReject(request: FastifyRequest, reply: FastifyReply): DashboardWindow | null {
  const parsed = windowSchema.safeParse(request.query);
  if (!parsed.success) {
    void reply.status(400).send({
      error: 'invalid_request',
      message: `Período inválido: use ${DASHBOARD_WINDOWS.join(', ')} dias.`,
    });
    return null;
  }
  return parsed.data.days;
}

export const dashboardRoutes: FastifyPluginAsync = async (app) => {
  const { db, env } = app.wings;
  const now = () => (app.wings.now ?? (() => new Date()))();
  const guard = { preHandler: app.requirePermission('ads.read') };

  app.get('/ads/dashboard/overview', guard, async (_request, reply) => {
    return reply.send({ overview: await overview(db, env, now()) });
  });

  app.get('/ads/dashboard/platforms', guard, async (request, reply) => {
    const days = windowOrReject(request, reply);
    if (days === null) return;
    return reply.send({ platforms: await platforms(db, days, now()) });
  });

  app.get('/ads/dashboard/campaigns', guard, async (request, reply) => {
    const days = windowOrReject(request, reply);
    if (days === null) return;
    return reply.send({ campaigns: await campaigns(db, days, now()) });
  });

  app.get('/ads/dashboard/site', guard, async (request, reply) => {
    const days = windowOrReject(request, reply);
    if (days === null) return;
    return reply.send({ site: await site(db, env, days, now()) });
  });

  app.get('/ads/dashboard/funnel', guard, async (request, reply) => {
    const days = windowOrReject(request, reply);
    if (days === null) return;
    return reply.send({ funnel: await funnel(db, env, days, now()) });
  });

  app.get('/ads/dashboard/creatives', guard, async (request, reply) => {
    const days = windowOrReject(request, reply);
    if (days === null) return;
    return reply.send({ creatives: await creatives(db, days, now()) });
  });

  app.get('/ads/dashboard/audience', guard, async (request, reply) => {
    const days = windowOrReject(request, reply);
    if (days === null) return;
    return reply.send({ audience: await audience(db, days, now()) });
  });

  /**
   * Configurações do Dashboard: the CPL and CPC targets the verdicts judge
   * against. The history proposes; only a person's confirmation sets one,
   * and that takes `ads.request`, the permission of whoever runs the traffic.
   */
  app.get('/ads/dashboard/settings', guard, async (_request, reply) => {
    return reply.send({ settings: await settingsOf() });
  });

  app.put(
    '/ads/dashboard/settings/cpl-target',
    { preHandler: app.requirePermission('ads.request') },
    async (request, reply) => {
      const parsed = setCplTargetSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          error: 'invalid_request',
          message: parsed.error.issues[0]?.message ?? 'Dados inválidos',
        });
      }
      const employeeId = request.session.actor.employeeId;
      await setTarget(db, { ...parsed.data, employeeId, now: now() });
      await writeAudit(db, {
        actorEmployeeId: employeeId,
        action: 'ads.cpl_target_set',
        entity: 'marketing_cpl_target',
        entityId: parsed.data.objectiveKind,
        ip: request.ip,
        metadata: {
          objectiveKind: parsed.data.objectiveKind,
          targetCents: parsed.data.targetCents,
        },
      });
      return reply.send({ settings: await settingsOf() });
    },
  );

  /** The leads CPL target of one account; it wins over the company-wide one. */
  app.put(
    '/ads/dashboard/settings/account-cpl-target',
    { preHandler: app.requirePermission('ads.request') },
    async (request, reply) => {
      const parsed = setAccountCplTargetSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          error: 'invalid_request',
          message: parsed.error.issues[0]?.message ?? 'Dados inválidos',
        });
      }
      const accounts = await activeAccounts(db);
      if (!accounts.some((account) => account.id === parsed.data.adAccountId)) {
        return reply
          .status(404)
          .send({ error: 'not_found', message: 'Conta de anúncios não encontrada.' });
      }
      const employeeId = request.session.actor.employeeId;
      await setAccountTarget(db, { ...parsed.data, employeeId, now: now() });
      await writeAudit(db, {
        actorEmployeeId: employeeId,
        action: 'ads.account_cpl_target_set',
        entity: 'marketing_account_cpl_target',
        entityId: parsed.data.adAccountId,
        ip: request.ip,
        metadata: { objectiveKind: 'leads', targetCents: parsed.data.targetCents },
      });
      return reply.send({ settings: await settingsOf() });
    },
  );

  async function settingsOf(): Promise<DashboardSettings> {
    const [targets, accountTargets] = await Promise.all([
      dashboardTargets(db, now()),
      dashboardAccountTargets(db),
    ]);
    return { targets, accountTargets };
  }
};
