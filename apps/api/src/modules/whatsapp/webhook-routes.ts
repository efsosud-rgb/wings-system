import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { tokensMatch } from '../../lib/tokens.js';
import { metaSignatureValid } from '../leads/meta-leads.js';
import { shapeOf } from '../media/kairogen-adapter.js';
import { storeWhatsAppEvent } from './intake.js';
import { whatsappChangesOf } from './webhook-parse.js';

/**
 * Meta's WhatsApp webhook (docs/whatsapp/cloud-api.md), with no session.
 * GET is the subscription handshake (our verify token); POST must carry
 * X-Hub-Signature-256 over the exact bytes with the app secret of "Wings CRM
 * Vendas" (WHATSAPP_APP_SECRET, not META_APP_SECRET). A signed body is stored
 * and answered 200 at once; the queue (`intake.ts`) does the rest. Off (503)
 * until both are set. Only the body's shape is logged, never a value.
 */

/** Meta sends up to 3 MB; a little room above it. */
const BODY_LIMIT = 4 * 1024 * 1024;
const rateLimit = { max: 1200, timeWindow: '1 minute' };

const verifyQuery = z.object({
  'hub.mode': z.string(),
  'hub.verify_token': z.string(),
  'hub.challenge': z.string(),
});

export const whatsappWebhookRoutes: FastifyPluginAsync = async (app) => {
  // No login: Meta's verify token and signature are checked in the handlers.
  const webhook = app.publicRoute('WhatsApp Cloud API webhook, signed by Meta');
  const { db, env } = app.wings;

  // Raw bodies, scoped to this plugin: the signature is over the exact bytes.
  for (const type of [['application/json', 'text/plain'], '*'] as const)
    app.addContentTypeParser(
      type as string | string[],
      { parseAs: 'buffer', bodyLimit: BODY_LIMIT },
      (_request, body, done) => done(null, body),
    );

  const unavailable = {
    error: 'webhook_not_configured',
    message: 'O webhook do WhatsApp não está configurado.',
  };

  app.get(
    '/integrations/whatsapp/webhook',
    { preHandler: webhook, config: { rateLimit } },
    async (request, reply) => {
      if (!env.WHATSAPP_WEBHOOK_VERIFY_TOKEN) return reply.status(503).send(unavailable);
      const query = verifyQuery.safeParse(request.query);
      if (
        !query.success ||
        query.data['hub.mode'] !== 'subscribe' ||
        !tokensMatch(query.data['hub.verify_token'], env.WHATSAPP_WEBHOOK_VERIFY_TOKEN)
      ) {
        return reply
          .status(403)
          .send({ error: 'bad_verify_token', message: 'Token de verificação inválido.' });
      }
      return reply.type('text/plain').send(query.data['hub.challenge']);
    },
  );

  app.post(
    '/integrations/whatsapp/webhook',
    { preHandler: webhook, config: { rateLimit }, bodyLimit: BODY_LIMIT },
    async (request, reply) => {
      if (!env.WHATSAPP_APP_SECRET || !env.WHATSAPP_WEBHOOK_VERIFY_TOKEN)
        return reply.status(503).send(unavailable);
      const raw = Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0);
      const signature = request.headers['x-hub-signature-256'];
      if (
        !metaSignatureValid(
          env.WHATSAPP_APP_SECRET,
          raw,
          Array.isArray(signature) ? signature[0] : signature,
        )
      ) {
        return reply.status(401).send({ error: 'bad_signature', message: 'Assinatura inválida.' });
      }
      let body: unknown;
      try {
        body = JSON.parse(raw.toString('utf8'));
      } catch {
        return reply.status(400).send({ error: 'invalid_json', message: 'Corpo inválido.' });
      }
      const changes = whatsappChangesOf(body);
      app.log.info({
        msg: 'whatsapp webhook',
        shape: shapeOf(body),
        fields: changes.map((c) => c.field),
        messages: changes.reduce((n, c) => n + c.messages.length, 0),
        statuses: changes.reduce((n, c) => n + c.statuses.length, 0),
      });
      if (changes.length === 0) return reply.send({ received: 0 });
      await storeWhatsAppEvent(db, body);
      app.wings.whatsappKick?.();
      return reply.send({ received: changes.length });
    },
  );
};
