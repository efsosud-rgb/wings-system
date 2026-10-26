import { cameraBatchSchema, cameraDeviceCreateSchema, camerasQuerySchema } from '@wings/shared';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { writeAudit } from '../../lib/audit.js';
import {
  camerasDashboardOf,
  deviceByToken,
  ingestBatch,
  intervalProblem,
  listDevices,
  registerDevice,
  revokeDevice,
} from './service.js';

const idParam = z.object({ id: z.uuid() });

const invalid = (reply: FastifyReply, message: string, error = 'invalid_request') =>
  reply.status(400).send({ error, message });

/** The device token, as `Authorization: Bearer <token>`. */
const bearerOf = (request: FastifyRequest) =>
  /^Bearer\s+(\S+)$/i.exec(request.headers.authorization ?? '')?.[1];

/**
 * Gestão → Câmeras (docs/cameras.md). The dashboard and the device list for who
 * reads the panel; registering and revoking devices is the Admin Master's. The
 * public route is the one a device calls, with its own token, to deliver a
 * 15-minute batch of counts. Nothing here ever accepts an image: the batch
 * schema is strict, so an unexpected field refuses the whole batch.
 */
export const cameraRoutes: FastifyPluginAsync = async (app) => {
  const { db } = app.wings;

  app.get(
    '/cameras/dashboard',
    { preHandler: app.requirePermission('cameras.read') },
    async (request, reply) => {
      const query = camerasQuerySchema.safeParse(request.query ?? {});
      if (!query.success)
        return invalid(reply, query.error.issues[0]?.message ?? 'Filtros inválidos.');
      const data = await camerasDashboardOf(db, query.data, request.session.actor);
      if (data === 'unit_not_found')
        return reply.status(404).send({ error: 'not_found', message: 'Unidade não encontrada.' });
      return reply.send(data);
    },
  );

  app.get(
    '/cameras/devices',
    { preHandler: app.requirePermission('cameras.read') },
    async (_request, reply) => reply.send({ devices: await listDevices(db) }),
  );

  app.post(
    '/cameras/devices',
    { preHandler: app.requirePermission('cameras.manage') },
    async (request, reply) => {
      const body = cameraDeviceCreateSchema.safeParse(request.body ?? {});
      if (!body.success) return invalid(reply, body.error.issues[0]?.message ?? 'Dados inválidos.');
      const made = await registerDevice(db, body.data, request.session.actor.employeeId);
      if (made === 'unit_not_found')
        return reply.status(404).send({ error: 'not_found', message: 'Unidade não encontrada.' });
      await writeAudit(db, {
        actorEmployeeId: request.session.actor.employeeId,
        action: 'camera_device.created',
        entity: 'camera_device',
        entityId: made.device.id,
        metadata: {
          unitId: made.device.unit.id,
          areaCode: made.device.area.code,
          kind: made.device.kind,
          test: made.device.test,
        },
      });
      // The token travels once, here; only its hash stays.
      return reply.status(201).send(made);
    },
  );

  app.post(
    '/cameras/devices/:id/revoke',
    { preHandler: app.requirePermission('cameras.manage') },
    async (request, reply) => {
      const params = idParam.safeParse(request.params);
      if (!params.success) return invalid(reply, 'Dispositivo inválido.');
      if (!(await revokeDevice(db, params.data.id)))
        return reply
          .status(404)
          .send({ error: 'not_found', message: 'Dispositivo não encontrado.' });
      await writeAudit(db, {
        actorEmployeeId: request.session.actor.employeeId,
        action: 'camera_device.revoked',
        entity: 'camera_device',
        entityId: params.data.id,
      });
      return reply.send({ ok: true });
    },
  );

  // The device's door: its own token, a strict body, idempotent by device + interval.
  app.post(
    '/public/cameras/batches',
    {
      preHandler: app.publicRoute('camera device batch, with the token of that device'),
      config: { rateLimit: { max: 120, timeWindow: '1 minute' } },
    },
    async (request, reply) => {
      const token = bearerOf(request);
      const device = token ? await deviceByToken(db, token) : null;
      if (!device)
        return reply
          .status(401)
          .send({ error: 'invalid_token', message: 'Token do dispositivo inválido.' });
      if (device.revoked)
        return reply
          .status(410)
          .send({ error: 'revoked', message: 'Token do dispositivo revogado.' });
      const body = cameraBatchSchema.safeParse(request.body ?? {});
      if (!body.success) {
        const issue = body.error.issues[0];
        return invalid(
          reply,
          `${issue?.path.join('.') || 'lote'}: ${issue?.message ?? 'inválido'}`,
          'invalid_batch',
        );
      }
      for (const [index, interval] of body.data.intervals.entries()) {
        const problem = intervalProblem(interval.startsAt);
        if (problem) return invalid(reply, `intervals.${index}: ${problem}`, 'invalid_batch');
      }
      return reply.send(await ingestBatch(db, device, body.data));
    },
  );
};
