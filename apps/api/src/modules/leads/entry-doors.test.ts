import { addBusinessHours, WINGS_CLIENT_ID } from '@wings/shared';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../../app.js';
import type { Database } from '../../db/client.js';
import {
  crmDistributionMembers,
  crmStages,
  leadSourceRules,
  leadTasks,
  leads,
} from '../../db/schema/index.js';
import { loadEnv } from '../../env.js';
import { loadHolidays } from '../../lib/holidays.js';
import { freezeClockAtMinuteEnd, WORKING_MINUTE } from '../../test/clock.js';
import { createTestDatabase, type TestDatabase } from '../../test/db.js';
import { createEmployee, TEST_CPF_KEY, TEST_INDEX_KEY } from '../../test/factories.js';

/**
 * Every door a new lead comes through lands it in the right funnel, in that
 * funnel's entry stage, with an owner from the rotation, a first-contact task
 * due in one working hour and the campaign it came from, even on a database
 * whose stage list is empty (production's first day) or where stages learned
 * from RD share the entry's position.
 */

const RD_SECRET = 'rd-secret-with-enough-length-doors';

let harness: TestDatabase;
let db: Database;
let app: FastifyInstance;
let expansionSeller: string;
let formatSeller: string;

function captchaFetch() {
  return (async () =>
    new Response(JSON.stringify({ success: true, 'error-codes': [] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch;
}

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
      TURNSTILE_SITE_KEY: '0x4AAAAAAA-site',
      TURNSTILE_SECRET_KEY: '0x4AAAAAAA-secret',
    }),
    db,
    captchaFetch: captchaFetch(),
  });
  expansionSeller = (await createEmployee(db, { role: 'vendedor_expansao', sector: 'comercial' }))
    .id;
  formatSeller = (await createEmployee(db, { role: 'vendedor_formatacao', sector: 'comercial' }))
    .id;
  await db.insert(crmDistributionMembers).values([
    { pipeline: 'expansao', employeeId: expansionSeller },
    { pipeline: 'formatacao', employeeId: formatSeller },
  ]);
  await db.insert(leadSourceRules).values([
    { kind: 'landing_page', pattern: 'lp-porta-exp', pipeline: 'expansao', brand: 'Marca Porta' },
    {
      kind: 'landing_page',
      pattern: 'lp-porta-fmt',
      pipeline: 'formatacao',
      clientId: WINGS_CLIENT_ID,
      siteFormEnabled: true,
    },
  ]);
}, 60_000);

afterAll(async () => {
  await app?.close();
  await harness?.drop();
});

afterEach(() => {
  vi.useRealTimers();
});

async function expectWorkedLead(
  lead: typeof leads.$inferSelect | undefined,
  expected: { pipeline: string; stage: string; owner: string; arrivedAt: Date },
) {
  expect(lead).toMatchObject({
    pipeline: expected.pipeline,
    stage: expected.stage,
    ownerEmployeeId: expected.owner,
    managedBy: 'wings',
  });
  const stage = await db.query.crmStages.findFirst({ where: eq(crmStages.id, lead!.stageId!) });
  expect(stage?.name).toBe(expected.stage);
  const tasks = await db.select().from(leadTasks).where(eq(leadTasks.leadId, lead!.id));
  expect(tasks).toHaveLength(1);
  expect(tasks[0]).toMatchObject({ kind: 'first_contact', assigneeEmployeeId: expected.owner });
  // From the instant the door read, not from created_at: the database stamps that at the start of
  // its transaction, a moment earlier, and the deadline is rounded to the minute.
  expect(tasks[0]!.dueAt).toEqual(addBusinessHours(expected.arrivedAt, 1, await loadHolidays(db)));
}

describe('the doors a new lead comes through', () => {
  it('RD webhook on an empty stage list: the entry stage is made, never a lead without a stage', async () => {
    expect(
      await db.select().from(crmStages).where(eq(crmStages.pipeline, 'expansao')),
    ).toHaveLength(0);
    const trafficSource = `encoded_${Buffer.from(
      JSON.stringify({
        current_session: {
          value:
            'https://franquia.example.com/lp-porta-exp?utm_source=fb&utm_medium=cpc&utm_campaign=120200000001&utm_content=120200000003&utm_term=120200000002',
        },
      }),
    ).toString('base64')}`;
    const arrivedAt = freezeClockAtMinuteEnd(WORKING_MINUTE);
    const delivered = await app.inject({
      method: 'POST',
      url: '/integrations/rd-station/webhook',
      headers: { 'x-wings-webhook-secret': RD_SECRET },
      payload: {
        leads: [
          {
            uuid: 'rd-uuid-porta',
            email: 'porta.rd@example.com',
            last_conversion: {
              content: { conversion_identifier: 'lp-porta-exp', traffic_source: trafficSource },
            },
          },
        ],
      },
    });
    expect(delivered.statusCode).toBe(200);
    const lead = await db.query.leads.findFirst({ where: eq(leads.externalId, 'rd-uuid-porta') });
    await expectWorkedLead(lead, {
      pipeline: 'expansao',
      stage: 'Novo Contato',
      owner: expansionSeller,
      arrivedAt,
    });
    // The campaign it came from, by the platform's ids.
    expect(lead).toMatchObject({
      brand: 'Marca Porta',
      utmSource: 'facebook',
      adPlatform: 'meta',
      adCampaignExternalId: '120200000001',
      adSetExternalId: '120200000002',
      adExternalId: '120200000003',
    });
  });

  it('site form where RD stages share the entry position: the entry stage wins by name', async () => {
    // Learned from an RD archive funnel, at the same position and earlier in the alphabet.
    await db.insert(crmStages).values([
      { pipeline: 'formatacao', name: 'Reativar - 01/2026', position: 1 },
      { pipeline: 'formatacao', name: 'Sem contato', position: 1 },
    ]);
    const arrivedAt = freezeClockAtMinuteEnd(WORKING_MINUTE);
    const sent = await app.inject({
      method: 'POST',
      url: '/public/site-forms/lp-porta-fmt',
      payload: {
        name: 'Pessoa Porta',
        email: 'porta.site@example.com',
        phone: '(21) 98888-0001',
        consent: true,
        turnstileToken: 'good',
        page: 'https://staging.wingssystem.online/lp/lp-porta-fmt?utm_source=google&utm_medium=cpc&utm_campaign=23000000001',
      },
    });
    expect(sent.statusCode).toBeLessThan(300);
    const lead = await db.query.leads.findFirst({
      where: eq(leads.email, 'porta.site@example.com'),
    });
    await expectWorkedLead(lead, {
      pipeline: 'formatacao',
      stage: 'Sem contato',
      owner: formatSeller,
      arrivedAt,
    });
    expect(lead).toMatchObject({
      source: 'site_form',
      utmSource: 'google',
      adPlatform: 'google',
      adCampaignExternalId: '23000000001',
    });
  });
});
