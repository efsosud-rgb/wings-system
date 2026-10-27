import { waNumberConnectSchema, type WaNumbersView } from '@wings/shared';
import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import { z } from 'zod';
import { writeAudit } from '../../lib/audit.js';
import {
  ConnectError,
  connectNumber,
  listNumbers,
  missingForSignup,
  numbersDepsOf,
  retryConnection,
  signupConfigOf,
  type ConnectErrorCode,
} from './numbers.js';

/**
 * CRM Vendas → WhatsApp → Números (docs/whatsapp/conectar-numero.md): the sellers' WhatsApp
 * Business numbers connected by coexistence. Admin Master only (`integrations.manage`, the same
 * as the official number's switch). Answers carry ids and names, never the token; audit rows
 * carry ids only.
 */

const idParams = z.object({ id: z.uuid() });

const STATUS: Record<ConnectErrorCode, number> = {
  owner_invalid: 400,
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
  owner_invalid: 'Escolha um vendedor ativo como dono do número.',
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

export const whatsappNumbersRoutes: FastifyPluginAsync = async (app) => {
  const { db, env } = app.wings;
  const manage = { preHandler: app.requirePermission('integrations.manage') };
  const deps = () => numbersDepsOf(app.wings);
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
    };
    return reply.send(view);
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
};
