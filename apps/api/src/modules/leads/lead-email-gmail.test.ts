import { randomBytes } from 'node:crypto';
import { SESSION_COOKIE, WINGS_CLIENT_ID } from '@wings/shared';
import { desc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../app.js';
import type { Database } from '../../db/client.js';
import { crmEmailOutbox, crmEmailTemplates, leadEvents, leads } from '../../db/schema/index.js';
import { loadEnv } from '../../env.js';
import type { Mail } from '../../lib/mailer.js';
import { createTestDatabase, type TestDatabase } from '../../test/db.js';
import { createEmployee, TEST_CPF_KEY, TEST_INDEX_KEY } from '../../test/factories.js';
import { fakeGoogle } from '../google-workspace/fake-google.js';
import { upsertLead } from './service.js';

let harness: TestDatabase;
let db: Database;
let app: FastifyInstance;
const google = fakeGoogle({ email: 'daniele@wingscompany.com.br' });
const smtpSent: Mail[] = [];
let smtpEnabled = true;

/**
 * CRM_EMAIL_MODE=gmail: the message leaves from the sender's own Gmail when
 * they connected their Google account; otherwise from the company's SMTP;
 * with neither, it is recorded as failed and nothing is retried.
 */
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
      CRM_EMAIL_MODE: 'gmail',
      SMTP_FROM: 'contato@wingscompany.com.br',
    }),
    db,
    googleFetch: google.transport,
    mailer: {
      get enabled() {
        return smtpEnabled;
      },
      send: async (mail) => void smtpSent.push(mail),
    },
  });
}, 60_000);

afterAll(async () => {
  await app?.close();
  await harness?.drop();
});

beforeEach(() => {
  google.reset();
  smtpSent.length = 0;
  smtpEnabled = true;
});

async function sessionFor(role: 'vendedor_formatacao' | 'vendedor_expansao') {
  const employee = await createEmployee(db, { role, sector: 'comercial' });
  const login = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { email: employee.email, password: employee.password },
  });
  const token = login.cookies.find((c) => c.name === SESSION_COOKIE)?.value;
  if (!token) throw new Error('login failed');
  return { id: employee.id, cookies: { [SESSION_COOKIE]: token } };
}

async function connect(cookies: Record<string, string>) {
  const start = await app.inject({ method: 'POST', url: '/me/google/connect', cookies });
  const state = new URL(start.json<{ url: string }>().url).searchParams.get('state');
  const callback = await app.inject({
    method: 'GET',
    url: `/me/google/callback?code=auth-code&state=${state}`,
    cookies,
  });
  expect(callback.headers.location).toBe('/minha-conta?google=ok');
}

const arrive = async (
  owner: string,
  email = 'paula@exemplo.com.br',
  pipeline: 'formatacao' | 'expansao' = 'formatacao',
) =>
  (
    await upsertLead(db, {
      source: 'site_form',
      name: 'Paula Candidata',
      phone: null,
      email,
      clientId: WINGS_CLIENT_ID,
      clientMapped: false,
      pipeline,
      ownerEmployeeId: owner,
      distribute: false,
      skipResearch: true,
      company: null,
      event: { kind: 'lead.received.site_form' },
    })
  ).lead;

const decode = (raw: string) => Buffer.from(raw, 'base64url').toString('utf8');

describe('e-mail to the lead through the sender’s Gmail', () => {
  let templateId: string;
  beforeAll(async () => {
    const [template] = await db
      .insert(crmEmailTemplates)
      .values({
        name: 'Boas-vindas',
        subject: 'Olá, {{nome}}',
        body: 'Oi {{nome}}, aqui é {{vendedor}}. Vamos conversar?',
        active: true,
      })
      .returning({ id: crmEmailTemplates.id });
    templateId = template!.id;
  });

  it('sends from the connected seller’s address and keeps the thread and Message-ID', async () => {
    const seller = await sessionFor('vendedor_formatacao');
    await connect(seller.cookies);
    const lead = await arrive(seller.id);

    const before = await app.inject({
      method: 'GET',
      url: `/leads/${lead.id}/emails`,
      cookies: seller.cookies,
    });
    expect(before.json()).toMatchObject({ mode: 'gmail', from: 'daniele@wingscompany.com.br' });

    const sent = await app.inject({
      method: 'POST',
      url: `/leads/${lead.id}/emails`,
      cookies: seller.cookies,
      payload: { templateId },
    });
    expect(sent.statusCode).toBe(201);
    expect(sent.json()).toMatchObject({ mode: 'gmail' });

    expect(google.sentMail).toHaveLength(1);
    const raw = decode(google.sentMail[0]!.raw);
    expect(raw).toContain('To: paula@exemplo.com.br');
    expect(raw).toContain('<daniele@wingscompany.com.br>');
    expect(raw).toMatch(/Message-ID: <[0-9a-f]{32}@staging\.wingssystem\.online>/);
    expect(raw).toContain('Content-Type: multipart/alternative');
    expect(decode(raw.split('\r\n\r\n')[2]!.split('\r\n')[0]!)).toContain('Oi Paula, aqui é');
    expect(smtpSent).toHaveLength(0);

    const [row] = await db
      .select()
      .from(crmEmailOutbox)
      .where(eq(crmEmailOutbox.leadId, lead.id))
      .orderBy(desc(crmEmailOutbox.createdAt));
    expect(row).toMatchObject({
      mode: 'gmail',
      status: 'sent',
      fromEmail: 'daniele@wingscompany.com.br',
      gmailMessageId: 'msg1',
      gmailThreadId: 'thr1',
    });
    expect(row!.messageId).toMatch(/^<[0-9a-f]{32}@staging\.wingssystem\.online>$/);
    const [event] = await db
      .select()
      .from(leadEvents)
      .where(eq(leadEvents.leadId, lead.id))
      .orderBy(desc(leadEvents.at));
    expect(event).toMatchObject({
      kind: 'lead.email_sent',
      detail: { mode: 'gmail', status: 'sent' },
    });

    const after = await app.inject({
      method: 'GET',
      url: `/leads/${lead.id}/emails`,
      cookies: seller.cookies,
    });
    expect(
      after.json<{ sent: Array<{ mode: string; fromEmail: string | null }> }>().sent[0],
    ).toMatchObject({
      mode: 'gmail',
      fromEmail: 'daniele@wingscompany.com.br',
    });
  });

  it('falls back to the company’s SMTP for someone not connected, and records failed with neither', async () => {
    const seller = await sessionFor('vendedor_expansao');
    const lead = await arrive(seller.id, 'outra@exemplo.com.br');
    const status = await app.inject({
      method: 'GET',
      url: `/leads/${lead.id}/emails`,
      cookies: seller.cookies,
    });
    expect(status.json()).toMatchObject({ mode: 'gmail', from: 'contato@wingscompany.com.br' });

    const viaSmtp = await app.inject({
      method: 'POST',
      url: `/leads/${lead.id}/emails`,
      cookies: seller.cookies,
      payload: { templateId },
    });
    expect(viaSmtp.statusCode).toBe(201);
    expect(viaSmtp.json()).toMatchObject({ mode: 'smtp' });
    expect(smtpSent).toHaveLength(1);
    expect(google.sentMail).toHaveLength(0);

    smtpEnabled = false;
    const nobody = await app.inject({
      method: 'GET',
      url: `/leads/${lead.id}/emails`,
      cookies: seller.cookies,
    });
    expect(nobody.json()).toMatchObject({ mode: 'gmail', from: null });
    const refused = await app.inject({
      method: 'POST',
      url: `/leads/${lead.id}/emails`,
      cookies: seller.cookies,
      payload: { templateId },
    });
    expect(refused.statusCode).toBe(502);
    expect(refused.json()).toMatchObject({ error: 'send_failed' });
    const rows = await db
      .select({ status: crmEmailOutbox.status, mode: crmEmailOutbox.mode })
      .from(crmEmailOutbox)
      .where(eq(crmEmailOutbox.leadId, lead.id))
      .orderBy(desc(crmEmailOutbox.createdAt));
    expect(rows[0]).toMatchObject({ status: 'failed', mode: 'gmail' });
  });

  it('sends nothing to the lead of an Expansão deal with a brand (the brand rule), connected or not', async () => {
    const seller = await sessionFor('vendedor_expansao');
    await connect(seller.cookies);
    const lead = await arrive(seller.id, 'marca@exemplo.com.br', 'expansao');
    await db.update(leads).set({ brand: 'Marca Exemplo' }).where(eq(leads.id, lead.id));
    const status = await app.inject({
      method: 'GET',
      url: `/leads/${lead.id}/emails`,
      cookies: seller.cookies,
    });
    expect(status.json()).toMatchObject({ hidden: true });
    const refused = await app.inject({
      method: 'POST',
      url: `/leads/${lead.id}/emails`,
      cookies: seller.cookies,
      payload: { templateId },
    });
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ error: 'brand_hidden' });
    expect(google.sentMail).toHaveLength(0);
    expect(smtpSent).toHaveLength(0);
    expect(await db.$count(crmEmailOutbox, eq(crmEmailOutbox.leadId, lead.id))).toBe(0);
  });
});
