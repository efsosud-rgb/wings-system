import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../app.js';
import type { Database } from '../../db/client.js';
import { leadEvents, leads } from '../../db/schema/index.js';
import { loadEnv } from '../../env.js';
import { createTestDatabase, type TestDatabase } from '../../test/db.js';
import { TEST_CPF_KEY, TEST_INDEX_KEY } from '../../test/factories.js';

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
});
