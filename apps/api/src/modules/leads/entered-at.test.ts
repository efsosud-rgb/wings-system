import { WINGS_CLIENT_ID } from '@wings/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from '../../db/client.js';
import { leads } from '../../db/schema/index.js';
import { createTestDatabase, type TestDatabase } from '../../test/db.js';
import { listLeads, upsertLead } from './service.js';

/**
 * The date a lead entered the CRM, by the source's own clock (`leads.entered_at`): kept on a new
 * lead, never moved by a later arrival, 'received' when the source brought none, and the one the
 * list sorts and filters by. `created_at` is the row's own time and stays as it was.
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

let counter = 0;
const nextPhone = () => `1197${String(++counter).padStart(7, '0')}`;

const arrive = (extra: Record<string, unknown>) =>
  upsertLead(db, {
    source: 'manual',
    phone: nextPhone(),
    clientId: WINGS_CLIENT_ID,
    clientMapped: false,
    skipResearch: true,
    distribute: false,
    event: { kind: 'lead.created_manually' },
    ...extra,
  });

const rowOf = (id: string) => db.query.leads.findFirst({ where: eq(leads.id, id) });
const HOUR = 3_600_000;

describe('entered_at on a new lead', () => {
  it("keeps the source's own date and says whose clock it is", async () => {
    const madeOnMeta = new Date(Date.now() - 5 * HOUR);
    const result = await arrive({
      source: 'meta_lead_ads',
      enteredAt: madeOnMeta,
      enteredAtSource: 'meta_created_time',
    });
    const row = await rowOf(result.lead.id);
    expect(row?.enteredAt.getTime()).toBe(madeOnMeta.getTime());
    expect(row?.enteredAtSource).toBe('meta_created_time');
    // The row's own time is the moment the system wrote it, not the source's date.
    expect(row!.createdAt.getTime()).toBeGreaterThan(madeOnMeta.getTime() + 4 * HOUR);
    expect(result.lead).toMatchObject({ enteredAtSource: 'meta_created_time' });
  });

  it('is "received" at the moment of arrival when the source brings no date', async () => {
    const before = Date.now();
    const result = await arrive({ source: 'google_lead_form' });
    const row = await rowOf(result.lead.id);
    expect(row?.enteredAtSource).toBe('received');
    expect(row!.enteredAt.getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect(row!.enteredAt.getTime()).toBeLessThanOrEqual(Date.now() + 1000);
  });

  it('is "received" when the date has no matching source, is not a date or lies in the future', async () => {
    const noSource = await arrive({ enteredAt: new Date(Date.now() - HOUR) });
    expect((await rowOf(noSource.lead.id))?.enteredAtSource).toBe('received');

    const broken = await arrive({
      enteredAt: new Date('not a date'),
      enteredAtSource: 'rd_conversion',
    });
    expect((await rowOf(broken.lead.id))?.enteredAtSource).toBe('received');

    const future = await arrive({
      enteredAt: new Date(Date.now() + 3 * HOUR),
      enteredAtSource: 'meta_created_time',
    });
    expect((await rowOf(future.lead.id))?.enteredAtSource).toBe('received');
  });

  it('uses "now" for a date a few seconds ahead (clock skew between machines)', async () => {
    const skew = new Date(Date.now() + 30_000);
    const result = await arrive({ enteredAt: skew, enteredAtSource: 'form_submitted' });
    const row = await rowOf(result.lead.id);
    expect(row?.enteredAtSource).toBe('form_submitted');
    expect(row!.enteredAt.getTime()).toBeLessThanOrEqual(Date.now() + 1000);
  });

  it('never moves the date of a lead that already exists', async () => {
    const phone = nextPhone();
    const first = await arrive({
      phone,
      source: 'site_form',
      enteredAt: new Date(Date.now() - 2 * HOUR),
      enteredAtSource: 'form_submitted',
    });
    const before = await rowOf(first.lead.id);
    const again = await arrive({
      phone,
      source: 'meta_lead_ads',
      enteredAt: new Date(Date.now() - 10 * HOUR),
      enteredAtSource: 'meta_created_time',
    });
    expect(again.created).toBe(false);
    const after = await rowOf(first.lead.id);
    expect(after?.enteredAt.getTime()).toBe(before?.enteredAt.getTime());
    expect(after?.enteredAtSource).toBe('form_submitted');
  });
});

describe('the list by entry date', () => {
  it('sorts and filters by entered_at, not by the row time', async () => {
    const tag = `Entrada ${Date.now()}`;
    const days = (n: number) => new Date(Date.now() - n * 24 * HOUR);
    const oldest = await arrive({
      name: `${tag} A`,
      enteredAt: days(20),
      enteredAtSource: 'rd_deal_created',
    });
    const middle = await arrive({
      name: `${tag} B`,
      enteredAt: days(10),
      enteredAtSource: 'meta_created_time',
    });
    const newest = await arrive({ name: `${tag} C` });

    const asc = await listLeads(db, { q: tag, sort: 'oldest' });
    expect(asc.leads.map((lead) => lead.id)).toEqual([
      oldest.lead.id,
      middle.lead.id,
      newest.lead.id,
    ]);
    expect(asc.leads[0]).toMatchObject({ enteredAtSource: 'rd_deal_created' });
    expect(asc.leads[2]).toMatchObject({ enteredAtSource: 'received' });
    const desc = await listLeads(db, { q: tag });
    expect(desc.leads.map((lead) => lead.id)).toEqual([
      newest.lead.id,
      middle.lead.id,
      oldest.lead.id,
    ]);

    // A day in Brasília time: the window around the middle lead holds only that lead,
    // although all three rows were written today.
    const dayOf = (date: Date) =>
      new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(date);
    const window = await listLeads(db, {
      q: tag,
      createdFrom: dayOf(days(11)),
      createdTo: dayOf(days(9)),
    });
    expect(window.leads.map((lead) => lead.id)).toEqual([middle.lead.id]);
  });
});
