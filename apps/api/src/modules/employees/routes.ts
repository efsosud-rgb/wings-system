import {
  EMPLOYEE_STATUS,
  INVITE_FAILURE_MESSAGE,
  SECTOR_SLUGS,
  employeeCreateSchema,
  employeeUpdateSchema,
  type EmployeeStatus,
  type InviteFailureCode,
  type InviteOutcome,
  type SectorSlug,
} from '@wings/shared';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { sendInvite } from '../auth/credentials-service.js';
import {
  createEmployee,
  getEmployee,
  listEmployees,
  revealCpf,
  updateEmployee,
  type EmployeeFailure,
} from './service.js';

const STATUS_BY_FAILURE: Record<EmployeeFailure, number> = {
  forbidden: 403,
  not_found: 404,
  cpf_taken: 409,
  email_taken: 409,
  role_not_allowed: 403,
  manager_flag_forbidden: 403,
};

const MESSAGE_BY_FAILURE: Record<EmployeeFailure, string> = {
  forbidden: 'Você não tem permissão para esta ação.',
  not_found: 'Funcionário não encontrado.',
  cpf_taken: 'Já existe um funcionário com este CPF.',
  email_taken: 'Já existe um funcionário com este e-mail.',
  role_not_allowed: 'Você não pode atribuir este nível de acesso.',
  manager_flag_forbidden: 'Apenas o Admin Master pode definir gestores de setor.',
};

function fail(reply: FastifyReply, reason: EmployeeFailure) {
  return reply
    .status(STATUS_BY_FAILURE[reason])
    .send({ error: reason, message: MESSAGE_BY_FAILURE[reason] });
}

function requestContext(request: FastifyRequest) {
  return { ip: request.ip, userAgent: request.headers['user-agent'] ?? null };
}

const listQuerySchema = z.object({
  search: z.string().trim().max(120).optional(),
  sector: z.enum(SECTOR_SLUGS as [SectorSlug, ...SectorSlug[]]).optional(),
  status: z.enum(EMPLOYEE_STATUS as unknown as [EmployeeStatus, ...EmployeeStatus[]]).optional(),
  page: z.coerce.number().int().positive().optional(),
  pageSize: z.coerce.number().int().positive().max(100).optional(),
});

const idParamSchema = z.object({ id: z.string().uuid() });

export const employeeRoutes: FastifyPluginAsync = async (app) => {
  const { db, cpfCrypto, mailer, env } = app.wings;

  function inviteFailure(code: InviteFailureCode): InviteOutcome {
    return { sent: false, error: { code, message: INVITE_FAILURE_MESSAGE[code] } };
  }

  /** Never throws: a mail problem must not undo a completed registration. */
  async function attemptInvite(
    employeeId: string,
    request: FastifyRequest,
  ): Promise<InviteOutcome> {
    if (!mailer.enabled) return inviteFailure('email_not_configured');
    try {
      const result = await sendInvite(db, mailer, {
        employeeId,
        baseUrl: env.APP_BASE_URL,
        actorId: request.session.actor.employeeId,
        ctx: requestContext(request),
      });
      // sendInvite only declines for an employee who cannot receive one.
      return result.sent ? { sent: true } : inviteFailure('employee_inactive');
    } catch (error) {
      request.log.error({ err: error }, 'invite e-mail failed after employee creation');
      return inviteFailure('send_failed');
    }
  }

  app.get(
    '/employees',
    { preHandler: app.requirePermission('employees.read') },
    async (request, reply) => {
      const query = listQuerySchema.safeParse(request.query);
      if (!query.success) {
        return reply.status(400).send({ error: 'invalid_request', message: 'Filtros inválidos' });
      }
      const result = await listEmployees(db, request.session.actor, cpfCrypto, query.data);
      return reply.send(result);
    },
  );

  app.get('/employees/:id', { preHandler: app.requireAuth }, async (request, reply) => {
    const params = idParamSchema.safeParse(request.params);
    if (!params.success) return fail(reply, 'not_found');

    const result = await getEmployee(db, request.session.actor, cpfCrypto, params.data.id);
    return result.ok ? reply.send({ employee: result.value }) : fail(reply, result.reason);
  });

  /**
   * Creating an employee also sends the invite so they can set their own
   * password. A mail failure does not roll back the employee: the record is
   * created and `inviteSent: false` tells the UI to offer a re-send.
   */
  app.post('/employees', { preHandler: app.requireAuth }, async (request, reply) => {
    const parsed = employeeCreateSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: 'invalid_request',
        message: parsed.error.issues[0]?.message ?? 'Dados inválidos',
        field: parsed.error.issues[0]?.path.join('.'),
      });
    }

    const created = await createEmployee(
      db,
      request.session.actor,
      cpfCrypto,
      parsed.data,
      requestContext(request),
    );
    if (!created.ok) return fail(reply, created.reason);

    // The registration is complete either way; the operator must be told
    // plainly whether the invite actually went out.
    const invite = await attemptInvite(created.value.id, request);
    return reply.status(201).send({ employee: created.value, invite, inviteSent: invite.sent });
  });

  app.patch('/employees/:id', { preHandler: app.requireAuth }, async (request, reply) => {
    const params = idParamSchema.safeParse(request.params);
    if (!params.success) return fail(reply, 'not_found');

    const parsed = employeeUpdateSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: 'invalid_request',
        message: parsed.error.issues[0]?.message ?? 'Dados inválidos',
        field: parsed.error.issues[0]?.path.join('.'),
      });
    }

    const updated = await updateEmployee(
      db,
      request.session.actor,
      cpfCrypto,
      params.data.id,
      parsed.data,
      requestContext(request),
    );
    return updated.ok ? reply.send({ employee: updated.value }) : fail(reply, updated.reason);
  });

  /** POST, not GET: a CPF must never sit in a URL, a log or browser history. */
  app.post('/employees/:id/reveal-cpf', { preHandler: app.requireAuth }, async (request, reply) => {
    const params = idParamSchema.safeParse(request.params);
    if (!params.success) return fail(reply, 'not_found');

    const result = await revealCpf(
      db,
      request.session.actor,
      cpfCrypto,
      params.data.id,
      requestContext(request),
    );
    return result.ok ? reply.send(result.value) : fail(reply, result.reason);
  });

  /** Re-sends the invite for an employee who has not set a password yet. */
  app.post('/employees/:id/invite', { preHandler: app.requireAuth }, async (request, reply) => {
    const params = idParamSchema.safeParse(request.params);
    if (!params.success) return fail(reply, 'not_found');

    const target = await getEmployee(db, request.session.actor, cpfCrypto, params.data.id);
    if (!target.ok) return fail(reply, target.reason);

    const decision = app.can(request, 'employees.create', { sector: target.value.sector });
    if (!decision) return fail(reply, 'forbidden');
    if (!mailer.enabled) {
      return reply
        .status(503)
        .send({ error: 'email_not_configured', message: 'Envio de e-mail indisponível.' });
    }

    const invite = await sendInvite(db, mailer, {
      employeeId: params.data.id,
      baseUrl: env.APP_BASE_URL,
      actorId: request.session.actor.employeeId,
      ctx: requestContext(request),
    });
    return invite.sent ? reply.send({ ok: true }) : fail(reply, 'not_found');
  });
};
