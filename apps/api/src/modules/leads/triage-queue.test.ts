import { WINGS_CLIENT_ID } from '@wings/shared';
import { and, eq, isNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../app.js';
import type { Database } from '../../db/client.js';
import {
  crmDistributionMembers,
  crmNotifications,
  leadEvents,
  leadTriageQueue,
  leads,
  waContacts,
  waConversations,
  waMessages,
} from '../../db/schema/index.js';
import { loadEnv } from '../../env.js';
import { createTestDatabase, type TestDatabase } from '../../test/db.js';
import { createEmployee, TEST_CPF_KEY, TEST_INDEX_KEY } from '../../test/factories.js';
import { upsertLead } from './service.js';
import {
  TRIAGE_CLAIM_TIMEOUT_MS,
  TRIAGE_GRACE_MS,
  TRIAGE_MAX_ATTEMPTS,
  claimTriage,
  enqueueTriage,
} from './triage-queue.js';
import { configureLeadTriage, type TriageTarget } from './triage-schedule.js';
import {
  resumeLeadTriage,
  runTriage,
  startLeadTriageResume,
  type JevClient,
  type TriageVerdict,
} from './triage.js';

/**
 * The Jev triage never loses what waits for it (docs/leads/triagem-jev.md, "Nada fica sem funil
 * e sem aviso"): the door writes the waiting row with the lead, an error ends in the usual
 * notice, and a restart in the middle is picked up again by the queue. The Jev is simulated.
 */

let harness: TestDatabase;
let db: Database;
let app: FastifyInstance;

const silentLog = {
  warn: () => undefined,
  info: () => undefined,
  error: () => undefined,
  debug: () => undefined,
  child: () => silentLog,
} as unknown as FastifyInstance['log'];

function verdict(sector: TriageVerdict['sector'], confidence = 0.97): TriageVerdict {
  return {
    sector,
    confidence,
    probabilities: { [sector]: confidence },
    wantsHuman: 0.1,
    interest: 2,
    model: 'jev-1.13.0',
    inputTokens: 800,
  };
}

/** A Jev that answers from a queue, counts its calls, can be slow, and can fail by throwing. */
const answers: (TriageVerdict | null)[] = [];
let jevCalls = 0;
let jevDelayMs = 0;
let jevThrows = false;
const fakeJev: JevClient = {
  classify: async () => {
    jevCalls += 1;
    if (jevDelayMs > 0) await new Promise((done) => setTimeout(done, jevDelayMs));
    if (jevThrows) throw new Error('boom: the Jev client broke');
    return answers.shift() ?? null;
  },
};
const deps = { jev: fakeJev, log: silentLog };

const scheduled: TriageTarget[] = [];

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
    jev: fakeJev,
  });
  // The doors only record what they hand to the triage; each test runs it by hand.
  configureLeadTriage((target) => scheduled.push(target));
}, 60_000);

afterAll(async () => {
  configureLeadTriage(null);
  await app?.close();
  await harness?.drop();
});

// Each test sees only its own rows on the list: what earlier ones left open is closed.
beforeEach(async () => {
  await db
    .update(leadTriageQueue)
    .set({ doneAt: new Date(), outcome: 'done' })
    .where(isNull(leadTriageQueue.doneAt));
});

afterEach(() => {
  answers.length = 0;
  jevCalls = 0;
  jevDelayMs = 0;
  jevThrows = false;
  scheduled.length = 0;
});

const queueRowOf = async (target: TriageTarget) =>
  (
    await db
      .select()
      .from(leadTriageQueue)
      .where(
        'leadId' in target
          ? eq(leadTriageQueue.leadId, target.leadId)
          : eq(leadTriageQueue.conversationId, target.conversationId),
      )
  )[0];
const leadRow = async (id: string) => (await db.select().from(leads).where(eq(leads.id, id)))[0]!;
const noticesOf = (leadId: string) =>
  db.select().from(crmNotifications).where(eq(crmNotifications.leadId, leadId));
const minutes = (n: number) => n * 60_000;

/** A lead the site form left without a funnel, as the door makes it (and queues it). */
async function bornWithoutFunnel(tag: string) {
  const born = await upsertLead(db, {
    source: 'site_form',
    name: `Padeira ${tag}`,
    email: `${tag}@teste.invalid`,
    clientId: WINGS_CLIENT_ID,
    clientMapped: false,
    formAnswers: { 'Conte sobre o seu negócio': 'Padaria com 2 unidades, quero virar franquia' },
    event: { kind: 'lead.received.site_form' },
  });
  return born;
}

async function sellerInRotation(pipeline: 'formatacao' | 'expansao') {
  const seller = await createEmployee(db, {
    role: pipeline === 'formatacao' ? 'vendedor_formatacao' : 'vendedor_expansao',
    sector: 'comercial',
  });
  await db.insert(crmDistributionMembers).values({ pipeline, employeeId: seller.id, active: true });
  return seller;
}

describe('the door writes the waiting row with the lead', () => {
  it('a lead born without a funnel is on the list before anything runs, and the arrival notice waits for the triage', async () => {
    const born = await bornWithoutFunnel('porta1');
    expect(born.created).toBe(true);
    expect(born.triageQueued).toBe(true);
    expect(scheduled).toEqual([{ leadId: born.lead.id }]);
    expect(await queueRowOf({ leadId: born.lead.id })).toMatchObject({
      attempts: 0,
      claimedAt: null,
      doneAt: null,
    });
    expect(await noticesOf(born.lead.id)).toEqual([]);
  });

  it('a lead with a funnel, a stale one, an import and a repeat arrival are not on the list', async () => {
    const withFunnel = await upsertLead(db, {
      source: 'site_form',
      name: 'Com Funil',
      email: 'comfunil@teste.invalid',
      clientId: WINGS_CLIENT_ID,
      clientMapped: true,
      pipeline: 'formatacao',
      event: { kind: 'lead.received.site_form' },
    });
    expect(withFunnel.triageQueued).toBe(false);
    expect(await queueRowOf({ leadId: withFunnel.lead.id })).toBeUndefined();

    const stale = await upsertLead(db, {
      source: 'site_form',
      name: 'Antigo',
      email: 'antigo@teste.invalid',
      clientId: WINGS_CLIENT_ID,
      clientMapped: false,
      originCreatedAt: new Date(Date.now() - 3 * 86_400_000),
      event: { kind: 'lead.received.site_form' },
    });
    expect(stale.triageQueued).toBe(false);
    expect(await queueRowOf({ leadId: stale.lead.id })).toBeUndefined();

    const again = await bornWithoutFunnel('porta1');
    expect(again.created).toBe(false);
    expect(again.triageQueued ?? false).toBe(false);
  });

  it('with the triage off nothing is written and the usual notice goes out at the door', async () => {
    await createEmployee(db, { role: 'gerente_comercial', sector: 'comercial' });
    configureLeadTriage(null);
    try {
      const born = await bornWithoutFunnel('desligada');
      expect(born.triageQueued ?? false).toBe(false);
      expect(await queueRowOf({ leadId: born.lead.id })).toBeUndefined();
      expect((await noticesOf(born.lead.id)).map((n) => n.kind)).toContain('lead_unassigned');
    } finally {
      configureLeadTriage((target) => scheduled.push(target));
    }
  });
});

describe('an error ends in the usual notice, never in silence', () => {
  it('an unexpected error inside the triage sends the "lead sem dono" notice, records it and closes the row', async () => {
    const manager = await createEmployee(db, { role: 'gerente_comercial', sector: 'comercial' });
    const born = await bornWithoutFunnel('erro1');
    jevThrows = true;

    const ended = await runTriage(db, { leadId: born.lead.id }, deps);
    expect(ended).toBe('fallback');
    expect(jevCalls).toBe(1);

    const notices = await noticesOf(born.lead.id);
    expect(
      notices.filter((n) => n.kind === 'lead_unassigned').map((n) => n.recipientEmployeeId),
    ).toContain(manager.id);
    const event = await db.query.leadEvents.findFirst({
      where: and(eq(leadEvents.leadId, born.lead.id), eq(leadEvents.kind, 'lead.triaged')),
    });
    expect(event?.detail).toMatchObject({ outcome: 'fallback', reason: 'error' });
    expect(JSON.stringify(event?.detail)).not.toMatch(/boom|Padaria|Padeira/);
    expect(await queueRowOf({ leadId: born.lead.id })).toMatchObject({
      outcome: 'fallback',
      attempts: 1,
    });
    expect((await queueRowOf({ leadId: born.lead.id }))?.doneAt).not.toBeNull();
  });

  it('a conversation whose triage errs gets the team notice instead of waiting unseen', async () => {
    const manager = await createEmployee(db, { role: 'gerente_comercial', sector: 'comercial' });
    const { conversation } = await conversationWith('5541944440001', 'Quero uma franquia');
    await enqueueTriage(db, { conversationId: conversation.id });
    jevThrows = true;

    expect(await runTriage(db, { conversationId: conversation.id }, deps)).toBe('fallback');
    const mine = (
      await db.select().from(crmNotifications).where(eq(crmNotifications.kind, 'triage_handoff'))
    ).filter((n) => n.dedupeKey?.includes(conversation.id));
    expect(mine.map((n) => n.recipientEmployeeId)).toContain(manager.id);
    expect(mine[0]?.message).toContain('a triagem do Jev não terminou');
    expect((await queueRowOf({ conversationId: conversation.id }))?.outcome).toBe('fallback');
  });

  it('a lead a person placed meanwhile is left alone: the run ends without asking the Jev', async () => {
    const born = await bornWithoutFunnel('pessoa1');
    await db.update(leads).set({ pipeline: 'expansao' }).where(eq(leads.id, born.lead.id));
    expect(await runTriage(db, { leadId: born.lead.id }, deps)).toBe('ran');
    expect(jevCalls).toBe(0);
    expect((await queueRowOf({ leadId: born.lead.id }))?.outcome).toBe('done');
  });
});

describe('a restart in the middle is picked up again', () => {
  it('a row nobody finished is run by the resume once past the grace: the lead gets its funnel, owner and notice', async () => {
    const seller = await sellerInRotation('formatacao');
    const born = await bornWithoutFunnel('reinicio1');
    const target = { leadId: born.lead.id };
    answers.push(verdict('formatacao'));

    // The process died before the run: a row that is only a few seconds old is still its door's.
    const queuedAt = (await queueRowOf(target))!.queuedAt;
    expect(
      await resumeLeadTriage(db, deps, new Date(queuedAt.getTime() + TRIAGE_GRACE_MS - 5_000)),
    ).toBe(0);
    expect((await leadRow(born.lead.id)).pipeline).toBeNull();

    const later = new Date(queuedAt.getTime() + TRIAGE_GRACE_MS + 5_000);
    expect(await resumeLeadTriage(db, deps, later)).toBeGreaterThanOrEqual(1);
    expect(await leadRow(born.lead.id)).toMatchObject({
      pipeline: 'formatacao',
      ownerEmployeeId: seller.id,
    });
    expect((await noticesOf(born.lead.id)).map((n) => [n.kind, n.recipientEmployeeId])).toEqual([
      ['new_lead', seller.id],
    ]);
    expect(await queueRowOf(target)).toMatchObject({ outcome: 'done', attempts: 1 });
    // Closed: a later pass does nothing.
    expect(await resumeLeadTriage(db, deps, new Date(later.getTime() + minutes(10)))).toBe(0);
  });

  it('a run cut short while it held the row is taken again only after the claim timed out', async () => {
    const born = await bornWithoutFunnel('reinicio2');
    const target = { leadId: born.lead.id };
    const row = (await queueRowOf(target))!;
    const tookAt = new Date(row.queuedAt.getTime() + minutes(1));
    expect(await claimTriage(db, target, tookAt)).toMatchObject({ attempts: 1 });
    // Held: nobody else takes it.
    expect(await claimTriage(db, target, new Date(tookAt.getTime() + minutes(1)))).toBeNull();
    answers.push(verdict('expansao'));
    expect(await resumeLeadTriage(db, deps, new Date(tookAt.getTime() + minutes(1)))).toBe(0);
    expect(jevCalls).toBe(0);

    const after = new Date(tookAt.getTime() + TRIAGE_CLAIM_TIMEOUT_MS + 5_000);
    expect(await resumeLeadTriage(db, deps, after)).toBeGreaterThanOrEqual(1);
    expect(await leadRow(born.lead.id)).toMatchObject({ pipeline: 'expansao' });
    expect(await queueRowOf(target)).toMatchObject({ outcome: 'done', attempts: 2 });
  });

  it('a row taken too many times gets the usual notice and the Jev is not asked again', async () => {
    await createEmployee(db, { role: 'gerente_comercial', sector: 'comercial' });
    const born = await bornWithoutFunnel('reinicio3');
    const target = { leadId: born.lead.id };
    await db
      .update(leadTriageQueue)
      .set({ attempts: TRIAGE_MAX_ATTEMPTS, claimedAt: new Date(Date.now() - minutes(30)) })
      .where(eq(leadTriageQueue.leadId, born.lead.id));
    answers.push(verdict('formatacao'));

    expect(
      await resumeLeadTriage(db, deps, new Date(Date.now() + minutes(5))),
    ).toBeGreaterThanOrEqual(1);
    expect(jevCalls).toBe(0);
    expect((await leadRow(born.lead.id)).pipeline).toBeNull();
    expect((await noticesOf(born.lead.id)).map((n) => n.kind)).toContain('lead_unassigned');
    expect(await queueRowOf(target)).toMatchObject({ outcome: 'fallback' });
  });

  it('with the triage off, what was left on the list gets the usual notice instead of waiting for a switch', async () => {
    await createEmployee(db, { role: 'gerente_comercial', sector: 'comercial' });
    const born = await bornWithoutFunnel('desligou');
    answers.push(verdict('formatacao'));
    const later = new Date(Date.now() + minutes(5));

    expect(await resumeLeadTriage(db, null, later)).toBeGreaterThanOrEqual(1);
    expect(jevCalls).toBe(0);
    expect((await leadRow(born.lead.id)).pipeline).toBeNull();
    expect((await noticesOf(born.lead.id)).map((n) => n.kind)).toContain('lead_unassigned');
    expect((await queueRowOf({ leadId: born.lead.id }))?.outcome).toBe('fallback');
  });

  it('a conversation left on the list is made a deal by the resume', async () => {
    const seller = await sellerInRotation('expansao');
    const { conversation } = await conversationWith(
      '5541944440002',
      'Vi o anúncio da franquia de churros. Quanto preciso investir?',
    );
    await enqueueTriage(db, { conversationId: conversation.id });
    answers.push(verdict('expansao'));

    expect(
      await resumeLeadTriage(db, deps, new Date(Date.now() + minutes(5))),
    ).toBeGreaterThanOrEqual(1);
    const [adopted] = await db
      .select()
      .from(waConversations)
      .where(eq(waConversations.id, conversation.id));
    expect(adopted?.leadId).not.toBeNull();
    expect(await leadRow(adopted!.leadId!)).toMatchObject({
      pipeline: 'expansao',
      ownerEmployeeId: seller.id,
    });
    expect((await queueRowOf({ conversationId: conversation.id }))?.outcome).toBe('done');
  });

  it('a pass cut short after the deal was made finishes on the next one: adopted, owner told once', async () => {
    const seller = await sellerInRotation('expansao');
    const { contact, conversation } = await conversationWith(
      '5541944440003',
      'Quero abrir uma franquia em Niterói.',
    );
    await enqueueTriage(db, { conversationId: conversation.id });
    // The first pass made the deal and died before adopting the conversation or telling the owner.
    const made = await upsertLead(db, {
      source: 'whatsapp',
      reopenClosed: true,
      name: contact.profileName,
      phone: contact.phone,
      clientId: WINGS_CLIENT_ID,
      clientMapped: true,
      pipeline: 'expansao',
      event: { kind: 'lead.received.whatsapp' },
    });
    expect(made.created).toBe(true);
    answers.push(verdict('expansao'));

    expect(
      await resumeLeadTriage(db, deps, new Date(Date.now() + minutes(5))),
    ).toBeGreaterThanOrEqual(1);
    const [adopted] = await db
      .select()
      .from(waConversations)
      .where(eq(waConversations.id, conversation.id));
    expect(adopted?.leadId).toBe(made.lead.id);
    expect(
      (await noticesOf(made.lead.id)).filter((n) => n.recipientEmployeeId === seller.id),
    ).toHaveLength(1);
  });
});

describe('one run at a time', () => {
  it('two runs of the same target ask the Jev once: the second finds the row held', async () => {
    const seller = await sellerInRotation('formatacao');
    const born = await bornWithoutFunnel('duas');
    answers.push(verdict('formatacao'));
    jevDelayMs = 150;

    const results = await Promise.all([
      runTriage(db, { leadId: born.lead.id }, deps),
      runTriage(db, { leadId: born.lead.id }, deps),
    ]);
    expect([...results].sort()).toEqual(['ran', 'skipped']);
    expect(jevCalls).toBe(1);
    expect((await leadRow(born.lead.id)).ownerEmployeeId).toBe(seller.id);
  });

  it('a target that was never on the list is not run (a run without its row does nothing)', async () => {
    const ghost = await upsertLead(db, {
      source: 'manual',
      name: 'Sem Fila',
      email: 'semfila@teste.invalid',
      clientId: WINGS_CLIENT_ID,
      clientMapped: true,
      event: { kind: 'lead.created' },
    });
    expect(await runTriage(db, { leadId: ghost.lead.id }, deps)).toBe('skipped');
    expect(jevCalls).toBe(0);
  });
});

describe('the loop that resumes', () => {
  it('runs a pass after its first delay and stops when told', async () => {
    await createEmployee(db, { role: 'gerente_comercial', sector: 'comercial' });
    const born = await bornWithoutFunnel('laco');
    // Everything on the list so far is old enough for the loop to take it.
    await db
      .update(leadTriageQueue)
      .set({ queuedAt: new Date(Date.now() - minutes(10)) })
      .where(eq(leadTriageQueue.leadId, born.lead.id));
    answers.push(verdict('formatacao'));
    const stop = startLeadTriageResume({
      db,
      deps,
      log: silentLog,
      firstMs: 10,
      everyMs: 60_000,
    });
    try {
      for (let i = 0; i < 100 && !(await queueRowOf({ leadId: born.lead.id }))?.doneAt; i++)
        await new Promise((done) => setTimeout(done, 50));
      expect((await queueRowOf({ leadId: born.lead.id }))?.doneAt).not.toBeNull();
    } finally {
      stop();
    }
  });
});

/** An unmatched conversation with one inbound text, as the WhatsApp door leaves it with Sofia off. */
async function conversationWith(phone: string, text: string) {
  const [contact] = await db
    .insert(waContacts)
    .values({ phone, profileName: 'Contato Teste' })
    .returning();
  const [conversation] = await db
    .insert(waConversations)
    .values({ contactId: contact!.id, leadId: null, attendance: 'waiting_human' })
    .returning();
  await db.insert(waMessages).values({
    conversationId: conversation!.id,
    contactId: contact!.id,
    leadId: null,
    direction: 'in',
    author: 'contact',
    kind: 'text',
    text,
    waTimestamp: new Date(),
  });
  return { contact: contact!, conversation: conversation! };
}
