import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from '../../db/client.js';
import { adAds, adCampaigns, adSets, campaignLeads } from '../../db/schema/index.js';
import { createSecretBox } from '../../lib/secret-box.js';
import { createTestDatabase, type TestDatabase } from '../../test/db.js';
import { TEST_CPF_KEY } from '../../test/factories.js';
import {
  attribute,
  buildAttributionCampaigns,
  inForceOn,
  syncCampaignLeads,
  UTM_RETRY_MS,
  utmLookupDue,
  type AttributionCampaign,
} from './campaign-leads-sync.js';
import { ensureAdAccount } from './metrics.js';

/**
 * Attribution v2: the UTM of a conversion asked again while RD has none to give,
 * an ad id alone naming the campaign, a paid utm_source/utm_medium marking a
 * deal as bought media, and a campaign ending with its ad sets.
 */

const norm = (value: string) =>
  value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');

const FORM_NAME = 'META | IG+FB | Formatacao | Form 5 perguntas | Out26';
const AD_ID = '120252401896000076';

const campaign = (fields: Partial<AttributionCampaign> & { id: string }): AttributionCampaign => ({
  platform: 'meta',
  keys: [],
  ads: [],
  deliveringNow: true,
  spendDays: new Set(),
  ...fields,
});
const form = campaign({
  id: 'c-form',
  externalId: '120252401895850076',
  keys: [norm('120252401895850076'), norm(FORM_NAME)],
  nameKey: norm(FORM_NAME),
  ads: [
    { id: 'a-umberto', externalId: AD_ID, keys: [AD_ID, norm('adj2-vídeo-umberto-diagnostico')] },
  ],
  startDate: '2026-10-07',
});
const other = campaign({
  id: 'c-other',
  externalId: '120252299216680076',
  keys: [norm('120252299216680076'), norm('META | IG | Outra | Out26')],
  nameKey: norm('META | IG | Outra | Out26'),
  ads: [{ id: 'a-other', externalId: '120252299249550076', keys: ['120252299249550076'] }],
  startDate: '2026-10-01',
});
const search = campaign({
  id: 'c-search',
  platform: 'google',
  externalId: '24289782134',
  keys: ['24289782134'],
  nameKey: norm('SEARCH | Formatação | Alta Intenção | Set26'),
  startDate: '2026-09-25',
});

const site = { sourceLabel: 'Contato pelo Site', campaignLabel: 'SITE WINGS // FORMATAÇÃO' };
const day = '2026-10-09';

describe('(c) an ad id alone names the campaign', () => {
  it('attributes a deal whose utm_campaign is missing but whose utm_content is the ad id', () => {
    const result = attribute(
      {
        utms: { source: 'meta', medium: 'paid_social', campaign: null, content: AD_ID },
        ...site,
        enteredDay: day,
      },
      [form, other, search],
    );
    expect(result).toMatchObject({
      campaignId: 'c-form',
      adId: 'a-umberto',
      attribution: 'utm',
      platform: 'meta',
    });
  });

  it('does not take a short utm_content for an ad', () => {
    const result = attribute(
      {
        utms: { source: 'meta', medium: 'paid_social', campaign: null, content: 'video2' },
        ...site,
        enteredDay: day,
      },
      [form, other],
    );
    expect(result.campaignId).toBeNull();
  });

  it('still says "other campaign" when a utm_campaign was given and nothing matches', () => {
    const result = attribute(
      {
        utms: {
          source: 'meta',
          medium: 'paid_social',
          campaign: 'campanha-que-nao-existe-mais',
          content: 'curto',
        },
        ...site,
        enteredDay: day,
      },
      [form, other],
    );
    expect(result.reason).toBe('utm_other_campaign');
  });

  it('keeps matching the campaign by its name text, and the ad by its id', () => {
    const result = attribute(
      {
        utms: { source: 'meta', medium: 'paid_social', campaign: FORM_NAME, content: AD_ID },
        ...site,
        enteredDay: day,
      },
      [form, other],
    );
    expect(result).toMatchObject({ campaignId: 'c-form', adId: 'a-umberto', attribution: 'utm' });
  });
});

describe('(d) a paid utm_source and utm_medium make the deal bought media', () => {
  it('finds the platform and its only campaign in force, whatever the RD origin says', () => {
    const result = attribute(
      {
        utms: { source: 'meta', medium: 'paid_social', campaign: null, content: null },
        ...site,
        enteredDay: day,
      },
      [form, search],
    );
    expect(result).toMatchObject({ platform: 'meta', campaignId: 'c-form', attribution: 'utm' });
  });

  it('reads Meta short names and Google as the platform', () => {
    const fromIg = attribute(
      {
        utms: { source: 'ig', medium: 'cpc', campaign: null, content: null },
        ...site,
        enteredDay: day,
      },
      [form, search],
    );
    expect(fromIg.campaignId).toBe('c-form');
    const fromGoogle = attribute(
      {
        utms: { source: 'google', medium: 'cpc', campaign: null, content: null },
        ...site,
        enteredDay: day,
      },
      [form, search],
    );
    expect(fromGoogle).toMatchObject({ platform: 'google', campaignId: 'c-search' });
  });

  it('is bought media with the platform known, but ambiguous when two campaigns run', () => {
    const result = attribute(
      {
        utms: { source: 'facebook', medium: 'paid', campaign: null, content: null },
        ...site,
        enteredDay: day,
      },
      [form, other],
    );
    expect(result).toMatchObject({
      platform: 'meta',
      campaignId: null,
      reason: 'platform_ambiguous',
    });
  });

  it('says there is no campaign in force when the platform has none that day', () => {
    const result = attribute(
      {
        utms: { source: 'meta', medium: 'paid_social', campaign: null, content: null },
        ...site,
        enteredDay: '2026-09-20',
      },
      [form, search],
    );
    expect(result).toMatchObject({ platform: 'meta', reason: 'platform_without_active_campaign' });
  });

  it('calls a paid medium of an unknown source "paid without platform", not "not paid"', () => {
    const result = attribute(
      {
        utms: { source: 'tiktok', medium: 'cpc', campaign: null, content: null },
        ...site,
        enteredDay: day,
      },
      [form, search],
    );
    expect(result.reason).toBe('paid_no_platform');
  });

  it('does not take an organic medium for paid media', () => {
    const result = attribute(
      {
        utms: { source: 'instagram', medium: 'social', campaign: null, content: null },
        ...site,
        enteredDay: day,
      },
      [form, search],
    );
    expect(result.reason).toBe('not_paid');
  });

  it('leaves the RD origin as before when there is no UTM at all', () => {
    const result = attribute(
      { utms: null, sourceLabel: 'Busca Paga | Facebook', campaignLabel: null, enteredDay: day },
      [form, search],
    );
    expect(result).toMatchObject({ campaignId: 'c-form', attribution: 'rd_origin' });
  });
});

describe('(e) a campaign ends with its ad sets that are on', () => {
  const row = (fields: Record<string, unknown>) =>
    ({
      id: 'cp1',
      externalId: '120252401895850076',
      name: FORM_NAME,
      status: 'ACTIVE',
      deliveryStatus: 'ACTIVE',
      startDate: '2026-10-07',
      endDate: null,
      ...fields,
    }) as never;
  const build = (adSetRows: { status: string; endDate: string | null }[]) =>
    buildAttributionCampaigns({
      campaigns: [{ campaign: row({}), platform: 'meta' }],
      drafts: [],
      ads: [],
      spend: [{ campaignId: 'cp1', day: '2026-10-13' }],
      adSets: adSetRows.map((adSet) => ({ campaignId: 'cp1', ...adSet })),
      now: new Date('2026-10-14T15:00:00.000Z'),
    })[0]!;

  it('takes the ad set end when the campaign has none, and stops delivering after it', () => {
    const built = build([
      { status: 'ACTIVE', endDate: '2026-10-13' },
      { status: 'PAUSED', endDate: null },
    ]);
    expect(built.endDate).toBe('2026-10-13');
    expect(built.deliveringNow).toBe(false);
    expect(inForceOn(built, '2026-10-13')).toBe(true);
    expect(inForceOn(built, '2026-10-14')).toBe(false);
  });

  it('stays open when one ad set that is on has no end', () => {
    const built = build([
      { status: 'ACTIVE', endDate: '2026-10-13' },
      { status: 'ACTIVE', endDate: null },
    ]);
    expect(built.endDate).toBeNull();
    expect(built.deliveringNow).toBe(true);
  });
});

describe('(a) the UTM of the conversion is asked again while RD has none to give', () => {
  const young = new Date('2026-10-09T15:50:00.000Z');
  const hour = 3_600_000;

  it('is due when never asked, and when asked empty on a young deal', () => {
    expect(utmLookupDue(null, null, true)).toBe(true);
    expect(
      utmLookupDue(new Date(), { source: null, medium: null, campaign: null, content: null }, true),
    ).toBe(true);
    expect(utmLookupDue(young, null, true)).toBe(true);
  });

  it('is not due once RD gave a UTM, nor once the deal is a day old', () => {
    expect(
      utmLookupDue(young, { source: 'meta', medium: null, campaign: null, content: null }, true),
    ).toBe(false);
    expect(
      utmLookupDue(young, { source: null, medium: null, campaign: null, content: AD_ID }, true),
    ).toBe(false);
    expect(utmLookupDue(young, null, false)).toBe(false);
    expect(UTM_RETRY_MS).toBe(24 * hour);
  });
});

describe('(a) the sync', () => {
  let harness: TestDatabase;
  let db: Database;
  const t0 = new Date('2026-10-09T15:00:00.000Z');
  const events: { event_timestamp: string; payload: { traffic_source: string } }[] = [];
  let marketingCalls = 0;

  const traffic = (url: string) =>
    `encoded_${Buffer.from(
      JSON.stringify({
        first_session: { value: url, extra_params: {} },
        current_session: { value: url, extra_params: {} },
      }),
    ).toString('base64')}`;

  const fakeRd = (deals: unknown[]) =>
    (async (input: unknown) => {
      const url = new URL(String(input));
      const json = (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), {
          status,
          headers: { 'content-type': 'application/json' },
        });
      if (url.pathname === '/api/v1/deal_pipelines') {
        return json([{ name: 'Formatação', deal_stages: [{ id: 's1', name: 'Sem contato' }] }]);
      }
      if (url.pathname === '/api/v1/deals') return json({ deals, has_more: false });
      if (url.pathname === '/api/v1/activities') return json({ activities: [] });
      if (url.pathname === '/api/v1/tasks') return json({ tasks: [] });
      if (url.pathname === '/auth/token') return json({ access_token: 'mkt-token' });
      if (url.pathname.startsWith('/platform/contacts/email:')) {
        marketingCalls += 1;
        return json({ uuid: 'u1' });
      }
      if (url.pathname === '/platform/contacts/u1/events') return json(events);
      return json({}, 404);
    }) as typeof fetch;

  const deal = (id: string, createdAt: string) => ({
    id,
    name: `Negócio ${id}`,
    created_at: createdAt,
    win: null,
    rating: 1,
    amount_total: 0,
    deal_stage: { id: 's1' },
    deal_source: { name: 'Contato pelo Site' },
    campaign: { name: 'SITE WINGS // FORMATAÇÃO' },
    contacts: [{ emails: [{ email: 'pessoa@example.com' }], phones: [] }],
  });
  const run = (deals: unknown[], now: Date) =>
    syncCampaignLeads(db, {
      rdCrmToken: 'crm-token',
      rdMarketing: { clientId: 'id', clientSecret: 'secret', refreshToken: 'refresh' },
      box: createSecretBox(TEST_CPF_KEY),
      now,
      fetchImpl: fakeRd(deals),
    });
  const rowOf = (id: string) =>
    db.query.campaignLeads.findFirst({ where: eq(campaignLeads.rdDealId, id) });

  beforeAll(async () => {
    harness = await createTestDatabase();
    db = harness.db;
    const meta = await ensureAdAccount(db, { platform: 'meta', externalId: 'act_9', name: 'Meta' });
    const [formCampaign] = await db
      .insert(adCampaigns)
      .values({
        adAccountId: meta,
        externalId: '120252401895850076',
        name: FORM_NAME,
        status: 'ACTIVE',
        deliveryStatus: 'ACTIVE',
        startDate: '2026-10-07',
      })
      .returning();
    await db.insert(adAds).values({
      adAccountId: meta,
      campaignId: formCampaign!.id,
      externalId: AD_ID,
      name: 'adj2-vídeo-umberto-diagnostico',
      status: 'ACTIVE',
      effectiveStatus: 'ACTIVE',
    });
  }, 60_000);

  afterAll(async () => {
    await harness?.drop();
  });

  it('asks again, a quarter of an hour later, when RD has not recorded the conversion yet', async () => {
    const entered = '2026-10-09T11:55:00.000-03:00'; // 14:55Z, 5 minutes before the first sync
    const first = await run([deal('dLate', entered)], t0);
    expect(first.utmLookups).toBe(1);
    expect(await rowOf('dLate')).toMatchObject({
      utmCheckedAt: null,
      unattributedReason: 'not_paid',
    });

    // RD records the conversion; the next sync (15 minutes on) finds it.
    events.push({
      event_timestamp: '2026-10-09T11:55:30.000-03:00',
      payload: {
        traffic_source: traffic(
          `https://wingscompany.com.br/contato/?utm_source=meta&utm_medium=paid_social&utm_campaign=${encodeURIComponent(FORM_NAME)}&utm_content=${AD_ID}`,
        ),
      },
    });
    const second = await run([deal('dLate', entered)], new Date(t0.getTime() + 15 * 60_000));
    expect(second.utmLookups).toBe(1);
    const row = await rowOf('dLate');
    expect(row).toMatchObject({
      attribution: 'utm',
      platform: 'meta',
      utmCampaign: FORM_NAME,
      utmContent: AD_ID,
    });
    expect(row?.utmCheckedAt).not.toBeNull();
    expect(row?.campaignId).toBeTruthy();
    expect(row?.adId).toBeTruthy();

    // Found: never asked again.
    const before = marketingCalls;
    await run([deal('dLate', entered)], new Date(t0.getTime() + 30 * 60_000));
    expect(marketingCalls).toBe(before);
  });

  it('gives up after a day with nothing, and does not ask again', async () => {
    events.length = 0;
    const entered = '2026-10-08T09:00:00.000-03:00';
    const enteredAt = Date.parse(entered);
    // Inside the day: asked and left open.
    await run([deal('dEmpty', entered)], new Date(enteredAt + 2 * 3_600_000));
    expect((await rowOf('dEmpty'))?.utmCheckedAt).toBeNull();
    // Past the day: asked once more, then closed.
    const closing = await run(
      [deal('dEmpty', entered)],
      new Date(enteredAt + UTM_RETRY_MS + 60_000),
    );
    expect(closing.utmLookups).toBe(1);
    expect((await rowOf('dEmpty'))?.utmCheckedAt).not.toBeNull();
    const after = await run(
      [deal('dEmpty', entered)],
      new Date(enteredAt + UTM_RETRY_MS + 120_000),
    );
    expect(after.utmLookups).toBe(0);
  });

  it('reads the end of the campaign from its ad sets when attributing', async () => {
    const [campaignRow] = await db
      .select()
      .from(adCampaigns)
      .where(eq(adCampaigns.externalId, '120252401895850076'));
    await db.insert(adSets).values({
      campaignId: campaignRow!.id,
      externalId: '120252401895960076',
      name: 'Conjunto',
      status: 'ACTIVE',
      endDate: '2026-10-08',
    });
    // The ad set ended on 08/10, so a deal entering on 09/10 with only the platform to go by finds no campaign in force.
    events.length = 0;
    const entered = '2026-10-09T12:00:00.000-03:00';
    await run(
      [
        {
          ...deal('dAfterEnd', entered),
          deal_source: { name: 'Busca Paga | Facebook' },
          campaign: null,
        },
      ],
      new Date('2026-10-09T16:00:00.000Z'),
    );
    expect(await rowOf('dAfterEnd')).toMatchObject({
      unattributedReason: 'platform_without_active_campaign',
      platform: 'meta',
    });
  });
});
