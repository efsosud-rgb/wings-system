import { CAMPAIGN_LEADS_SINCE, UNATTRIBUTED_REASONS } from '@wings/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from '../../db/client.js';
import { adAds, adCampaigns, adMetricsDaily, campaignLeads, leads } from '../../db/schema/index.js';
import { createSecretBox } from '../../lib/secret-box.js';
import { createTestDatabase, type TestDatabase } from '../../test/db.js';
import { TEST_CPF_KEY } from '../../test/factories.js';
import { summaryOf } from './campaign-leads-routes.js';
import {
  attribute,
  inForceOn,
  syncCampaignLeads,
  utmCampaignOfUrlTags,
  type AttributionCampaign,
} from './campaign-leads-sync.js';
import { ensureAdAccount } from './metrics.js';

/**
 * Leads das Campanhas, attribution by the lead and by the day it entered:
 * Meta instant-form deals claimed through the Wings lead, UTM texts that are
 * not the campaign's name, campaigns judged on the entry day and not "now",
 * and old leads copied to RD later kept out of every figure.
 */

const SINCE = new Date(CAMPAIGN_LEADS_SINCE);
const norm = (value: string) =>
  value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');

const campaign = (fields: Partial<AttributionCampaign> & { id: string }): AttributionCampaign => ({
  platform: 'meta',
  keys: [],
  ads: [],
  deliveringNow: false,
  spendDays: new Set(),
  ...fields,
});

const thais = campaign({
  id: 'c-thais',
  externalId: '120252299216680076',
  keys: [norm('120252299216680076'), norm('META | IG | Formatação | Vídeos Thais | Out26')],
  nameKey: norm('META | IG | Formatação | Vídeos Thais | Out26'),
  ads: [
    { id: 'a-thais-2', externalId: '120252299249550076', keys: ['120252299249550076', 'video2'] },
  ],
  startDate: '2026-09-30',
  endDate: '2026-10-05',
  spendDays: new Set(['2026-10-04', '2026-10-05']),
});
const jimmy = campaign({
  id: 'c-jimmy',
  externalId: '120252260012720076',
  keys: [norm('120252260012720076'), norm('META | FB+IG | Formatação | Jimmy Ogro | 28Set')],
  nameKey: norm('META | FB+IG | Formatação | Jimmy Ogro | 28Set'),
  ads: [{ id: 'a-jimmy', externalId: '120252260025750076', keys: ['120252260025750076'] }],
  startDate: '2026-09-28',
  endDate: '2026-10-05',
  spendDays: new Set(['2026-09-28', '2026-10-03']),
});
const form = campaign({
  id: 'c-form',
  externalId: '120252401895850076',
  keys: [norm('120252401895850076'), norm('META | IG+FB | Formatacao | Form 5 perguntas | Out26')],
  nameKey: norm('META | IG+FB | Formatacao | Form 5 perguntas | Out26'),
  ads: [{ id: 'a-form-1', externalId: '120252401895830076', keys: ['120252401895830076'] }],
  startDate: '2026-10-07',
  deliveringNow: true,
});
const search = campaign({
  id: 'c-search',
  platform: 'google',
  externalId: '24289782134',
  keys: ['24289782134'],
  nameKey: norm('SEARCH | Formatação | Alta Intenção | Set26'),
  ads: [{ id: 'a-search', externalId: '826301381476', keys: ['826301381476'] }],
  startDate: '2026-09-25',
  deliveringNow: true,
});
const all = [thais, jimmy, form, search];

const noUtms = { utms: null, sourceLabel: null, campaignLabel: null };

describe('a Meta instant-form deal, claimed through the Wings lead', () => {
  const lead = {
    enteredAt: new Date('2026-10-08T11:08:00.000Z'),
    adPlatform: 'meta',
    adCampaignExternalId: '120252401895850076',
    adExternalId: '120252401895830076',
  };

  it('goes to the campaign and the ad the lead carries, with no UTM and no RD label', () => {
    expect(attribute({ ...noUtms, enteredDay: '2026-10-08', lead, since: SINCE }, all)).toEqual({
      platform: 'meta',
      campaignId: 'c-form',
      adId: 'a-form-1',
      attribution: 'lead_ads',
      reason: null,
    });
  });

  it('does not ask whether the campaign is in force: the lead names it', () => {
    const ended = { ...lead, adCampaignExternalId: '120252299216680076', adExternalId: null };
    expect(
      attribute({ ...noUtms, enteredDay: '2026-10-08', lead: ended, since: SINCE }, all),
    ).toMatchObject({ campaignId: 'c-thais', adId: null, attribution: 'lead_ads' });
  });

  it('says so when the campaign of the form is not in the register', () => {
    const unknown = { ...lead, adCampaignExternalId: '999' };
    expect(
      attribute({ ...noUtms, enteredDay: '2026-10-08', lead: unknown, since: SINCE }, all),
    ).toMatchObject({
      campaignId: null,
      attribution: null,
      reason: 'lead_ads_campaign_unknown',
    });
  });

  it('keeps out of the account a person who arrived before 28/09, whatever else is known', () => {
    const old = { ...lead, enteredAt: new Date('2026-07-15T12:00:00.000Z') };
    expect(
      attribute({ ...noUtms, enteredDay: '2026-10-06', lead: old, since: SINCE }, all),
    ).toEqual({
      platform: null,
      campaignId: null,
      adId: null,
      attribution: null,
      reason: 'arrived_before_cutoff',
    });
    // The first day counted is in: 28/09 00:00 in Brasília.
    const first = { ...lead, enteredAt: new Date('2026-09-28T03:00:00.000Z') };
    expect(
      attribute({ ...noUtms, enteredDay: '2026-09-28', lead: first, since: SINCE }, all),
    ).toMatchObject({ campaignId: 'c-form' });
  });
});

describe('a UTM that is text, not the campaign name', () => {
  it('finds the campaign whose name contains the slug', () => {
    const utms = {
      source: 'instagram',
      medium: 'instagram',
      campaign: 'formatacao_videos_thais_out26',
      content: 'video-2',
    };
    expect(
      attribute({ utms, sourceLabel: null, campaignLabel: null, enteredDay: '2026-10-04' }, all),
    ).toEqual({
      platform: 'meta',
      campaignId: 'c-thais',
      adId: 'a-thais-2',
      attribution: 'utm',
      reason: null,
    });
  });

  it('does not take a short or shared slug for a campaign', () => {
    const utms = { source: 'x', medium: null, campaign: 'formatacao', content: null };
    expect(
      attribute({ utms, sourceLabel: null, campaignLabel: null, enteredDay: '2026-10-04' }, all),
    ).toMatchObject({ campaignId: null, reason: 'utm_other_campaign' });
    // Two campaigns in force carry the slug: no guess.
    const twin = campaign({ ...thais, id: 'c-twin', externalId: '2' });
    expect(
      attribute(
        {
          utms: {
            source: 'x',
            medium: null,
            campaign: 'formatacao_videos_thais_out26',
            content: null,
          },
          sourceLabel: null,
          campaignLabel: null,
          enteredDay: '2026-10-04',
        },
        [thais, twin],
      ),
    ).toMatchObject({ campaignId: null, reason: 'utm_other_campaign' });
  });

  it('falls back to the ad id in utm_content when the campaign text matches nothing', () => {
    const utms = {
      source: 'facebook',
      medium: 'facebook',
      campaign: 'formatacao_jimmyogro_set26',
      content: '120252260025750076',
    };
    expect(
      attribute({ utms, sourceLabel: null, campaignLabel: null, enteredDay: '2026-10-03' }, all),
    ).toEqual({
      platform: 'meta',
      campaignId: 'c-jimmy',
      adId: 'a-jimmy',
      attribution: 'utm',
      reason: null,
    });
    // A short label like "video-2" is not enough to pick a campaign on its own.
    expect(
      attribute(
        {
          utms: { ...utms, content: 'video-2' },
          sourceLabel: null,
          campaignLabel: null,
          enteredDay: '2026-10-03',
        },
        all,
      ),
    ).toMatchObject({ campaignId: null, reason: 'utm_other_campaign' });
  });

  it('reads the static utm_campaign of an ad URL tag, and none that holds a {{macro}}', () => {
    expect(
      utmCampaignOfUrlTags('utm_source=Meta&utm_campaign=formatacao_x_out26&utm_content=a'),
    ).toBe('formatacao_x_out26');
    expect(
      utmCampaignOfUrlTags(
        'utm_source=MetaAds&utm_campaign={{campaign.name}}&utm_content={{ad.name}}',
      ),
    ).toBeNull();
    expect(utmCampaignOfUrlTags('')).toBeNull();
    expect(utmCampaignOfUrlTags(null)).toBeNull();
  });
});

describe('a campaign is judged on the day the deal entered, not on the day of the sync', () => {
  const utms = {
    source: 'instagram',
    medium: 'instagram',
    campaign: 'formatacao_videos_thais_out26',
    content: null,
  };

  it('is in force inside its dates when it delivers now or spent that day or the day before', () => {
    expect(inForceOn(thais, '2026-10-04')).toBe(true);
    expect(inForceOn(thais, '2026-10-06')).toBe(false); // ended 05/10
    expect(inForceOn(thais, '2026-09-29')).toBe(false); // starts 30/09
    expect(inForceOn(form, '2026-10-08')).toBe(true);
    expect(inForceOn(form, '2026-10-06')).toBe(false); // starts 07/10
    // No dates and no spend near the day: paused long ago, not in force.
    expect(inForceOn(campaign({ id: 'old' }), '2026-10-04')).toBe(false);
    expect(
      inForceOn(campaign({ id: 'old', spendDays: new Set(['2026-10-03']) }), '2026-10-04'),
    ).toBe(true);
    expect(inForceOn(thais, undefined)).toBe(true);
  });

  it('attributes a deal that entered while its campaign ran, even after it ended', () => {
    expect(
      attribute({ utms, sourceLabel: null, campaignLabel: null, enteredDay: '2026-10-04' }, all),
    ).toMatchObject({ campaignId: 'c-thais', attribution: 'utm' });
    // Entered after the end date: the UTM points to a campaign that was not active.
    expect(
      attribute({ utms, sourceLabel: null, campaignLabel: null, enteredDay: '2026-10-07' }, all),
    ).toMatchObject({ campaignId: null, reason: 'utm_other_campaign' });
  });

  it("picks the platform's only campaign in force that day, and calls two of them ambiguous", () => {
    const meta = { utms: null, sourceLabel: 'Busca Paga | Facebook', campaignLabel: null };
    // 05/10: Thais spent that day; Jimmy Ogro spent neither 04/10 nor 05/10.
    expect(attribute({ ...meta, enteredDay: '2026-10-05' }, all)).toMatchObject({
      campaignId: 'c-thais',
      attribution: 'rd_origin',
    });
    // 08/10: only the form campaign delivers.
    expect(attribute({ ...meta, enteredDay: '2026-10-08' }, all)).toMatchObject({
      campaignId: 'c-form',
      attribution: 'rd_origin',
    });
    // 03/10: Jimmy Ogro spent that day; Thais had not spent yet.
    expect(attribute({ ...meta, enteredDay: '2026-10-03' }, all)).toMatchObject({
      campaignId: 'c-jimmy',
    });
    // 04/10: Jimmy Ogro spent 03/10 (the day before) and Thais spent 04/10: two in force.
    expect(attribute({ ...meta, enteredDay: '2026-10-04' }, all)).toMatchObject({
      campaignId: null,
      reason: 'platform_ambiguous',
    });
    // Before anything ran for the platform.
    expect(attribute({ ...meta, enteredDay: '2026-09-20' }, all)).toMatchObject({
      campaignId: null,
      reason: 'platform_without_active_campaign',
    });
  });
});

// --- The sync end to end, on a throwaway database -----------------------------------------------

let harness: TestDatabase;
let db: Database;
const NOW = new Date('2026-10-09T13:00:00.000Z');

function fakeRd(deals: unknown[]) {
  return (async (input: unknown) => {
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
    return json({}, 404);
  }) as typeof fetch;
}

const deal = (id: string, createdAt: string, fields: Record<string, unknown> = {}) => ({
  id,
  name: `Negócio ${id}`,
  created_at: createdAt,
  win: null,
  rating: 1,
  amount_total: 0,
  deal_stage: { id: 's1' },
  contacts: [],
  ...fields,
});

beforeAll(async () => {
  harness = await createTestDatabase();
  db = harness.db;
  const meta = await ensureAdAccount(db, { platform: 'meta', externalId: 'act_9', name: 'Meta' });
  const [formCampaign] = await db
    .insert(adCampaigns)
    .values({
      adAccountId: meta,
      externalId: '120252401895850076',
      name: 'META | IG+FB | Formatacao | Form 5 perguntas | Out26',
      status: 'ACTIVE',
      deliveryStatus: 'ACTIVE',
      startDate: '2026-10-07',
    })
    .returning();
  const [endedCampaign] = await db
    .insert(adCampaigns)
    .values({
      adAccountId: meta,
      externalId: '120252299216680076',
      name: 'META | IG | Formatação | Vídeos Thais | Out26',
      status: 'ACTIVE',
      deliveryStatus: 'ACTIVE',
      startDate: '2026-09-30',
      endDate: '2026-10-05',
    })
    .returning();
  await db.insert(adAds).values({
    adAccountId: meta,
    campaignId: formCampaign!.id,
    externalId: '120252401895830076',
    name: 'Anúncio do formulário',
    status: 'ACTIVE',
    effectiveStatus: 'ACTIVE',
  });
  await db.insert(adMetricsDaily).values({
    adAccountId: meta,
    level: 'campaign',
    entityExternalId: endedCampaign!.externalId,
    campaignId: endedCampaign!.id,
    day: '2026-10-04',
    spendCents: 10_500,
  });

  // The Wings leads behind the deals: two new instant-form leads, one old one
  // that RD only received on 06/10, and a deal RD made on its own.
  await db.insert(leads).values([
    {
      source: 'meta_lead_ads',
      email: 'novo1@example.com',
      rdDealId: 'dN1',
      enteredAt: new Date('2026-10-07T23:58:00-03:00'),
      adPlatform: 'meta',
      adCampaignExternalId: '120252401895850076',
      adExternalId: '120252401895830076',
    },
    {
      source: 'meta_lead_ads',
      email: 'novo2@example.com',
      rdDealId: 'dN2',
      enteredAt: new Date('2026-10-08T08:07:00-03:00'),
      adPlatform: 'meta',
      adCampaignExternalId: '120252401895850076',
      adExternalId: null,
    },
    {
      source: 'meta_lead_ads',
      email: 'antigo@example.com',
      rdDealId: 'dOld',
      enteredAt: new Date('2026-07-15T10:00:00-03:00'),
      adPlatform: 'meta',
      adCampaignExternalId: '120252401895850076',
      adExternalId: null,
    },
  ]);

  await syncCampaignLeads(db, {
    rdCrmToken: 'crm-token',
    rdMarketing: null,
    box: createSecretBox(TEST_CPF_KEY),
    now: NOW,
    fetchImpl: fakeRd([
      deal('dN1', '2026-10-08T00:10:00.000-03:00'),
      deal('dN2', '2026-10-08T08:08:00.000-03:00'),
      deal('dOld', '2026-10-06T14:16:00.000-03:00'),
      // RD's own deal on 04/10 from a Facebook source, no UTM: the only campaign in
      // force that day was the one that has ended since.
      deal('dRd', '2026-10-04T12:00:00.000-03:00', {
        deal_source: { name: 'Busca Paga | Facebook' },
      }),
      deal('dTest', '2026-10-08T09:00:00.000-03:00', {
        deal_lost_reason: { name: 'Teste' },
      }),
    ]),
  });
}, 60_000);

afterAll(async () => {
  await harness?.drop();
});

describe('the sync', () => {
  const rowOf = (dealId: string) =>
    db.query.campaignLeads.findFirst({ where: eq(campaignLeads.rdDealId, dealId) });

  it('files the two new instant-form deals under the form campaign, with the ad when the lead has it', async () => {
    const [first, second] = await Promise.all([rowOf('dN1'), rowOf('dN2')]);
    expect(first).toMatchObject({
      attribution: 'lead_ads',
      unattributedReason: null,
      platform: 'meta',
    });
    expect(second).toMatchObject({ attribution: 'lead_ads', unattributedReason: null });
    expect(first?.campaignId).toBeTruthy();
    expect(first?.campaignId).toBe(second?.campaignId);
    expect(first?.adId).toBeTruthy();
    expect(second?.adId).toBeNull();
  });

  it('keeps the old lead out of the account, by the day the person really arrived', async () => {
    const old = await rowOf('dOld');
    expect(old).toMatchObject({ campaignId: null, unattributedReason: 'arrived_before_cutoff' });
  });

  it('judges a deal without UTM by the campaign in force the day it entered', async () => {
    const own = await rowOf('dRd');
    expect(own).toMatchObject({ attribution: 'rd_origin', platform: 'meta' });
    const ended = await db.query.adCampaigns.findFirst({
      where: eq(adCampaigns.externalId, '120252299216680076'),
    });
    expect(own?.campaignId).toBe(ended?.id);
  });

  it('counts the old lead in no total, no percentage, and still lists it by reason', async () => {
    const rows = await db.query.campaignLeads.findMany();
    const summary = summaryOf(rows, NOW);
    expect(summary.total).toBe(3); // dN1, dN2, dRd
    expect(summary.outOfAccount).toBe(1);
    expect(summary.tests).toBe(1);
    expect(summary.unattributedPercent).toBe(0);
    expect(summary.unattributed).toEqual([{ reason: 'arrived_before_cutoff', count: 1 }]);
    expect(UNATTRIBUTED_REASONS.arrived_before_cutoff).toMatch(/28\/09/);
  });

  it('puts an old lead back on the percentage only when it stays unattributed for a reason that counts', () => {
    const rows = [
      { campaignId: null, unattributedReason: 'not_paid', isTest: false },
      { campaignId: 'c', unattributedReason: null, isTest: false },
      { campaignId: null, unattributedReason: 'arrived_before_cutoff', isTest: false },
      { campaignId: null, unattributedReason: 'arrived_before_cutoff', isTest: false },
    ].map((row, index) => ({
      ...row,
      enteredAt: new Date('2026-10-08T12:00:00.000Z'),
      fetchedAt: NOW,
      stage: 'Sem contato',
      stageOrder: 1,
      firstContactAt: null,
      win: null,
      lostReason: null,
      id: String(index),
    }));
    const summary = summaryOf(rows as unknown as (typeof campaignLeads.$inferSelect)[], NOW);
    expect(summary.outOfAccount).toBe(2);
    expect(summary.unattributedPercent).toBe(50); // 1 of the 2 deals in the account
    expect(summary.unattributed).toEqual(
      expect.arrayContaining([
        { reason: 'not_paid', count: 1 },
        { reason: 'arrived_before_cutoff', count: 2 },
      ]),
    );
  });
});
