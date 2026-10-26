import {
  waNumberConnectSchema,
  waNumberRegisterSchema,
  waNumberUpdateSchema,
  type WaFailedEvent,
  type WaNumbersView,
} from '@wings/shared';
import { and, desc, eq, isNotNull } from 'drizzle-orm';
import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import { z } from 'zod';
import { waWebhookEvents } from '../../db/schema/index.js';
import { writeAudit } from '../../lib/audit.js';
import {
  activePeople,
  ConnectError,
  connectNumber,
  listNumbers,
  missingForSignup,
  numbersDepsOf,
  officialNumberOf,
  registerNumber,
  retryConnection,
  signupConfigOf,
  updateNumber,
  type ConnectErrorCode,
} from './numbers.js';

/**
 * CRM Vendas → WhatsApp → Números (docs/whatsapp/central.md, conectar-numero.md): the company's
 * work numbers, registered first and connected by coexistence later, and the webhook bodies the
 * queue gave up on. Admin Master only (`integrations.manage`, the same as the official number's
 * switch). Answers carry ids and names, never the token; audit rows carry ids only.
 */

const idParams = z.object({ id: z.uuid() });

const STATUS: Record<ConnectErrorCode, number> = {
  owner_invalid: 400,
  official_number: 409,
  phone_taken: 409,
  phone_locked: 409,
  number_mismatch: 409,
  not_registered: 404,
  not_eligible: 409,
  code_refused: 502,
  waba_unreadable: 502,
  number_not_found: 409,
  number_ambiguous: 409,
  not_business_app: 409,
  not_found: 404,
  sync_expired: 409,
  busy: 409,
};

const MESSAGES: Record<ConnectErrorCode, string> = {
  owner_invalid: 'Escolha uma pessoa ativa como dona do número.',
  official_number:
    'Este é o número oficial da Wings: ele é o canal oficial do sistema e não entra aqui como número de pessoa. Nada foi salvo.',
  phone_taken: 'Este número já está cadastrado.',
  phone_locked:
    'O número conectado é o que a Meta mostrou: para outro número, cadastre um novo. Nada foi salvo.',
  number_mismatch:
    'Na janela da Meta foi escolhido outro número, não o deste cadastro. Nada foi salvo: conecte de novo escolhendo o número certo.',
  not_registered: 'Cadastre o número antes de conectar.',
  not_eligible:
    'Só se conecta número confirmado no cadastro (app Business 2.24.17 ou maior, número de trabalho, dono com o celular na mão). Nada foi feito.',
  code_refused:
    'A Meta recusou o código da conexão (ele vale 30 segundos). Nada foi salvo: conecte de novo.',
  waba_unreadable: 'A Meta não deixou ler a conta do WhatsApp conectada. Nada foi salvo.',
  number_not_found: 'A conta do WhatsApp conectada não mostra esse número. Nada foi salvo.',
  number_ambiguous:
    'A conta do WhatsApp conectada tem mais de um número e a Meta não disse qual. Nada foi salvo.',
  not_business_app:
    'Este número não está no app WhatsApp Business. Aqui só se conecta número que continua no celular.',
  not_found: 'Número não encontrado.',
  sync_expired:
    'Passaram as 24 horas da conexão: a Meta não manda mais contatos e histórico. Para pedir de novo, o número precisa ser desconectado e conectado outra vez.',
  busy: 'Este número já está sendo conectado agora. Espere terminar e veja a lista.',
};

const refuse = (reply: FastifyReply, error: ConnectError) =>
  reply.status(STATUS[error.code]).send({
    error: error.code,
    message: MESSAGES[error.code],
    ...(error.metaCode !== null ? { metaCode: error.metaCode } : {}),
  });

const invalid = (reply: FastifyReply, issues: { message: string }[]) =>
  reply
    .status(400)
    .send({ error: 'invalid_request', message: issues[0]?.message ?? 'Dados inválidos.' });

export const whatsappNumbersRoutes: FastifyPluginAsync = async (app) => {
  const { db, env } = app.wings;
  const manage = { preHandler: app.requirePermission('integrations.manage') };
  const deps = () => numbersDepsOf(app.wings);
  const official = officialNumberOf(env);
  const off = (reply: FastifyReply) =>
    reply.status(503).send({
      error: 'signup_not_configured',
      message: `Falta configurar neste ambiente: ${missingForSignup(env).join(', ')}.`,
    });

  app.get('/whatsapp/numbers', manage, async (_request, reply) => {
    const view: WaNumbersView = {
      signup: signupConfigOf(env),
      missing: missingForSignup(env),
      numbers: await listNumbers(db),
      people: await activePeople(db),
    };
    return reply.send(view);
  });

  /** The registry (Eric, 26/10): a number, its owner, department and checks, before any connection. */
  app.post('/whatsapp/numbers', manage, async (request, reply) => {
    const body = waNumberRegisterSchema.safeParse(request.body);
    if (!body.success) return invalid(reply, body.error.issues);
    try {
      const number = await registerNumber(
        db,
        official,
        body.data,
        request.session.actor.employeeId,
      );
      await writeAudit(db, {
        actorEmployeeId: request.session.actor.employeeId,
        action: 'whatsapp.number_registered',
        entity: 'wa_numbers',
        entityId: number.id,
        ip: request.ip,
        metadata: { ownerEmployeeId: number.ownerEmployeeId, eligibility: number.eligibility },
      });
      return reply.status(201).send({ number });
    } catch (error) {
      if (error instanceof ConnectError) return refuse(reply, error);
      throw error;
    }
  });

  app.patch('/whatsapp/numbers/:id', manage, async (request, reply) => {
    const params = idParams.safeParse(request.params);
    if (!params.success) return refuse(reply, new ConnectError('not_found'));
    const body = waNumberUpdateSchema.safeParse(request.body);
    if (!body.success) return invalid(reply, body.error.issues);
    try {
      const number = await updateNumber(db, official, params.data.id, body.data);
      await writeAudit(db, {
        actorEmployeeId: request.session.actor.employeeId,
        action: 'whatsapp.number_updated',
        entity: 'wa_numbers',
        entityId: number.id,
        ip: request.ip,
        // Which fields changed, never their values (the number is a phone).
        metadata: { fields: Object.keys(body.data).sort() },
      });
      return reply.send({ number });
    } catch (error) {
      if (error instanceof ConnectError) return refuse(reply, error);
      throw error;
    }
  });

  app.post('/whatsapp/numbers/connect', manage, async (request, reply) => {
    const ready = deps();
    if (!ready) return off(reply);
    const body = waNumberConnectSchema.safeParse(request.body);
    if (!body.success)
      return reply.status(400).send({ error: 'invalid_request', message: 'Dados inválidos.' });
    try {
      const result = await connectNumber(ready, body.data, request.session.actor.employeeId);
      await writeAudit(db, {
        actorEmployeeId: request.session.actor.employeeId,
        action: 'whatsapp.number_connected',
        entity: 'wa_numbers',
        entityId: result.number.id,
        ip: request.ip,
        metadata: {
          wabaId: result.number.wabaId,
          phoneNumberId: result.number.phoneNumberId,
          businessId: result.number.businessId,
          ownerEmployeeId: result.number.ownerEmployeeId,
          tokenExpiresAt: result.number.tokenExpiresAt,
          steps: result.steps,
        },
      });
      return reply.send(result);
    } catch (error) {
      if (error instanceof ConnectError) return refuse(reply, error);
      throw error;
    }
  });

  app.post('/whatsapp/numbers/:id/retry', manage, async (request, reply) => {
    const ready = deps();
    if (!ready) return off(reply);
    const params = idParams.safeParse(request.params);
    if (!params.success) return refuse(reply, new ConnectError('not_found'));
    try {
      const result = await retryConnection(ready, params.data.id);
      await writeAudit(db, {
        actorEmployeeId: request.session.actor.employeeId,
        action: 'whatsapp.number_retried',
        entity: 'wa_numbers',
        entityId: result.number.id,
        ip: request.ip,
        metadata: { steps: result.steps },
      });
      return reply.send(result);
    } catch (error) {
      if (error instanceof ConnectError) return refuse(reply, error);
      throw error;
    }
  });

  /** Webhook bodies the queue gave up on (5 tries): ids, times and codes, never what they carry. */
  app.get('/whatsapp/webhook-events/failed', manage, async (_request, reply) => {
    const rows = await db
      .select({
        id: waWebhookEvents.id,
        receivedAt: waWebhookEvents.receivedAt,
        attempts: waWebhookEvents.attempts,
        lastError: waWebhookEvents.lastError,
        payload: waWebhookEvents.payload,
      })
      .from(waWebhookEvents)
      .where(eq(waWebhookEvents.status, 'failed'))
      .orderBy(desc(waWebhookEvents.receivedAt))
      .limit(100);
    const events: WaFailedEvent[] = rows.map((row) => ({
      id: row.id,
      receivedAt: row.receivedAt.toISOString(),
      attempts: row.attempts,
      lastError: row.lastError,
      hasPayload: row.payload !== null,
    }));
    return reply.send({ events });
  });

  /** "Processar de novo": the body goes back to the queue as new (every step is safe to repeat). */
  app.post('/whatsapp/webhook-events/:id/retry', manage, async (request, reply) => {
    const params = idParams.safeParse(request.params);
    if (!params.success)
      return reply.status(404).send({ error: 'not_found', message: 'Aviso não encontrado.' });
    const [row] = await db
      .update(waWebhookEvents)
      .set({ status: 'pending', attempts: 0, lastError: null, nextAttemptAt: new Date() })
      .where(
        and(
          eq(waWebhookEvents.id, params.data.id),
          eq(waWebhookEvents.status, 'failed'),
          // A body cleared by the 90-day purge has nothing left to process.
          isNotNull(waWebhookEvents.payload),
        ),
      )
      .returning({ id: waWebhookEvents.id });
    if (!row)
      return reply.status(409).send({
        error: 'not_retryable',
        message: 'Este aviso não está mais com falha, ou o conteúdo já foi apagado (90 dias).',
      });
    await writeAudit(db, {
      actorEmployeeId: request.session.actor.employeeId,
      action: 'whatsapp.webhook_event_retried',
      entity: 'wa_webhook_events',
      entityId: row.id,
      ip: request.ip,
      metadata: {},
    });
    app.wings.whatsappKick?.();
    return reply.status(202).send({ id: row.id });
  });
};
