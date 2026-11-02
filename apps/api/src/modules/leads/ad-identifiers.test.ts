import { WINGS_CLIENT_ID } from '@wings/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from '../../db/client.js';
import { leadAdIdentifiers } from '../../db/schema/index.js';
import { createTestDatabase, type TestDatabase } from '../../test/db.js';
import { adIdentifiersOf } from './ad-identifiers.js';
import { googleLeadOf, ingestGoogleLead } from './google-leads.js';
import { upsertLead, type IncomingLead } from './service.js';

let harness: TestDatabase;
let db: Database;

beforeAll(async () => {
  harness = await createTestDatabase();
  db = harness.db;
}, 60_000);

afterAll(async () => {
  await harness?.drop();
});

const idsOf = async (leadId: string) =>
  (await db.select().from(leadAdIdentifiers).where(eq(leadAdIdentifiers.leadId, leadId)))
    .map((row) => ({ kind: row.kind, value: row.value, source: row.source, at: row.capturedAt }))
    .sort((a, b) => a.kind.localeCompare(b.kind));

// Made-up people: 55 21 9xxxx numbers no test elsewhere uses.
const arrival = (values: Partial<IncomingLead>): IncomingLead => ({
  source: 'site_form',
  clientId: WINGS_CLIENT_ID,
  clientMapped: true,
  skipResearch: true,
  distribute: false,
  event: { kind: 'lead.received.test' },
  ...values,
});

describe('adIdentifiersOf', () => {
  it("takes Meta's lead id only from the Meta door, and only values in the platform's shape", () => {
    expect(
      adIdentifiersOf({
        source: 'meta_lead_ads',
        externalId: '1234567890123456',
        attribution: { gclid: 'Cj0-ok', fbclid: 'x' },
        metaBrowserIds: { fbc: 'fb.1.1761955200000.IwAR-ok', fbp: 'nao-e-fbp' },
      }),
    ).toEqual([
      { kind: 'meta_lead_id', value: '1234567890123456' },
      { kind: 'gclid', value: 'Cj0-ok' },
      { kind: 'fbc', value: 'fb.1.1761955200000.IwAR-ok' },
    ]);
    expect(adIdentifiersOf({ source: 'rd_station', externalId: '1234567890123456' })).toEqual([]);
  });
});

describe('the arrival keeps its identifiers on the lead', () => {
  it("a Meta instant form: the leadgen id, with Meta's moment", async () => {
    const createdTime = new Date('2026-10-30T09:00:00.000Z');
    const result = await upsertLead(
      db,
      arrival({
        source: 'meta_lead_ads',
        externalId: '1234567890123001',
        phone: '21987650001',
        enteredAt: createdTime,
        enteredAtSource: 'meta_created_time',
      }),
    );
    expect(await idsOf(result.lead.id)).toEqual([
      { kind: 'meta_lead_id', value: '1234567890123001', source: 'meta_lead_ads', at: createdTime },
    ]);
  });

  it('a person who comes back by another door keeps both, each with its own door', async () => {
    const first = await upsertLead(
      db,
      arrival({ phone: '21987650002', attribution: { gclid: 'Cj0-primeiro' } }),
    );
    const again = await upsertLead(
      db,
      arrival({
        source: 'meta_lead_ads',
        externalId: '1234567890123002',
        phone: '21987650002',
        attribution: { gclid: 'Cj0-primeiro' },
      }),
    );
    expect(again.lead.id).toBe(first.lead.id);
    expect((await idsOf(first.lead.id)).map((id) => [id.kind, id.source])).toEqual([
      ['gclid', 'site_form'],
      ['meta_lead_id', 'meta_lead_ads'],
    ]);
  });

  it('an import keeps none (its stage changes are never sent)', async () => {
    const result = await upsertLead(
      db,
      arrival({
        phone: '21987650003',
        importBatchId: 'lote-teste',
        attribution: { gclid: 'Cj0-imp' },
      }),
    );
    expect(await idsOf(result.lead.id)).toEqual([]);
  });

  it("Google's lead form: the gcl_id is kept as the gclid", async () => {
    const lead = googleLeadOf({
      lead_id: 'google-lead-1',
      form_id: '77',
      campaign_id: '88',
      gcl_id: 'Cj0KCQ-google-form',
      user_column_data: [{ column_id: 'PHONE_NUMBER', string_value: '+55 21 98765-0004' }],
    });
    expect(lead?.gclId).toBe('Cj0KCQ-google-form');
    await ingestGoogleLead({ db, log: () => {} }, lead!);
    const [row] = await db
      .select()
      .from(leadAdIdentifiers)
      .where(eq(leadAdIdentifiers.value, 'Cj0KCQ-google-form'));
    expect(row).toMatchObject({ kind: 'gclid', source: 'google_lead_form' });
  });
});
