import { canonicalWhatsAppPhone, waCallSdpSchema, type WaCall } from '@wings/shared';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { waCalls, waContacts } from '../../db/schema/index.js';
import { writeAudit } from '../../lib/audit.js';
import { leadInScope, leadOwnerFilter } from '../leads/access.js';
import { notifyCallsChanged } from './call-signal.js';
import { callingOn } from './calling.js';
import { startWhatsAppCall, whatsappCallAction, whatsappConfigOf } from './graph.js';
import { conversationFor } from './intake.js';
import { callView, ringingFor } from './ringing.js';

/**
 * WhatsApp voice calls (Calling API; docs/whatsapp/cloud-api.md). The browser
 * carries the audio (its own WebRTC); this relays the media descriptions to
 * Meta and keeps the record. Same permission and scope as the chat
 * (`leads.whatsapp`). Every call to Meta is made once, never retried; the
 * person's phone and the descriptions never reach a log.
 *
 * Outgoing: the browser's offer goes to Meta (`connect`); Meta's answer comes
 * by webhook and the browser fetches it here. Incoming: the person's offer
 * comes by webhook; the first person in reach to pick up gets it, answers,
 * and that answer goes to Meta (`accept`). The screens learn of a ringing call
 * by the stream (`ringing-stream.ts`), and ask for it here, slowly, while the
 * stream is down.
 */

const idParams = z.object({ id: z.uuid() });
type Row = typeof waCalls.$inferSelect;

export const whatsappCallRoutes: FastifyPluginAsync = async (app) => {
  const { db, env } = app.wings;
  const now = () => app.wings.now?.() ?? new Date();
  const fetchImpl = () => app.wings.whatsappFetch ?? fetch;
  const use = { preHandler: app.requirePermission('leads.whatsapp') };

  const notFound = (reply: FastifyReply) =>
    reply.status(404).send({ error: 'not_found', message: 'Ligação não encontrada.' });
  const refuse = (reply: FastifyReply, status: number, error: string, message: string) =>
    reply.status(status).send({ error, message });

  async function inReach(request: FastifyRequest, row: Row) {
    const actor = request.session.actor;
    if (row.employeeId === actor.employeeId) return true;
    if (row.leadId) return Boolean(await leadInScope(db, actor, row.leadId, 'leads.whatsapp'));
    return leadOwnerFilter(actor, 'leads.whatsapp') === undefined;
  }

  const toCall = (row: Row, viewer: string): Promise<WaCall> => callView(db, row, viewer);

  // --- placing a call -----------------------------------------------------------------

  app.post('/leads/:id/whatsapp/calls', use, async (request, reply) => {
    const params = idParams.safeParse(request.params);
    if (!params.success) return notFound(reply);
    const actor = request.session.actor;
    const lead = await leadInScope(db, actor, params.data.id, 'leads.whatsapp');
    if (!lead) return notFound(reply);
    const body = waCallSdpSchema.safeParse(request.body);
    if (!body.success)
      return refuse(reply, 400, 'invalid', body.error.issues[0]?.message ?? 'Pedido inválido.');
    const config = whatsappConfigOf(env);
    if (!config)
      return refuse(
        reply,
        503,
        'whatsapp_off',
        'O WhatsApp oficial ainda não está ligado no sistema.',
      );
    if (!(await callingOn(fetchImpl(), config)))
      return refuse(
        reply,
        409,
        'calling_off',
        'As ligações ainda não estão ligadas neste número do WhatsApp.',
      );
    if (!lead.phone) return refuse(reply, 422, 'no_phone', 'A negociação não tem telefone.');
    const phone = canonicalWhatsAppPhone(lead.phone);
    const [contact] = await db
      .insert(waContacts)
      .values({ phone })
      .onConflictDoUpdate({
        target: [waContacts.tenantId, waContacts.phone],
        set: { updatedAt: now() },
      })
      .returning();
    const conversation = await conversationFor(db, contact!.id, lead.id, {
      referral: null,
      originCode: null,
    });
    // Written first: Meta's webhooks may come before its answer, and find it by our id.
    const [row] = await db
      .insert(waCalls)
      .values({
        contactId: contact!.id,
        conversationId: conversation.id,
        leadId: lead.id,
        direction: 'out',
        status: 'dialing',
        employeeId: actor.employeeId,
        startedAt: now(),
      })
      .returning();
    const result = await startWhatsAppCall(
      fetchImpl(),
      config,
      contact!.waId ?? contact!.phone,
      body.data.sdp,
      row!.id,
    );
    const [saved] = await db
      .update(waCalls)
      .set(
        result.ok
          ? { callId: result.data.callId }
          : {
              status: 'failed',
              endedAt: now(),
              errorCode: result.code,
              errorTitle: result.title,
              durationSeconds: 0,
              // A call that never left is not a call on the deal's history.
              activityLoggedAt: now(),
            },
      )
      .where(eq(waCalls.id, row!.id))
      .returning();
    await writeAudit(db, {
      actorEmployeeId: actor.employeeId,
      action: 'whatsapp.call_started',
      entity: 'lead',
      entityId: lead.id,
      ip: request.ip,
      metadata: {
        callId: row!.id,
        outcome: result.ok ? 'dialing' : result.unknown ? 'unknown' : 'failed',
        ...(result.ok ? {} : { errorCode: result.code }),
      },
    });
    return reply.status(201).send({ call: await toCall(saved!, actor.employeeId) });
  });

  app.get('/whatsapp/calls/:id', use, async (request, reply) => {
    const params = idParams.safeParse(request.params);
    if (!params.success) return notFound(reply);
    const row = await db.query.waCalls.findFirst({ where: eq(waCalls.id, params.data.id) });
    if (!row || !(await inReach(request, row))) return notFound(reply);
    return reply.send({ call: await toCall(row, request.session.actor.employeeId) });
  });

  /** The browser says the audio connected (Meta's own "accepted" may come later, or not). */
  app.post('/whatsapp/calls/:id/connected', use, async (request, reply) => {
    const params = idParams.safeParse(request.params);
    if (!params.success) return notFound(reply);
    const actor = request.session.actor;
    const [row] = await db
      .update(waCalls)
      .set({ status: 'accepted', connectedAt: sql`coalesce(${waCalls.connectedAt}, now())` })
      .where(
        and(
          eq(waCalls.id, params.data.id),
          eq(waCalls.employeeId, actor.employeeId),
          inArray(waCalls.status, ['dialing', 'ringing', 'accepted']),
        ),
      )
      .returning();
    if (!row) return notFound(reply);
    return reply.send({ call: await toCall(row, actor.employeeId) });
  });

  // --- a call coming in ---------------------------------------------------------------

  /** The same answer the stream gives, for a screen whose stream is down. */
  app.get('/whatsapp/calls/ringing', use, async (request, reply) =>
    reply.send(await ringingFor(db, env, fetchImpl(), request.session.actor, now())),
  );

  /** The first one in reach to pick up gets the person's offer; anyone else hears it was taken. */
  app.post('/whatsapp/calls/:id/pickup', use, async (request, reply) => {
    const params = idParams.safeParse(request.params);
    if (!params.success) return notFound(reply);
    const row = await db.query.waCalls.findFirst({ where: eq(waCalls.id, params.data.id) });
    if (!row || row.direction !== 'in' || !(await inReach(request, row))) return notFound(reply);
    const actor = request.session.actor;
    const [claimed] = await db
      .update(waCalls)
      .set({ employeeId: actor.employeeId })
      .where(and(eq(waCalls.id, row.id), eq(waCalls.status, 'ringing'), isNull(waCalls.employeeId)))
      .returning();
    // Taken: the others' cards go away now, not at their next look.
    if (claimed) notifyCallsChanged();
    if (!claimed?.remoteSdp)
      return refuse(reply, 409, 'taken', 'A ligação já foi atendida por outra pessoa ou terminou.');
    return reply.send({
      offerSdp: claimed.remoteSdp,
      call: await toCall(claimed, actor.employeeId),
    });
  });

  app.post('/whatsapp/calls/:id/accept', use, async (request, reply) => {
    const params = idParams.safeParse(request.params);
    if (!params.success) return notFound(reply);
    const body = waCallSdpSchema.safeParse(request.body);
    if (!body.success)
      return refuse(reply, 400, 'invalid', body.error.issues[0]?.message ?? 'Pedido inválido.');
    const actor = request.session.actor;
    const row = await db.query.waCalls.findFirst({ where: eq(waCalls.id, params.data.id) });
    if (!row || row.employeeId !== actor.employeeId || row.direction !== 'in')
      return notFound(reply);
    if (row.status !== 'ringing' || !row.callId)
      return refuse(reply, 409, 'ended', 'A ligação já terminou.');
    const config = whatsappConfigOf(env);
    if (!config) return refuse(reply, 503, 'whatsapp_off', 'O WhatsApp oficial não está ligado.');
    // Straight to accept, no pre_accept: a browser cannot hold its audio back
    // (Meta's FAQ), and the caller counts the first audio packet as answered.
    const result = await whatsappCallAction(
      fetchImpl(),
      config,
      row.callId,
      'accept',
      body.data.sdp,
    );
    const [saved] = await db
      .update(waCalls)
      .set(
        result.ok
          ? { status: 'accepted', connectedAt: now(), remoteSdp: null }
          : { status: 'failed', endedAt: now(), errorCode: result.code, errorTitle: result.title },
      )
      .where(eq(waCalls.id, row.id))
      .returning();
    await writeAudit(db, {
      actorEmployeeId: actor.employeeId,
      action: 'whatsapp.call_answered',
      entity: row.leadId ? 'lead' : 'wa_call',
      entityId: row.leadId ?? row.id,
      ip: request.ip,
      metadata: { callId: row.id, outcome: result.ok ? 'accepted' : 'failed' },
    });
    return reply.send({ call: await toCall(saved!, actor.employeeId) });
  });

  /** Declines a ringing call (anyone in reach) or hangs up a live one (who is on it, or full scope). */
  for (const action of ['reject', 'hangup'] as const) {
    app.post(`/whatsapp/calls/:id/${action}`, use, async (request, reply) => {
      const params = idParams.safeParse(request.params);
      if (!params.success) return notFound(reply);
      const actor = request.session.actor;
      const row = await db.query.waCalls.findFirst({ where: eq(waCalls.id, params.data.id) });
      if (!row || !(await inReach(request, row))) return notFound(reply);
      if (row.endedAt) return reply.send({ call: await toCall(row, actor.employeeId) });
      const config = whatsappConfigOf(env);
      if (!config) return refuse(reply, 503, 'whatsapp_off', 'O WhatsApp oficial não está ligado.');
      const rejecting = action === 'reject' && row.direction === 'in' && row.status === 'ringing';
      if (row.callId)
        await whatsappCallAction(
          fetchImpl(),
          config,
          row.callId,
          rejecting ? 'reject' : 'terminate',
        );
      // Closed here at once; Meta's terminate webhook then brings the real duration.
      const at = now();
      const talked = row.status === 'accepted' && row.connectedAt !== null;
      const [saved] = await db
        .update(waCalls)
        .set({
          status: rejecting ? 'rejected' : talked ? 'completed' : 'missed',
          endedAt: at,
          remoteSdp: null,
          durationSeconds: talked
            ? Math.max(0, Math.round((at.getTime() - row.connectedAt!.getTime()) / 1000))
            : 0,
          employeeId: row.employeeId ?? actor.employeeId,
        })
        .where(and(eq(waCalls.id, row.id), isNull(waCalls.endedAt)))
        .returning();
      if (saved) notifyCallsChanged();
      return reply.send({ call: await toCall(saved ?? row, actor.employeeId) });
    });
  }
};
