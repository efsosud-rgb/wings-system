import { createHash, randomUUID } from 'node:crypto';
import {
  WINGS_CLIENT_ID,
  leadHidesWings,
  meetingCreateSchema,
  meetingListQuerySchema,
  meetingRecordingCompleteSchema,
  meetingSpeakersSchema,
  meetingUpdateSchema,
  meetingUploadUrlSchema,
  summarySendCreateSchema,
  summarySendApproveSchema,
  summarySendUpdateSchema,
  type MeetingSpeaker,
} from '@wings/shared';
import { and, desc, eq } from 'drizzle-orm';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { clientContacts, crmMeetings, jobs, leadEvents, leads } from '../../db/schema/index.js';
import { writeAudit } from '../../lib/audit.js';
import { leadInScope, leadOwnerFilter } from '../leads/access.js';
import { ZapiClient } from '../../lib/zapi.js';
import { googleWorkspaceDepsOf } from '../google-workspace/service.js';
import { createTask } from '../leads/crm.js';
import {
  cancelMeetingEvent,
  createMeetingEvent,
  MeetingGoogleError,
  mirrored,
  patchMeetingEvent,
  type GoogleSyncDeps,
} from './google-sync.js';
import {
  maskContact,
  meetingListFor,
  runMeetingAnalysis,
  runQueuedAnalyses,
  toMeeting,
  toMeetingSummary,
  toTranscript,
  type MeetingAnalysisDeps,
  type MeetingRow,
} from './service.js';

/**
 * Reuniões (docs/crm/reunioes-api.md). Seeing a meeting follows the deal's
 * `leads.read` scope (another seller's meeting is a 404 for an `own` seller);
 * changing it needs `leads.write`; the franchisor summary is approved and
 * sent only by `meetings.approve_send`. Creating on Google needs the person's
 * own connection (`/me/google`); until then the pasted link is the way, and
 * the screen is told so with a 503. Nothing personal reaches a log.
 */

const idParam = z.object({ id: z.uuid() });
const stepParam = z.object({ id: z.uuid(), index: z.coerce.number().int().min(0).max(20) });
const UPLOAD_SECONDS = 15 * 60;
const LISTEN_SECONDS = 5 * 60;

const EXTENSION: Record<string, string> = {
  'audio/webm': 'webm',
  'audio/ogg': 'ogg',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'audio/wav': 'wav',
  'video/webm': 'webm',
  'video/mp4': 'mp4',
};

const bad = (reply: FastifyReply, message = 'Dados inválidos') =>
  reply.status(400).send({ error: 'invalid_request', message });
const notFound = (reply: FastifyReply) =>
  reply.status(404).send({ error: 'not_found', message: 'Reunião não encontrada' });
const conflict = (reply: FastifyReply, error: string, message: string) =>
  reply.status(409).send({ error, message });
const googleOff = (reply: FastifyReply) =>
  reply.status(503).send({
    error: 'google_not_connected',
    message:
      'O Google Workspace ainda não foi autorizado: cole o link do Meet ou envie a gravação pela tela.',
  });
const googleFailed = (reply: FastifyReply, error: MeetingGoogleError) =>
  reply.status(error.status).send({ error: error.code, message: error.message });

export const meetingRoutes: FastifyPluginAsync = async (app) => {
  const { db, env } = app.wings;
  const now = () => app.wings.now?.() ?? new Date();
  const googleSync = (): GoogleSyncDeps => ({
    db,
    google: googleWorkspaceDepsOf(app.wings),
    wingsCalendarId: env.GOOGLE_WORKSPACE_WINGS_CALENDAR_ID ?? null,
    sleep:
      env.NODE_ENV === 'test'
        ? async () => {}
        : (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  });

  const analysisDeps = (): MeetingAnalysisDeps => ({
    db,
    llm: app.wings.agentLlm ?? null,
    model: env.AGENT_MODEL,
    dailyUsd: env.MEETINGS_DAILY_USD,
    now,
    log: app.log,
  });

  // The worker queues an analysis when a transcript is ready; the API owns the model,
  // so it picks them up here, a few a minute. Never in tests (they call the runner).
  if (env.NODE_ENV !== 'test') {
    const timer = setInterval(() => {
      void runQueuedAnalyses(analysisDeps()).catch(() =>
        app.log.warn({ msg: 'meeting analyses failed' }),
      );
    }, 60_000);
    timer.unref();
    app.addHook('onClose', async () => clearInterval(timer));
  }

  /** The deal, when this person may see it; null otherwise (answered as 404). */
  async function visibleLead(request: FastifyRequest, leadId: string) {
    const lead = await leadInScope(db, request.session.actor, leadId, 'leads.read');
    return lead
      ? {
          id: lead.id,
          ownerEmployeeId: lead.ownerEmployeeId,
          pipeline: lead.pipeline,
          brand: lead.brand,
          clientId: lead.clientId,
        }
      : null;
  }

  async function visibleMeeting(request: FastifyRequest, id: string) {
    const [row] = await db.select().from(crmMeetings).where(eq(crmMeetings.id, id));
    if (!row) return null;
    const lead = await visibleLead(request, row.leadId);
    return lead ? { row, lead } : null;
  }

  async function franchisorContact(clientId: string | null) {
    if (!clientId || clientId === WINGS_CLIENT_ID) return null;
    const [contact] = await db
      .select({
        email: clientContacts.email,
        whatsapp: clientContacts.whatsapp,
        name: clientContacts.name,
      })
      .from(clientContacts)
      .where(and(eq(clientContacts.clientId, clientId), eq(clientContacts.role, 'principal')));
    return contact ?? null;
  }

  async function answer(row: MeetingRow, clientId: string | null) {
    let to: string | null = null;
    if (row.sendState !== 'nenhum') {
      const contact = await franchisorContact(clientId);
      to = maskContact(
        row.sendChannel,
        row.sendChannel === 'whatsapp' ? (contact?.whatsapp ?? null) : (contact?.email ?? null),
      );
    }
    return toMeeting(row, to);
  }

  /** The stored recording's transcription failed, or its job was given up. */
  async function transcriptionFailed(row: MeetingRow): Promise<boolean> {
    if (row.transcriptState === 'falhou') return true;
    if (!row.transcriptJobId || row.transcriptState === 'pronta') return false;
    const [job] = await db
      .select({ state: jobs.state })
      .from(jobs)
      .where(eq(jobs.id, row.transcriptJobId));
    return job?.state === 'failed';
  }

  /** The address an approval was given for, kept as a hash only. */
  const destinationHash = (address: string) =>
    createHash('sha256').update(address.trim().toLowerCase()).digest('hex');

  const update = async (id: string, patch: Partial<typeof crmMeetings.$inferInsert>) => {
    const [row] = await db
      .update(crmMeetings)
      .set({ ...patch, updatedAt: now() })
      .where(eq(crmMeetings.id, id))
      .returning();
    return row!;
  };

  // --- agenda ------------------------------------------------------------------------------

  app.get(
    '/leads/:id/meetings',
    { preHandler: app.requirePermission('leads.read') },
    async (request, reply) => {
      const params = idParam.safeParse(request.params);
      if (!params.success) return bad(reply);
      if (!(await visibleLead(request, params.data.id))) return notFound(reply);
      const rows = await db
        .select()
        .from(crmMeetings)
        .where(eq(crmMeetings.leadId, params.data.id))
        .orderBy(desc(crmMeetings.startsAt));
      return reply.send({ meetings: rows.map(toMeetingSummary) });
    },
  );

  // Produtividade → Reuniões: a seller reads the meetings of their own deals, Admin every one.
  app.get(
    '/meetings',
    { preHandler: app.requirePermission('leads.read') },
    async (request, reply) => {
      const query = meetingListQuerySchema.safeParse(request.query);
      if (!query.success) return bad(reply);
      const owner = leadOwnerFilter(request.session.actor, 'leads.read');
      return reply.send({ meetings: await meetingListFor(db, owner, query.data.when, now()) });
    },
  );

  app.post(
    '/leads/:id/meetings',
    { preHandler: app.requirePermission('leads.write') },
    async (request, reply) => {
      const params = idParam.safeParse(request.params);
      const body = meetingCreateSchema.safeParse(request.body);
      if (!params.success) return bad(reply);
      if (!body.success) return bad(reply, body.error.issues[0]?.message);
      const lead = await visibleLead(request, params.data.id);
      if (!lead) return notFound(reply);
      const actor = request.session.actor.employeeId;
      const startsAt = new Date(body.data.startsAt);
      const endsAt = new Date(body.data.endsAt);
      let google: Awaited<ReturnType<typeof createMeetingEvent>> | null = null;
      const [contact] = await db
        .select({
          name: leads.name,
          email: leads.email,
          ownerEmployeeId: leads.ownerEmployeeId,
          pipeline: leads.pipeline,
          brand: leads.brand,
          companyName: leads.companyName,
        })
        .from(leads)
        .where(eq(leads.id, lead.id));
      const hidden = contact ? leadHidesWings(contact) : false;
      if (body.data.createMeet) {
        // The event, its Meet and the invitations, on the calendar chosen, as this person,
        // titled and coloured the way the team writes its calls.
        try {
          google = await createMeetingEvent(googleSync(), {
            startsAt,
            endsAt,
            calendar: body.data.calendar,
            attendees: body.data.attendees,
            lead: {
              name: contact?.name ?? null,
              email: contact?.email ?? null,
              pipeline: contact?.pipeline ?? null,
              brand: contact?.brand ?? null,
              companyName: contact?.companyName ?? null,
            },
            inviteLead: body.data.inviteLead,
            ownerEmployeeId: contact?.ownerEmployeeId ?? actor,
            actorEmployeeId: actor,
          });
        } catch (error) {
          if (error instanceof MeetingGoogleError) return googleFailed(reply, error);
          throw error;
        }
      }
      const [row] = await db
        .insert(crmMeetings)
        .values({
          leadId: lead.id,
          ownerEmployeeId: actor,
          title: google?.title ?? body.data.title,
          startsAt,
          endsAt,
          calendar: body.data.calendar,
          meetUrl: google?.meetUrl ?? body.data.meetUrl ?? null,
          attendees: google
            ? google.attendees
            : (hidden ? [] : body.data.attendees).map((a) => ({
                email: a.email,
                name: a.name ?? null,
                responseStatus: null,
              })),
          ...(google
            ? {
                googleEventId: google.eventId,
                googleCalendarId: google.calendarId,
                googleHtmlLink: google.htmlLink,
                googleSync: 'ok',
                googleSyncedAt: now(),
              }
            : {}),
          createdBy: actor,
        })
        .returning();
      await db.insert(leadEvents).values({
        leadId: lead.id,
        kind: 'meeting.scheduled',
        actorEmployeeId: actor,
        detail: {
          meetingId: row!.id,
          attendees: (google?.attendees ?? body.data.attendees).length,
          google: Boolean(google),
        },
      });
      await writeAudit(db, {
        actorEmployeeId: actor,
        action: 'meeting.created',
        entity: 'meeting',
        entityId: row!.id,
        ip: request.ip,
      });
      return reply.status(201).send({ meeting: await answer(row!, lead.clientId) });
    },
  );

  app.get(
    '/meetings/:id',
    { preHandler: app.requirePermission('leads.read') },
    async (request, reply) => {
      const params = idParam.safeParse(request.params);
      if (!params.success) return bad(reply);
      const found = await visibleMeeting(request, params.data.id);
      if (!found) return notFound(reply);
      return reply.send({ meeting: await answer(found.row, found.lead.clientId) });
    },
  );

  app.patch(
    '/meetings/:id',
    { preHandler: app.requirePermission('leads.write') },
    async (request, reply) => {
      const params = idParam.safeParse(request.params);
      const body = meetingUpdateSchema.safeParse(request.body);
      if (!params.success) return bad(reply);
      if (!body.success) return bad(reply, body.error.issues[0]?.message);
      const found = await visibleMeeting(request, params.data.id);
      if (!found) return notFound(reply);
      const { row } = found;
      if (row.status === 'encerrada' || row.status === 'cancelada') {
        return conflict(reply, 'meeting_closed', 'Esta reunião já foi encerrada ou cancelada.');
      }
      const startsAt = body.data.startsAt ? new Date(body.data.startsAt) : row.startsAt;
      const endsAt = body.data.endsAt ? new Date(body.data.endsAt) : row.endsAt;
      if (startsAt >= endsAt) return bad(reply, 'O fim vem depois do início');
      const actor = request.session.actor.employeeId;
      const cancelling = body.data.status === 'cancelada';
      // A deal that hides the Wings never gets outside guests, on Google or here.
      if (body.data.attendees && leadHidesWings(found.lead)) delete body.data.attendees;
      const moved =
        body.data.title !== undefined ||
        body.data.startsAt !== undefined ||
        body.data.endsAt !== undefined ||
        body.data.attendees !== undefined;
      let googleAttendees: typeof row.attendees | null = null;
      let googlePatch: Partial<typeof crmMeetings.$inferInsert> = {};
      if (mirrored(row) && (cancelling || moved)) {
        // Google first: guests must never hold a time or a cancellation the screen does not.
        const mirror = {
          googleEventId: row.googleEventId,
          googleCalendarId: row.googleCalendarId,
          calendar: row.calendar,
          createdBy: row.createdBy,
        };
        if (body.data.skipGoogle) {
          googlePatch = { googleSync: 'falhou', googleSyncError: 'skipped', googleSyncedAt: now() };
        } else {
          try {
            if (cancelling) {
              await cancelMeetingEvent(googleSync(), mirror, actor);
            } else {
              googleAttendees = await patchMeetingEvent(googleSync(), mirror, actor, {
                ...(body.data.title !== undefined ? { title: body.data.title } : {}),
                ...(body.data.startsAt !== undefined ? { startsAt } : {}),
                ...(body.data.endsAt !== undefined ? { endsAt } : {}),
                ...(body.data.attendees
                  ? {
                      attendees: body.data.attendees.map((a) => ({
                        email: a.email,
                        name: a.name ?? null,
                      })),
                    }
                  : {}),
              });
            }
            googlePatch = { googleSync: 'ok', googleSyncError: null, googleSyncedAt: now() };
          } catch (error) {
            if (error instanceof MeetingGoogleError) {
              await update(row.id, {
                googleSync: 'falhou',
                googleSyncError: error.code,
                googleSyncedAt: now(),
              });
              return googleFailed(reply, error);
            }
            throw error;
          }
        }
      }
      const updated = await update(row.id, {
        title: body.data.title ?? row.title,
        startsAt,
        endsAt,
        meetUrl: body.data.meetUrl === undefined ? row.meetUrl : body.data.meetUrl,
        status: body.data.status ?? row.status,
        ...(googleAttendees
          ? { attendees: googleAttendees }
          : body.data.attendees
            ? {
                attendees: body.data.attendees.map((a) => ({
                  email: a.email,
                  name: a.name ?? null,
                  responseStatus: null,
                })),
              }
            : {}),
        ...googlePatch,
      });
      await writeAudit(db, {
        actorEmployeeId: actor,
        action: cancelling ? 'meeting.cancelled' : 'meeting.updated',
        entity: 'meeting',
        entityId: row.id,
        ip: request.ip,
        metadata: {
          google: mirrored(row) ? (body.data.skipGoogle ? 'skipped' : 'mirrored') : 'none',
        },
      });
      return reply.send({ meeting: await answer(updated, found.lead.clientId) });
    },
  );

  // --- recording ---------------------------------------------------------------------------

  app.post(
    '/meetings/:id/recording/upload-url',
    { preHandler: app.requirePermission('leads.write') },
    async (request, reply) => {
      const params = idParam.safeParse(request.params);
      const body = meetingUploadUrlSchema.safeParse(request.body);
      if (!params.success) return bad(reply);
      if (!body.success) return bad(reply, 'Tipo ou tamanho de gravação não aceito');
      const storage = app.wings.storage;
      if (!storage) {
        return reply.status(503).send({
          error: 'storage_not_configured',
          message: 'O armazenamento não está configurado.',
        });
      }
      const found = await visibleMeeting(request, params.data.id);
      if (!found) return notFound(reply);
      // A new recording replaces one only when its transcription failed (the
      // screen then says "envie a gravação de novo") or its job was given up.
      const replacing = found.row.recordingState === 'guardada';
      if (replacing && !(await transcriptionFailed(found.row))) {
        return conflict(reply, 'recording_exists', 'Esta reunião já tem gravação.');
      }
      if (replacing && found.row.recordingKey) {
        await storage.delete(found.row.recordingKey).catch(() => {
          request.log.warn({ meetingId: found.row.id }, 'old meeting recording not deleted');
        });
      }
      const fileId = randomUUID();
      const key = `meetings/${found.row.id}/${fileId}.${EXTENSION[body.data.contentType] ?? 'bin'}`;
      const signed = await storage.presignPut(key, {
        contentType: body.data.contentType,
        contentLength: body.data.sizeBytes,
        expiresSeconds: UPLOAD_SECONDS,
      });
      await update(found.row.id, {
        recordingState: 'enviando',
        recordingKey: key,
        recordingFileId: fileId,
        recordingContentType: body.data.contentType,
        recordingSizeBytes: body.data.sizeBytes,
      });
      return reply.send({
        uploadUrl: signed.url,
        headers: signed.headers,
        fileId,
        expiresAt: new Date(now().getTime() + UPLOAD_SECONDS * 1000).toISOString(),
      });
    },
  );

  app.post(
    '/meetings/:id/recording/complete',
    { preHandler: app.requirePermission('leads.write') },
    async (request, reply) => {
      const params = idParam.safeParse(request.params);
      const body = meetingRecordingCompleteSchema.safeParse(request.body);
      if (!params.success || !body.success) return bad(reply);
      const storage = app.wings.storage;
      if (!storage) {
        return reply.status(503).send({
          error: 'storage_not_configured',
          message: 'O armazenamento não está configurado.',
        });
      }
      const found = await visibleMeeting(request, params.data.id);
      if (!found) return notFound(reply);
      const { row } = found;
      if (
        row.recordingState !== 'enviando' ||
        row.recordingFileId !== body.data.fileId ||
        !row.recordingKey
      ) {
        return conflict(reply, 'upload_unknown', 'Este envio não é o que foi combinado.');
      }
      const head = await storage.head(row.recordingKey);
      if (!head)
        return conflict(reply, 'upload_missing', 'A gravação ainda não chegou ao armazenamento.');
      if (head.size !== row.recordingSizeBytes) {
        return conflict(
          reply,
          'upload_size',
          'A gravação chegou com tamanho diferente do combinado.',
        );
      }
      // Claimed in one statement, so a retried or double "complete" queues one job only.
      const updated = await db.transaction(async (tx) => {
        const [claimed] = await tx
          .update(crmMeetings)
          .set({
            recordingState: 'guardada',
            transcriptState: 'na_fila',
            transcriptError: null,
            updatedAt: now(),
          })
          .where(
            and(
              eq(crmMeetings.id, row.id),
              eq(crmMeetings.recordingState, 'enviando'),
              eq(crmMeetings.recordingFileId, body.data.fileId),
            ),
          )
          .returning({ id: crmMeetings.id });
        if (!claimed) return null;
        const [job] = await tx
          .insert(jobs)
          .values({ type: 'transcribe_meeting', input: { meetingId: row.id } })
          .returning({ id: jobs.id });
        const [stored] = await tx
          .update(crmMeetings)
          .set({ transcriptJobId: job!.id })
          .where(eq(crmMeetings.id, row.id))
          .returning();
        return stored!;
      });
      if (!updated)
        return conflict(reply, 'upload_unknown', 'Este envio não é o que foi combinado.');
      await writeAudit(db, {
        actorEmployeeId: request.session.actor.employeeId,
        action: 'meeting.recording_stored',
        entity: 'meeting',
        entityId: row.id,
        ip: request.ip,
        metadata: { sizeBytes: head.size },
      });
      return reply.status(202).send({ meeting: await answer(updated, found.lead.clientId) });
    },
  );

  app.post(
    '/meetings/:id/recording/import',
    { preHandler: app.requirePermission('leads.write') },
    async (_request, reply) => googleOff(reply),
  );

  app.get(
    '/meetings/:id/recording/link',
    { preHandler: app.requirePermission('leads.read') },
    async (request, reply) => {
      const params = idParam.safeParse(request.params);
      if (!params.success) return bad(reply);
      const storage = app.wings.storage;
      const found = await visibleMeeting(request, params.data.id);
      if (!found) return notFound(reply);
      if (!storage) {
        return reply.status(503).send({
          error: 'storage_not_configured',
          message: 'O armazenamento não está configurado.',
        });
      }
      if (found.row.recordingState !== 'guardada' || !found.row.recordingKey) {
        return conflict(reply, 'no_recording', 'Esta reunião não tem gravação guardada.');
      }
      const url = await storage.presignGet(found.row.recordingKey, {
        expiresSeconds: LISTEN_SECONDS,
        disposition: 'inline',
        contentType: found.row.recordingContentType ?? undefined,
      });
      return reply.send({
        url,
        expiresAt: new Date(now().getTime() + LISTEN_SECONDS * 1000).toISOString(),
      });
    },
  );

  // --- transcript and speakers -------------------------------------------------------------

  app.get(
    '/meetings/:id/transcript',
    { preHandler: app.requirePermission('leads.read') },
    async (request, reply) => {
      const params = idParam.safeParse(request.params);
      if (!params.success) return bad(reply);
      const found = await visibleMeeting(request, params.data.id);
      if (!found) return notFound(reply);
      return reply.send({ transcript: toTranscript(found.row) });
    },
  );

  app.patch(
    '/meetings/:id/speakers',
    { preHandler: app.requirePermission('leads.write') },
    async (request, reply) => {
      const params = idParam.safeParse(request.params);
      const body = meetingSpeakersSchema.safeParse(request.body);
      if (!params.success) return bad(reply);
      if (!body.success) return bad(reply, 'Diga quem é cada voz (S1, S2…)');
      const found = await visibleMeeting(request, params.data.id);
      if (!found) return notFound(reply);
      const transcript = toTranscript(found.row);
      const known = new Set(transcript.segments.map((s) => s.speaker).filter(Boolean) as string[]);
      for (const key of Object.keys(body.data)) {
        if (!known.has(key))
          return conflict(reply, 'unknown_speaker', `A voz ${key} não está nesta transcrição.`);
      }
      const speakers: MeetingSpeaker[] = [...known].sort().map((key) => {
        const given = body.data[key];
        const before = transcript.speakers.find((s) => s.key === key);
        return {
          key,
          label: given?.label ?? before?.label ?? null,
          employeeId: given?.employeeId ?? before?.employeeId ?? null,
          attendeeEmail: given?.attendeeEmail ?? before?.attendeeEmail ?? null,
        };
      });
      const updated = await update(found.row.id, { speakers });
      return reply.send({ transcript: toTranscript(updated) });
    },
  );

  // --- AI analysis -------------------------------------------------------------------------

  app.post(
    '/meetings/:id/analysis',
    { preHandler: app.requirePermission('leads.write') },
    async (request, reply) => {
      const params = idParam.safeParse(request.params);
      if (!params.success) return bad(reply);
      const found = await visibleMeeting(request, params.data.id);
      if (!found) return notFound(reply);
      if (found.row.transcriptState !== 'pronta') {
        return conflict(reply, 'no_transcript', 'A análise precisa da transcrição pronta.');
      }
      if (found.row.analysisState === 'na_fila' || found.row.analysisState === 'analisando') {
        return conflict(reply, 'analysis_running', 'A análise já está em andamento.');
      }
      const queued = await update(found.row.id, { analysisState: 'na_fila', analysisReason: null });
      // Off the request: the model may take a while; the page polls the meeting.
      void runMeetingAnalysis(analysisDeps(), found.row.id).catch(() =>
        app.log.warn({ msg: 'meeting analysis failed' }),
      );
      return reply.status(202).send({ meeting: await answer(queued, found.lead.clientId) });
    },
  );

  app.post(
    '/meetings/:id/next-steps/:index/task',
    { preHandler: app.requirePermission('leads.write') },
    async (request, reply) => {
      const params = stepParam.safeParse(request.params);
      if (!params.success) return bad(reply);
      const found = await visibleMeeting(request, params.data.id);
      if (!found) return notFound(reply);
      type Steps = { nextSteps?: { what: string; dueAt: string | null; taskId: string | null }[] };
      // Read and written under the row's lock, so a double click makes one task.
      const outcome = await db.transaction(async (tx) => {
        const [row] = await tx
          .select({ analysis: crmMeetings.analysis, analysisState: crmMeetings.analysisState })
          .from(crmMeetings)
          .where(eq(crmMeetings.id, found.row.id))
          .for('update');
        const analysis = (row?.analysis ?? null) as Steps | null;
        const step = analysis?.nextSteps?.[params.data.index];
        if (row?.analysisState !== 'pronta' || !step) return 'not_found' as const;
        if (step.taskId) return 'task_exists' as const;
        // Noon in Rio of the day said, else of tomorrow; the seller edits it on the task.
        const day = step.dueAt ?? new Date(now().getTime() + 86_400_000).toISOString().slice(0, 10);
        const task = await createTask(tx as unknown as typeof db, {
          leadId: found.row.leadId,
          kind: 'follow_up',
          title: step.what.slice(0, 160),
          dueAt: new Date(`${day}T15:00:00Z`),
          assigneeEmployeeId: found.lead.ownerEmployeeId ?? request.session.actor.employeeId,
          createdBy: request.session.actor.employeeId,
        });
        const nextSteps = analysis!.nextSteps!.map((s, i) =>
          i === params.data.index ? { ...s, taskId: task.id } : s,
        );
        await tx
          .update(crmMeetings)
          .set({ analysis: { ...analysis, nextSteps }, updatedAt: now() })
          .where(eq(crmMeetings.id, found.row.id));
        return task;
      });
      if (outcome === 'not_found') return notFound(reply);
      if (outcome === 'task_exists')
        return conflict(reply, 'task_exists', 'Este próximo passo já virou tarefa.');
      return reply.status(201).send({ task: outcome });
    },
  );

  // --- Expansão: summary to the franchisor's owner, only after approval --------------------

  app.post(
    '/meetings/:id/summary-send',
    { preHandler: app.requirePermission('leads.write') },
    async (request, reply) => {
      const params = idParam.safeParse(request.params);
      const body = summarySendCreateSchema.safeParse(request.body ?? {});
      if (!params.success || !body.success) return bad(reply);
      const found = await visibleMeeting(request, params.data.id);
      if (!found) return notFound(reply);
      const { row, lead } = found;
      if (lead.pipeline !== 'expansao' || !lead.clientId || lead.clientId === WINGS_CLIENT_ID) {
        return conflict(
          reply,
          'not_expansion',
          'O envio ao franqueador é só para negociações de Expansão com marca.',
        );
      }
      if (row.analysisState !== 'pronta')
        return conflict(reply, 'no_analysis', 'O resumo precisa da análise pronta.');
      if (!['nenhum', 'recusado', 'falhou'].includes(row.sendState)) {
        return conflict(reply, 'send_exists', 'Já existe um envio deste resumo.');
      }
      const contact = await franchisorContact(lead.clientId);
      const address = body.data.channel === 'whatsapp' ? contact?.whatsapp : contact?.email;
      if (!contact || !address) {
        return conflict(
          reply,
          'no_franchisor_contact',
          'A ficha da marca não tem o contato principal com esse canal.',
        );
      }
      const analysis = (row.analysis ?? {}) as { summary?: string; nextSteps?: { what: string }[] };
      const steps = (analysis.nextSteps ?? []).map((s) => `• ${s.what}`).join('\n');
      const text = [
        `Olá, ${contact.name.split(' ')[0]}. Resumo da reunião com um candidato à sua franquia:`,
        analysis.summary ?? '—',
        steps ? `Próximos passos:\n${steps}` : '',
        'Wings Company',
      ]
        .filter(Boolean)
        .join('\n\n');
      const updated = await update(row.id, {
        sendState: 'rascunho',
        sendChannel: body.data.channel,
        sendContactRole: 'principal',
        sendText: text.slice(0, 4000),
        sendDestinationHash: null,
        sendApprovedBy: null,
        sendApprovedAt: null,
        sentAt: null,
        sendError: null,
      });
      return reply.status(201).send({ meeting: await answer(updated, lead.clientId) });
    },
  );

  app.patch(
    '/meetings/:id/summary-send',
    { preHandler: app.requirePermission('leads.write') },
    async (request, reply) => {
      const params = idParam.safeParse(request.params);
      const body = summarySendUpdateSchema.safeParse(request.body);
      if (!params.success) return bad(reply);
      if (!body.success) return bad(reply, 'O texto precisa de 20 a 4.000 caracteres');
      const found = await visibleMeeting(request, params.data.id);
      if (!found) return notFound(reply);
      // Only while still a draft, checked in the same statement as the write.
      const [updated] = await db
        .update(crmMeetings)
        .set({ sendText: body.data.text, updatedAt: now() })
        .where(and(eq(crmMeetings.id, found.row.id), eq(crmMeetings.sendState, 'rascunho')))
        .returning();
      if (!updated) return conflict(reply, 'not_draft', 'Só o rascunho pode ser editado.');
      return reply.send({ meeting: await answer(updated, found.lead.clientId) });
    },
  );

  app.post(
    '/meetings/:id/summary-send/approve',
    { preHandler: app.requirePermission('meetings.approve_send') },
    async (request, reply) => {
      const params = idParam.safeParse(request.params);
      const body = summarySendApproveSchema.safeParse(request.body ?? {});
      if (!params.success) return bad(reply);
      if (!body.success) return bad(reply, 'Aprovar exige o texto que foi lido');
      const found = await visibleMeeting(request, params.data.id);
      if (!found) return notFound(reply);
      if (found.row.sendState !== 'rascunho')
        return conflict(reply, 'not_draft', 'Só um rascunho pode ser aprovado.');
      // The approval is for this text and this address: the send refuses if either changed.
      const contact = await franchisorContact(found.lead.clientId);
      const address = found.row.sendChannel === 'whatsapp' ? contact?.whatsapp : contact?.email;
      if (!address) {
        return conflict(
          reply,
          'no_franchisor_contact',
          'A ficha da marca não tem o contato principal com esse canal.',
        );
      }
      const actor = request.session.actor.employeeId;
      const [updated] = await db
        .update(crmMeetings)
        .set({
          sendState: 'aprovado',
          sendApprovedBy: actor,
          sendApprovedAt: now(),
          sendDestinationHash: destinationHash(address),
          updatedAt: now(),
        })
        .where(
          and(
            eq(crmMeetings.id, found.row.id),
            eq(crmMeetings.sendState, 'rascunho'),
            eq(crmMeetings.sendText, body.data.text),
          ),
        )
        .returning();
      if (!updated) {
        return conflict(
          reply,
          'draft_changed',
          'O rascunho mudou depois de lido; leia de novo antes de aprovar.',
        );
      }
      await writeAudit(db, {
        actorEmployeeId: actor,
        action: 'meeting.summary_approved',
        entity: 'meeting',
        entityId: found.row.id,
        ip: request.ip,
      });
      return reply.send({ meeting: await answer(updated, found.lead.clientId) });
    },
  );

  app.post(
    '/meetings/:id/summary-send/refuse',
    { preHandler: app.requirePermission('meetings.approve_send') },
    async (request, reply) => {
      const params = idParam.safeParse(request.params);
      if (!params.success) return bad(reply);
      const found = await visibleMeeting(request, params.data.id);
      if (!found) return notFound(reply);
      if (!['rascunho', 'aprovado'].includes(found.row.sendState)) {
        return conflict(reply, 'not_pending', 'Não há envio esperando decisão.');
      }
      const updated = await update(found.row.id, { sendState: 'recusado' });
      await writeAudit(db, {
        actorEmployeeId: request.session.actor.employeeId,
        action: 'meeting.summary_refused',
        entity: 'meeting',
        entityId: found.row.id,
        ip: request.ip,
      });
      return reply.send({ meeting: await answer(updated, found.lead.clientId) });
    },
  );

  app.post(
    '/meetings/:id/summary-send/send',
    { preHandler: app.requirePermission('meetings.approve_send') },
    async (request, reply) => {
      const params = idParam.safeParse(request.params);
      if (!params.success) return bad(reply);
      const found = await visibleMeeting(request, params.data.id);
      if (!found) return notFound(reply);
      const { row, lead } = found;
      if (row.sendState !== 'aprovado' || !row.sendText) {
        return conflict(reply, 'not_approved', 'O resumo só sai depois de aprovado.');
      }
      const contact = await franchisorContact(lead.clientId);
      const address = row.sendChannel === 'whatsapp' ? contact?.whatsapp : contact?.email;
      if (!address || destinationHash(address) !== row.sendDestinationHash) {
        // The franchisor's contact changed since the approval: approve again.
        const reopened = await update(row.id, {
          sendState: 'rascunho',
          sendApprovedBy: null,
          sendApprovedAt: null,
          sendDestinationHash: null,
        });
        return reply.status(409).send({
          error: 'contact_changed',
          message: 'O contato da marca mudou depois da aprovação; aprove de novo.',
          meeting: await answer(reopened, lead.clientId),
        });
      }
      // Claim before the one attempt, so a double click never sends twice.
      const [claimed] = await db
        .update(crmMeetings)
        .set({ sendState: 'enviando', updatedAt: now() })
        .where(and(eq(crmMeetings.id, row.id), eq(crmMeetings.sendState, 'aprovado')))
        .returning({ id: crmMeetings.id });
      if (!claimed) return conflict(reply, 'not_approved', 'O resumo só sai depois de aprovado.');
      let error: string | null = null;
      try {
        if (row.sendChannel === 'whatsapp') {
          if (!env.ZAPI_INSTANCE_ID || !env.ZAPI_INSTANCE_TOKEN || !env.ZAPI_CLIENT_TOKEN) {
            throw new Error('zapi_off');
          }
          const zapi = new ZapiClient({
            instanceId: env.ZAPI_INSTANCE_ID,
            instanceToken: env.ZAPI_INSTANCE_TOKEN,
            clientToken: env.ZAPI_CLIENT_TOKEN,
          });
          await zapi.sendText(address, row.sendText);
        } else {
          if (!app.wings.mailer.enabled) throw new Error('smtp_off');
          await app.wings.mailer.send({
            to: address,
            subject: 'Resumo da reunião com um candidato à sua franquia',
            text: row.sendText,
            html: row.sendText
              .split('\n')
              .map((line) =>
                line.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
              )
              .join('<br>'),
          });
        }
      } catch (e) {
        const code = e instanceof Error ? e.message : 'failed';
        error =
          code === 'smtp_off'
            ? 'O e-mail não está configurado neste ambiente'
            : code === 'zapi_off'
              ? 'O WhatsApp da Wings não está configurado neste ambiente'
              : 'O envio falhou; nada foi repetido';
      }
      const updated = await update(
        row.id,
        error ? { sendState: 'falhou', sendError: error } : { sendState: 'enviado', sentAt: now() },
      );
      await writeAudit(db, {
        actorEmployeeId: request.session.actor.employeeId,
        action: error ? 'meeting.summary_send_failed' : 'meeting.summary_sent',
        entity: 'meeting',
        entityId: row.id,
        ip: request.ip,
        metadata: { channel: row.sendChannel },
      });
      return reply
        .status(error ? 502 : 200)
        .send({ meeting: await answer(updated, lead.clientId) });
    },
  );
};
