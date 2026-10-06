import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  SESSION_COOKIE,
  WINGS_CLIENT_ID,
  type DriveUploadTicket,
  type LeadFile,
  type RoleKey,
} from '@wings/shared';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../app.js';
import type { Database } from '../../db/client.js';
import { driveFolders, leadEvents } from '../../db/schema/index.js';
import { loadEnv } from '../../env.js';
import { createTestDatabase, type TestDatabase } from '../../test/db.js';
import { createEmployee, TEST_CPF_KEY, TEST_INDEX_KEY } from '../../test/factories.js';
import { seedDriveTemplate, syncDriveFolders } from '../drive/folders.js';
import { folderNameFor } from './files.js';
import { upsertLead } from './service.js';

/**
 * Files of a deal: sent to the Drive under Comercial / Negociações / <deal>,
 * listed on the deal, removable from it without leaving the Drive; a seller
 * only on their own leads.
 */

let harness: TestDatabase;
let db: Database;
let app: FastifyInstance;
let dir: string;
type Session = { employeeId: string; cookies: Record<string, string> };
let seller: Session;
let other: Session;

const loginAs = async (role: RoleKey) => {
  const employee = await createEmployee(db, { role, sector: 'comercial' });
  const login = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { email: employee.email, password: employee.password },
  });
  const token = login.cookies.find((c) => c.name === SESSION_COOKIE)?.value;
  if (!token) throw new Error('login failed in setup');
  return { employeeId: employee.id, cookies: { [SESSION_COOKIE]: token } };
};

beforeAll(async () => {
  harness = await createTestDatabase();
  db = harness.db;
  dir = await mkdtemp(join(tmpdir(), 'wings-lead-files-'));
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
  seller = await loginAs('vendedor_expansao');
  other = await loginAs('vendedor_expansao');
}, 60_000);

afterAll(async () => {
  await app?.close();
  await harness?.drop();
  await rm(dir, { recursive: true, force: true });
});

const arrive = (name: string, phone: string, owner = seller.employeeId) =>
  upsertLead(db, {
    source: 'site_form',
    name,
    phone,
    email: null,
    clientId: WINGS_CLIENT_ID,
    clientMapped: false,
    pipeline: 'expansao',
    ownerEmployeeId: owner,
    distribute: false,
    skipResearch: true,
    company: null,
    event: { kind: 'lead.received.site_form' },
  });

async function send(session: Session, leadId: string, name: string, bytes: Buffer) {
  const asked = await app.inject({
    method: 'POST',
    url: `/leads/${leadId}/files/uploads`,
    cookies: session.cookies,
    payload: { name, mimeType: 'application/pdf', byteSize: bytes.length },
  });
  if (asked.statusCode !== 201) return { asked, file: null };
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
  return { asked, file: done.json<{ file: LeadFile }>().file };
}

const listed = async (session: Session, leadId: string) =>
  app.inject({ url: `/leads/${leadId}/files`, cookies: session.cookies });

describe('files of a deal', () => {
  it('sends a file to the Drive under Comercial / Negociações / <deal>, lists it and writes one event by id', async () => {
    const lead = await arrive('Padaria Sol', '21999990301');
    const { file } = await send(seller, lead.lead.id, 'proposta.pdf', Buffer.from('%PDF-1'));
    expect(file).toMatchObject({ name: 'proposta.pdf', mimeType: 'application/pdf', byteSize: 6 });

    const list = await listed(seller, lead.lead.id);
    expect(list.statusCode).toBe(200);
    expect(list.json<{ files: LeadFile[] }>().files.map((f) => f.name)).toEqual(['proposta.pdf']);

    const folders = await db.select({ path: driveFolders.path }).from(driveFolders);
    expect(folders.map((f) => f.path)).toContain('/Comercial/Negociações/Padaria Sol');

    const events = await db
      .select({ kind: leadEvents.kind, detail: leadEvents.detail })
      .from(leadEvents)
      .where(eq(leadEvents.leadId, lead.lead.id));
    expect(events.filter((e) => e.kind === 'lead.file_added')).toEqual([
      { kind: 'lead.file_added', detail: { fileId: file?.fileId } },
    ]);
    expect(JSON.stringify(events)).not.toContain('proposta');
  });

  it('a second deal of the same name gets its own folder, "(2)"', async () => {
    const first = await arrive('Mesma Marca', '21999990302');
    const second = await arrive('Mesma Marca', '21999990303');
    await send(seller, first.lead.id, 'a.pdf', Buffer.from('a'));
    await send(seller, second.lead.id, 'a.pdf', Buffer.from('b'));
    const folders = await db.select({ path: driveFolders.path }).from(driveFolders);
    expect(folders.map((f) => f.path)).toEqual(
      expect.arrayContaining([
        '/Comercial/Negociações/Mesma Marca',
        '/Comercial/Negociações/Mesma Marca (2)',
      ]),
    );
  });

  it('removes the file from the deal and leaves it in the Drive', async () => {
    const lead = await arrive('Com arquivo', '21999990304');
    const { file } = await send(seller, lead.lead.id, 'contrato.pdf', Buffer.from('c'));
    const removed = await app.inject({
      method: 'DELETE',
      url: `/leads/${lead.lead.id}/files/${file?.fileId}`,
      cookies: seller.cookies,
    });
    expect(removed.statusCode).toBe(204);
    expect((await listed(seller, lead.lead.id)).json<{ files: LeadFile[] }>().files).toEqual([]);
    const stillThere = await app.inject({
      url: `/drive/files/${file?.fileId}/link`,
      cookies: seller.cookies,
    });
    expect(stillThere.statusCode).toBe(200);
  });

  it("a seller neither lists nor sends files on another seller's deal", async () => {
    const lead = await arrive('De outro', '21999990305');
    expect((await listed(other, lead.lead.id)).statusCode).toBe(404);
    const { asked } = await send(other, lead.lead.id, 'x.pdf', Buffer.from('x'));
    expect(asked.statusCode).toBe(404);
  });

  it('names the folder without separators and never empty', () => {
    expect(folderNameFor('Café / Bar')).toBe('Café - Bar');
    expect(folderNameFor(null)).toBe('Negociação');
    expect(folderNameFor('  ')).toBe('Negociação');
  });
});
