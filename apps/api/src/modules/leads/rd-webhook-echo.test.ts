import { WINGS_CLIENT_ID } from '@wings/shared';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../app.js';
import type { Database } from '../../db/client.js';
import { expansionIntakeLedger, jobs, leadEvents, leads } from '../../db/schema/index.js';
import { loadEnv } from '../../env.js';
import { createTestDatabase, type TestDatabase } from '../../test/db.js';
import { TEST_CPF_KEY, TEST_INDEX_KEY } from '../../test/factories.js';
import { upsertLead } from './service.js';

/**
 * RD Marketing records a conversion on a contact every time RD Station CRM
 * changes its deal ("Negociação atualizada no RD Station CRM"). That is an echo
 * of the CRM, not a landing-page conversion: from a person the Wings does not
 * know it must not make a lead (it has no funnel, no stage, no owner and shows
 * on no board). For a person the Wings already has it keeps merging, as before.
 */

const RD_SECRET = 'rd-secret-with-enough-length-echo';
const ECHO = 'Negociação atualizada no RD Station CRM';

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
      RD_STATION_WEBHOOK_SECRET: RD_SECRET,
    }),
    db,
  });
}, 60_000);

afterAll(async () => {
  await app?.close();
  await harness?.drop();
});

// The body the RD screen webhook sends. Every value is made up.
const contactEvent = (identifier: string, contact: Record<string, unknown>) => ({
  event_type: 'WEBHOOK.CONVERTED',
  entity_type: 'CONTACT',
  event_timestamp: '2026-10-19T09:34:00.000-03:00',
  event_identifier: identifier,
  contact: { name: 'Pessoa Teste', legal_bases: [], ...contact },
});

const deliver = (payload: unknown) =>
  app.inject({
    method: 'POST',
    url: '/integrations/rd-station/webhook',
    headers: { 'x-wings-webhook-secret': RD_SECRET },
    payload: payload as Record<string, unknown>,
  });

const leadCount = async () => (await db.select().from(leads)).length;

describe('RD webhook: the echo of RD Station CRM', () => {
  it.each([
    [1, ECHO],
    [2, 'RD Station CRM'],
    [3, 'negociacao atualizada no rd station crm'],
  ])('does not make a lead of an unknown contact (case %i: "%s")', async (n, identifier) => {
    const before = await leadCount();
    const res = await deliver(
      contactEvent(identifier, {
        uuid: `rd-uuid-echo-${n}`,
        email: `eco.${n}@example.com`,
        personal_phone: `(11) 97777-010${n}`,
      }),
    );
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ leads: [] });
    expect(await leadCount()).toBe(before);
  });

  it('keeps merging the echo into a lead the Wings already has', async () => {
    const person = {
      uuid: 'rd-uuid-known',
      email: 'conhecida@example.com',
      personal_phone: '(11) 97777-0002',
    };
    const first = await deliver(contactEvent('lp-eco-conhecida', person));
    expect(first.statusCode).toBe(200);
    const known = await db.query.leads.findFirst({ where: eq(leads.externalId, 'rd-uuid-known') });
    expect(known).toBeDefined();
    const before = await leadCount();

    const echo = await deliver(contactEvent(ECHO, person));
    expect(echo.statusCode).toBe(200);
    expect(await leadCount()).toBe(before);
    const events = await db.select().from(leadEvents).where(eq(leadEvents.leadId, known!.id));
    expect(events.filter((event) => event.kind === 'lead.received.rd_station')).toHaveLength(2);
  });

  it('still makes a lead of a real landing-page conversion from an unknown contact', async () => {
    const before = await leadCount();
    const res = await deliver(
      contactEvent('lp-eco-nova', {
        uuid: 'rd-uuid-new',
        email: 'nova@example.com',
        personal_phone: '(11) 97777-0003',
      }),
    );
    expect(res.statusCode).toBe(200);
    expect(await leadCount()).toBe(before + 1);
  });

  describe('an echo from a person the Wings has from the RD CRM import', () => {
    const personOf = (n: number) => ({
      uuid: `rd-uuid-imported-${n}`,
      email: `importada.${n}@example.com`,
      personal_phone: `(11) 97777-020${n}`,
    });
    const researchOf = (leadId: string) =>
      db
        .select()
        .from(jobs)
        .where(and(eq(jobs.type, 'enrich_lead'), eq(jobs.input, { leadId })));

    const eventsOfKind = async (leadId: string, kind: string) =>
      (await db.select().from(leadEvents).where(eq(leadEvents.leadId, leadId))).filter(
        (event) => event.kind === kind,
      );

    // An imported deal (the RD mirror): no research was paid for, none of the page fields is set.
    const importedLead = async (n: number) => {
      const imported = await upsertLead(db, {
        source: 'rd_crm',
        name: 'Pessoa Importada',
        email: personOf(n).email,
        phone: `+551197777020${n}`,
        clientId: WINGS_CLIENT_ID,
        clientMapped: true,
        pipeline: 'formatacao',
        externalId: `deal-imported-${n}`,
        importBatchId: 'rd-crm-test-echo',
        skipResearch: true,
        event: { kind: 'lead.imported.rd_crm' },
      });
      return imported.lead;
    };

    it('queues no paid research and writes the echo as neither the page nor the conversion', async () => {
      const lead = await importedLead(1);
      expect(lead.enrichmentState).toBe('none');
      expect(lead.landingPage).toBeNull();

      const res = await deliver(contactEvent(ECHO, personOf(1)));
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ leads: [{ leadId: lead.id, created: false }] });

      const after = await db.query.leads.findFirst({ where: eq(leads.id, lead.id) });
      expect(after).toMatchObject({
        enrichmentState: 'none',
        enrichmentJobId: null,
        landingPage: null,
        conversionIdentifier: null,
      });
      expect(await researchOf(lead.id)).toHaveLength(0);
      const events = await db.select().from(leadEvents).where(eq(leadEvents.leadId, lead.id));
      expect(events.filter((event) => event.kind === 'research.queued')).toHaveLength(0);
      // The echo is still on the timeline, as before.
      expect(events.filter((event) => event.kind === 'lead.received.rd_station')).toHaveLength(1);
    });

    it('does not tie a deal the intake made for another page to the lead (the echo names no page)', async () => {
      const lead = await importedLead(3);
      await db.insert(expansionIntakeLedger).values({
        conversionKey: `${personOf(3).uuid}|lp-outra-pagina|2026-10-30`,
        target: 'formatacao',
        outcome: 'created',
        rdDealId: 'deal-from-intake-3',
      });
      const res = await deliver(contactEvent(ECHO, personOf(3)));
      expect(res.statusCode).toBe(200);
      const after = await db.query.leads.findFirst({ where: eq(leads.id, lead.id) });
      expect(after!.rdDealId).toBeNull();
      expect(await eventsOfKind(lead.id, 'rd.deal_linked')).toHaveLength(0);
    });

    it('still researches the same person when they convert on a real landing page later', async () => {
      const lead = await importedLead(2);
      const res = await deliver(contactEvent('lp-eco-real', personOf(2)));
      expect(res.statusCode).toBe(200);
      const after = await db.query.leads.findFirst({ where: eq(leads.id, lead.id) });
      expect(after!.enrichmentState).toBe('pending');
      expect(await researchOf(lead.id)).toHaveLength(1);
    });
  });
});
