import { DASHBOARD_WINDOWS, type DashboardWindow } from '@wings/shared';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { audience, campaigns, creatives, overview, platforms } from './queries.js';

/**
 * HTTP surface of Dashboard → Marketing. Reads only: every figure comes from
 * what the ingest job mirrored, so opening a tab calls no platform, spends
 * nothing and changes nothing. Alerts are acknowledged through the cockpit
 * route that already exists.
 */

const windowSchema = z.object({
  days: z.coerce
    .number()
    .refine((value): value is DashboardWindow => DASHBOARD_WINDOWS.includes(value as DashboardWindow))
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
};
