import type { FastifyPluginAsync } from 'fastify';
import { youtubeChannelView } from './view.js';

/**
 * Wings' YouTube channel as the daily ingestion keeps it: the Canais próprios
 * block on the marketing dashboard and the builder's list of the channel's
 * videos read the same answer. Calls no Google service and never shows the
 * key, only whether there is one.
 */
export const youtubeRoutes: FastifyPluginAsync = async (app) => {
  const { db, env } = app.wings;

  app.get(
    '/marketing/youtube/videos',
    { preHandler: app.requirePermission('ads.read') },
    async (_request, reply) => {
      const now = (app.wings.now ?? (() => new Date()))();
      return reply.send(await youtubeChannelView(db, env, now));
    },
  );
};
