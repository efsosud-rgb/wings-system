import {
  AGENDA_CALENDAR_KEYS,
  agendaEventInputSchema,
  agendaEventPatchSchema,
  agendaEventsQuerySchema,
  type AgendaCalendarKey,
} from '@wings/shared';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { writeAudit } from '../../lib/audit.js';
import { googleWorkspaceDepsOf } from '../google-workspace/service.js';
import {
  AgendaError,
  createAgendaEvent,
  eventsFor,
  overviewFor,
  pastedMeetingsFor,
  removeAgendaEvent,
  updateAgendaEvent,
  type AgendaDeps,
} from './service.js';

/**
 * Agenda (docs/agenda.md): every level opens it (`calendar.use`, scope own)
 * and each person reaches only their own Google account; creating, editing and
 * deleting also need `calendar.write`, which the sellers lack (they schedule
 * from the lead's page, Eric 19/10). There is no route
 * that takes an employee id. Audit entries carry the event id and the
 * calendar key, never a title, a guest or a time.
 */

const eventParams = z.object({
  calendar: z.enum(AGENDA_CALENDAR_KEYS),
  eventId: z.string().min(1).max(1024),
});

const invalid = (reply: FastifyReply, message?: string) =>
  reply.status(400).send({ error: 'invalid_request', message: message ?? 'Dados inválidos' });
const notFound = (reply: FastifyReply) =>
  reply
    .status(404)
    .send({ error: 'event_not_found', message: 'Evento não encontrado no Google Agenda.' });
const failed = (reply: FastifyReply, error: AgendaError) =>
  reply.status(error.status).send({ error: error.code, message: error.message, ...error.extra });

export const agendaRoutes: FastifyPluginAsync = async (app) => {
  const { db, env } = app.wings;
  const deps = (): AgendaDeps => ({
    db,
    google: googleWorkspaceDepsOf(app.wings),
    wingsCalendarId: env.GOOGLE_WORKSPACE_WINGS_CALENDAR_ID ?? null,
    sleep:
      env.NODE_ENV === 'test'
        ? async () => {}
        : (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  });

  /** Runs a service call, answering an `AgendaError` as its status and code. */
  async function answer<T>(reply: FastifyReply, run: () => Promise<T>): Promise<T | FastifyReply> {
    try {
      return await run();
    } catch (error) {
      if (error instanceof AgendaError) return failed(reply, error);
      throw error;
    }
  }

  const audit = (
    request: FastifyRequest,
    action: 'calendar.event_created' | 'calendar.event_updated' | 'calendar.event_deleted',
    eventId: string,
    calendar: AgendaCalendarKey,
  ) =>
    writeAudit(db, {
      actorEmployeeId: request.session.actor.employeeId,
      action,
      entity: 'calendar_event',
      entityId: eventId,
      ip: request.ip,
      metadata: { calendar },
    });

  app.get(
    '/agenda',
    { preHandler: app.requirePermission('calendar.use') },
    async (request, reply) =>
      reply.send({ overview: await overviewFor(deps(), request.session.actor.employeeId) }),
  );

  app.get(
    '/agenda/events',
    { preHandler: app.requirePermission('calendar.use') },
    async (request, reply) => {
      const query = agendaEventsQuerySchema.safeParse(request.query);
      if (!query.success) return invalid(reply, query.error.issues[0]?.message);
      return answer(reply, async () =>
        reply.send(await eventsFor(deps(), request.session.actor, query.data)),
      );
    },
  );

  // A deal's meetings with a pasted link, for someone with no Google connection yet (Eric, 19/10).
  app.get(
    '/agenda/crm-meetings',
    { preHandler: app.requirePermission('calendar.use') },
    async (request, reply) => {
      const query = agendaEventsQuerySchema.safeParse(request.query);
      if (!query.success) return invalid(reply, query.error.issues[0]?.message);
      return reply.send({ events: await pastedMeetingsFor(db, request.session.actor, query.data) });
    },
  );

  app.post(
    '/agenda/events',
    { preHandler: app.requirePermission('calendar.write') },
    async (request, reply) => {
      const body = agendaEventInputSchema.safeParse(request.body);
      if (!body.success) return invalid(reply, body.error.issues[0]?.message);
      return answer(reply, async () => {
        const written = await createAgendaEvent(deps(), request.session.actor, body.data);
        await audit(request, 'calendar.event_created', written.event.id, written.calendar);
        return reply.status(201).send({ event: written.event });
      });
    },
  );

  app.patch(
    '/agenda/events/:calendar/:eventId',
    { preHandler: app.requirePermission('calendar.write') },
    async (request, reply) => {
      const params = eventParams.safeParse(request.params);
      if (!params.success) return notFound(reply);
      const body = agendaEventPatchSchema.safeParse(request.body);
      if (!body.success) return invalid(reply, body.error.issues[0]?.message);
      const { calendar, eventId } = params.data;
      return answer(reply, async () => {
        const written = await updateAgendaEvent(
          deps(),
          request.session.actor,
          calendar,
          eventId,
          body.data,
        );
        await audit(request, 'calendar.event_updated', eventId, written.calendar);
        return reply.send({ event: written.event });
      });
    },
  );

  app.delete(
    '/agenda/events/:calendar/:eventId',
    { preHandler: app.requirePermission('calendar.write') },
    async (request, reply) => {
      const params = eventParams.safeParse(request.params);
      if (!params.success) return notFound(reply);
      const { calendar, eventId } = params.data;
      return answer(reply, async () => {
        const removed = await removeAgendaEvent(deps(), request.session.actor, calendar, eventId);
        await audit(request, 'calendar.event_deleted', eventId, removed.calendar);
        return reply.status(204).send();
      });
    },
  );
};
