import { randomBytes } from 'node:crypto';
import { SESSION_COOKIE, type GoogleWorkspaceStatus, type Meeting, type RoleKey } from '@wings/shared';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../app.js';
import type { Database } from '../../db/client.js';
import { googleWorkspaceConnections, leads } from '../../db/schema/index.js';
import { loadEnv } from '../../env.js';
import { createTestDatabase, type TestDatabase } from '../../test/db.js';
import { createEmployee, TEST_CPF_KEY, TEST_INDEX_KEY } from '../../test/factories.js';
import { fakeGoogle } from './fake-google.js';

let harness: TestDatabase;
let db: Database;
let app: FastifyInstance;
const NOW = new Date('2026-10-07T15:00:00Z');
const WINGS_CALENDAR = 'wings-company@group.calendar.google.com';

const google = fakeGoogle({
  calendars: [
    { id: 'vendedor@wingscompany.com.br', summary: 'Vendedor', primary: true, accessRole: 'owner' },
    { id: WINGS_CALENDAR, summary: 'Wings Company', accessRole: 'writer' },
  ],
  meetPendingReads: 1,
});

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
      APP_BASE_URL: 'https://staging.wingssystem.online',
      INTEGRATIONS_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
      GOOGLE_WORKSPACE_CLIENT_ID: 'client-id.apps.googleusercontent.com',
      GOOGLE_WORKSPACE_CLIENT_SECRET: 'client-secret',
      GOOGLE_WORKSPACE_WINGS_CALENDAR_ID: WINGS_CALENDAR,
    }),
    db,
    now: () => NOW,
    googleFetch: google.transport,
    mailer: { enabled: true, send: async () => {} },
  });
}, 60_000);

afterAll(async () => {
  await app?.close();
  await harness?.drop();
});

beforeEach(() => google.reset());

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
  return { id: employee.id, email: employee.email, cookies: { [SESSION_COOKIE]: token } };
}

/** Connect → consent → callback, as the browser would. */
async function connect(cookies: Record<string, string>) {
  const start = await app.inject({ method: 'POST', url: '/me/google/connect', cookies });
  expect(start.statusCode).toBe(200);
  const url = new URL(start.json<{ url: string }>().url);
  expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
  expect(url.searchParams.get('redirect_uri')).toBe(
    'https://staging.wingssystem.online/api/me/google/callback',
  );
  expect(url.searchParams.get('scope')).toContain('calendar.events');
  expect(url.searchParams.get('access_type')).toBe('offline');
  const callback = await app.inject({
    method: 'GET',
    url: `/me/google/callback?code=auth-code&state=${url.searchParams.get('state')}`,
    cookies,
  });
  expect(callback.statusCode).toBe(302);
  expect(callback.headers.location).toBe('/minha-conta?google=ok');
}

async function status(cookies: Record<string, string>) {
  const response = await app.inject({ method: 'GET', url: '/me/google', cookies });
  expect(response.statusCode).toBe(200);
  return response.json<{ status: GoogleWorkspaceStatus }>().status;
}

async function deal(ownerId: string, email: string | null = 'candidato@exemplo.com.br') {
  const [row] = await db
    .insert(leads)
    .values({
      source: 'manual',
      name: 'Candidato Exemplo',
      email,
      ownerEmployeeId: ownerId,
      pipeline: 'formatacao',
      stage: 'Diagnóstico',
    })
    .returning({ id: leads.id });
  return row!.id;
}

const slot = {
  title: 'Diagnóstico',
  startsAt: '2026-10-08T14:00:00-03:00',
  endsAt: '2026-10-08T15:00:00-03:00',
};

const guestsOf = (body: unknown) =>
  ((body as { attendees?: Array<{ email: string }> }).attendees ?? []).map((a) => a.email).sort();

describe('Google Workspace por pessoa', () => {
  it('connects, reports the calendars, and disconnects', async () => {
    const seller = await sessionFor('vendedor_formatacao');
    expect(await status(seller.cookies)).toMatchObject({
      configured: true,
      state: 'disconnected',
      wingsCalendarConfigured: true,
    });

    await connect(seller.cookies);
    const connected = await status(seller.cookies);
    expect(connected).toMatchObject({
      state: 'connected',
      email: 'vendedor@wingscompany.com.br',
      calendars: {
        mine: { id: 'primary' },
        wings: { id: WINGS_CALENDAR, name: 'Wings Company', access: 'writer' },
      },
    });
    // Tokens are stored sealed, never in clear.
    const [row] = await db
      .select()
      .from(googleWorkspaceConnections)
      .where(eq(googleWorkspaceConnections.employeeId, seller.id));
    expect(row!.refreshTokenEnc).not.toContain('refresh-1');
    expect(row!.accessTokenEnc).not.toContain('access-');
    expect(row!.pending).toBeNull();

    const off = await app.inject({ method: 'DELETE', url: '/me/google', cookies: seller.cookies });
    expect(off.statusCode).toBe(200);
    expect(off.json<{ status: GoogleWorkspaceStatus }>().status.state).toBe('disconnected');
    expect(google.calls.some((c) => c.url.startsWith('https://oauth2.googleapis.com/revoke'))).toBe(true);
  });

  it('refuses a callback whose state is not the one this person started', async () => {
    const seller = await sessionFor('vendedor_formatacao');
    await app.inject({ method: 'POST', url: '/me/google/connect', cookies: seller.cookies });
    const callback = await app.inject({
      method: 'GET',
      url: '/me/google/callback?code=auth-code&state=forged',
      cookies: seller.cookies,
    });
    expect(callback.statusCode).toBe(302);
    expect(callback.headers.location).toBe('/minha-conta?google=erro&motivo=state_mismatch');
    expect(google.calls.filter((c) => c.url.includes('/token'))).toHaveLength(0);
    expect((await status(seller.cookies)).state).toBe('disconnected');
  });

  it('schedules on Google with a Meet and invitations to the lead and the owner, then mirrors a move and a cancel', async () => {
    const seller = await sessionFor('vendedor_formatacao');
    await connect(seller.cookies);
    const leadId = await deal(seller.id);

    const created = await app.inject({
      method: 'POST',
      url: `/leads/${leadId}/meetings`,
      cookies: seller.cookies,
      payload: { ...slot, createMeet: true, attendees: [{ email: 'socio@exemplo.com.br' }] },
    });
    expect(created.statusCode).toBe(201);
    const meeting = created.json<{ meeting: Meeting }>().meeting;
    expect(meeting).toMatchObject({
      meetUrl: 'https://meet.google.com/evt1',
      googleEventId: 'evt1',
      googleHtmlLink: 'https://calendar.google.com/event?eid=evt1',
      googleSync: { state: 'ok', error: null },
      calendar: 'vendedor',
    });
    const insert = google.calls.find((c) => c.method === 'POST' && c.url.includes('/events'));
    expect(insert!.url).toContain('/calendars/primary/events');
    expect(insert!.url).toContain('conferenceDataVersion=1');
    expect(insert!.url).toContain('sendUpdates=all');
    expect(guestsOf(insert!.body)).toEqual(
      ['socio@exemplo.com.br', 'candidato@exemplo.com.br', seller.email.toLowerCase()].sort(),
    );
    expect((insert!.body as { conferenceData: unknown }).conferenceData).toMatchObject({
      createRequest: { conferenceSolutionKey: { type: 'hangoutsMeet' } },
    });
    // The Meet was still pending on the insert: one re-read fetched it.
    expect(google.calls.filter((c) => c.method === 'GET' && c.url.includes('/events/evt1'))).toHaveLength(1);
    expect(meeting.attendees.map((a) => a.responseStatus)).toEqual([
      'sem_resposta',
      'sem_resposta',
      'sem_resposta',
    ]);

    const moved = await app.inject({
      method: 'PATCH',
      url: `/meetings/${meeting.id}`,
      cookies: seller.cookies,
      payload: { startsAt: '2026-10-09T14:00:00-03:00', endsAt: '2026-10-09T15:00:00-03:00' },
    });
    expect(moved.statusCode).toBe(200);
    const patch = google.calls.find((c) => c.method === 'PATCH');
    expect(patch!.url).toContain('/events/evt1?');
    expect(patch!.url).toContain('sendUpdates=all');
    expect(patch!.body).toMatchObject({ start: { timeZone: 'America/Sao_Paulo' } });
    expect((patch!.body as Record<string, unknown>).attendees).toBeUndefined();
    expect(moved.json<{ meeting: Meeting }>().meeting.startsAt).toBe('2026-10-09T17:00:00.000Z');

    const cancelled = await app.inject({
      method: 'PATCH',
      url: `/meetings/${meeting.id}`,
      cookies: seller.cookies,
      payload: { status: 'cancelada' },
    });
    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.json<{ meeting: Meeting }>().meeting.status).toBe('cancelada');
    const del = google.calls.find((c) => c.method === 'DELETE');
    expect(del!.url).toContain('/events/evt1?sendUpdates=all');
    expect(google.events.get('evt1')!.deleted).toBe(true);
  });

  it('puts the event on the Wings Company calendar with the scheduler as a guest', async () => {
    const seller = await sessionFor('vendedor_expansao');
    await connect(seller.cookies);
    const leadId = await deal(seller.id, null);
    const created = await app.inject({
      method: 'POST',
      url: `/leads/${leadId}/meetings`,
      cookies: seller.cookies,
      payload: { ...slot, createMeet: true, calendar: 'wings' },
    });
    expect(created.statusCode).toBe(201);
    const insert = google.calls.find((c) => c.method === 'POST' && c.url.includes('/events'));
    expect(insert!.url).toContain(`/calendars/${encodeURIComponent(WINGS_CALENDAR)}/events`);
    // A lead without e-mail gets no invitation; the seller (owner and scheduler) does.
    expect(guestsOf(insert!.body)).toEqual([seller.email.toLowerCase()]);
    expect(created.json<{ meeting: Meeting }>().meeting.calendar).toBe('wings');
  });

  it('answers 503 google_not_connected to someone who never connected, and leaves the CRM alone when Google refuses a move', async () => {
    const seller = await sessionFor('vendedor_formatacao');
    const leadId = await deal(seller.id);
    const refused = await app.inject({
      method: 'POST',
      url: `/leads/${leadId}/meetings`,
      cookies: seller.cookies,
      payload: { ...slot, createMeet: true },
    });
    expect(refused.statusCode).toBe(503);
    expect(refused.json()).toMatchObject({ error: 'google_not_connected' });
    expect(google.calls).toHaveLength(0);

    await connect(seller.cookies);
    const created = await app.inject({
      method: 'POST',
      url: `/leads/${leadId}/meetings`,
      cookies: seller.cookies,
      payload: { ...slot, createMeet: true },
    });
    expect(created.statusCode).toBe(201);
    const meeting = created.json<{ meeting: Meeting }>().meeting;

    // Google loses the event: the move fails and the screen still shows the old time.
    google.events.get(meeting.googleEventId!)!.deleted = true;
    const moved = await app.inject({
      method: 'PATCH',
      url: `/meetings/${meeting.id}`,
      cookies: seller.cookies,
      payload: { startsAt: '2026-10-09T14:00:00-03:00', endsAt: '2026-10-09T15:00:00-03:00' },
    });
    expect(moved.statusCode).toBe(502);
    expect(moved.json()).toMatchObject({ error: 'google_sync_failed' });
    const kept = await app.inject({ method: 'GET', url: `/meetings/${meeting.id}`, cookies: seller.cookies });
    expect(kept.json<{ meeting: Meeting }>().meeting).toMatchObject({
      startsAt: '2026-10-08T17:00:00.000Z',
      googleSync: { state: 'falhou', error: 'google_sync_failed' },
    });

    // The person decides to change only the CRM's copy.
    const forced = await app.inject({
      method: 'PATCH',
      url: `/meetings/${meeting.id}`,
      cookies: seller.cookies,
      payload: { status: 'cancelada', skipGoogle: true },
    });
    expect(forced.statusCode).toBe(200);
    expect(forced.json<{ meeting: Meeting }>().meeting).toMatchObject({
      status: 'cancelada',
      googleSync: { state: 'falhou', error: 'skipped' },
    });
  });

  it('marks the connection needs_reconnect when Google refuses the refresh', async () => {
    const revoked = fakeGoogle({ refreshRevoked: true });
    const seller = await sessionFor('vendedor_formatacao');
    await connect(seller.cookies);
    // Expire the access token and make the next refresh fail.
    await db
      .update(googleWorkspaceConnections)
      .set({ accessExpiresAt: new Date(NOW.getTime() - 1000) })
      .where(eq(googleWorkspaceConnections.employeeId, seller.id));
    app.wings.googleFetch = revoked.transport;
    try {
      const after = await status(seller.cookies);
      expect(after).toMatchObject({ state: 'needs_reconnect', lastError: 'invalid_grant' });
      const leadId = await deal(seller.id);
      const refused = await app.inject({
        method: 'POST',
        url: `/leads/${leadId}/meetings`,
        cookies: seller.cookies,
        payload: { ...slot, createMeet: true },
      });
      expect(refused.statusCode).toBe(503);
      expect(refused.json()).toMatchObject({ error: 'google_needs_reconnect' });
    } finally {
      app.wings.googleFetch = google.transport;
    }
  });

  it('keeps another seller out of a Google-made meeting (404), while the Admin may cancel it', async () => {
    const seller = await sessionFor('vendedor_formatacao');
    await connect(seller.cookies);
    const leadId = await deal(seller.id);
    const created = await app.inject({
      method: 'POST',
      url: `/leads/${leadId}/meetings`,
      cookies: seller.cookies,
      payload: { ...slot, createMeet: true },
    });
    const meeting = created.json<{ meeting: Meeting }>().meeting;

    const other = await sessionFor('vendedor_expansao');
    const peek = await app.inject({ method: 'GET', url: `/meetings/${meeting.id}`, cookies: other.cookies });
    expect(peek.statusCode).toBe(404);

    // The Admin never connected: the creator's token cancels it on Google.
    const admin = await sessionFor('admin_master');
    const cancelled = await app.inject({
      method: 'PATCH',
      url: `/meetings/${meeting.id}`,
      cookies: admin.cookies,
      payload: { status: 'cancelada' },
    });
    expect(cancelled.statusCode).toBe(200);
    expect(google.events.get(meeting.googleEventId!)!.deleted).toBe(true);
  });
});
