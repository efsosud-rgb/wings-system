import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import { z } from 'zod';
import { tokensMatch } from '../../lib/tokens.js';
import { metaSignatureValid } from '../leads/meta-leads.js';
import { enqueueInstagramEvents } from './intake.js';
import { instagramWebhookEventsOf } from './payload.js';

/**
 * The Meta webhook of Instagram (docs/prospeccao/instagram.md §5.1; spec PA annex 3 §5.5): the
 * handshake, then every POST signed with the app secret over the raw bytes, stored and answered at
 * once. Nothing here calls the Graph or the AI: the loop (`intake.ts`) does. Off
 * (INSTAGRAM_WEBHOOK_ENABLED, or the secret or the verify token missing) it answers 503 and stores
 * nothing, so Meta retries and shows the error. The log keeps kinds and counts, never the text,
 * the @ or the person's id.
 */

const rateLimit = { max: 1200, timeWindow: '1 minute' };
const verifyQuery = z.object({
  'hub.mode': z.string(),
  'hub.verify_token': z.string(),
  'hub.challenge': z.string(),
});

export const instagramWebhookRoutes: FastifyPluginAsync = async (app) => {
  const webhook = app.publicRoute('platform webhook with its own secret');
  const { db, env } = app.wings;
  const on = env.INSTAGRAM_WEBHOOK_ENABLED === 'true';

  // Raw bodies, scoped to this plugin: Meta's signature is over the exact bytes.
  for (const type of [['application/json', 'text/plain', 'application/x-www-form-urlencoded'], '*'])
    app.addContentTypeParser(
      type,
      { parseAs: 'buffer', bodyLimit: 1024 * 1024 },
      (_request, body, done) => done(null, body),
    );

  const off = (reply: FastifyReply) =>
    reply.status(503).send({
      error: 'instagram_disabled',
      message: 'O webhook do Instagram está desligado.',
    });

  app.get(
    '/integrations/instagram/webhook',
    { preHandler: webhook, config: { rateLimit } },
    async (request, reply) => {
      if (!on || !env.INSTAGRAM_WEBHOOK_VERIFY_TOKEN) return off(reply);
      const query = verifyQuery.safeParse(request.query);
      if (
        !query.success ||
        query.data['hub.mode'] !== 'subscribe' ||
        !tokensMatch(query.data['hub.verify_token'], env.INSTAGRAM_WEBHOOK_VERIFY_TOKEN)
      )
        return reply
          .status(403)
          .send({ error: 'bad_verify_token', message: 'Token de verificação inválido.' });
      return reply.type('text/plain').send(query.data['hub.challenge']);
    },
  );

  app.post(
    '/integrations/instagram/webhook',
    { preHandler: webhook, config: { rateLimit } },
    async (request, reply) => {
      if (!on || !env.INSTAGRAM_APP_SECRET || !env.INSTAGRAM_WEBHOOK_VERIFY_TOKEN)
        return off(reply);
      const raw = Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0);
      const signature = request.headers['x-hub-signature-256'];
      if (
        !metaSignatureValid(
          env.INSTAGRAM_APP_SECRET,
          raw,
          Array.isArray(signature) ? signature[0] : signature,
        )
      )
        return reply.status(401).send({ error: 'bad_signature', message: 'Assinatura inválida.' });
      let body: unknown;
      try {
        body = JSON.parse(raw.toString('utf8'));
      } catch {
        return reply.status(400).send({ error: 'invalid_json', message: 'Corpo inválido.' });
      }
      const events = instagramWebhookEventsOf(body);
      const queued = await enqueueInstagramEvents(db, events);
      app.log.info({
        msg: 'instagram webhook',
        kinds: events.map((event) => event.kind),
        queued,
      });
      if (queued > 0) app.wings.instagramKick?.();
      return reply.send({ received: events.length, queued });
    },
  );
};
