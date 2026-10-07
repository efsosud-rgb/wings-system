import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  SESSION_COOKIE,
  WINGS_CLIENT_ID,
  type Actor,
  type DriveUploadTicket,
  type LeadFile,
  type RoleKey,
} from '@wings/shared';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../app.js';
import type { Database } from '../../db/client.js';
import {
  crmMeetings,
  crmNotifications,
  leadEvents,
  leadNotes,
  leadTasks,
  leads,
} from '../../db/schema/index.js';
import { loadEnv } from '../../env.js';
import { createTestDatabase, type TestDatabase } from '../../test/db.js';
import { createEmployee, TEST_CPF_KEY, TEST_INDEX_KEY } from '../../test/factories.js';
import { seedDriveTemplate, syncDriveFolders } from '../drive/folders.js';
import { canChangeLeadOwner, leadInScope, leadOwnerFilter } from './access.js';
import { findOrCreateCompany, findOrCreateContact, linkContact } from './contacts.js';
import { upsertLead } from './service.js';

/**
 * "Cada usuário vê só os seus leads" (Eric, 07/10/2026), proved against the API with real sessions:
 *  - a seller (vendedor) sees and touches only the leads they own, in every route that returns a lead
 *    or anything hanging from one; a lead out of reach answers 404, also when opened by its URL;
 *  - a lead nobody owns is seen only by Admin Master and Diretoria (and the Gerente comercial);
 *  - only the Admin changes the owner; the API refuses it for a seller.
 */

let harness: TestDatabase;
let db: Database;
let app: FastifyInstance;
let dir: string;

type Session = { id: string; role: RoleKey; cookies: Record<string, string> };
let sellerA: Session;
let sellerB: Session;
let admin: Session;
let board: Session;

type Deal = {
  id: string;
  name: string;
  phone: string;
  noteId: string;
  taskId: string;
  meetingId: string;
  contactId: string;
  contactEmail: string;
  companyId: string;
  companyName: string;
  fileId: string;
};
let dealA: Deal;
let dealB: Deal;
let dealN: Deal;

const loginAs = async (role: RoleKey): Promise<Session> => {
  const employee = await createEmployee(db, { role, sector: 'comercial' });
  const login = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { email: employee.email, password: employee.password },
  });
  const token = login.cookies.find((c) => c.name === SESSION_COOKIE)?.value;
  if (!token) throw new Error('login failed in setup');
  return { id: employee.id, role, cookies: { [SESSION_COOKIE]: token } };
};

const actorOf = (session: Session): Actor => ({
  employeeId: session.id,
  role: session.role,
  sector: 'comercial',
  isSectorManager: false,
});

async function send(session: Session, leadId: string, name: string) {
  const bytes = Buffer.from(`conteudo de ${name}`);
  const asked = await app.inject({
    method: 'POST',
    url: `/leads/${leadId}/files/uploads`,
    cookies: session.cookies,
    payload: { name, mimeType: 'application/pdf', byteSize: bytes.length },
  });
  expect(asked.statusCode).toBe(201);
  const { ticket } = asked.json<{ ticket: DriveUploadTicket }>();
  const sent = await app.inject({
    method: 'PUT',
    url: ticket.url.replace('http://localhost:5173/api', ''),
    headers: { ...ticket.headers, 'content-length': String(bytes.length) },
    payload: bytes,
  });
  expect(sent.statusCode).toBe(200);
  const done = await app.inject({
    method: 'POST',
    url: `/leads/${leadId}/files/uploads/${ticket.uploadId}/complete`,
    cookies: session.cookies,
  });
  expect(done.statusCode).toBe(201);
  return done.json<{ file: LeadFile }>().file.fileId;
}

/** A deal with one of everything hanging from it. `owner` null = a lead nobody owns. */
async function makeDeal(
  tag: string,
  phone: string,
  owner: Session | null,
  uploader: Session,
): Promise<Deal> {
  const name = `${tag} Negocio`;
  const { lead } = await upsertLead(db, {
    source: 'site_form',
    name,
    phone,
    email: null,
    clientId: WINGS_CLIENT_ID,
    clientMapped: false,
    pipeline: 'expansao',
    ownerEmployeeId: owner?.id ?? null,
    distribute: false,
    skipResearch: true,
    company: null,
    event: { kind: 'lead.received.site_form' },
  });
  const [note] = await db
    .insert(leadNotes)
    .values({ leadId: lead.id, authorEmployeeId: admin.id, body: `anotacao ${tag}` })
    .returning();
  const [task] = await db
    .insert(leadTasks)
    .values({
      leadId: lead.id,
      title: `tarefa ${tag}`,
      dueAt: new Date(Date.now() + 86_400_000),
      assigneeEmployeeId: owner?.id ?? null,
    })
    .returning();
  const [meeting] = await db
    .insert(crmMeetings)
    .values({
      leadId: lead.id,
      ownerEmployeeId: owner?.id ?? admin.id,
      title: `reuniao ${tag}`,
      startsAt: new Date(Date.now() + 86_400_000),
      endsAt: new Date(Date.now() + 90_000_000),
    })
    .returning();
  const companyName = `Empresa ${tag}`;
  const company = await findOrCreateCompany(db, { name: companyName }, null);
  const contactEmail = `${tag.toLowerCase()}@contato.test`;
  const contact = await findOrCreateContact(
    db,
    { name: `Contato ${tag}`, email: contactEmail, phone: null, companyId: company!.company.id },
    null,
  );
  await linkContact(db, { leadId: lead.id, contactId: contact!.contact.id, actorEmployeeId: null });
  await db.update(leads).set({ companyId: company!.company.id }).where(eq(leads.id, lead.id));
  await db.insert(crmNotifications).values({
    recipientEmployeeId: owner?.id ?? admin.id,
    leadId: lead.id,
    kind: 'new_lead',
    message: `aviso ${tag}`,
    dedupeKey: `owner-scope:${tag}`,
  });
  const fileId = await send(uploader, lead.id, `contrato-${tag}.pdf`);
  return {
    id: lead.id,
    name,
    phone,
    noteId: note!.id,
    taskId: task!.id,
    meetingId: meeting!.id,
    contactId: contact!.contact.id,
    contactEmail,
    companyId: company!.company.id,
    companyName,
    fileId,
  };
}

beforeAll(async () => {
  harness = await createTestDatabase();
  db = harness.db;
  dir = await mkdtemp(join(tmpdir(), 'wings-owner-scope-'));
  app = await buildApp({
    env: loadEnv({
      NODE_ENV: 'test',
      DATABASE_URL: harness.url,
      SESSION_SECRET: 'x'.repeat(48),
      CPF_ENCRYPTION_KEY: TEST_CPF_KEY,
      CPF_INDEX_KEY: TEST_INDEX_KEY,
      APP_BASE_URL: 'http://localhost:5173',
      MEDIA_DIR: dir,
    }),
    db,
  });
  await seedDriveTemplate(db);
  await syncDriveFolders(db);
  sellerA = await loginAs('vendedor_expansao');
  sellerB = await loginAs('vendedor_expansao');
  admin = await loginAs('admin_master');
  board = await loginAs('diretoria');
  dealA = await makeDeal('Alfa', '21999990001', sellerA, sellerA);
  dealB = await makeDeal('Beta', '21999990002', sellerB, sellerB);
  dealN = await makeDeal('Gama', '21999990003', null, admin);
}, 120_000);

afterAll(async () => {
  await app?.close();
  await harness?.drop();
  await rm(dir, { recursive: true, force: true });
});

const call = (
  session: Session,
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  url: string,
  payload?: unknown,
) => app.inject({ method, url, cookies: session.cookies, payload: payload as never });

const text = (response: { body: string }) => response.body;

describe('a seller sees only the leads they own', () => {
  it('list, search, board, counters, summary and CSV carry only their own lead', async () => {
    for (const url of [
      '/leads',
      '/leads?q=Negocio',
      '/leads/board?pipeline=expansao',
      '/leads/board/counters?pipeline=expansao',
      '/leads/export.csv',
    ]) {
      const mine = await call(sellerA, 'GET', url);
      expect(mine.statusCode, url).toBe(200);
      const body = text(mine);
      if (!url.startsWith('/leads/board/counters')) {
        expect(body, url).toContain('Alfa');
        expect(body, url).not.toContain('Beta');
        expect(body, url).not.toContain('Gama');
      }
    }
    // The seller's count is the seller's own; the Admin sees all three.
    const summary = await call(sellerA, 'GET', '/leads/summary');
    expect(summary.statusCode).toBe(200);
    const mine = await call(sellerA, 'GET', '/leads');
    expect(mine.json<{ total: number }>().total).toBe(1);
    const all = await call(admin, 'GET', '/leads');
    expect(all.json<{ total: number }>().total).toBe(3);
    expect(text(all)).toContain('Gama');
    // Diretoria sees every lead too, the ownerless one included.
    const directors = await call(board, 'GET', '/leads');
    expect(directors.json<{ total: number }>().total).toBe(3);
  });

  it('tasks, notices, contacts, companies and brands carry only what is tied to their leads', async () => {
    const tasks = text(await call(sellerA, 'GET', '/crm/tasks?status=all'));
    expect(tasks).toContain('tarefa Alfa');
    expect(tasks).not.toContain('tarefa Beta');
    expect(tasks).not.toContain('tarefa Gama');
    const adminTasks = text(await call(admin, 'GET', '/crm/tasks?status=all&everyone=true'));
    expect(adminTasks).toContain('tarefa Beta');
    expect(adminTasks).toContain('tarefa Gama');

    const notices = text(await call(sellerA, 'GET', '/crm/notifications'));
    expect(notices).toContain('aviso Alfa');
    expect(notices).not.toContain('aviso Beta');
    expect(notices).not.toContain('aviso Gama');

    const contacts = text(await call(sellerA, 'GET', '/crm/contacts'));
    expect(contacts).toContain('alfa@contato.test');
    expect(contacts).not.toContain('beta@contato.test');
    expect(contacts).not.toContain('gama@contato.test');

    const companies = text(await call(sellerA, 'GET', '/crm/companies'));
    expect(companies).toContain('Empresa Alfa');
    expect(companies).not.toContain('Empresa Beta');
    expect(companies).not.toContain('Empresa Gama');
    expect(text(await call(admin, 'GET', '/crm/companies'))).toContain('Empresa Gama');

    // A company shows the seller only the people and the numbers of their own leads.
    const company = await call(sellerA, 'GET', `/crm/companies/${dealA.companyId}`);
    expect(company.statusCode).toBe(200);
    expect(company.json<{ company: { leads: number } }>().company.leads).toBe(1);
  });

  it("a notice about a lead that moved to another owner leaves the old owner's inbox", async () => {
    const lead = await makeDeal('Delta', '21999990004', sellerA, sellerA);
    expect(text(await call(sellerA, 'GET', '/crm/notifications'))).toContain('aviso Delta');
    const moved = await call(admin, 'PATCH', `/leads/${lead.id}`, {
      ownerEmployeeId: sellerB.id,
    });
    expect(moved.statusCode).toBe(200);
    expect(text(await call(sellerA, 'GET', '/crm/notifications'))).not.toContain('aviso Delta');
    // ...and the lead itself, its task and its files are gone from the old owner too.
    expect((await call(sellerA, 'GET', `/leads/${lead.id}`)).statusCode).toBe(404);
    expect((await call(sellerB, 'GET', `/leads/${lead.id}`)).statusCode).toBe(200);
    expect(text(await call(sellerA, 'GET', '/crm/tasks?status=all'))).not.toContain('tarefa Delta');
    expect((await call(sellerA, 'GET', `/leads/${lead.id}/files`)).statusCode).toBe(404);
  });
});

/**
 * Every route that names a lead, or a child of one, with a valid body. `skipOwn` marks the routes that
 * cannot succeed on the owner's own lead for a reason of their own (the file is already attached; the
 * template does not exist): they are still proved to answer 404 on a lead out of reach.
 */
const routesOf = (deal: Deal, session: Session) => {
  const later = new Date(Date.now() + 2 * 86_400_000).toISOString();
  const table: [string, string, unknown?, boolean?][] = [
    ['GET', `/leads/${deal.id}`],
    ['PATCH', `/leads/${deal.id}`, { won: null }],
    ['POST', `/leads/${deal.id}/notes`, { body: 'oi' }],
    ['POST', `/leads/${deal.id}/tasks`, { title: 'ligar', dueAt: later }],
    ['PATCH', `/leads/${deal.id}/tasks/${deal.taskId}`, { done: false }],
    ['POST', `/leads/${deal.id}/checks`],
    ['POST', `/leads/${deal.id}/research`],
    ['POST', `/leads/${deal.id}/activities`, { kind: 'call', outcome: 'answered' }],
    ['PATCH', `/leads/${deal.id}/deal`, { valueCents: 100 }],
    ['POST', `/leads/${deal.id}/contacts`, { contactId: deal.contactId }],
    ['GET', `/leads/${deal.id}/files`],
    ['GET', `/leads/${deal.id}/files/${deal.fileId}/link`],
    ['POST', `/leads/${deal.id}/files`, { fileId: deal.fileId }, true],
    [
      'POST',
      `/leads/${deal.id}/files/uploads`,
      { name: 'x.pdf', mimeType: 'application/pdf', byteSize: 3 },
    ],
    ['POST', `/leads/${deal.id}/resumo`],
    ['POST', `/leads/${deal.id}/resumo/pergunta`, { question: 'o que falta?' }],
    ['GET', `/leads/${deal.id}/emails`],
    ['POST', `/leads/${deal.id}/emails/preview`, { templateId: randomUUID() }, true],
    ['GET', `/leads/${deal.id}/meetings`],
    [
      'POST',
      `/leads/${deal.id}/meetings`,
      {
        title: 'Diag',
        startsAt: '2026-12-08T14:00:00-03:00',
        endsAt: '2026-12-08T15:00:00-03:00',
        meetUrl: 'https://meet.google.com/abc-defg-hij',
      },
    ],
    ['GET', `/meetings/${deal.meetingId}`],
    ['PATCH', `/meetings/${deal.meetingId}`, { title: 'Novo titulo' }],
    ['GET', `/meetings/${deal.meetingId}/transcript`],
    ['GET', `/meetings/${deal.meetingId}/recording/link`],
    ['POST', `/meetings/${deal.meetingId}/analysis`],
    ['POST', `/meetings/${deal.meetingId}/summary-send`],
    ['GET', `/crm/contacts/${deal.contactId}`],
    ['PATCH', `/crm/contacts/${deal.contactId}`, { jobTitle: 'Dono' }],
    ['GET', `/crm/companies/${deal.companyId}`],
    ['PATCH', `/crm/companies/${deal.companyId}`, { city: 'Rio' }],
    // Last: these take things away.
    ['DELETE', `/leads/${deal.id}/contacts/${deal.contactId}`],
    ['DELETE', `/leads/${deal.id}/files/${deal.fileId}`],
  ];
  return table.map(([method, url, payload, skipOwn]) => ({
    method: method as 'GET' | 'POST' | 'PATCH' | 'DELETE',
    url,
    payload,
    skipOwn: skipOwn === true,
    session,
  }));
};

describe("opening another seller's lead by its URL", () => {
  for (const [label, victim] of [
    ["another seller's", () => dealB],
    ['an ownerless', () => dealN],
  ] as const) {
    it(`answers 404 to a seller on every route of ${label} lead and its children`, async () => {
      const deal = victim();
      const failures: string[] = [];
      for (const route of routesOf(deal, sellerA)) {
        const response = await call(route.session, route.method, route.url, route.payload);
        if (response.statusCode !== 404)
          failures.push(
            `${route.method} ${route.url.replace(deal.id, ':lead')} -> ${response.statusCode}`,
          );
      }
      expect(failures).toEqual([]);
    });
  }

  it('no route changed anything on the lead the seller does not own', async () => {
    const lead = await db.query.leads.findFirst({ where: eq(leads.id, dealB.id) });
    expect(lead?.ownerEmployeeId).toBe(sellerB.id);
    const events = await db.select().from(leadEvents).where(eq(leadEvents.leadId, dealB.id));
    expect(events.filter((e) => e.actorEmployeeId === sellerA.id)).toEqual([]);
    const notes = await db.select().from(leadNotes).where(eq(leadNotes.leadId, dealB.id));
    expect(notes.map((n) => n.body)).toEqual(['anotacao Beta']);
  });

  it('the same routes on their own lead are never 404 or 403', async () => {
    const own = await makeDeal('Zeta', '21999990006', sellerA, sellerA);
    const failures: string[] = [];
    for (const route of routesOf(own, sellerA)) {
      if (route.skipOwn) continue;
      const response = await call(route.session, route.method, route.url, route.payload);
      if (response.statusCode === 404 || response.statusCode === 403)
        failures.push(
          `${route.method} ${route.url.replace(own.id, ':lead')} -> ${response.statusCode}`,
        );
    }
    expect(failures).toEqual([]);
  });

  it('the Admin opens every lead, the ownerless one included', async () => {
    for (const deal of [dealA, dealB, dealN]) {
      for (const url of [
        `/leads/${deal.id}`,
        `/leads/${deal.id}/files`,
        `/leads/${deal.id}/meetings`,
        `/meetings/${deal.meetingId}`,
        `/crm/contacts/${deal.contactId}`,
        `/crm/companies/${deal.companyId}`,
      ]) {
        expect((await call(admin, 'GET', url)).statusCode, url).toBe(200);
      }
    }
  });

  it('Diretoria reads every lead and edits none', async () => {
    for (const deal of [dealA, dealB, dealN]) {
      expect((await call(board, 'GET', `/leads/${deal.id}`)).statusCode).toBe(200);
      expect((await call(board, 'GET', `/leads/${deal.id}/files`)).statusCode).toBe(200);
      expect((await call(board, 'PATCH', `/leads/${deal.id}`, { won: null })).statusCode).toBe(403);
      expect(
        (await call(board, 'POST', `/leads/${deal.id}/notes`, { body: 'oi' })).statusCode,
      ).toBe(403);
    }
  });
});

describe('only the Admin changes the owner', () => {
  it('refuses a seller on their own lead, to someone else, to themself-less (nobody) and via the body of a task', async () => {
    const toOther = await call(sellerA, 'PATCH', `/leads/${dealA.id}`, {
      ownerEmployeeId: sellerB.id,
    });
    expect(toOther.statusCode).toBe(403);
    const toNobody = await call(sellerA, 'PATCH', `/leads/${dealA.id}`, { ownerEmployeeId: null });
    expect(toNobody.statusCode).toBe(403);
    const lead = await db.query.leads.findFirst({ where: eq(leads.id, dealA.id) });
    expect(lead?.ownerEmployeeId).toBe(sellerA.id);
    // A task handed to somebody else stays with the lead's owner.
    const task = await call(sellerA, 'POST', `/leads/${dealA.id}/tasks`, {
      title: 'passar adiante',
      dueAt: new Date(Date.now() + 86_400_000).toISOString(),
      assigneeEmployeeId: sellerB.id,
    });
    expect(task.statusCode).toBe(201);
    expect(text(task)).not.toContain(sellerB.id);
  });

  it('refuses a seller creating a lead for somebody else, and lets the Admin name the owner', async () => {
    const forOther = await call(sellerA, 'POST', '/leads', {
      name: 'Para o colega',
      phone: '21988880001',
      ownerEmployeeId: sellerB.id,
      pipeline: 'expansao',
    });
    expect(forOther.statusCode).toBe(403);
    const mine = await call(sellerA, 'POST', '/leads', {
      name: 'Meu lead novo',
      phone: '21988880002',
      pipeline: 'expansao',
    });
    expect(mine.statusCode).toBe(201);
    expect(mine.json<{ lead: { ownerEmployeeId: string } }>().lead.ownerEmployeeId).toBe(
      sellerA.id,
    );
    const named = await call(admin, 'POST', '/leads', {
      name: 'Lead do Beta',
      phone: '21988880003',
      ownerEmployeeId: sellerB.id,
      pipeline: 'expansao',
    });
    expect(named.statusCode).toBe(201);
    expect(named.json<{ lead: { ownerEmployeeId: string } }>().lead.ownerEmployeeId).toBe(
      sellerB.id,
    );
  });

  it('the Admin moves a lead to a seller, to nobody and back; the seller then loses or gains the URL', async () => {
    const lead = await makeDeal('Eps', '21999990005', sellerA, sellerA);
    expect((await call(sellerA, 'GET', `/leads/${lead.id}`)).statusCode).toBe(200);
    expect(
      (await call(admin, 'PATCH', `/leads/${lead.id}`, { ownerEmployeeId: null })).statusCode,
    ).toBe(200);
    expect((await call(sellerA, 'GET', `/leads/${lead.id}`)).statusCode).toBe(404);
    expect((await call(board, 'GET', `/leads/${lead.id}`)).statusCode).toBe(200);
    expect(
      (await call(admin, 'PATCH', `/leads/${lead.id}`, { ownerEmployeeId: sellerB.id })).statusCode,
    ).toBe(200);
    expect((await call(sellerB, 'GET', `/leads/${lead.id}`)).statusCode).toBe(200);
  });
});

describe('who may change the owner', () => {
  it('is the Admin only: Diretoria sees and talks on every lead but does not hand leads over', async () => {
    expect(canChangeLeadOwner(actorOf(admin))).toBe(true);
    expect(canChangeLeadOwner(actorOf(board))).toBe(false);
    expect(canChangeLeadOwner(actorOf(sellerA))).toBe(false);
    const byBoard = await call(board, 'PATCH', `/leads/${dealB.id}`, {
      ownerEmployeeId: sellerA.id,
    });
    expect(byBoard.statusCode).toBe(403);
    const lead = await db.query.leads.findFirst({ where: eq(leads.id, dealB.id) });
    expect(lead?.ownerEmployeeId).toBe(sellerB.id);
  });
});

describe("a new or imported lead never reaches into somebody else's", () => {
  it("POST /leads with the phone of another seller's or an ownerless lead is refused and writes nothing", async () => {
    for (const deal of [dealB, dealN]) {
      const before = await db.select().from(leadEvents).where(eq(leadEvents.leadId, deal.id));
      const response = await call(sellerA, 'POST', '/leads', {
        name: 'Tentando entrar',
        phone: deal.phone,
        pipeline: 'expansao',
      });
      expect(response.statusCode).toBe(409);
      expect(text(response)).not.toContain(deal.name);
      const after = await db.select().from(leadEvents).where(eq(leadEvents.leadId, deal.id));
      expect(after.length).toBe(before.length);
    }
    // The owner themself merges into their own lead, as before.
    const again = await call(sellerA, 'POST', '/leads', {
      name: 'Alfa de novo',
      phone: dealA.phone,
      pipeline: 'expansao',
    });
    expect(again.statusCode).toBe(200);
    // And the Admin may.
    const byAdmin = await call(admin, 'POST', '/leads', {
      name: 'Beta pelo admin',
      phone: dealB.phone,
      pipeline: 'expansao',
    });
    expect(byAdmin.statusCode).toBe(200);
  });

  it('a CSV import by a seller skips rows of other leads and rows naming another owner', async () => {
    const csv = [
      'Nome;Telefone;Dono',
      `Linha nova;21977770001;`,
      `Do Beta;${dealB.phone};`,
      `Sem dono;${dealN.phone};`,
      `Para o colega;21977770002;${'colega@exemplo.test'}`,
    ].join('\n');
    const mapping = { Nome: 'name', Telefone: 'phone', Dono: 'owner' };
    const preview = await call(sellerA, 'POST', '/leads/import/preview', { csv, mapping });
    expect(preview.statusCode).toBe(200);
    expect(text(preview)).not.toContain(dealB.id);
    expect(text(preview)).not.toContain(dealN.id);
    const run = await call(sellerA, 'POST', '/leads/import', {
      csv,
      mapping,
      pipeline: 'expansao',
    });
    expect(run.statusCode).toBe(201);
    const report = run.json<{ created: number; skipped: number }>();
    expect(report.created).toBe(1);
    expect(report.skipped).toBe(3);
    const created = await db.query.leads.findFirst({ where: eq(leads.phone, '5521977770001') });
    expect(created?.ownerEmployeeId).toBe(sellerA.id);
  });

  it('a seller cannot name an owner for the import; the Admin can', async () => {
    const csv = 'Nome;Telefone\nLinha;21977770009';
    const mapping = { Nome: 'name', Telefone: 'phone' };
    const refused = await call(sellerA, 'POST', '/leads/import', {
      csv,
      mapping,
      pipeline: 'expansao',
      ownerEmployeeId: sellerB.id,
    });
    // The seller's import lands on the seller, whatever the body says.
    expect(refused.statusCode).toBe(201);
    const row = await db.query.leads.findFirst({ where: eq(leads.phone, '5521977770009') });
    expect(row?.ownerEmployeeId).toBe(sellerA.id);
  });
});

describe('contacts and companies of other leads stay hidden', () => {
  it('a seller gets 409 without data when the person or the company is already in another lead', async () => {
    const contact = await call(sellerA, 'POST', '/crm/contacts', {
      name: 'Tentando',
      email: dealB.contactEmail,
    });
    expect(contact.statusCode).toBe(409);
    expect(text(contact)).not.toContain('Contato Beta');
    const company = await call(sellerA, 'POST', '/crm/companies', { name: dealB.companyName });
    expect(company.statusCode).toBe(409);
    expect(text(company)).not.toContain(dealB.companyId);
    const linked = await call(sellerA, 'POST', `/leads/${dealA.id}/contacts`, {
      contactId: dealB.contactId,
    });
    expect(linked.statusCode).toBe(404);
    const inline = await call(sellerA, 'POST', `/leads/${dealA.id}/contacts`, {
      contact: { name: 'Mesmo', email: dealB.contactEmail },
    });
    expect(inline.statusCode).toBe(409);
    const company2 = await call(sellerA, 'PATCH', `/leads/${dealA.id}/deal`, {
      companyId: dealB.companyId,
    });
    expect(company2.statusCode).toBe(400);
    // Nothing of the other record was filled or changed on the way.
    const admins = text(await call(admin, 'GET', `/crm/contacts/${dealB.contactId}`));
    expect(admins).toContain('Contato Beta');
    expect(admins).not.toContain('Tentando');
  });

  it("a seller's own new contact and company are theirs to see and link", async () => {
    const contact = await call(sellerA, 'POST', '/crm/contacts', {
      name: 'Novo do Alfa',
      email: 'novo.alfa@contato.test',
    });
    expect(contact.statusCode).toBe(201);
    const id = contact.json<{ contact: { id: string } }>().contact.id;
    expect((await call(sellerA, 'GET', `/crm/contacts/${id}`)).statusCode).toBe(200);
    expect((await call(sellerB, 'GET', `/crm/contacts/${id}`)).statusCode).toBe(404);
    const linked = await call(sellerA, 'POST', `/leads/${dealA.id}/contacts`, { contactId: id });
    expect(linked.statusCode).toBe(201);
  });
});

describe('what a seller needs not to see is not served', () => {
  it('the doors list (/crm/sources) is for the CRM manager only', async () => {
    expect((await call(sellerA, 'GET', '/crm/sources')).statusCode).toBe(403);
    expect((await call(admin, 'GET', '/crm/sources')).statusCode).toBe(200);
  });

  it('the RD user map and the owner-changing automation rules need the right to assign', async () => {
    expect(
      (await call(sellerA, 'PUT', '/leads/rd-users/1', { employeeId: sellerA.id })).statusCode,
    ).toBe(403);
    expect((await call(sellerA, 'POST', '/crm/automations/rules', {})).statusCode).toBe(403);
  });
});

describe("the deal's files follow the deal in the Drive", () => {
  it("the Drive does not list, search, open or version another deal's files, nor its folder", async () => {
    const tree = text(await call(sellerA, 'GET', '/drive/tree'));
    expect(tree).not.toContain('Beta Negocio');
    expect(tree).not.toContain('Gama Negocio');
    expect(tree).not.toContain('Alfa Negocio');
    expect(tree).not.toContain('Negociações');
    for (const url of [
      `/drive/files/${dealB.fileId}/link`,
      `/drive/files/${dealB.fileId}/versions`,
      `/drive/files/${dealN.fileId}/link`,
      `/drive/files/${dealA.fileId}/link`,
    ]) {
      expect((await call(sellerA, 'GET', url)).statusCode, url).toBe(404);
    }
    const search = text(await call(sellerA, 'GET', '/drive/search?q=contrato'));
    expect(search).not.toContain('contrato-');
    const trash = await call(sellerA, 'GET', '/drive/trash');
    expect(text(trash)).not.toContain('contrato-');
    for (const [method, url, payload] of [
      ['PATCH', `/drive/files/${dealB.fileId}`, { name: 'roubado.pdf' }],
      ['POST', `/drive/files/${dealB.fileId}/trash`, undefined],
    ] as const) {
      expect((await call(sellerA, method, url, payload)).statusCode, url).toBe(404);
    }
    // The Admin still sees the whole tree and every file.
    const adminTree = text(await call(admin, 'GET', '/drive/tree'));
    expect(adminTree).toContain('Beta Negocio');
    expect((await call(admin, 'GET', `/drive/files/${dealB.fileId}/link`)).statusCode).toBe(200);
  });

  it("a seller opens only their own deal's files, through the deal", async () => {
    const own = await call(sellerA, 'GET', `/leads/${dealA.id}/files/${dealA.fileId}/link`);
    expect(own.statusCode).toBe(200);
    expect(own.json<{ url: string }>().url).toBeTruthy();
    // A file of another deal, asked through their own deal or through the other deal: 404 both ways.
    expect(
      (await call(sellerA, 'GET', `/leads/${dealA.id}/files/${dealB.fileId}/link`)).statusCode,
    ).toBe(404);
    expect(
      (await call(sellerA, 'GET', `/leads/${dealB.id}/files/${dealB.fileId}/link`)).statusCode,
    ).toBe(404);
  });
});

describe('the WhatsApp permission follows the same owner rule', () => {
  it('a seller reaches only their own lead; Diretoria and the Admin reach every lead', async () => {
    const seller = actorOf(sellerA);
    expect(await leadInScope(db, seller, dealA.id, 'leads.whatsapp')).not.toBeNull();
    expect(await leadInScope(db, seller, dealB.id, 'leads.whatsapp')).toBeNull();
    expect(await leadInScope(db, seller, dealN.id, 'leads.whatsapp')).toBeNull();
    for (const session of [board, admin]) {
      for (const deal of [dealA, dealB, dealN]) {
        expect(await leadInScope(db, actorOf(session), deal.id, 'leads.whatsapp')).not.toBeNull();
      }
    }
    // Diretoria reads and talks on every lead, but does not edit a deal.
    expect(await leadInScope(db, actorOf(board), dealB.id, 'leads.write')).toBeNull();
    expect(leadOwnerFilter(actorOf(board), 'leads.write')).toBe(board.id);
    expect(leadOwnerFilter(actorOf(board), 'leads.read')).toBeUndefined();
    expect(leadOwnerFilter(actorOf(board), 'leads.whatsapp')).toBeUndefined();
    expect(leadOwnerFilter(actorOf(sellerB), 'leads.whatsapp')).toBe(sellerB.id);
  });
});
