import { SESSION_COOKIE } from '@wings/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../app.js';
import type { Database } from '../../db/client.js';
import {
  adAccounts,
  adAds,
  adCampaigns,
  metaLeadForms,
  metaLeadgenEvents,
} from '../../db/schema/index.js';
import { loadEnv } from '../../env.js';
import { createTestDatabase, type TestDatabase } from '../../test/db.js';
import { createEmployee, TEST_CPF_KEY, TEST_INDEX_KEY } from '../../test/factories.js';
import {
  enqueueMetaLeadgenEvents,
  metaFailureReason,
  processMetaLeadgenEvents,
} from './meta-intake.js';

/**
 * "Eventos que falharam" in Integrações → Meta Lead Ads: the events that gave
 * up, with when, form, campaign and the reason in plain Portuguese. Everything
 * is made-up sample data; nothing reaches Meta.
 */

let harness: TestDatabase;
let db: Database;
let app: FastifyInstance;
const logs: Record<string, unknown>[] = [];

const PERSON_NAME = 'Pessoa Que Nao Deve Aparecer';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** The Graph answer for a form that came with a name and nothing to call. */
const graphWithoutContact = (async () =>
  json({
    id: 'x',
    created_time: '2026-10-10T23:23:00+0000',
    field_data: [{ name: 'full_name', values: [PERSON_NAME] }],
    form_id: 'form-sem-contato',
    ad_id: 'ad-espelhado',
    campaign_id: 'camp-1',
    campaign_name: 'Campanha do Graph',
  })) as unknown as typeof fetch;

async function loginAs(role: 'admin_master' | 'vendedor_expansao') {
  const person = await createEmployee(db, {
    role,
    sector: role === 'admin_master' ? 'diretoria' : 'comercial',
  });
  const login = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { email: person.email, password: person.password },
  });
  return { [SESSION_COOKIE]: login.cookies.find((c) => c.name === SESSION_COOKIE)!.value };
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
    }),
    db,
  });
}, 60_000);

afterAll(async () => {
  await app?.close();
  await harness?.drop();
});

describe('metaFailureReason', () => {
  it('reads a lead with nothing to call as a warning and every other code as an error', () => {
    expect(metaFailureReason('no_contact_data')).toEqual({
      code: 'no_contact_data',
      label: 'Sem telefone nem e-mail',
      severity: 'warning',
    });
    for (const code of ['no_token', 'graph_unreachable', 'lead_missing', 'error', null]) {
      expect(metaFailureReason(code).severity).toBe('error');
    }
  });

  it('says what the Meta answered, in words, and keeps an unknown code visible', () => {
    expect(metaFailureReason('graph_400').label).toBe('Erro da Meta (erro 400)');
    expect(metaFailureReason('graph_403').label).toBe(
      'A Meta recusou a chave de leitura (erro 403)',
    );
    expect(metaFailureReason('graph_404').label).toBe('A Meta não encontrou esse lead (erro 404)');
    expect(metaFailureReason('graph_unreachable').label).toBe('Não foi possível falar com a Meta');
    expect(metaFailureReason(null).label).toBe('Sem motivo registrado');
    expect(metaFailureReason('coisa_nova').label).toBe('Motivo desconhecido (coisa_nova)');
  });
});

describe('GET /crm/meta-leads/failed', () => {
  it('lists the failed events with date, form, campaign and reason, and nothing about a person', async () => {
    // The ad mirror: an ad of a campaign, and a form the periodic read has named.
    const [account] = await db
      .insert(adAccounts)
      .values({ platform: 'meta', externalId: 'act_1', name: 'Conta de teste' })
      .returning();
    const [campaign] = await db
      .insert(adCampaigns)
      .values({ adAccountId: account!.id, externalId: 'camp-1', name: 'Campanha Espelhada' })
      .returning();
    await db.insert(adAds).values({
      adAccountId: account!.id,
      campaignId: campaign!.id,
      externalId: 'ad-espelhado',
      name: 'Anúncio de teste',
    });
    await db.insert(metaLeadForms).values({
      formId: 'form-sem-contato',
      pageId: 'page-1',
      name: 'Formulário Exemplo',
    });

    // 1. The real path: a lead that came with a name and no phone or e-mail.
    await enqueueMetaLeadgenEvents(db, [
      {
        leadgenId: '1082808061389189',
        formId: 'form-sem-contato',
        pageId: 'page-1',
        adId: 'ad-espelhado',
        adgroupId: null,
        createdTime: new Date('2026-10-10T23:23:00Z'),
        raw: null,
      },
    ]);
    const run = await processMetaLeadgenEvents({
      db,
      accessToken: 'chave-de-teste',
      rdCrmToken: null,
      expansionOwnerId: null,
      rdCopyEnabled: false,
      graphFetch: graphWithoutContact,
      log: (facts) => logs.push(facts),
    });
    expect(run).toMatchObject({ processed: 1, failed: 1 });

    // 2. A Graph refusal on an older event whose ad the mirror does not know.
    await db.insert(metaLeadgenEvents).values({
      leadgenId: '900002',
      formId: 'form-desconhecido',
      adId: 'ad-fora-do-espelho',
      createdTime: new Date('2026-10-05T12:00:00Z'),
      status: 'failed',
      attempts: 1,
      lastError: 'graph_403',
    });
    // 3. An event Meta sent with no time, form or ad: the arrival time stands in.
    await db.insert(metaLeadgenEvents).values({
      leadgenId: '900003',
      receivedAt: new Date('2026-10-08T09:00:00Z'),
      status: 'failed',
      attempts: 8,
      lastError: 'error',
    });
    // Not failures: one done, one still waiting for its next try.
    await db.insert(metaLeadgenEvents).values([
      { leadgenId: '900004', status: 'done' },
      { leadgenId: '900005', status: 'pending', attempts: 1, lastError: 'graph_500' },
    ]);

    const cookies = await loginAs('admin_master');
    const response = await app.inject({ method: 'GET', url: '/crm/meta-leads/failed', cookies });
    expect(response.statusCode).toBe(200);
    const body = response.json<{ total: number; items: Record<string, unknown>[] }>();
    expect(body.total).toBe(3);
    expect(body.items.map((item) => item.leadgenId)).toEqual([
      '1082808061389189',
      '900003',
      '900002',
    ]);

    expect(body.items[0]).toEqual({
      leadgenId: '1082808061389189',
      leadAt: '2026-10-10T23:23:00.000Z',
      formId: 'form-sem-contato',
      formName: 'Formulário Exemplo',
      adId: 'ad-espelhado',
      campaignName: 'Campanha Espelhada',
      attempts: 1,
      reason: { code: 'no_contact_data', label: 'Sem telefone nem e-mail', severity: 'warning' },
    });
    expect(body.items[1]).toMatchObject({
      leadAt: '2026-10-08T09:00:00.000Z',
      formId: null,
      formName: null,
      adId: null,
      campaignName: null,
      reason: { code: 'error', severity: 'error' },
    });
    expect(body.items[2]).toMatchObject({
      formId: 'form-desconhecido',
      formName: null,
      campaignName: null,
      reason: { code: 'graph_403', severity: 'error' },
    });

    // The person was never stored, never answered and never logged.
    expect(response.body).not.toContain(PERSON_NAME);
    expect(JSON.stringify(logs)).not.toContain(PERSON_NAME);
    expect(JSON.stringify(logs)).not.toContain('Pessoa');
  });

  it('caps the list but still counts every failure', async () => {
    await db.insert(metaLeadgenEvents).values(
      Array.from({ length: 52 }, (_, index) => ({
        leadgenId: `bulk-${index}`,
        status: 'failed',
        lastError: 'graph_500',
        receivedAt: new Date(Date.UTC(2026, 9, 1, 0, index)),
      })),
    );
    const cookies = await loginAs('admin_master');
    const response = await app.inject({ method: 'GET', url: '/crm/meta-leads/failed', cookies });
    const body = response.json<{ total: number; items: unknown[] }>();
    expect(body.total).toBe(55);
    expect(body.items).toHaveLength(50);
  });

  it('answers only to integrations.manage, and only to a GET', async () => {
    const seller = await loginAs('vendedor_expansao');
    const denied = await app.inject({
      method: 'GET',
      url: '/crm/meta-leads/failed',
      cookies: seller,
    });
    expect(denied.statusCode).toBe(403);

    const anonymous = await app.inject({ method: 'GET', url: '/crm/meta-leads/failed' });
    expect(anonymous.statusCode).toBe(401);

    const admin = await loginAs('admin_master');
    const post = await app.inject({
      method: 'POST',
      url: '/crm/meta-leads/failed',
      cookies: admin,
    });
    expect(post.statusCode).toBe(404);
  });
});
