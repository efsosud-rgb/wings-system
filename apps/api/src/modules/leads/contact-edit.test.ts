import { readdirSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  SESSION_COOKIE,
  WINGS_CLIENT_ID,
  type LeadContactChange,
  type RoleKey,
} from '@wings/shared';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../app.js';
import type { Database } from '../../db/client.js';
import {
  auditLog,
  contactOptOuts,
  crmContacts,
  leadContactChanges,
  leadEvents,
  leads,
} from '../../db/schema/index.js';
import { loadEnv } from '../../env.js';
import { createTestDatabase, type TestDatabase } from '../../test/db.js';
import { createEmployee, TEST_CPF_KEY, TEST_INDEX_KEY } from '../../test/factories.js';
import { contactBlock, recordContactOptOut } from './contact-block.js';
import { attachLeadContact } from './contacts.js';
import { upsertLead } from './service.js';

/**
 * Editing a lead's contact data on the ficha (t089), against the API with real sessions: validation,
 * who may edit, the history, and that the new number is what the rest of the system reads.
 * Made-up people only.
 */

let harness: TestDatabase;
let db: Database;
let app: FastifyInstance;
let dir: string;

type Session = { id: string; cookies: Record<string, string> };
let owner: Session;
let other: Session;
let admin: Session;
let manager: Session;
let board: Session;

const loginAs = async (role: RoleKey): Promise<Session> => {
  const employee = await createEmployee(db, { role, sector: 'comercial' });
  const login = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { email: employee.email, password: employee.password },
  });
  const token = login.cookies.find((c) => c.name === SESSION_COOKIE)?.value;
  if (!token) throw new Error('login failed in setup');
  return { id: employee.id, cookies: { [SESSION_COOKIE]: token } };
};

let seq = 0;
async function makeLead(
  ownerId: string | null,
  over: { phone?: string | null; email?: string | null } = {},
) {
  seq += 1;
  const { lead } = await upsertLead(db, {
    source: 'site_form',
    name: `Pessoa Teste ${seq}`,
    phone: over.phone === undefined ? `21 9${String(80000000 + seq)}` : over.phone,
    email: over.email === undefined ? `pessoa${seq}@exemplo.test` : over.email,
    clientId: WINGS_CLIENT_ID,
    clientMapped: false,
    pipeline: 'expansao',
    ownerEmployeeId: ownerId,
    distribute: false,
    skipResearch: true,
    company: null,
    event: { kind: 'lead.received.site_form' },
  });
  await attachLeadContact(db, lead, null);
  return lead;
}

beforeAll(async () => {
  harness = await createTestDatabase();
  db = harness.db;
  dir = await mkdtemp(join(tmpdir(), 'wings-contact-edit-'));
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
  owner = await loginAs('vendedor_expansao');
  other = await loginAs('vendedor_expansao');
  admin = await loginAs('admin_master');
  manager = await loginAs('gerente_comercial');
  board = await loginAs('diretoria');
}, 120_000);

afterAll(async () => {
  await app?.close();
  await harness?.drop();
  await rm(dir, { recursive: true, force: true });
});

const patch = (session: Session, leadId: string, payload: unknown) =>
  app.inject({
    method: 'PATCH',
    url: `/leads/${leadId}/contact`,
    cookies: session.cookies,
    payload: payload as never,
  });
const row = async (id: string) => (await db.query.leads.findFirst({ where: eq(leads.id, id) }))!;

describe('validation', () => {
  it('stores the phone as digits with 55 and the e-mail in lower case', async () => {
    const lead = await makeLead(owner.id);
    const res = await patch(owner, lead.id, {
      phone: '(11) 91234-5678',
      email: ' Novo.Contato@Exemplo.TEST ',
      instagram: '@Perfil.Teste',
      website: 'exemplo.test',
    });
    expect(res.statusCode).toBe(200);
    const saved = await row(lead.id);
    expect(saved.phone).toBe('5511912345678');
    expect(saved.email).toBe('novo.contato@exemplo.test');
    expect(saved.instagram).toBe('perfil.teste');
    expect(saved.website).toBe('https://exemplo.test/');
  });

  it('refuses an invalid phone or e-mail with the field named, and writes nothing', async () => {
    const lead = await makeLead(owner.id);
    const before = await row(lead.id);
    for (const [payload, field] of [
      [{ phone: '1234' }, 'phone'],
      [{ phone: '(10) 91234-5678' }, 'phone'],
      [{ email: 'sem-arroba' }, 'email'],
      [{ phone: '(11) 91234-5678', email: 'ruim@' }, 'email'],
    ] as const) {
      const res = await patch(owner, lead.id, payload);
      expect(res.statusCode).toBe(400);
      expect(res.json().field).toBe(field);
    }
    const after = await row(lead.id);
    expect(after.phone).toBe(before.phone);
    expect(after.email).toBe(before.email);
    expect(
      await db.select().from(leadContactChanges).where(eq(leadContactChanges.leadId, lead.id)),
    ).toEqual([]);
  });

  it('does not clear the last way to reach the person', async () => {
    const lead = await makeLead(owner.id);
    expect((await patch(owner, lead.id, { phone: null })).statusCode).toBe(200);
    const res = await patch(owner, lead.id, { email: null });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('no_contact_key');
    expect((await row(lead.id)).email).not.toBeNull();
  });
});

describe('who may edit', () => {
  it('the owner, a manager and the Admin may; Diretoria and another seller may not', async () => {
    const lead = await makeLead(owner.id);
    expect((await patch(owner, lead.id, { email: 'dono@exemplo.test' })).statusCode).toBe(200);
    expect((await patch(manager, lead.id, { email: 'gerente@exemplo.test' })).statusCode).toBe(200);
    expect((await patch(admin, lead.id, { email: 'admin@exemplo.test' })).statusCode).toBe(200);
    expect((await patch(board, lead.id, { email: 'diretoria@exemplo.test' })).statusCode).toBe(403);
    const refused = await patch(other, lead.id, { email: 'intruso@exemplo.test' });
    expect(refused.statusCode).toBe(404);
    expect((await row(lead.id)).email).toBe('admin@exemplo.test');
  });

  it('a seller cannot touch a lead nobody owns, and cannot read its history', async () => {
    const lead = await makeLead(null);
    expect((await patch(owner, lead.id, { email: 'x@exemplo.test' })).statusCode).toBe(404);
    const history = await app.inject({
      method: 'GET',
      url: `/leads/${lead.id}/contact-changes`,
      cookies: owner.cookies,
    });
    expect(history.statusCode).toBe(404);
  });
});

describe('history', () => {
  it('keeps who, when, the field and the value before, and shows it to who sees the lead', async () => {
    const lead = await makeLead(owner.id, { phone: '21 987650001', email: 'antigo@exemplo.test' });
    await patch(owner, lead.id, { phone: '(21) 98765-0002', email: 'novo@exemplo.test' });
    await patch(manager, lead.id, { phone: '(21) 98765-0003' });
    await patch(manager, lead.id, { phone: '(21) 98765-0003' }); // unchanged: no row
    const res = await app.inject({
      method: 'GET',
      url: `/leads/${lead.id}/contact-changes`,
      cookies: owner.cookies,
    });
    const { changes } = res.json<{ changes: LeadContactChange[] }>();
    expect(changes).toHaveLength(3);
    expect(changes[0]).toMatchObject({
      field: 'phone',
      from: '5521987650002',
      to: '5521987650003',
    });
    expect(changes.filter((c) => c.field === 'email')).toMatchObject([
      { from: 'antigo@exemplo.test', to: 'novo@exemplo.test' },
    ]);
    expect(changes.every((c) => c.actorName)).toBe(true);
    const stored = await db
      .select()
      .from(leadContactChanges)
      .where(eq(leadContactChanges.leadId, lead.id));
    expect(new Set(stored.map((c) => c.actorEmployeeId))).toEqual(new Set([owner.id, manager.id]));
  });

  it('puts no value on the timeline or in the audit log, only the field names', async () => {
    const lead = await makeLead(owner.id);
    await patch(owner, lead.id, { phone: '(21) 98765-0010', email: 'timeline@exemplo.test' });
    const events = await db
      .select()
      .from(leadEvents)
      .where(and(eq(leadEvents.leadId, lead.id), eq(leadEvents.kind, 'lead.contact_changed')));
    expect(events).toHaveLength(1);
    expect(events[0]!.actorEmployeeId).toBe(owner.id);
    const audit = await db.select().from(auditLog).where(eq(auditLog.entityId, lead.id));
    const entry = audit.find((a) => a.action === 'lead.contact_updated');
    expect(entry?.metadata).toEqual({ changed: ['phone', 'email'] });
    const text = JSON.stringify([events[0]!.detail, entry?.metadata]);
    expect(text).not.toMatch(/987650010|timeline@/);
  });

  it('no migration lets the read-only role (reports, BI) see the history table', () => {
    const dirName = join(import.meta.dirname, '../../../migrations');
    const sql = readdirSync(dirName)
      .filter((f) => f.endsWith('.sql'))
      .map((f) => readFileSync(join(dirName, f), 'utf8'))
      .join('\n');
    expect(sql).toContain('lead_contact_changes');
    expect(sql).not.toMatch(/GRANT[^;]*lead_contact_changes[^;]*wings_ro/i);
    expect(sql).not.toMatch(/VIEW[^;]*lead_contact_changes/i);
  });
});

describe('where the contact is used', () => {
  it('WhatsApp reads the new number; the deal main contact follows', async () => {
    const lead = await makeLead(owner.id, { phone: '21 987651001', email: 'zap@exemplo.test' });
    await patch(owner, lead.id, { phone: '(21) 98765-1002' });
    const page = await app.inject({
      method: 'GET',
      url: `/leads/${lead.id}/whatsapp`,
      cookies: owner.cookies,
    });
    expect(page.statusCode).toBe(200);
    expect(page.json().phone).toBe('5521987651002');
    const detail = await app.inject({
      method: 'GET',
      url: `/leads/${lead.id}`,
      cookies: owner.cookies,
    });
    expect(detail.json().lead.phone).toBe('5521987651002');
    expect(detail.json().lead.contacts[0].phone).toBe('5521987651002');
    const [contact] = await db
      .select()
      .from(crmContacts)
      .where(eq(crmContacts.phone, '5521987651002'));
    expect(contact).toBeDefined();
  });

  it('drops the stored check of a field that changed', async () => {
    const lead = await makeLead(owner.id);
    await db
      .update(leads)
      .set({ fieldChecks: { whatsapp: { status: 'confere' }, cnpj: { status: 'confere' } } })
      .where(eq(leads.id, lead.id));
    await patch(owner, lead.id, { phone: '(21) 98765-1100' });
    expect((await row(lead.id)).fieldChecks).toEqual({ cnpj: { status: 'confere' } });
  });
});

describe('another deal holds the number', () => {
  it('a seller is refused, without a word about the other deal; the Admin may', async () => {
    const mine = await makeLead(owner.id);
    const theirs = await makeLead(other.id, { phone: '21 987652001', email: 'deles@exemplo.test' });
    const byPhone = await patch(owner, mine.id, { phone: '(21) 98765-2001' });
    expect(byPhone.statusCode).toBe(409);
    expect(byPhone.body).not.toContain(theirs.id);
    expect((await patch(owner, mine.id, { email: 'deles@exemplo.test' })).statusCode).toBe(409);
    expect((await row(mine.id)).phone).not.toBe('5521987652001');
    expect((await patch(admin, mine.id, { phone: '(21) 98765-2001' })).statusCode).toBe(200);
  });
});

describe('não me contate follows the new keys', () => {
  it('fixing a number does not lift the block', async () => {
    const lead = await makeLead(owner.id, { phone: '21 987653001' });
    await recordContactOptOut(db, {
      leadId: lead.id,
      channels: ['whatsapp'],
      origin: 'crm',
      reason: 'pediu',
      createdBy: owner.id,
    });
    expect((await contactBlock(db, 'whatsapp', { leadId: lead.id })).blocked).toBe(true);
    await patch(owner, lead.id, { phone: '(21) 98765-3002' });
    expect((await contactBlock(db, 'whatsapp', { leadId: lead.id })).blocked).toBe(true);
    const keys = await db
      .select({ value: contactOptOuts.keyValue })
      .from(contactOptOuts)
      .where(eq(contactOptOuts.keyKind, 'phone'));
    expect(keys.map((k) => k.value)).toContain('5521987653002');
  });

  // The block written by one key only (no lead key) must reach the new value of that same key.
  // Each case has its own keys: the register is shared, so equal keys would let one case cover another.
  it.each([
    { origin: 'prospeccao', channel: 'instagram', kind: 'instagram' },
    { origin: 'instagram', channel: 'instagram', kind: 'instagram' },
    { origin: 'importacao', channel: 'email', kind: 'email' },
    { origin: 'crm', channel: 'phone', kind: 'phone' },
    { origin: 'prospeccao', channel: 'all', kind: 'email' },
  ] as const)(
    'keeps a $origin block on $channel written only by the $kind that changes',
    async (c) => {
      seq += 1;
      const tag = `${c.origin}${c.channel}${seq}`;
      const old = {
        instagram: `antigo.${tag}`,
        email: `antigo.${tag}@exemplo.test`,
        phone: `21 97${String(1000000 + seq)}`,
      };
      const lead = await makeLead(owner.id, {
        phone: c.kind === 'phone' ? old.phone : undefined,
        email: c.kind === 'email' ? old.email : undefined,
      });
      if (c.kind === 'instagram')
        await db.update(leads).set({ instagram: old.instagram }).where(eq(leads.id, lead.id));
      await recordContactOptOut(db, {
        ...(c.kind === 'instagram' ? { instagramUser: old.instagram } : { [c.kind]: old[c.kind] }),
        channels: [c.channel],
        origin: c.origin,
        reason: null,
        createdBy: null,
      });
      const asked = c.channel === 'all' ? c.kind : c.channel;
      expect((await contactBlock(db, asked, { leadId: lead.id })).blocked).toBe(true);

      const change = {
        instagram: { instagram: `@novo.${tag}` },
        email: { email: `novo.${tag}@exemplo.test` },
        phone: { phone: `(21) 96${String(1000000 + seq)}` },
      }[c.kind];
      expect((await patch(owner, lead.id, change)).statusCode).toBe(200);
      expect((await contactBlock(db, asked, { leadId: lead.id })).blocked).toBe(true);
    },
  );
});
