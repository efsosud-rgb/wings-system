import { SESSION_COOKIE, type ConversionsPanel } from '@wings/shared';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../app.js';
import type { Database } from '../../db/client.js';
import {
  adConversionSends,
  auditLog,
  crmStages,
  leads,
  leadStageHistory,
} from '../../db/schema/index.js';
import { loadEnv } from '../../env.js';
import { createTestDatabase, type TestDatabase } from '../../test/db.js';
import { createEmployee, TEST_CPF_KEY, TEST_INDEX_KEY } from '../../test/factories.js';

let harness: TestDatabase;
let db: Database;
let app: FastifyInstance;
let stageId: string;

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
      CRM_CONVERSIONS_META_ENABLED: 'true',
      CRM_CONVERSIONS_SINCE: '2026-10-20',
    }),
    db,
    now: () => new Date('2026-11-02T12:00:00.000Z'),
  });
  const [stage] = await db
    .insert(crmStages)
    .values({ pipeline: 'expansao', name: 'Proposta enviada (teste)', position: 5 })
    .returning();
  stageId = stage!.id;
}, 60_000);

afterAll(async () => {
  await app?.close();
  await harness?.drop();
});

async function cookiesFor(role: 'admin_master' | 'marketing' | 'vendedor_expansao') {
  const employee = await createEmployee(db, {
    role,
    sector:
      role === 'admin_master' ? 'diretoria' : role === 'marketing' ? 'marketing' : 'comercial',
  });
  const login = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { email: employee.email, password: employee.password },
  });
  const token = login.cookies.find((c) => c.name === SESSION_COOKIE)?.value;
  if (!token) throw new Error('login failed in setup');
  return { [SESSION_COOKIE]: token };
}

const mapping = (overrides: Record<string, unknown> = {}) => ({
  stageId,
  platform: 'meta',
  eventName: 'proposta_enviada',
  active: true,
  ...overrides,
});

describe('closing the loop panel', () => {
  it('only ads.approve chooses which stage becomes which event, and it is audited', async () => {
    const marketing = await cookiesFor('marketing');
    const refused = await app.inject({
      method: 'PUT',
      url: '/ads/conversions/mappings',
      cookies: marketing,
      payload: mapping(),
    });
    expect(refused.statusCode).toBe(403);

    const admin = await cookiesFor('admin_master');
    const noAction = await app.inject({
      method: 'PUT',
      url: '/ads/conversions/mappings',
      cookies: admin,
      payload: mapping({ platform: 'google' }),
    });
    expect(noAction.statusCode).toBe(400);

    const saved = await app.inject({
      method: 'PUT',
      url: '/ads/conversions/mappings',
      cookies: admin,
      payload: mapping(),
    });
    expect(saved.statusCode).toBe(200);
    const id = saved.json().mapping.id as string;
    expect(saved.json().mapping).toMatchObject({
      stageName: 'Proposta enviada (teste)',
      active: true,
    });
    const [audit] = await db.select().from(auditLog).where(eq(auditLog.entityId, id));
    expect(audit).toMatchObject({ action: 'ad_conversion.mapping_saved' });

    // Saving again changes the same row (renaming the event keeps the stage's id).
    const renamed = await app.inject({
      method: 'PUT',
      url: '/ads/conversions/mappings',
      cookies: admin,
      payload: mapping({ eventName: 'proposta' }),
    });
    expect(renamed.json().mapping).toMatchObject({ id, eventName: 'proposta' });
  });

  it('shows counts and codes per platform, never a lead', async () => {
    const [lead] = await db
      .insert(leads)
      .values({ source: 'meta_lead_ads', externalId: '1234567890123999', phone: '5521987659999' })
      .returning();
    const [history] = await db
      .insert(leadStageHistory)
      .values({ leadId: lead!.id, toStageId: stageId, source: 'wings' })
      .returning();
    const base = {
      leadId: lead!.id,
      stageId,
      historyId: history!.id,
      eventName: 'proposta',
      eventTime: new Date(),
    };
    await db.insert(adConversionSends).values([
      { ...base, platform: 'meta', state: 'failed', lastError: 'http_400:100' },
      { ...base, platform: 'google', state: 'skipped', skipReason: 'no_identifier' },
    ]);

    const seller = await cookiesFor('vendedor_expansao');
    const denied = await app.inject({ method: 'GET', url: '/ads/conversions', cookies: seller });
    expect(denied.statusCode).toBe(403);

    const response = await app.inject({
      method: 'GET',
      url: '/ads/conversions',
      cookies: await cookiesFor('marketing'),
    });
    expect(response.statusCode).toBe(200);
    const panel = response.json() as ConversionsPanel;
    expect(panel.since).toBe('2026-10-20T03:00:00.000Z');
    expect(panel.hashedEnabled).toBe(false);
    expect(panel.googleValidateOnly).toBe(true);
    const meta = panel.platforms.find((p) => p.platform === 'meta')!;
    expect(meta).toMatchObject({
      enabled: true,
      missing: ['CRM_CONVERSIONS_META_DATASET_ID', 'META_CAPI_TOKEN'],
      failed: 1,
      errors: [{ code: 'http_400:100', count: 1 }],
    });
    const google = panel.platforms.find((p) => p.platform === 'google')!;
    expect(google).toMatchObject({
      enabled: false,
      skipped: 1,
      skips: [{ reason: 'no_identifier', count: 1 }],
    });
    const text = response.body;
    for (const personal of [lead!.id, lead!.phone!, lead!.externalId!]) {
      expect(text).not.toContain(personal);
    }
  });
});
