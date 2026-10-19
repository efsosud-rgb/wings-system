import { SESSION_COOKIE, type Meeting, type RoleKey } from '@wings/shared';
import { and, eq, like } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../app.js';
import type { Database } from '../../db/client.js';
import {
  clientContacts,
  crmMeetingAnalysisRuns,
  clients,
  crmMeetings,
  jobs,
  leadEvents,
  leadTasks,
  leads,
} from '../../db/schema/index.js';
import { loadEnv } from '../../env.js';
import type { Mail } from '../../lib/mailer.js';
import type { ObjectStorage } from '../../lib/storage/index.js';
import { createTestDatabase, type TestDatabase } from '../../test/db.js';
import { createEmployee, TEST_CPF_KEY, TEST_INDEX_KEY } from '../../test/factories.js';
import type { AgentLlm } from '../agent/llm.js';

let harness: TestDatabase;
let db: Database;
let app: FastifyInstance;
const NOW = new Date('2026-10-06T15:00:00Z');
const stored = new Map<string, number>();
const sent: Mail[] = [];
const llmCost = 0.01;

const storage = {
  kind: 'local',
  presignPut: async (key: string) => ({
    url: `https://storage.test/put/${key.length}`,
    headers: { 'content-type': 'audio/webm' },
  }),
  presignGet: async () => 'https://storage.test/get',
  head: async (key: string) => (stored.has(key) ? { size: stored.get(key)!, etag: null } : null),
  put: async () => {},
  get: async () => null,
  delete: async () => {},
} as unknown as ObjectStorage;

const llm: AgentLlm = {
  complete: async () => ({
    text: '',
    finishReason: 'tool_calls',
    usage: { inputTokens: 1000, outputTokens: 200, costUsd: llmCost },
    toolCalls: [
      {
        id: 't1',
        name: 'registrar_analise',
        arguments: JSON.stringify({
          summary: 'Conversa sobre abrir uma unidade em três meses.',
          topics: ['Prazo', 'Capital'],
          participants: [{ speaker: null, role: 'cliente', suggestedName: null }],
          nextSteps: [{ what: 'Enviar proposta', owner: 'vendedor', dueAt: '2026-10-09' }],
          leadEvaluation: {
            score: 70,
            fit: 'bom',
            reasons: ['Tem capital'],
            risks: ['Sócio ausente'],
          },
        }),
      },
    ],
  }),
};

beforeAll(async () => {
  harness = await createTestDatabase();
  db = harness.db;
  app = await buildApp({
    env: loadEnv({
      NODE_ENV: 'test',
      DATABASE_URL: harness.url,
      SESSION_SECRET: 'x'.repeat(48),
      CPF_ENCRYPTION_KEY: TEST_CPF_KEY,
      CPF_INDEX_KEY: TEST_INDEX_KEY,
      APP_BASE_URL: 'http://localhost:5173',
      MEETINGS_DAILY_USD: '0.05',
    }),
    db,
    now: () => NOW,
    storage,
    agentLlm: llm,
    mailer: { enabled: true, send: async (mail) => void sent.push(mail) },
  });
}, 60_000);

afterAll(async () => {
  await app?.close();
  await harness?.drop();
});

async function sessionFor(role: RoleKey) {
  const employee = await createEmployee(db, {
    role,
    sector: role === 'diretoria' ? 'diretoria' : 'comercial',
  });
  const login = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { email: employee.email, password: employee.password },
  });
  const token = login.cookies.find((c) => c.name === SESSION_COOKIE)?.value;
  if (!token) throw new Error('login failed');
  return { id: employee.id, cookies: { [SESSION_COOKIE]: token } };
}

async function deal(ownerId: string, pipeline = 'formatacao', clientId?: string) {
  const [row] = await db
    .insert(leads)
    .values({
      source: 'manual',
      name: 'Candidato Exemplo',
      ownerEmployeeId: ownerId,
      pipeline,
      stage: 'Diagnóstico',
      ...(clientId ? { clientId } : {}),
    })
    .returning({ id: leads.id });
  return row!.id;
}

const slot = {
  title: 'Diagnóstico',
  startsAt: '2026-10-08T14:00:00-03:00',
  endsAt: '2026-10-08T15:00:00-03:00',
};

async function schedule(cookies: Record<string, string>, leadId: string) {
  const response = await app.inject({
    method: 'POST',
    url: `/leads/${leadId}/meetings`,
    cookies,
    payload: {
      ...slot,
      meetUrl: 'https://meet.google.com/abc-defg-hij',
      attendees: [{ email: 'candidato@exemplo.com.br' }],
    },
  });
  expect(response.statusCode).toBe(201);
  return response.json<{ meeting: Meeting }>().meeting;
}

describe('Reuniões', () => {
  it('schedules with a pasted Meet link, and answers 503 for a Google-made Meet while unconfigured', async () => {
    const seller = await sessionFor('vendedor_formatacao');
    const leadId = await deal(seller.id);
    const google = await app.inject({
      method: 'POST',
      url: `/leads/${leadId}/meetings`,
      cookies: seller.cookies,
      payload: { ...slot, createMeet: true },
    });
    expect(google.statusCode).toBe(503);
    expect(google.json()).toMatchObject({ error: 'google_not_configured' });

    const meeting = await schedule(seller.cookies, leadId);
    expect(meeting).toMatchObject({
      status: 'agendada',
      recordingState: 'nenhuma',
      calendar: 'vendedor',
      summarySend: null,
    });
    const list = await app.inject({
      method: 'GET',
      url: `/leads/${leadId}/meetings`,
      cookies: seller.cookies,
    });
    expect(list.json().meetings).toHaveLength(1);
  });

  it("hides another seller's meeting from an own-scope seller", async () => {
    const owner = await sessionFor('vendedor_formatacao');
    const other = await sessionFor('vendedor_formatacao');
    const meeting = await schedule(owner.cookies, await deal(owner.id));
    const response = await app.inject({
      method: 'GET',
      url: `/meetings/${meeting.id}`,
      cookies: other.cookies,
    });
    expect(response.statusCode).toBe(404);
  });

  it('takes a recording of the agreed size, queues the transcript, and never shows the storage key', async () => {
    const seller = await sessionFor('vendedor_formatacao');
    const meeting = await schedule(seller.cookies, await deal(seller.id));
    const ticket = await app.inject({
      method: 'POST',
      url: `/meetings/${meeting.id}/recording/upload-url`,
      cookies: seller.cookies,
      payload: { contentType: 'audio/webm', sizeBytes: 1234 },
    });
    expect(ticket.statusCode).toBe(200);
    expect(ticket.body).not.toContain('meetings/');
    const { fileId } = ticket.json<{ fileId: string }>();

    const early = await app.inject({
      method: 'POST',
      url: `/meetings/${meeting.id}/recording/complete`,
      cookies: seller.cookies,
      payload: { fileId },
    });
    expect(early.json()).toMatchObject({ error: 'upload_missing' });

    const [row] = await db.select().from(crmMeetings).where(eq(crmMeetings.id, meeting.id));
    stored.set(row!.recordingKey!, 999);
    const wrong = await app.inject({
      method: 'POST',
      url: `/meetings/${meeting.id}/recording/complete`,
      cookies: seller.cookies,
      payload: { fileId },
    });
    expect(wrong.json()).toMatchObject({ error: 'upload_size' });

    stored.set(row!.recordingKey!, 1234);
    const done = await app.inject({
      method: 'POST',
      url: `/meetings/${meeting.id}/recording/complete`,
      cookies: seller.cookies,
      payload: { fileId },
    });
    expect(done.statusCode).toBe(202);
    expect(done.json().meeting).toMatchObject({
      recordingState: 'guardada',
      transcriptState: 'na_fila',
    });
    const repeated = await app.inject({
      method: 'POST',
      url: `/meetings/${meeting.id}/recording/complete`,
      cookies: seller.cookies,
      payload: { fileId },
    });
    expect(repeated.statusCode).toBe(409);
    const queued = await db.select().from(jobs).where(eq(jobs.type, 'transcribe_meeting'));
    expect(
      queued.filter((j) => (j.input as { meetingId?: string }).meetingId === meeting.id),
    ).toHaveLength(1);

    // A stored recording is replaced only after its transcription failed.
    const exists = await app.inject({
      method: 'POST',
      url: `/meetings/${meeting.id}/recording/upload-url`,
      cookies: seller.cookies,
      payload: { contentType: 'audio/webm', sizeBytes: 2000 },
    });
    expect(exists.json()).toMatchObject({ error: 'recording_exists' });
    await db
      .update(crmMeetings)
      .set({ transcriptState: 'falhou' })
      .where(eq(crmMeetings.id, meeting.id));
    const again = await app.inject({
      method: 'POST',
      url: `/meetings/${meeting.id}/recording/upload-url`,
      cookies: seller.cookies,
      payload: { contentType: 'audio/webm', sizeBytes: 2000 },
    });
    expect(again.statusCode).toBe(200);
  });

  it('analyses a ready transcript, turns a next step into a task on a click, and stops at the daily ceiling', async () => {
    const seller = await sessionFor('vendedor_formatacao');
    const leadId = await deal(seller.id);
    const meeting = await schedule(seller.cookies, leadId);
    const early = await app.inject({
      method: 'POST',
      url: `/meetings/${meeting.id}/analysis`,
      cookies: seller.cookies,
    });
    expect(early.json()).toMatchObject({ error: 'no_transcript' });

    await db
      .update(crmMeetings)
      .set({
        transcriptState: 'pronta',
        transcript: {
          language: 'pt',
          durationSeconds: 60,
          segments: [{ start: 0, end: 5, speaker: null, text: 'Quero abrir em três meses.' }],
        },
      })
      .where(eq(crmMeetings.id, meeting.id));
    const run = await app.inject({
      method: 'POST',
      url: `/meetings/${meeting.id}/analysis`,
      cookies: seller.cookies,
    });
    expect(run.statusCode).toBe(202);
    let analysed: Meeting | undefined;
    for (let i = 0; i < 40 && analysed?.analysisState !== 'pronta'; i++) {
      await new Promise((r) => setTimeout(r, 50));
      analysed = (
        await app.inject({ method: 'GET', url: `/meetings/${meeting.id}`, cookies: seller.cookies })
      ).json().meeting;
    }
    expect(analysed?.analysis).toMatchObject({
      state: 'pronta',
      topics: ['Prazo', 'Capital'],
      leadEvaluation: { score: 70 },
    });

    const task = await app.inject({
      method: 'POST',
      url: `/meetings/${meeting.id}/next-steps/0/task`,
      cookies: seller.cookies,
    });
    expect(task.statusCode).toBe(201);
    const [made] = await db.select().from(leadTasks).where(eq(leadTasks.leadId, leadId));
    expect(made).toMatchObject({ title: 'Enviar proposta', kind: 'follow_up' });
    const again = await app.inject({
      method: 'POST',
      url: `/meetings/${meeting.id}/next-steps/0/task`,
      cookies: seller.cookies,
    });
    expect(again.json()).toMatchObject({ error: 'task_exists' });

    // Ceiling 0.05 USD: each call reserves up to the ceiling under a lock before it is made,
    // so with 0.01 spent today a second run (a re-analysis counts) never calls the model.
    await db
      .update(crmMeetings)
      .set({ analysisState: 'falhou' })
      .where(eq(crmMeetings.id, meeting.id));
    await app.inject({
      method: 'POST',
      url: `/meetings/${meeting.id}/analysis`,
      cookies: seller.cookies,
    });
    let capped: Meeting | undefined;
    for (let i = 0; i < 40 && capped?.analysisState !== 'sem_verba'; i++) {
      await new Promise((r) => setTimeout(r, 50));
      capped = (
        await app.inject({ method: 'GET', url: `/meetings/${meeting.id}`, cookies: seller.cookies })
      ).json().meeting;
    }
    expect(capped?.analysisState).toBe('sem_verba');
    const runs = await db
      .select()
      .from(crmMeetingAnalysisRuns)
      .where(eq(crmMeetingAnalysisRuns.meetingId, meeting.id));
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ reservedMicroUsd: 50_000, costMicroUsd: 10_000 });
  });

  it('sends the Expansão summary to the franchisor only after approval, once', async () => {
    const seller = await sessionFor('vendedor_expansao');
    const manager = await sessionFor('gerente_comercial');
    const [brand] = await db
      .insert(clients)
      .values({ name: 'Marca Exemplo', slug: 'marca-exemplo' })
      .returning({ id: clients.id });
    await db.insert(clientContacts).values({
      clientId: brand!.id,
      role: 'principal',
      name: 'Dona Exemplo',
      email: 'dona@marca-exemplo.com.br',
    });
    const leadId = await deal(seller.id, 'expansao', brand!.id);
    const meeting = await schedule(seller.cookies, leadId);
    await db
      .update(crmMeetings)
      .set({
        transcriptState: 'pronta',
        analysisState: 'pronta',
        analysis: {
          summary: 'Candidato com capital.',
          nextSteps: [{ what: 'Visitar unidade', owner: 'cliente', dueAt: null, taskId: null }],
        },
      })
      .where(eq(crmMeetings.id, meeting.id));

    const draft = await app.inject({
      method: 'POST',
      url: `/meetings/${meeting.id}/summary-send`,
      cookies: seller.cookies,
      payload: { channel: 'email' },
    });
    expect(draft.statusCode).toBe(201);
    expect(draft.json().meeting.summarySend).toMatchObject({
      state: 'rascunho',
      to: 'd•••@marca-exemplo.com.br',
    });
    expect(draft.json().meeting.summarySend.text).toContain('Dona');

    const notYet = await app.inject({
      method: 'POST',
      url: `/meetings/${meeting.id}/summary-send/send`,
      cookies: manager.cookies,
    });
    expect(notYet.json()).toMatchObject({ error: 'not_approved' });
    const sellerApproves = await app.inject({
      method: 'POST',
      url: `/meetings/${meeting.id}/summary-send/approve`,
      cookies: seller.cookies,
    });
    expect(sellerApproves.statusCode).toBe(403);

    const text = draft.json().meeting.summarySend.text as string;
    const unread = await app.inject({
      method: 'POST',
      url: `/meetings/${meeting.id}/summary-send/approve`,
      cookies: manager.cookies,
      payload: { text: `${text} (outra versão)` },
    });
    expect(unread.json()).toMatchObject({ error: 'draft_changed' });
    const approve = () =>
      app.inject({
        method: 'POST',
        url: `/meetings/${meeting.id}/summary-send/approve`,
        cookies: manager.cookies,
        payload: { text },
      });
    expect((await approve()).statusCode).toBe(200);

    // The franchisor's contact changes after the approval: nothing goes out, approve again.
    await db
      .update(clientContacts)
      .set({ email: 'outra@marca-exemplo.com.br' })
      .where(eq(clientContacts.clientId, brand!.id));
    const moved = await app.inject({
      method: 'POST',
      url: `/meetings/${meeting.id}/summary-send/send`,
      cookies: manager.cookies,
    });
    expect(moved.statusCode).toBe(409);
    expect(moved.json()).toMatchObject({ error: 'contact_changed' });
    expect(moved.json().meeting.summarySend.state).toBe('rascunho');
    expect(sent.filter((m) => m.to.includes('marca-exemplo'))).toHaveLength(0);
    await db
      .update(clientContacts)
      .set({ email: 'dona@marca-exemplo.com.br' })
      .where(eq(clientContacts.clientId, brand!.id));
    expect((await approve()).statusCode).toBe(200);
    const send = await app.inject({
      method: 'POST',
      url: `/meetings/${meeting.id}/summary-send/send`,
      cookies: manager.cookies,
    });
    expect(send.statusCode).toBe(200);
    expect(send.json().meeting.summarySend).toMatchObject({
      state: 'enviado',
      approvedBy: manager.id,
    });
    expect(sent.filter((m) => m.to === 'dona@marca-exemplo.com.br')).toHaveLength(1);
    const twice = await app.inject({
      method: 'POST',
      url: `/meetings/${meeting.id}/summary-send/send`,
      cookies: manager.cookies,
    });
    expect(twice.statusCode).toBe(409);
    expect(sent.filter((m) => m.to === 'dona@marca-exemplo.com.br')).toHaveLength(1);
  });

  it('refuses the franchisor summary outside Expansão', async () => {
    const seller = await sessionFor('vendedor_formatacao');
    const meeting = await schedule(seller.cookies, await deal(seller.id));
    await db
      .update(crmMeetings)
      .set({ analysisState: 'pronta', analysis: { summary: 'x' } })
      .where(eq(crmMeetings.id, meeting.id));
    const response = await app.inject({
      method: 'POST',
      url: `/meetings/${meeting.id}/summary-send`,
      cookies: seller.cookies,
      payload: {},
    });
    expect(response.json()).toMatchObject({ error: 'not_expansion' });
  });
});

describe('Histórico da ficha', () => {
  const meetingEvents = (leadId: string) =>
    db
      .select()
      .from(leadEvents)
      .where(and(eq(leadEvents.leadId, leadId), like(leadEvents.kind, 'meeting.%')));
  const patch = (cookies: Record<string, string>, id: string, payload: Record<string, unknown>) =>
    app.inject({ method: 'PATCH', url: `/meetings/${id}`, cookies, payload });

  it('records when the meeting was set for', async () => {
    const seller = await sessionFor('vendedor_formatacao');
    const leadId = await deal(seller.id);
    await schedule(seller.cookies, leadId);
    const events = await meetingEvents(leadId);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: 'meeting.scheduled',
      detail: { startsAt: '2026-10-08T17:00:00.000Z', attendees: 1, google: false },
    });
  });

  it('records a new time as meeting.rescheduled with the old and the new start', async () => {
    const seller = await sessionFor('vendedor_formatacao');
    const leadId = await deal(seller.id);
    const meeting = await schedule(seller.cookies, leadId);
    const response = await patch(seller.cookies, meeting.id, {
      startsAt: '2026-10-09T10:00:00-03:00',
      endsAt: '2026-10-09T11:00:00-03:00',
    });
    expect(response.statusCode).toBe(200);
    const moved = (await meetingEvents(leadId)).filter((e) => e.kind === 'meeting.rescheduled');
    expect(moved).toHaveLength(1);
    expect(moved[0]).toMatchObject({
      actorEmployeeId: seller.id,
      at: NOW,
      detail: {
        meetingId: meeting.id,
        from: '2026-10-08T17:00:00.000Z',
        to: '2026-10-09T13:00:00.000Z',
      },
    });
  });

  it('records a cancellation as meeting.cancelled, and a cancel wins over a new time', async () => {
    const seller = await sessionFor('vendedor_formatacao');
    const leadId = await deal(seller.id);
    const meeting = await schedule(seller.cookies, leadId);
    const response = await patch(seller.cookies, meeting.id, {
      status: 'cancelada',
      startsAt: '2026-10-09T10:00:00-03:00',
      endsAt: '2026-10-09T11:00:00-03:00',
    });
    expect(response.statusCode).toBe(200);
    const kinds = (await meetingEvents(leadId)).map((e) => e.kind).sort();
    expect(kinds).toEqual(['meeting.cancelled', 'meeting.scheduled']);
    const [cancelled] = (await meetingEvents(leadId)).filter((e) => e.kind === 'meeting.cancelled');
    expect(cancelled?.detail).toEqual({ meetingId: meeting.id });
  });

  it('writes nothing for a change of title, link or guests alone', async () => {
    const seller = await sessionFor('vendedor_formatacao');
    const leadId = await deal(seller.id);
    const meeting = await schedule(seller.cookies, leadId);
    const response = await patch(seller.cookies, meeting.id, {
      title: 'Diagnóstico remarcado',
      meetUrl: 'https://meet.google.com/xyz-abcd-efg',
      attendees: [{ email: 'outra.pessoa@exemplo.com.br' }],
    });
    expect(response.statusCode).toBe(200);
    expect((await meetingEvents(leadId)).map((e) => e.kind)).toEqual(['meeting.scheduled']);
    // The same time sent again is not a new time either.
    const same = await patch(seller.cookies, meeting.id, {
      startsAt: slot.startsAt,
      endsAt: slot.endsAt,
    });
    expect(same.statusCode).toBe(200);
    expect((await meetingEvents(leadId)).map((e) => e.kind)).toEqual(['meeting.scheduled']);
  });
});
