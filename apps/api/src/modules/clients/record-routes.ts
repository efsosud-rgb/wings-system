//   GET    /clients/:id/record                      -> ClientRecord            clients.read
//   PUT    /clients/:id/company        (block 1)    -> ClientRecord            clients.edit
//   POST   /clients/:id/partners       (block 2)    -> ClientRecord            clients.edit (+ clients.sensitive for CPF, estado civil, regime)
//   PUT    /clients/:id/partners/:partnerId         -> ClientRecord            idem
//   DELETE /clients/:id/partners/:partnerId         -> ClientRecord            clients.edit
//   PUT    /clients/:id/contacts       (block 3)    -> ClientRecord            clients.edit
//   PUT    /clients/:id/business       (block 4)    -> ClientRecord            clients.edit
//   PUT    /clients/:id/contracts      (block 5)    -> ClientRecord            clients.edit
//   PUT    /clients/:id/franchise      (block 6)    -> ClientRecord            clients.edit
//   PUT    /clients/:id/signature      (block 7)    -> ClientRecord            clients.edit (+ clients.sensitive for witness CPFs)
//   POST   /clients/:id/reveal-cpf { kind, id }     -> { cpf }                 clients.sensitive, audited
//   POST   /clients/lookup/cnpj { cnpj }            -> CnpjLookup              clients.edit or clients.manage
//   POST   /clients/lookup/cep  { cep }             -> CepLookup               idem
// Lookups are POSTs so a CNPJ or CEP never lands in a URL, and so in no request log.
import {
  WINGS_CLIENT_ID,
  clientBusinessSchema,
  clientCompanySchema,
  clientContactsSchema,
  clientContractsSchema,
  clientFranchiseSchema,
  clientPartnerInputSchema,
  clientSignatureSchema,
  isValidCnpj,
  normalizeCep,
} from '@wings/shared';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { createRegistryLookup } from './lookup.js';
import {
  deletePartner,
  loadRecord,
  revealCpf,
  saveBusiness,
  saveCompany,
  saveContacts,
  saveContracts,
  saveFranchise,
  savePartner,
  saveSignature,
  type Failure,
  type WriteContext,
} from './record.js';

const idParam = z.object({ id: z.uuid() });
const partnerParam = z.object({ id: z.uuid(), partnerId: z.uuid() });

export const clientRecordRoutes: FastifyPluginAsync = async (app) => {
  const { db, cpfCrypto } = app.wings;
  const registry = createRegistryLookup({ fetch: app.wings.registryFetch, log: app.log });

  const access = (request: FastifyRequest) => ({
    canEdit: app.can(request, 'clients.edit'),
    canSeeSensitive: app.can(request, 'clients.sensitive'),
  });

  const context = (request: FastifyRequest): WriteContext => ({
    actor: request.session.actor,
    ip: request.ip,
    cpfCrypto,
    canSeeSensitive: app.can(request, 'clients.sensitive'),
  });

  const badRequest = (reply: FastifyReply, error?: z.ZodError) =>
    reply.status(400).send({ error: 'invalid_request', message: error?.issues[0]?.message ?? 'Dados inválidos' });

  const failed = (reply: FastifyReply, failure: Failure) =>
    reply.status(failure.status).send({
      error: failure.error === 'conflict' ? failure.code : failure.error === 'invalid' ? 'invalid_request' : failure.error,
      message: failure.message,
    });

  const sendRecord = async (request: FastifyRequest, reply: FastifyReply, clientId: string) => {
    const record = await loadRecord(db, cpfCrypto, request.session.actor, clientId, access(request));
    if (!record) return reply.status(404).send({ error: 'not_found', message: 'Cliente não encontrado.' });
    return reply.send(record);
  };

  /** Wings Company is the default client, not a franchisor being formatted: it has no record. */
  const clientIdOf = (request: FastifyRequest, reply: FastifyReply): string | null => {
    const params = idParam.safeParse(request.params);
    if (!params.success) {
      void badRequest(reply);
      return null;
    }
    if (params.data.id === WINGS_CLIENT_ID) {
      void reply.status(409).send({ error: 'client_fixed', message: 'Wings Company não tem ficha de cliente.' });
      return null;
    }
    return params.data.id;
  };

  app.get('/clients/:id/record', { preHandler: app.requirePermission('clients.read') }, async (request, reply) => {
    const clientId = clientIdOf(request, reply);
    if (!clientId) return reply;
    return sendRecord(request, reply, clientId);
  });

  /** One PUT per block: parse, save, answer with the whole record (and its new %). */
  const block = <S extends z.ZodType>(
    path: string,
    schema: S,
    save: (ctx: WriteContext, clientId: string, input: z.output<S>) => Promise<{ ok: true } | { ok: false; failure: Failure }>,
  ) =>
    app.put(path, { preHandler: app.requirePermission('clients.edit') }, async (request, reply) => {
      const clientId = clientIdOf(request, reply);
      if (!clientId) return reply;
      const body = schema.safeParse(request.body);
      if (!body.success) return badRequest(reply, body.error);
      const result = await save(context(request), clientId, body.data);
      if (!result.ok) return failed(reply, result.failure);
      return sendRecord(request, reply, clientId);
    });

  block('/clients/:id/company', clientCompanySchema, (ctx, id, input) => saveCompany(db, ctx, id, input));
  block('/clients/:id/contacts', clientContactsSchema, (ctx, id, input) => saveContacts(db, ctx, id, input));
  block('/clients/:id/business', clientBusinessSchema, (ctx, id, input) => saveBusiness(db, ctx, id, input));
  block('/clients/:id/contracts', clientContractsSchema, (ctx, id, input) => saveContracts(db, ctx, id, input));
  block('/clients/:id/franchise', clientFranchiseSchema, (ctx, id, input) => saveFranchise(db, ctx, id, input));
  block('/clients/:id/signature', clientSignatureSchema, (ctx, id, input) => saveSignature(db, ctx, id, input));

  app.post('/clients/:id/partners', { preHandler: app.requirePermission('clients.edit') }, async (request, reply) => {
    const clientId = clientIdOf(request, reply);
    if (!clientId) return reply;
    const body = clientPartnerInputSchema.safeParse(request.body);
    if (!body.success) return badRequest(reply, body.error);
    const result = await savePartner(db, context(request), clientId, null, body.data);
    if (!result.ok) return failed(reply, result.failure);
    reply.status(201);
    return sendRecord(request, reply, clientId);
  });

  app.put(
    '/clients/:id/partners/:partnerId',
    { preHandler: app.requirePermission('clients.edit') },
    async (request, reply) => {
      const clientId = clientIdOf(request, reply);
      if (!clientId) return reply;
      const params = partnerParam.safeParse(request.params);
      const body = clientPartnerInputSchema.safeParse(request.body);
      if (!params.success) return badRequest(reply);
      if (!body.success) return badRequest(reply, body.error);
      const result = await savePartner(db, context(request), clientId, params.data.partnerId, body.data);
      if (!result.ok) return failed(reply, result.failure);
      return sendRecord(request, reply, clientId);
    },
  );

  app.delete(
    '/clients/:id/partners/:partnerId',
    { preHandler: app.requirePermission('clients.edit') },
    async (request, reply) => {
      const clientId = clientIdOf(request, reply);
      if (!clientId) return reply;
      const params = partnerParam.safeParse(request.params);
      if (!params.success) return badRequest(reply);
      const result = await deletePartner(db, context(request), clientId, params.data.partnerId);
      if (!result.ok) return failed(reply, result.failure);
      return sendRecord(request, reply, clientId);
    },
  );

  app.post(
    '/clients/:id/reveal-cpf',
    { preHandler: app.requirePermission('clients.sensitive') },
    async (request, reply) => {
      const clientId = clientIdOf(request, reply);
      if (!clientId) return reply;
      const body = z.object({ kind: z.enum(['partner', 'witness']), id: z.uuid() }).safeParse(request.body);
      if (!body.success) return badRequest(reply, body.error);
      const result = await revealCpf(db, context(request), clientId, body.data.kind, body.data.id);
      if (!result.ok) return failed(reply, result.failure);
      return reply.send(result.value);
    },
  );

  // --- CNPJ and CEP --------------------------------------------------------------

  const canLookUp = (request: FastifyRequest) => app.can(request, 'clients.edit') || app.can(request, 'clients.manage');
  // The public registries throttle us per IP; keep each person to a human pace.
  const lookupLimit = { rateLimit: { max: 20, timeWindow: '1 minute' } };

  app.post('/clients/lookup/cnpj', { preHandler: app.requireAuth, config: lookupLimit }, async (request, reply) => {
    if (!canLookUp(request)) return reply.status(403).send({ error: 'forbidden', message: 'Acesso negado' });
    const body = z.object({ cnpj: z.string().max(30) }).safeParse(request.body);
    if (!body.success || !isValidCnpj(body.data.cnpj)) {
      return reply.status(400).send({ error: 'invalid_request', message: 'CNPJ inválido' });
    }
    const result = await registry.cnpj(body.data.cnpj);
    if (result.ok) return reply.send(result.value);
    return result.reason === 'not_found'
      ? reply.status(404).send({ error: 'cnpj_not_found', message: 'A Receita não tem este CNPJ.' })
      : reply.status(503).send({
          error: 'lookup_unavailable',
          message: 'A consulta de CNPJ não respondeu agora. Tente de novo ou preencha à mão.',
        });
  });

  app.post('/clients/lookup/cep', { preHandler: app.requireAuth, config: lookupLimit }, async (request, reply) => {
    if (!canLookUp(request)) return reply.status(403).send({ error: 'forbidden', message: 'Acesso negado' });
    const body = z.object({ cep: z.string().max(12) }).safeParse(request.body);
    if (!body.success || normalizeCep(body.data.cep).length !== 8) {
      return reply.status(400).send({ error: 'invalid_request', message: 'CEP com 8 dígitos' });
    }
    const result = await registry.cep(body.data.cep);
    if (result.ok) return reply.send(result.value);
    return result.reason === 'not_found'
      ? reply.status(404).send({ error: 'cep_not_found', message: 'CEP não encontrado.' })
      : reply.status(503).send({
          error: 'lookup_unavailable',
          message: 'A consulta de CEP não respondeu agora. Tente de novo ou preencha à mão.',
        });
  });
};
