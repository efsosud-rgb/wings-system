import { SESSION_COOKIE, WINGS_CLIENT_ID, type LeadEmailSent } from '@wings/shared';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../app.js';
import type { Database } from '../../db/client.js';
import { auditLog, crmEmailOutbox, crmEmailTemplates, leadEvents } from '../../db/schema/index.js';
import { loadEnv } from '../../env.js';
import { createTestDatabase, type TestDatabase } from '../../test/db.js';
import { createEmployee, TEST_CPF_KEY, TEST_INDEX_KEY } from '../../test/factories.js';
import { upsertLead } from './service.js';

let harness: TestDatabase;
let db: Database;
let app: FastifyInstance;

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
    }),
    db,
  });
}, 60_000);

afterAll(async () => {
  await app?.close();
  await harness?.drop();
});

async function sessionFor(role: 'gerente_comercial' | 'vendedor_expansao') {
  const employee = await createEmployee(db, { role, sector: 'comercial' });
  const login = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { email: employee.email, password: employee.password },
  });
  const token = login.cookies.find((c) => c.name === SESSION_COOKIE)?.value;
  if (!token) throw new Error('login failed in setup');
  return { employeeId: employee.id, cookies: { [SESSION_COOKIE]: token } };
}

const arrive = (input: { name: string; email?: string; owner?: string }) =>
  upsertLead(db, {
    source: 'site_form',
    name: input.name,
    phone: null,
    email: input.email ?? null,
    clientId: WINGS_CLIENT_ID,
    clientMapped: false,
    pipeline: 'expansao',
    ownerEmployeeId: input.owner ?? null,
    distribute: false,
    skipResearch: true,
    company: null,
    event: { kind: 'lead.received.site_form' },
  });

describe('e-mail to the lead from the deal page', () => {
  let manager: Awaited<ReturnType<typeof sessionFor>>;
  let seller: Awaited<ReturnType<typeof sessionFor>>;
  let templateId: string;
  let offId: string;

  beforeAll(async () => {
    manager = await sessionFor('gerente_comercial');
    seller = await sessionFor('vendedor_expansao');
    const [on] = await db
      .insert(crmEmailTemplates)
      .values({
        name: 'Boas-vindas',
        subject: 'Olá, {{nome}}',
        body: 'Oi {{nome}}, aqui é {{vendedor}}.',
      })
      .returning({ id: crmEmailTemplates.id });
    const [off] = await db
      .insert(crmEmailTemplates)
      .values({ name: 'Antigo', subject: 'Antigo', body: 'Antigo', active: false })
      .returning({ id: crmEmailTemplates.id });
    templateId = on!.id;
    offId = off!.id;
  });

  it('previews the template filled in, then records it in test mode with the event and audit', async () => {
    const { lead } = await arrive({
      name: 'Carla Souza',
      email: 'carla@exemplo.com',
      owner: seller.employeeId,
    });
    const preview = await app.inject({
      method: 'POST',
      url: `/leads/${lead.id}/emails/preview`,
      cookies: seller.cookies,
      payload: { templateId },
    });
    expect(preview.statusCode).toBe(200);
    expect(preview.json().subject).toBe('Olá, Carla');
    expect(await db.$count(crmEmailOutbox, eq(crmEmailOutbox.leadId, lead.id))).toBe(0);

    const sent = await app.inject({
      method: 'POST',
      url: `/leads/${lead.id}/emails`,
      cookies: seller.cookies,
      payload: { templateId },
    });
    expect(sent.statusCode).toBe(201);
    expect(sent.json().mode).toBe('test');

    const list = await app.inject({
      method: 'GET',
      url: `/leads/${lead.id}/emails`,
      cookies: seller.cookies,
    });
    const body = list.json() as {
      to: string;
      mode: string;
      templates: unknown[];
      sent: LeadEmailSent[];
    };
    expect(body.mode).toBe('test');
    expect(body.to).toBe('carla@exemplo.com');
    expect(body.templates).toHaveLength(1);
    expect(body.sent).toHaveLength(1);
    expect(body.sent[0]).toMatchObject({
      status: 'recorded',
      mode: 'test',
      templateName: 'Boas-vindas',
    });

    const events = await db.select().from(leadEvents).where(eq(leadEvents.leadId, lead.id));
    expect(events.filter((e) => e.kind === 'lead.email_sent')).toHaveLength(1);
    const audits = await db.select().from(auditLog).where(eq(auditLog.entityId, lead.id));
    const entry = audits.find((a) => a.action === 'lead.email_sent');
    expect(entry).toBeTruthy();
    expect(JSON.stringify(entry?.metadata)).not.toContain('Carla');
  });

  it('refuses a lead without e-mail and a disabled or unknown template', async () => {
    const { lead: noMail } = await arrive({ name: 'Sem Email', owner: seller.employeeId });
    const none = await app.inject({
      method: 'POST',
      url: `/leads/${noMail.id}/emails`,
      cookies: seller.cookies,
      payload: { templateId },
    });
    expect(none.statusCode).toBe(422);
    expect(none.json().error).toBe('no_email');

    const { lead } = await arrive({
      name: 'Dora',
      email: 'dora@exemplo.com',
      owner: seller.employeeId,
    });
    const off = await app.inject({
      method: 'POST',
      url: `/leads/${lead.id}/emails`,
      cookies: seller.cookies,
      payload: { templateId: offId },
    });
    expect(off.statusCode).toBe(409);
    const offPreview = await app.inject({
      method: 'POST',
      url: `/leads/${lead.id}/emails/preview`,
      cookies: seller.cookies,
      payload: { templateId: offId },
    });
    expect(offPreview.statusCode).toBe(404);
    expect(await db.$count(crmEmailOutbox, eq(crmEmailOutbox.leadId, lead.id))).toBe(0);
  });

  it("a seller cannot reach another seller's lead; a manager can", async () => {
    const { lead } = await arrive({
      name: 'Edu',
      email: 'edu@exemplo.com',
      owner: manager.employeeId,
    });
    const denied = await app.inject({
      method: 'POST',
      url: `/leads/${lead.id}/emails`,
      cookies: seller.cookies,
      payload: { templateId },
    });
    expect(denied.statusCode).toBe(404);
    const readDenied = await app.inject({
      method: 'GET',
      url: `/leads/${lead.id}/emails`,
      cookies: seller.cookies,
    });
    expect(readDenied.statusCode).toBe(404);
    const allowed = await app.inject({
      method: 'POST',
      url: `/leads/${lead.id}/emails`,
      cookies: manager.cookies,
      payload: { templateId },
    });
    expect(allowed.statusCode).toBe(201);
    expect(await db.$count(crmEmailOutbox, eq(crmEmailOutbox.leadId, lead.id))).toBe(1);
  });
});
