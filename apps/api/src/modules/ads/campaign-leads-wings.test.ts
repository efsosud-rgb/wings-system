import { CAMPAIGN_LEADS_SINCE } from '@wings/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from '../../db/client.js';
import { adAds, adCampaigns, adSets, campaignLeads, leads } from '../../db/schema/index.js';
import { createSecretBox } from '../../lib/secret-box.js';
import { createTestDatabase, type TestDatabase } from '../../test/db.js';
import { createEmployee, TEST_CPF_KEY } from '../../test/factories.js';
import { summaryOf, visibleCampaignLeads } from './campaign-leads-routes.js';
import { contactKeys, pairDealsWithLeads, syncCampaignLeads } from './campaign-leads-sync.js';
import { ensureAdAccount } from './metrics.js';

/**
 * Leads das Campanhas reads the Wings leads too: a lead RD holds no deal for
 * gets a row of its own, a deal that belongs to a lead only the contact can
 * tell is joined to it (one line per person, the lead's campaign, ad, owner
 * and stage win), and the rows follow the lead when RD claims it.
 */

describe('the contact that identifies a person', () => {
  it('is the e-mail and the phone in both forms of a Brazilian mobile', () => {
    expect(contactKeys(' Ana@Exemplo.com ', '+55 (21) 98765-4321')).toEqual([
      'e:ana@exemplo.com',
      'p:5521987654321',
      'p:552187654321',
    ]);
    expect(contactKeys(null, '000')).toEqual([]);
    expect(contactKeys('sem-arroba', null)).toEqual([]);
  });
});

describe('pairing a deal with the Wings lead of the same person', () => {
  const at = (hours: number) => new Date(Date.UTC(2026, 9, 8, 12) + hours * 3_600_000);

  it('joins by the shared contact within a day, the closest lead first, one lead for one deal', () => {
    const pairs = pairDealsWithLeads(
      [
        { id: 'd1', at: at(0), keys: ['e:a@x.com'] },
        { id: 'd2', at: at(1), keys: ['e:a@x.com'] },
      ],
      [
        { id: 'far', at: at(10), keys: ['e:a@x.com'] },
        { id: 'near', at: at(0.5), keys: ['e:a@x.com'] },
      ],
    );
    expect(pairs.get('d1')).toBe('near');
    // The second deal takes the next lead still free, inside the window.
    expect(pairs.get('d2')).toBe('far');
  });

  it('does not join a stranger, nor the same person a day and more apart', () => {
    const pairs = pairDealsWithLeads(
      [
        { id: 'd1', at: at(0), keys: ['e:a@x.com'] },
        { id: 'd2', at: at(0), keys: ['p:5521987654321'] },
      ],
      [
        { id: 'other', at: at(0), keys: ['e:b@x.com'] },
        { id: 'late', at: at(25), keys: ['p:5521987654321'] },
      ],
    );
    expect(pairs.size).toBe(0);
  });

  it('answers the same for the same rows', () => {
    const deals = [{ id: 'd1', at: at(0), keys: ['e:a@x.com', 'p:1'] }];
    const candidates = [
      { id: 'l1', at: at(2), keys: ['e:a@x.com'] },
      { id: 'l2', at: at(-2), keys: ['p:1'] },
    ];
    expect(pairDealsWithLeads(deals, candidates)).toEqual(pairDealsWithLeads(deals, candidates));
  });
});

// --- The sync on a throwaway database -------------------------------------------------------

let harness: TestDatabase;
let db: Database;
const NOW = new Date('2026-10-09T13:00:00.000Z');
const FORM_CAMPAIGN = '120252401895850076';
const FORM_AD = '120252401895830076';
const FORM_NAME = 'META | IG+FB | Formatacao | Form 5 perguntas | Out26';
const box = createSecretBox(TEST_CPF_KEY);
const ids: Record<string, string> = {};
let ownerId: string;
let formCampaignId: string;
let formAdId: string;
let fetchCalls: string[] = [];

function fakeRd(deals: unknown[]) {
  fetchCalls = [];
  return (async (input: unknown) => {
    const url = new URL(String(input));
    fetchCalls.push(url.pathname);
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    if (url.pathname === '/api/v1/deal_pipelines') {
      return json([
        {
          name: 'Formatação',
          deal_stages: [
            { id: 's1', name: 'Sem contato' },
            { id: 's2', name: 'Tentando contato' },
          ],
        },
      ]);
    }
    if (url.pathname === '/api/v1/deals') return json({ deals, has_more: false });
    if (url.pathname === '/api/v1/activities') return json({ activities: [] });
    if (url.pathname === '/api/v1/tasks') return json({ tasks: [] });
    return json({});
  }) as typeof fetch;
}

const deal = (
  id: string,
  createdAt: string,
  contact: { email?: string; phone?: string },
  fields: Record<string, unknown> = {},
) => ({
  id,
  name: `Negócio ${id}`,
  created_at: createdAt,
  win: null,
  rating: 1,
  amount_total: 0,
  deal_stage: { id: 's2' },
  contacts: [
    {
      name: 'Contato do RD',
      emails: contact.email ? [{ email: contact.email }] : [],
      phones: contact.phone ? [{ phone: contact.phone }] : [],
    },
  ],
  ...fields,
});

const sync = (deals: unknown[] | null) =>
  syncCampaignLeads(db, {
    rdCrmToken: deals ? 'crm-token' : null,
    rdMarketing: null,
    box,
    now: NOW,
    fetchImpl: deals ? fakeRd(deals) : undefined,
  });

const rowOfLead = (key: string) =>
  db.query.campaignLeads.findFirst({ where: eq(campaignLeads.leadId, ids[key]!) });
const rowOfDeal = (dealId: string) =>
  db.query.campaignLeads.findFirst({ where: eq(campaignLeads.rdDealId, dealId) });

async function addLead(key: string, fields: Partial<typeof leads.$inferInsert>) {
  const [lead] = await db
    .insert(leads)
    .values({
      source: 'meta_lead_ads',
      pipeline: 'formatacao',
      name: `Lead ${key}`,
      email: `${key}@example.com`,
      enteredAt: new Date('2026-10-08T08:07:00-03:00'),
      stage: 'Sem contato',
      stageOrder: 1,
      ownerEmployeeId: ownerId,
      adPlatform: 'meta',
      adCampaignExternalId: FORM_CAMPAIGN,
      adExternalId: FORM_AD,
      ...fields,
    })
    .returning({ id: leads.id });
  ids[key] = lead!.id;
}

beforeAll(async () => {
  harness = await createTestDatabase();
  db = harness.db;
  ownerId = (await createEmployee(db, { role: 'vendedor_formatacao' })).id;
  const meta = await ensureAdAccount(db, { platform: 'meta', externalId: 'act_9', name: 'Meta' });
  const [campaign] = await db
    .insert(adCampaigns)
    .values({
      adAccountId: meta,
      externalId: FORM_CAMPAIGN,
      name: FORM_NAME,
      status: 'ACTIVE',
      deliveryStatus: 'ACTIVE',
      startDate: '2026-10-07',
    })
    .returning();
  formCampaignId = campaign!.id;
  const [adSet] = await db
    .insert(adSets)
    .values({
      campaignId: campaign!.id,
      externalId: '120252401895960076',
      name: 'Conjunto adj2',
      status: 'ACTIVE',
    })
    .returning();
  const [ad] = await db
    .insert(adAds)
    .values({
      adAccountId: meta,
      campaignId: campaign!.id,
      adSetId: adSet!.id,
      externalId: FORM_AD,
      name: 'adj2-vídeo-umberto-diagnostico',
      status: 'ACTIVE',
      effectiveStatus: 'ACTIVE',
    })
    .returning();
  formAdId = ad!.id;

  // L1: a Meta form lead RD never received. L2: RD received it (deal D2, the same e-mail a minute later).
  // L3: the same e-mail as a deal three days later (another request). L4: names its deal (D4).
  // L5: organic WhatsApp. L6: arrived before 28/09. L7: a test. L8: from the site, with paid UTMs.
  // L9: the deal D9 has only the phone in common.
  await addLead('l1', {});
  await addLead('l2', {});
  await addLead('l3', {});
  await addLead('l4', { rdDealId: 'D4' });
  await addLead('l5', {
    source: 'whatsapp',
    adPlatform: null,
    adCampaignExternalId: null,
    adExternalId: null,
  });
  await addLead('l6', { enteredAt: new Date('2026-09-20T10:00:00-03:00') });
  await addLead('l7', { name: 'Teste Fulano' });
  await addLead('l8', {
    source: 'site_form',
    adPlatform: null,
    adCampaignExternalId: null,
    adExternalId: null,
    utmSource: 'meta',
    utmMedium: 'paid_social',
    utmCampaign: FORM_NAME,
    utmContent: FORM_AD,
  });
  await addLead('l9', { email: null, phone: '5521998765432' });
}, 60_000);

afterAll(async () => {
  await harness?.drop();
});

describe('the sync with only the Wings leads (no RD token)', () => {
  beforeAll(async () => {
    await sync(null);
  });

  it('never calls RD without a token', () => {
    expect(fetchCalls).toEqual([]);
  });

  it('gives the lead RD never received a row of its own, with the campaign, ad and owner it carries', async () => {
    const row = await rowOfLead('l1');
    expect(row).toMatchObject({
      rdDealId: null,
      campaignId: formCampaignId,
      adId: formAdId,
      platform: 'meta',
      attribution: 'lead_ads',
      unattributedReason: null,
      stage: 'Sem contato',
      stageOrder: 1,
      ownerEmployeeId: ownerId,
      pipeline: 'Formatação',
      isTest: false,
    });
    expect(row!.enteredAt.toISOString()).toBe('2026-10-08T11:07:00.000Z');
    // The contact is kept sealed, with a mask, like a deal's.
    expect(row!.emailMasked).toBe('l•••@e•••.com');
    expect(box.open(row!.emailEncrypted!)).toBe('l1@example.com');
  });

  it('reads the campaign of a site lead from its paid UTMs', async () => {
    expect(await rowOfLead('l8')).toMatchObject({
      campaignId: formCampaignId,
      adId: formAdId,
      attribution: 'utm',
    });
  });

  it('keeps out an organic lead, one that arrived before 28/09, and a lead that names its deal', async () => {
    expect(await rowOfLead('l5')).toBeUndefined();
    expect(await rowOfLead('l6')).toBeUndefined();
    expect(await rowOfLead('l4')).toBeUndefined();
  });

  it('marks a test lead, which stays out of every figure', async () => {
    const row = await rowOfLead('l7');
    expect(row?.isTest).toBe(true);
    const rows = await visibleCampaignLeads(db, undefined);
    expect(summaryOf(rows, NOW).tests).toBe(1);
  });

  it('lists the lead to its owner and to nobody else in the own scope', async () => {
    const mine = await visibleCampaignLeads(db, ownerId);
    expect(mine.some((row) => row.leadId === ids.l1)).toBe(true);
    const other = (await createEmployee(db, { role: 'vendedor_formatacao' })).id;
    expect(await visibleCampaignLeads(db, other)).toEqual([]);
  });
});

describe('the sync with RD', () => {
  let ownRowOfL2: string;

  beforeAll(async () => {
    ownRowOfL2 = (await rowOfLead('l2'))!.id;
    await sync([
      deal('D2', '2026-10-08T08:08:00.000-03:00', { email: 'l2@example.com' }),
      deal('D3', '2026-10-09T09:30:00.000-03:00', { email: 'l3@example.com' }),
      deal('D4', '2026-10-08T08:09:00.000-03:00', { email: 'l4@example.com' }),
      deal('D9', '2026-10-08T08:10:00.000-03:00', { phone: '+55 (21) 99876-5432' }),
    ]);
  });

  it('joins the deal to the lead it belongs to: one line, the row the lead already had', async () => {
    const row = await rowOfDeal('D2');
    expect(row).toMatchObject({
      id: ownRowOfL2,
      leadId: ids.l2,
      campaignId: formCampaignId,
      adId: formAdId,
      attribution: 'lead_ads',
      stage: 'Sem contato',
      ownerEmployeeId: ownerId,
    });
    expect(
      await db.query.campaignLeads.findMany({ where: eq(campaignLeads.leadId, ids.l2!) }),
    ).toHaveLength(1);
  });

  it('joins by the phone when the e-mail is not the same', async () => {
    expect(await rowOfDeal('D9')).toMatchObject({
      leadId: ids.l9,
      campaignId: formCampaignId,
      attribution: 'lead_ads',
    });
  });

  it('does not join a deal of another request three days later: two lines', async () => {
    expect(await rowOfDeal('D3')).toMatchObject({
      leadId: null,
      campaignId: null,
      unattributedReason: 'not_paid',
    });
    expect(await rowOfLead('l3')).toMatchObject({ rdDealId: null, campaignId: formCampaignId });
  });

  it('leaves a deal the lead names as it was: the RD row, no second line', async () => {
    expect(await rowOfDeal('D4')).toMatchObject({
      leadId: null,
      campaignId: formCampaignId,
      attribution: 'lead_ads',
    });
    expect(await rowOfLead('l4')).toBeUndefined();
  });

  it('is the same on the next run', async () => {
    const before = (await db.query.campaignLeads.findMany()).map((row) => row.id).sort();
    await sync([
      deal('D2', '2026-10-08T08:08:00.000-03:00', { email: 'l2@example.com' }),
      deal('D3', '2026-10-09T09:30:00.000-03:00', { email: 'l3@example.com' }),
      deal('D4', '2026-10-08T08:09:00.000-03:00', { email: 'l4@example.com' }),
      deal('D9', '2026-10-08T08:10:00.000-03:00', { phone: '+55 (21) 99876-5432' }),
    ]);
    expect((await db.query.campaignLeads.findMany()).map((row) => row.id).sort()).toEqual(before);
  });

  it('follows the lead: moved to another stage and owner, the line shows it', async () => {
    const other = (await createEmployee(db, { role: 'vendedor_formatacao' })).id;
    await db
      .update(leads)
      .set({ stage: 'Contato feito', stageOrder: 2, ownerEmployeeId: other })
      .where(eq(leads.id, ids.l1!));
    await sync([]);
    expect(await rowOfLead('l1')).toMatchObject({
      stage: 'Contato feito',
      stageOrder: 2,
      ownerEmployeeId: other,
    });
  });

  it("drops the lead's own line once RD holds a deal that the lead names", async () => {
    await db.update(leads).set({ rdDealId: 'D1' }).where(eq(leads.id, ids.l1!));
    await sync([deal('D1', '2026-10-08T08:08:30.000-03:00', { email: 'l1@example.com' })]);
    expect(await rowOfLead('l1')).toBeUndefined();
    expect(await rowOfDeal('D1')).toMatchObject({
      campaignId: formCampaignId,
      attribution: 'lead_ads',
    });
  });

  it('counts the lines it made', async () => {
    const result = await sync([
      deal('D2', '2026-10-08T08:08:00.000-03:00', { email: 'l2@example.com' }),
    ]);
    expect(result).toMatchObject({ deals: 1, paired: 1 });
    expect(result.wingsLeads).toBeGreaterThanOrEqual(1);
    expect(CAMPAIGN_LEADS_SINCE).toBe('2026-09-28T00:00:00-03:00');
  });
});
