import {
  DASHBOARD_WINDOWS,
  setCplTargetSchema,
  type DashboardSettings,
  type DashboardWindow,
} from '@wings/shared';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { writeAudit } from '../../../lib/audit.js';
import { audience, campaigns, creatives, overview, platforms } from './queries.js';
import { dashboardTargets, setTarget } from './targets.js';

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
    const settings: DashboardSettings = { targets: await dashboardTargets(db, now()) };
    return reply.send({ settings });
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
      const settings: DashboardSettings = { targets: await dashboardTargets(db, now()) };
      return reply.send({ settings });
    },
  );
};
