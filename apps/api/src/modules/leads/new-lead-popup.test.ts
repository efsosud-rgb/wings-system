import { SESSION_COOKIE, WINGS_CLIENT_ID, type NewLeadPopup } from '@wings/shared';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../app.js';
import type { Database } from '../../db/client.js';
import { crmNotifications, leads } from '../../db/schema/index.js';
import { loadEnv } from '../../env.js';
import type { Mail, Mailer } from '../../lib/mailer.js';
import { createTestDatabase, type TestDatabase } from '../../test/db.js';
import { createEmployee, TEST_CPF_KEY, TEST_INDEX_KEY } from '../../test/factories.js';
import { sendPendingNoticeMails } from './crm-notice-mail.js';
import { newLeadPopupsOf } from './crm-alerts.js';
import { upsertLead } from './service.js';

/**
 * The new-lead pop-up (`GET /crm/notifications/new-leads`) and the guarantee behind switching the
 * owner's e-mail on: only the lead's owner is told, and a lead that arrived before the switch is never
 * e-mailed afterwards.
 */

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

let phoneSeq = 0;
const arrive = (ownerEmployeeId: string | null) => {
  phoneSeq += 1;
  return upsertLead(db, {
    source: 'meta_lead_ads',
    name: 'Fulana Teste da Silva',
    phone: `55119666${String(phoneSeq).padStart(5, '0')}`,
    clientId: WINGS_CLIENT_ID,
    clientMapped: true,
    pipeline: 'formatacao',
    ownerEmployeeId,
    campaignName: 'Form 5 perguntas Out26',
    skipResearch: true,
    event: { kind: 'lead.received.meta_lead_ads' },
  });
};

async function cookiesOf(person: { email: string; password: string }) {
  const login = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { email: person.email, password: person.password },
  });
  return { [SESSION_COOKIE]: login.cookies.find((c) => c.name === SESSION_COOKIE)!.value };
}

function fakeMailer() {
  const sent: Mail[] = [];
  const mailer: Mailer = { enabled: true, send: async (mail) => void sent.push(mail) };
  return { mailer, sent };
}

describe('the new-lead pop-up', () => {
  it('reaches the owner alone, with the first name, funnel, origin and deadline', async () => {
    const owner = await createEmployee(db, { role: 'vendedor_formatacao', sector: 'comercial' });
    const other = await createEmployee(db, { role: 'vendedor_formatacao', sector: 'comercial' });
    const born = await arrive(owner.id);
    // A notice written for someone else about the same lead must not raise a pop-up for them.
    await db.insert(crmNotifications).values({
      recipientEmployeeId: other.id,
      leadId: born.lead.id,
      kind: 'new_lead',
      message: 'Novo lead para você.',
    });

    const asOwner = await app.inject({
      method: 'GET',
      url: '/crm/notifications/new-leads',
      cookies: await cookiesOf(owner),
    });
    expect(asOwner.statusCode).toBe(200);
    const [popup, ...rest] = asOwner.json<{ leads: NewLeadPopup[] }>().leads;
    expect(rest).toEqual([]);
    expect(popup).toMatchObject({
      leadId: born.lead.id,
      firstName: 'Fulana',
      funnel: 'Formatação',
      origin: 'Meta Lead Ads — Form 5 perguntas Out26',
    });
    expect(popup?.firstContactDueAt).toEqual(expect.any(String));
    // Nothing but the first name of the person.
    expect(JSON.stringify(popup)).not.toMatch(/Silva|Teste|55119666/);

    const asOther = await app.inject({
      method: 'GET',
      url: '/crm/notifications/new-leads',
      cookies: await cookiesOf(other),
    });
    expect(asOther.json()).toEqual({ leads: [] });
    expect(
      (await app.inject({ method: 'GET', url: '/crm/notifications/new-leads' })).statusCode,
    ).toBe(401);
  });

  it('never goes to a manager or the board for a lead without an owner', async () => {
    const boss = await createEmployee(db, { role: 'diretoria', sector: 'diretoria' });
    const born = await arrive(null);
    expect(born.lead.ownerEmployeeId).toBeNull();
    expect(await newLeadPopupsOf(db, boss.id)).toEqual([]);
  });

  it('goes away once read, once the deal moves on or is closed, once it changes hands, or when stale', async () => {
    const owner = await createEmployee(db, { role: 'vendedor_formatacao', sector: 'comercial' });
    const heir = await createEmployee(db, { role: 'vendedor_formatacao', sector: 'comercial' });
    const [read, moved, lost, given, stale] = [
      await arrive(owner.id),
      await arrive(owner.id),
      await arrive(owner.id),
      await arrive(owner.id),
      await arrive(owner.id),
    ];
    expect(await newLeadPopupsOf(db, owner.id)).toHaveLength(5);

    await db
      .update(crmNotifications)
      .set({ readAt: new Date() })
      .where(and(eq(crmNotifications.leadId, read.lead.id), eq(crmNotifications.kind, 'new_lead')));
    await db.update(leads).set({ stage: 'Em contato' }).where(eq(leads.id, moved.lead.id));
    await db.update(leads).set({ won: false }).where(eq(leads.id, lost.lead.id));
    await db.update(leads).set({ ownerEmployeeId: heir.id }).where(eq(leads.id, given.lead.id));
    expect((await newLeadPopupsOf(db, owner.id)).map((p) => p.leadId)).toEqual([stale.lead.id]);
    // The new owner has no notice of their own: nothing is raised for a hand-over.
    expect(await newLeadPopupsOf(db, heir.id)).toEqual([]);
    // Three days later it is the bell's business, not a pop-up.
    expect(
      await newLeadPopupsOf(db, owner.id, new Date(Date.now() + 3 * 86_400_000 + 60_000)),
    ).toEqual([]);
  });
});

describe('switching the owner e-mail on', () => {
  it('e-mails only the owner, and never the leads that arrived while it was off', async () => {
    const owner = await createEmployee(db, { role: 'vendedor_formatacao', sector: 'comercial' });
    const watcher = await createEmployee(db, { role: 'diretoria', sector: 'diretoria' });
    const before = await arrive(owner.id);
    await arrive(null); // a lead nobody owns: the board is told in the panel, never by e-mail
    await db.insert(crmNotifications).values({
      recipientEmployeeId: watcher.id,
      leadId: before.lead.id,
      kind: 'new_lead',
      message: 'Novo lead para você.',
      emailState: 'pending',
    });

    // Off: everything pending is settled as skipped, nothing is kept for later.
    const off = fakeMailer();
    const closed = await sendPendingNoticeMails(
      db,
      { mailer: off.mailer, enabled: false, baseUrl: 'http://x' },
      new Date(),
    );
    expect(closed.sent).toBe(0);
    expect(off.sent).toEqual([]);

    // On: nothing is left over from before.
    const on = fakeMailer();
    const opened = await sendPendingNoticeMails(
      db,
      { mailer: on.mailer, enabled: true, baseUrl: 'http://x' },
      new Date(),
    );
    expect(opened).toEqual({ sent: 0, skipped: 0, failed: 0 });
    expect(on.sent).toEqual([]);

    // A lead that arrives after the switch reaches its owner, and only the owner.
    const after = await arrive(owner.id);
    await db.insert(crmNotifications).values({
      recipientEmployeeId: watcher.id,
      leadId: after.lead.id,
      kind: 'new_lead',
      message: 'Novo lead para você.',
      emailState: 'pending',
    });
    const result = await sendPendingNoticeMails(
      db,
      { mailer: on.mailer, enabled: true, baseUrl: 'http://x' },
      new Date(),
    );
    expect(result).toMatchObject({ sent: 1, skipped: 1 });
    expect(on.sent.map((mail) => mail.to)).toEqual([owner.email]);
  });

  it('skips a pending new-lead notice hours old, as if the switch found it waiting', async () => {
    const owner = await createEmployee(db, { role: 'vendedor_formatacao', sector: 'comercial' });
    const born = await arrive(owner.id);
    const seven = new Date(Date.now() + 7 * 3_600_000);
    const mail = fakeMailer();
    const result = await sendPendingNoticeMails(
      db,
      { mailer: mail.mailer, enabled: true, baseUrl: 'http://x' },
      seven,
    );
    expect(result.sent).toBe(0);
    expect(mail.sent).toEqual([]);
    const [notice] = await db
      .select()
      .from(crmNotifications)
      .where(and(eq(crmNotifications.leadId, born.lead.id), eq(crmNotifications.kind, 'new_lead')));
    expect(notice).toMatchObject({ emailState: 'skipped', emailError: 'too_old' });
  });
});
