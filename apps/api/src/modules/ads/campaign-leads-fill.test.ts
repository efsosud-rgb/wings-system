import { WINGS_CLIENT_ID } from '@wings/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from '../../db/client.js';
import { leadEvents, leads } from '../../db/schema/index.js';
import { createTestDatabase, type TestDatabase } from '../../test/db.js';
import { fillLeadAttribution, type AttributionCampaign } from './campaign-leads-sync.js';

/**
 * A site lead copied from its RD deal comes with no UTM; the campaign and ad
 * its conversion's UTMs name are written on the lead (orchestrator, 13/10),
 * never over what the lead already says, and never from a guess. Made-up data.
 */

let harness: TestDatabase;
let db: Database;

beforeAll(async () => {
  harness = await createTestDatabase();
  db = harness.db;
}, 60_000);

afterAll(async () => {
  await harness?.drop();
});

const CAMPAIGNS: AttributionCampaign[] = [
  {
    id: '00000000-0000-4000-8000-0000000000c1',
    platform: 'meta',
    externalId: '120252260012720076',
    keys: ['formatacao_jimmyogro_set26'],
    ads: [
      { id: '00000000-0000-4000-8000-0000000000a1', externalId: '120252260025750076', keys: [] },
    ],
  },
];
const DECIDED = {
  platform: 'meta' as const,
  campaignId: '00000000-0000-4000-8000-0000000000c1',
  adId: '00000000-0000-4000-8000-0000000000a1',
  attribution: 'utm' as const,
  reason: null,
};
const UTMS = {
  source: 'facebook',
  medium: 'paid_social',
  campaign: 'formatacao_jimmyogro_set26',
  content: null,
};

const siteLead = async (extra: Partial<typeof leads.$inferInsert> = {}) => {
  const [row] = await db
    .insert(leads)
    .values({
      source: 'rd_crm',
      channel: 'landing_page',
      pipeline: 'formatacao',
      clientId: WINGS_CLIENT_ID,
      ...extra,
    })
    .returning();
  return row!;
};

describe('fillLeadAttribution', () => {
  it('writes the campaign and ad the UTM named on a lead that had none, with an event', async () => {
    const lead = await siteLead();
    expect(await fillLeadAttribution(db, lead, DECIDED, UTMS, CAMPAIGNS)).toBe(true);
    const row = await db.query.leads.findFirst({ where: eq(leads.id, lead.id) });
    expect(row).toMatchObject({
      utmCampaign: 'formatacao_jimmyogro_set26',
      utmMedium: 'paid_social',
      adPlatform: 'meta',
      adCampaignExternalId: '120252260012720076',
      adExternalId: '120252260025750076',
    });
    const events = await db.select().from(leadEvents).where(eq(leadEvents.leadId, lead.id));
    expect(events.map((event) => event.kind)).toEqual(['lead.attribution_filled']);
    // Once written, a second sync leaves it.
    expect(await fillLeadAttribution(db, row!, DECIDED, UTMS, CAMPAIGNS)).toBe(false);
  });

  it('never overwrites what the lead says, nor writes a guess', async () => {
    const own = await siteLead({ utmCampaign: 'outra_campanha' });
    expect(await fillLeadAttribution(db, own, DECIDED, UTMS, CAMPAIGNS)).toBe(false);
    expect((await db.query.leads.findFirst({ where: eq(leads.id, own.id) }))?.utmCampaign).toBe(
      'outra_campanha',
    );
    const plain = await siteLead();
    const guess = { ...DECIDED, attribution: 'rd_origin' as const };
    expect(await fillLeadAttribution(db, plain, guess, UTMS, CAMPAIGNS)).toBe(false);
    const platformOnly = { ...UTMS, campaign: null };
    expect(await fillLeadAttribution(db, plain, DECIDED, platformOnly, CAMPAIGNS)).toBe(false);
    expect(await fillLeadAttribution(db, plain, DECIDED, null, CAMPAIGNS)).toBe(false);
    expect((await db.query.leads.findFirst({ where: eq(leads.id, plain.id) }))?.utmCampaign).toBe(
      null,
    );
  });
});
