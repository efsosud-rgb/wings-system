import { randomUUID } from 'node:crypto';
import {
  WINGS_CLIENT_ID,
  grantedScope,
  meetingCreateSchema,
  meetingRecordingCompleteSchema,
  meetingSpeakersSchema,
  meetingUpdateSchema,
  meetingUploadUrlSchema,
  summarySendCreateSchema,
  summarySendUpdateSchema,
  type MeetingSpeaker,
} from '@wings/shared';
import { and, desc, eq } from 'drizzle-orm';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { clientContacts, crmMeetings, jobs, leadEvents, leads } from '../../db/schema/index.js';
import { writeAudit } from '../../lib/audit.js';
import { ZapiClient } from '../../lib/zapi.js';
import { createTask } from '../leads/crm.js';
import {
  maskContact,
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
 * sent only by `meetings.approve_send`. Google routes answer 503 until the
 * Workspace is authorised. Nothing personal reaches a log.
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

export const meetingRoutes: FastifyPluginAsync = async (app) => {
  const { db, env } = app.wings;
  const now = () => app.wings.now?.() ?? new Date();

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
    const [lead] = await db
      .select({
        id: leads.id,
        ownerEmployeeId: leads.ownerEmployeeId,
        pipeline: leads.pipeline,
        clientId: leads.clientId,
      })
      .from(leads)
      .where(eq(leads.id, leadId));
    if (!lead) return null;
    const own = grantedScope(request.session.actor, 'leads.read') === 'own';
    return own && lead.ownerEmployeeId !== request.session.actor.employeeId ? null : lead;
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
      // Creating the event (and its Meet) needs the Workspace authorisation (Thais).
      if (body.data.createMeet) return googleOff(reply);
      const actor = request.session.actor.employeeId;
      const [row] = await db
        .insert(crmMeetings)
        .values({
          leadId: lead.id,
          ownerEmployeeId: actor,
          title: body.data.title,
          startsAt: new Date(body.data.startsAt),
          endsAt: new Date(body.data.endsAt),
          calendar: body.data.calendar,
          meetUrl: body.data.meetUrl ?? null,
          attendees: body.data.attendees.map((a) => ({
            email: a.email,
            name: a.name ?? null,
            responseStatus: null,
          })),
          createdBy: actor,
        })
        .returning();
      await db.insert(leadEvents).values({
        leadId: lead.id,
        kind: 'meeting.scheduled',
        actorEmployeeId: actor,
        detail: { meetingId: row!.id, attendees: body.data.attendees.length },
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
      const updated = await update(row.id, {
        title: body.data.title ?? row.title,
        startsAt,
        endsAt,
        meetUrl: body.data.meetUrl === undefined ? row.meetUrl : body.data.meetUrl,
        status: body.data.status ?? row.status,
        ...(body.data.attendees
          ? {
              attendees: body.data.attendees.map((a) => ({
                email: a.email,
                name: a.name ?? null,
                responseStatus: null,
              })),
            }
          : {}),
      });
      await writeAudit(db, {
        actorEmployeeId: request.session.actor.employeeId,
        action: body.data.status === 'cancelada' ? 'meeting.cancelled' : 'meeting.updated',
        entity: 'meeting',
        entityId: row.id,
        ip: request.ip,
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
      if (found.row.recordingState === 'guardada') {
        return conflict(reply, 'recording_exists', 'Esta reunião já tem gravação.');
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
      const [job] = await db
        .insert(jobs)
        .values({ type: 'transcribe_meeting', input: { meetingId: row.id } })
        .returning({ id: jobs.id });
      const updated = await update(row.id, {
        recordingState: 'guardada',
        transcriptState: 'na_fila',
        transcriptJobId: job!.id,
        transcriptError: null,
      });
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
      if (!storage || found.row.recordingState !== 'guardada' || !found.row.recordingKey) {
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
      const analysis = (found.row.analysis ?? null) as {
        nextSteps?: { what: string; dueAt: string | null; taskId: string | null }[];
      } | null;
      const step = analysis?.nextSteps?.[params.data.index];
      if (found.row.analysisState !== 'pronta' || !step) return notFound(reply);
      if (step.taskId) return conflict(reply, 'task_exists', 'Este próximo passo já virou tarefa.');
      // Noon in Rio of the day said, else of tomorrow; the seller edits it on the task.
      const day = step.dueAt ?? new Date(now().getTime() + 86_400_000).toISOString().slice(0, 10);
      const task = await createTask(db, {
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
      await update(found.row.id, { analysis: { ...analysis, nextSteps } });
      return reply.status(201).send({ task });
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
      if (found.row.sendState !== 'rascunho')
        return conflict(reply, 'not_draft', 'Só o rascunho pode ser editado.');
      const updated = await update(found.row.id, { sendText: body.data.text });
      return reply.send({ meeting: await answer(updated, found.lead.clientId) });
    },
  );

  app.post(
    '/meetings/:id/summary-send/approve',
    { preHandler: app.requirePermission('meetings.approve_send') },
    async (request, reply) => {
      const params = idParam.safeParse(request.params);
      if (!params.success) return bad(reply);
      const found = await visibleMeeting(request, params.data.id);
      if (!found) return notFound(reply);
      if (found.row.sendState !== 'rascunho')
        return conflict(reply, 'not_draft', 'Só um rascunho pode ser aprovado.');
      const actor = request.session.actor.employeeId;
      const updated = await update(found.row.id, {
        sendState: 'aprovado',
        sendApprovedBy: actor,
        sendApprovedAt: now(),
      });
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
          if (!contact?.whatsapp) throw new Error('no_whatsapp');
          if (!env.ZAPI_INSTANCE_ID || !env.ZAPI_INSTANCE_TOKEN || !env.ZAPI_CLIENT_TOKEN) {
            throw new Error('zapi_off');
          }
          const zapi = new ZapiClient({
            instanceId: env.ZAPI_INSTANCE_ID,
            instanceToken: env.ZAPI_INSTANCE_TOKEN,
            clientToken: env.ZAPI_CLIENT_TOKEN,
          });
          await zapi.sendText(contact.whatsapp, row.sendText);
        } else {
          if (!contact?.email) throw new Error('no_email');
          if (!app.wings.mailer.enabled) throw new Error('smtp_off');
          await app.wings.mailer.send({
            to: contact.email,
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

  // --- Google Workspace (after Thais authorises the app) ------------------------------------

  app.get(
    '/integrations/google-workspace',
    { preHandler: app.requireAuth },
    async (_request, reply) =>
      reply.send({
        connected: false,
        reason:
          'A autorização do Google Workspace ainda não foi dada (administradora do Workspace).',
        scopes: [],
        calendars: { wings: null, mine: null },
      }),
  );

  app.get('/me/google/connect', { preHandler: app.requireAuth }, async (_request, reply) =>
    googleOff(reply),
  );
};
