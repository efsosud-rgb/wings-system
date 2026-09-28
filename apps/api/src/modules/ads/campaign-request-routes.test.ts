import { randomBytes } from 'node:crypto';
import { SESSION_COOKIE, type ApprovalDetail, type PendingGroup } from '@wings/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../app.js';
import type { Database } from '../../db/client.js';
import { eq, sql } from 'drizzle-orm';
import { adAccounts, marketingAudienceProfiles, WINGS_TENANT_ID } from '../../db/schema/index.js';
import { loadEnv } from '../../env.js';
import { createTestDatabase, type TestDatabase } from '../../test/db.js';
import { createEmployee, TEST_CPF_KEY, TEST_INDEX_KEY } from '../../test/factories.js';
import { openPeriod } from './budget-guard.js';

/**
 * "Lançar campanha" over HTTP: who may ask, what is refused before it reaches
 * an approver, and that the approver then sees the whole campaign.
 */

const TODAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(
  new Date(),
);

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
      SESSION_SECRET: randomBytes(48).toString('base64'),
      CPF_ENCRYPTION_KEY: TEST_CPF_KEY,
      CPF_INDEX_KEY: TEST_INDEX_KEY,
      APP_BASE_URL: 'https://staging.wingssystem.online',
    }),
    db,
  });

  const [account] = await db
    .insert(adAccounts)
    .values({ platform: 'meta', externalId: 'act_1234567890', name: 'Fly High' })
    .returning({ id: adAccounts.id });
  if (!account) throw new Error('failed');
  await openPeriod(db, {
    adAccountId: account.id,
    periodMonth: `${TODAY.slice(0, 7)}-01`,
    capCents: 400_000,
    usablePercent: 70,
  });
}, 60_000);

afterAll(async () => {
  await app?.close();
  await harness?.drop();
});

async function cookiesFor(role: 'admin_master' | 'marketing' | 'vendedor_expansao') {
  const employee = await createEmployee(db, {
    role,
    sector:
      role === 'vendedor_expansao' ? 'comercial' : role === 'marketing' ? 'marketing' : 'diretoria',
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

/** The smallest thing the header reader accepts as a PNG of the given size. */
function pngOf(width: number, height: number): Buffer {
  const bytes = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes, 0);
  bytes.writeUInt32BE(13, 8);
  bytes.write('IHDR', 12, 'latin1');
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
}

async function upload(cookies: Record<string, string>, body: Buffer, type = 'image/png') {
  return app.inject({
    method: 'POST',
    url: '/ads/creatives',
    cookies,
    headers: { 'content-type': type },
    payload: body,
  });
}

let creativeIds: [string, string];

async function draft(overrides: Record<string, unknown> = {}) {
  if (!creativeIds) {
    const cookies = await cookiesFor('marketing');
    const ids = await Promise.all(
      [1080, 1200].map(
        async (side) =>
          (await upload(cookies, pngOf(side, side))).json<{ creative: { id: string } }>().creative
            .id,
      ),
    );
    creativeIds = [ids[0] as string, ids[1] as string];
  }
  return {
    platform: 'meta',
    name: `Sacrifício ${randomBytes(3).toString('hex')}`,
    objective: 'lead',
    idealCustomerProfile: 'Empreendedor de 30 a 50 anos, com experiência em gestão.',
    reach: { states: ['SP'], cities: [{ name: 'Curitiba', state: 'PR' }] },
    formatKey: 'feed_square',
    destinationUrl: 'https://wingscompany.com.br/franquia',
    variations: [
      {
        creativeId: creativeIds[0],
        headline: 'Leve a Wings',
        primaryText: 'Fale com a gente.',
        callToAction: 'LEARN_MORE',
      },
      {
        creativeId: creativeIds[1],
        headline: 'Seja franqueado',
        primaryText: 'Suporte completo.',
        callToAction: 'CONTACT_US',
      },
    ],
    startDate: TODAY,
    endDate: TODAY,
    dailyBudgetCents: 600,
    utms: { utm_source: 'meta', utm_medium: 'paid_social', utm_campaign: 'x', utm_content: 'lead' },
    ageMin: 25,
    ageMax: 65,
    placements: { mode: 'automatic' },
    identity: { pageId: '104567890123456', instagramActorId: null },
    startPaused: true,
    ...overrides,
  };
}

describe('POST /ads/campaign-requests', () => {
  it('lets Marketing ask, and puts the whole campaign in front of the approver', async () => {
    const payload = await draft();
    const response = await app.inject({
      method: 'POST',
      url: '/ads/campaign-requests',
      cookies: await cookiesFor('marketing'),
      payload,
    });
    expect(response.statusCode).toBe(201);
    const { approvalId } = response.json<{ approvalId: string }>();

    const admin = await cookiesFor('admin_master');
    const detail = await app.inject({ url: `/ads/approvals/${approvalId}`, cookies: admin });
    const approval = detail.json<{ approval: ApprovalDetail }>().approval;
    expect(approval.changeKind).toBe('create_campaign');
    expect(approval.status).toBe('pending');
    expect(approval.campaignName).toBe(payload.name);
    expect(approval.campaignExternalId).toBe('');
    expect(approval.draft?.startPaused).toBe(true);
    expect(approval.draft?.variations).toHaveLength(2);
    // The switch is off in this environment: approving cannot lead to a write.
    expect(approval.executionAvailable).toBe(false);

    const list = await app.inject({ url: '/ads/approvals', cookies: admin });
    expect(
      list.json<{ approvals: { id: string }[] }>().approvals.some((a) => a.id === approvalId),
    ).toBe(true);
    const groups = await app.inject({ url: '/ads/approvals-groups', cookies: admin });
    expect(
      groups.json<{ groups: PendingGroup[] }>().groups.some((g) => g.campaignName === payload.name),
    ).toBe(true);
  });

  it('lets Marketing ask but not approve', async () => {
    const marketing = await cookiesFor('marketing');
    const created = await app.inject({
      method: 'POST',
      url: '/ads/campaign-requests',
      cookies: marketing,
      payload: await draft(),
    });
    const { approvalId } = created.json<{ approvalId: string }>();
    const decision = await app.inject({
      method: 'POST',
      url: `/ads/approvals/${approvalId}/decision`,
      cookies: marketing,
      payload: { decision: 'approved' },
    });
    expect(decision.statusCode).toBe(403);
  });

  it('refuses someone without ads.request', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/ads/campaign-requests',
      cookies: await cookiesFor('vendedor_expansao'),
      payload: await draft(),
    });
    expect(response.statusCode).toBe(403);
  });

  it('refuses blocked copy on the server, whatever the screen did', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/ads/campaign-requests',
      cookies: await cookiesFor('marketing'),
      payload: await draft({
        variations: [
          {
            creativeId: creativeIds[0],
            headline: 'Retorno garantido',
            primaryText: 'Fale.',
            callToAction: 'LEARN_MORE',
          },
          {
            creativeId: creativeIds[1],
            headline: 'Seja franqueado',
            primaryText: 'Suporte.',
            callToAction: 'CONTACT_US',
          },
        ],
      }),
    });
    expect(response.statusCode).toBe(400);
    expect(response.json<{ message: string }>().message).toContain('Retorno garantido');
  });

  it('answers a guard refusal with its reason', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/ads/campaign-requests',
      cookies: await cookiesFor('marketing'),
      payload: await draft({ dailyBudgetCents: 300_000 }),
    });
    expect(response.statusCode).toBe(409);
    expect(response.json<{ error: string }>().error).toBe('usable_would_be_exceeded');
  });
});

describe('creative uploads', () => {
  it('stores what the bytes prove, and serves the same bytes back', async () => {
    const cookies = await cookiesFor('marketing');
    const bytes = pngOf(1080, 1350);
    // The browser's claim about the type is ignored: the bytes are a PNG.
    const response = await upload(cookies, bytes, 'image/jpeg');
    expect(response.statusCode).toBe(201);
    const { creative } = response.json<{ creative: { id: string; mimeType: string } }>();
    expect(creative).toMatchObject({ mimeType: 'image/png', width: 1080, height: 1350 });

    const served = await app.inject({ url: `/ads/creatives/${creative.id}`, cookies });
    expect(served.headers['content-type']).toBe('image/png');
    expect(served.headers['x-content-type-options']).toBe('nosniff');
    expect(served.rawPayload.equals(bytes)).toBe(true);
  });

  it('refuses a file that is not an image, and one that is too small', async () => {
    const cookies = await cookiesFor('marketing');
    const fake = await upload(cookies, Buffer.from('<svg onload=alert(1)>'));
    expect(fake.statusCode).toBe(400);
    expect(fake.json<{ error: string }>().error).toBe('invalid_image');

    const small = await upload(cookies, pngOf(300, 300));
    expect(small.json<{ error: string }>().error).toBe('image_too_small');
  });

  it('refuses an upload from someone who may not ask for campaigns', async () => {
    const response = await upload(await cookiesFor('vendedor_expansao'), pngOf(1080, 1080));
    expect(response.statusCode).toBe(403);
  });

  it('refuses a campaign pointing at a creative that was never uploaded', async () => {
    const payload = await draft();
    const response = await app.inject({
      method: 'POST',
      url: '/ads/campaign-requests',
      cookies: await cookiesFor('marketing'),
      payload: {
        ...payload,
        variations: [
          payload.variations[0],
          { ...payload.variations[1], creativeId: '33333333-3333-4333-8333-333333333333' },
        ],
      },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json<{ error: string }>().error).toBe('creative_not_found');
  });
});

describe('the tenant audience profile', () => {
  const profile = {
    idealCustomerProfile: 'Empreendedor de 30 a 50 anos, com experiência em gestão.',
    reach: { states: ['SP', 'PR'], cities: [{ name: 'Goiânia', state: 'GO' }] },
  };

  it('is empty until somebody saves it, then comes back as saved', async () => {
    const marketing = await cookiesFor('marketing');
    const before = await app.inject({ url: '/ads/audience-profile', cookies: marketing });
    expect(before.json<{ profile: unknown }>().profile).toBeNull();

    const saved = await app.inject({
      method: 'PUT',
      url: '/ads/audience-profile',
      cookies: marketing,
      payload: profile,
    });
    expect(saved.statusCode).toBe(200);

    // Saving again replaces the single row instead of adding another.
    await app.inject({
      method: 'PUT',
      url: '/ads/audience-profile',
      cookies: marketing,
      payload: { ...profile, reach: { states: ['RJ'], cities: [] } },
    });
    const after = await app.inject({ url: '/ads/audience-profile', cookies: marketing });
    const body = after.json<{ profile: { reach: unknown; updatedByName: string | null } }>();
    expect(body.profile.reach).toEqual({ states: ['RJ'], cities: [], customLocations: [] });
    expect(body.profile.updatedByName).not.toBeNull();
  });

  it('refuses an empty reach, an unknown state and a reader trying to save', async () => {
    const marketing = await cookiesFor('marketing');
    const put = (payload: Record<string, unknown>, cookies = marketing) =>
      app.inject({ method: 'PUT', url: '/ads/audience-profile', cookies, payload });

    const empty = await put({ ...profile, reach: { states: [], cities: [] } });
    expect(empty.statusCode).toBe(400);
    expect(empty.json<{ message: string }>().message).toBe(
      'Escolha pelo menos um estado, uma cidade ou um ponto no mapa',
    );
    expect((await put({ ...profile, reach: { states: ['XX'], cities: [] } })).statusCode).toBe(400);
    expect((await put(profile, await cookiesFor('vendedor_expansao'))).statusCode).toBe(403);
  });

  it('keeps the audience inside the request, as the approver will see it', async () => {
    const payload = await draft();
    const created = await app.inject({
      method: 'POST',
      url: '/ads/campaign-requests',
      cookies: await cookiesFor('marketing'),
      payload,
    });
    const { approvalId } = created.json<{ approvalId: string }>();
    const detail = await app.inject({
      url: `/ads/approvals/${approvalId}`,
      cookies: await cookiesFor('admin_master'),
    });
    const approval = detail.json<{ approval: ApprovalDetail }>().approval;
    expect(approval.draft?.reach.cities).toEqual([{ name: 'Curitiba', state: 'PR' }]);
    expect(approval.draft?.idealCustomerProfile).toContain('Empreendedor');
  });
});

describe('reach by radius on the map', () => {
  const point = { latitude: -22.9056, longitude: -47.0608, radiusKm: 25, label: 'Campinas' };

  it('travels with the request, as the only reach if the operator wants', async () => {
    const payload = await draft({ reach: { states: [], cities: [], customLocations: [point] } });
    const created = await app.inject({
      method: 'POST',
      url: '/ads/campaign-requests',
      cookies: await cookiesFor('marketing'),
      payload,
    });
    expect(created.statusCode).toBe(201);
    const detail = await app.inject({
      url: `/ads/approvals/${created.json<{ approvalId: string }>().approvalId}`,
      cookies: await cookiesFor('admin_master'),
    });
    expect(detail.json<{ approval: ApprovalDetail }>().approval.draft?.reach).toEqual({
      states: [],
      cities: [],
      customLocations: [point],
    });
  });

  it('refuses a radius Meta would not take', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/ads/campaign-requests',
      cookies: await cookiesFor('marketing'),
      payload: await draft({
        reach: { states: [], cities: [], customLocations: [{ ...point, radiusKm: 200 }] },
      }),
    });
    expect(response.statusCode).toBe(400);
    expect(response.json<{ message: string }>().message).toBe('O raio máximo é 80 km');
  });

  it('reads back a profile and a draft saved before the map existed', async () => {
    const old = { states: ['SP'], cities: [] };
    await db
      .insert(marketingAudienceProfiles)
      .values({
        tenantId: WINGS_TENANT_ID,
        idealCustomerProfile: 'Perfil salvo antes do mapa existir.',
        reach: old,
      })
      .onConflictDoUpdate({ target: marketingAudienceProfiles.tenantId, set: { reach: old } });

    const profile = await app.inject({
      url: '/ads/audience-profile',
      cookies: await cookiesFor('marketing'),
    });
    expect(profile.json<{ profile: { reach: unknown } }>().profile.reach).toEqual({
      ...old,
      customLocations: [],
    });

    // A draft stored without the field still opens, and still matches its hash.
    const created = await app.inject({
      method: 'POST',
      url: '/ads/campaign-requests',
      cookies: await cookiesFor('marketing'),
      payload: await draft(),
    });
    const { approvalId, changeRequestId } = created.json<{
      approvalId: string;
      changeRequestId: string;
    }>();
    await db.execute(sql`
      update ad_campaign_drafts set payload = payload #- '{reach,customLocations}'
       where id = (select draft_id from ad_change_requests where id = ${changeRequestId})
    `);
    const detail = await app.inject({
      url: `/ads/approvals/${approvalId}`,
      cookies: await cookiesFor('admin_master'),
    });
    expect(detail.statusCode).toBe(200);
    expect(
      detail.json<{ approval: ApprovalDetail }>().approval.draft?.reach.customLocations,
    ).toEqual([]);
  });
});

describe('Google campaigns through the same request', () => {
  const googleDraft = async () => {
    return {
      ...(await draft()),
      formatKey: undefined,
      variations: [],
      ageMin: undefined,
      ageMax: undefined,
      placements: undefined,
      identity: undefined,
      platform: 'google_search',
      name: `Pesquisa ${randomBytes(3).toString('hex')}`,
      utms: { utm_source: 'google', utm_medium: 'cpc', utm_campaign: 'x', utm_content: 'lead' },
      search: {
        keywords: ['[abrir franquia]'],
        negativeKeywords: [],
        headlines: ['Franquia Wings', 'Expanda sua marca', 'Fale com a Wings'],
        descriptions: ['Conheça o modelo de negócio e o suporte da Wings.', 'Suporte do início ao fim.'],
      },
    };
  };

  it('says plainly when this environment has no Google Ads account', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/ads/campaign-requests',
      cookies: await cookiesFor('marketing'),
      payload: await googleDraft(),
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      error: 'account_not_found',
      message: 'Nenhuma conta Google Ads ativa neste ambiente.',
    });
  });

  it('files the request under the Google account, in front of the same approver', async () => {
    const [google] = await db
      .insert(adAccounts)
      .values({ platform: 'google', externalId: '4268586278', name: 'Wings Company — Google Ads' })
      .returning({ id: adAccounts.id });
    if (!google) throw new Error('failed');
    await openPeriod(db, {
      adAccountId: google.id,
      periodMonth: `${TODAY.slice(0, 7)}-01`,
      capCents: 150_000,
      usablePercent: 70,
    });

    const payload = await googleDraft();
    const response = await app.inject({
      method: 'POST',
      url: '/ads/campaign-requests',
      cookies: await cookiesFor('marketing'),
      payload,
    });
    expect(response.statusCode).toBe(201);
    expect(response.json<{ exposureDeltaCents: number }>().exposureDeltaCents).toBe(0);

    const { approvalId } = response.json<{ approvalId: string }>();
    const detail = await app.inject({
      url: `/ads/approvals/${approvalId}`,
      cookies: await cookiesFor('admin_master'),
    });
    const approval = detail.json<{ approval: ApprovalDetail }>().approval;
    expect(approval.platform).toBe('google');
    expect(approval.status).toBe('pending');
    expect(approval.draft?.search?.keywords).toEqual(['[abrir franquia]']);
    // No Google credentials and the switch off: approving cannot lead to a write.
    expect(approval.executionAvailable).toBe(false);

    // A born-active Google campaign never gets this far.
    const active = await app.inject({
      method: 'POST',
      url: '/ads/campaign-requests',
      cookies: await cookiesFor('marketing'),
      payload: { ...(await googleDraft()), startPaused: false },
    });
    expect(active.statusCode).toBe(400);
  });
});

describe('saved drafts', () => {
  it('saves, lists, opens and deletes a draft without any request, approval or reservation', async () => {
    const cookies = await cookiesFor('marketing');
    const payload = {
      ...(await draft()),
      formatKey: undefined,
      variations: [],
      ageMin: undefined,
      ageMax: undefined,
      placements: undefined,
      identity: undefined,
      platform: 'google_search',
      name: 'SEARCH | Formatação | Alta Intenção | Set26',
      utms: { utm_source: 'google', utm_medium: 'cpc', utm_campaign: 'x', utm_content: 'lead' },
      search: {
        adGroupName: 'Formatação',
        keywords: ['"formatação de franquia"', '[wings company]'],
        negativeKeywords: ['emprego'],
        headlines: ['Formate Sua Franquia', 'Consultoria de Franquias', 'Fale com um Especialista'],
        descriptions: ['Formatamos sua empresa para virar franqueadora.', 'Fale com a Wings.'],
      },
    };
    const changesBefore = (await db.query.adChangeRequests.findMany()).length;
    const saved = await app.inject({ method: 'POST', url: '/ads/saved-drafts', cookies, payload: { draft: payload } });
    expect(saved.statusCode).toBe(201);
    const { id } = saved.json<{ id: string }>();

    const list = await app.inject({ url: '/ads/saved-drafts', cookies });
    expect(list.json<{ drafts: { id: string; name: string; platform: string }[] }>().drafts).toContainEqual(
      expect.objectContaining({ id, name: payload.name, platform: 'google_search' }),
    );
    const one = await app.inject({ url: `/ads/saved-drafts/${id}`, cookies });
    expect(one.statusCode).toBe(200);
    expect(one.json<{ draft: { search: { adGroupName: string } } }>().draft.search.adGroupName).toBe('Formatação');

    // Nothing was requested, approved or reserved.
    expect(await db.query.adChangeRequests.findMany()).toHaveLength(changesBefore);

    // A draft the schema refuses is not saved.
    const bad = await app.inject({
      method: 'POST',
      url: '/ads/saved-drafts',
      cookies,
      payload: { draft: { ...payload, search: { ...payload.search, keywords: ['abrir franquia'] } } },
    });
    expect(bad.statusCode).toBe(400);

    expect((await app.inject({ method: 'DELETE', url: `/ads/saved-drafts/${id}`, cookies })).statusCode).toBe(204);
    expect((await app.inject({ url: `/ads/saved-drafts/${id}`, cookies })).statusCode).toBe(404);
    // A seller cannot see the builder's drafts.
    expect((await app.inject({ url: '/ads/saved-drafts', cookies: await cookiesFor('vendedor_expansao') })).statusCode).toBe(403);
  });
});

describe('a request compared with its saved draft', () => {
  it('shows the approver what was edited after loading the draft, and says so when nothing was', async () => {
    const cookies = await cookiesFor('marketing');
    // The Google account and its period exist from the suite above.
    const account = await db.query.adAccounts.findFirst({
      where: eq(adAccounts.platform, 'google'),
    });
    if (!account) throw new Error('expected the Google account of the suite above');

    const name = `Drift ${randomBytes(3).toString('hex')}`;
    const base = {
      ...(await draft()),
      formatKey: undefined,
      variations: [],
      ageMin: undefined,
      ageMax: undefined,
      placements: undefined,
      identity: undefined,
      platform: 'google_search',
      name,
      dailyBudgetCents: 3000,
      utms: { utm_source: 'google', utm_medium: 'cpc', utm_campaign: 'x', utm_content: 'lead' },
      search: {
        keywords: ['[abrir franquia]'],
        negativeKeywords: [],
        headlines: ['Franquia Wings', 'Expanda sua marca', 'Fale com a Wings'],
        descriptions: ['Conheça o modelo de negócio e o suporte da Wings.', 'Suporte do início ao fim.'],
      },
    };
    expect(
      (await app.inject({ method: 'POST', url: '/ads/saved-drafts', cookies, payload: { draft: base } }))
        .statusCode,
    ).toBe(201);

    // Requested with twice the budget: the approval names the difference.
    const edited = await app.inject({
      method: 'POST',
      url: '/ads/campaign-requests',
      cookies,
      payload: { ...base, dailyBudgetCents: 6000 },
    });
    expect(edited.statusCode).toBe(201);
    const detail = await app.inject({
      url: `/ads/approvals/${edited.json<{ approvalId: string }>().approvalId}`,
      cookies: await cookiesFor('admin_master'),
    });
    expect(detail.json<{ approval: ApprovalDetail }>().approval.savedDraftDrift).toMatchObject({
      savedDraftName: name,
      differences: [
        { field: 'dailyBudgetCents', saved: 'R$ 30,00', requested: 'R$ 60,00' },
      ],
    });

    // Requested exactly as saved (another name: the guard refuses a repeated
    // campaign name): the approval says they agree.
    const other = { ...base, name: `${name} B` };
    expect(
      (await app.inject({ method: 'POST', url: '/ads/saved-drafts', cookies, payload: { draft: other } }))
        .statusCode,
    ).toBe(201);
    const same = await app.inject({
      method: 'POST',
      url: '/ads/campaign-requests',
      cookies,
      payload: other,
    });
    expect(same.statusCode).toBe(201);
    const sameDetail = await app.inject({
      url: `/ads/approvals/${same.json<{ approvalId: string }>().approvalId}`,
      cookies: await cookiesFor('admin_master'),
    });
    expect(sameDetail.json<{ approval: ApprovalDetail }>().approval.savedDraftDrift).toMatchObject({
      savedDraftName: `${name} B`,
      differences: [],
    });
  });
});
