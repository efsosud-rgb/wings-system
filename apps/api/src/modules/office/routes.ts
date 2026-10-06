import type { FastifyPluginAsync } from 'fastify';
import { officeSnapshot } from './service.js';

/**
 * Laboratório → Escritório virtual. One read: the snapshot the 3D floor and
 * its list fallback are drawn from. `office.read` is held by the Admin
 * Master only; the frontend gate is convenience, this is the authority.
 */
export const officeRoutes: FastifyPluginAsync = async (app) => {
  const { db } = app.wings;
  const now = () => app.wings.now?.() ?? new Date();

  app.get(
    '/office',
    { preHandler: app.requirePermission('office.read') },
    async (_request, reply) => {
      reply.header('Cache-Control', 'no-store');
      return reply.send(await officeSnapshot(db, now()));
    },
  );
};
