import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { leadAdIdentifiers } from '../../db/schema/index.js';
import { createTestDatabase, type TestDatabase } from '../../test/db.js';
import { recordContactOptOut } from '../leads/contact-block.js';
import {
  conversionsKit,
  GOOGLE_ON,
  HOUR,
  META_ON,
  NOW,
  platforms,
} from './crm-conversions-fixtures.js';
import { conversionsPanel } from './crm-conversions-status.js';

/**
 * Each guard of closing the loop, in a case where it alone holds the event back (the other guards
 * loose), and Google's validation, which never counts as sent (revisão do PR #81).
 */

let harness: TestDatabase;

beforeAll(async () => {
  harness = await createTestDatabase();
}, 60_000);

afterAll(async () => {
  await harness?.drop();
});

const { envOf, cycle, stage, mapStage, lead, enter, sendsOf, setup } = conversionsKit(
  () => harness,
);
const later = (hours: number) => new Date(NOW.getTime() + hours * HOUR);
const GOOGLE_RECORDS = { ...GOOGLE_ON, CRM_CONVERSIONS_GOOGLE_VALIDATE_ONLY: 'false' };

async function googleLead() {
  const result = await setup('google', { source: 'site_form', externalId: null });
  await harness.db.insert(leadAdIdentifiers).values({
    leadId: result.lead.id,
    kind: 'gclid',
    value: 'Cj0KCQ-ensaio',
    source: 'site_form',
    capturedAt: result.lead.enteredAt,
  });
  return result;
}

describe('validating is never sending', () => {
  it('Google: what only validated is recorded for real once validation is off', async () => {
    const { lead: row } = await googleLead();
    const sim = platforms();
    await cycle(envOf(GOOGLE_ON), sim.fetchImpl);
    const [validated] = await sendsOf(row.id);
    expect(validated).toMatchObject({ state: 'validated', sentAt: null, attempts: 1 });
    let google = (await conversionsPanel(harness.db, envOf(GOOGLE_ON), NOW)).platforms[1]!;
    expect(google).toMatchObject({ sent: 0, validated: 1, lastSentAt: null });

    // Still rehearsing: it is not validated again.
    await cycle(envOf(GOOGLE_ON), sim.fetchImpl, later(1));
    expect(sim.events().filter((c) => c.body.includes(validated!.id))).toHaveLength(1);

    await cycle(envOf(GOOGLE_RECORDS), sim.fetchImpl, later(2));
    const [sent] = await sendsOf(row.id);
    expect(sent).toMatchObject({ state: 'sent', attempts: 1 });
    expect(sent!.sentAt?.toISOString()).toBe(later(2).toISOString());
    const calls = sim.events().filter((c) => c.body.includes(validated!.id));
    expect(calls.map((c) => JSON.parse(c.body).validateOnly)).toEqual([true, false]);
    expect(calls.map((c) => JSON.parse(c.body).events[0].transactionId)).toEqual([
      validated!.id,
      validated!.id,
    ]);
    google = (await conversionsPanel(harness.db, envOf(GOOGLE_RECORDS), later(2))).platforms[1]!;
    expect(google).toMatchObject({ sent: 1, validated: 0 });
  });

  it('Meta: a test-coded event is a real send (Meta keeps it), so it never goes twice', async () => {
    const { lead: row } = await setup('meta');
    const sim = platforms();
    const testing = envOf({ ...META_ON, CRM_CONVERSIONS_META_TEST_EVENT_CODE: 'TEST123' });
    await cycle(testing, sim.fetchImpl);
    const [send] = await sendsOf(row.id);
    expect(send).toMatchObject({ state: 'sent', attempts: 1 });
    expect((await conversionsPanel(harness.db, testing, NOW)).metaTestEvents).toBe(true);

    await cycle(envOf(META_ON), sim.fetchImpl, later(1));
    const bodies = sim
      .events()
      .filter((c) => c.body.includes(send!.id))
      .map((c) => JSON.parse(c.body));
    expect(bodies.map((b) => b.test_event_code)).toEqual(['TEST123']);
  });
});

describe('the cut-off day alone holds the event back', () => {
  it("Meta: a first entry inside Meta's 7 days but before the cut-off never goes", async () => {
    // Meta's window starts on 26/10 at noon; the cut-off is later, on 30/10.
    const env = envOf({ ...META_ON, CRM_CONVERSIONS_SINCE: '2026-10-30' });
    const stageId = await stage();
    await mapStage(stageId, 'meta');
    const enteredAt = new Date('2026-10-20T09:00:00.000Z');
    const before = await lead({ enteredAt });
    await enter(before.id, stageId, new Date('2026-10-28T12:00:00.000Z'));
    const after = await lead({ enteredAt });
    await enter(after.id, stageId, new Date('2026-10-31T12:00:00.000Z'));
    const sim = platforms();
    await cycle(env, sim.fetchImpl);
    expect(await sendsOf(before.id)).toHaveLength(0);
    expect((await sendsOf(after.id))[0]).toMatchObject({ state: 'sent' });
  });

  it("Google: a first entry inside Google's 90 days but before the cut-off never goes", async () => {
    const stageId = await stage();
    await mapStage(stageId, 'google');
    const enteredAt = new Date('2026-10-01T09:00:00.000Z');
    const ids: string[] = [];
    for (const at of ['2026-10-15T12:00:00.000Z', '2026-10-21T12:00:00.000Z']) {
      const row = await lead({ source: 'site_form', externalId: null, enteredAt });
      await harness.db.insert(leadAdIdentifiers).values({
        leadId: row.id,
        kind: 'gclid',
        value: 'Cj0KCQ-corte',
        source: 'site_form',
        capturedAt: enteredAt,
      });
      await enter(row.id, stageId, new Date(at));
      ids.push(row.id);
    }
    await cycle(envOf(GOOGLE_RECORDS), platforms().fetchImpl);
    expect(await sendsOf(ids[0]!)).toHaveLength(0);
    expect((await sendsOf(ids[1]!))[0]).toMatchObject({ state: 'sent' });
  });
});

describe('"não me contate" by a key other than the lead', () => {
  it('blocks by the phone, recorded on another lead with the same number', async () => {
    const { lead: row } = await setup('meta');
    const other = await lead({ phone: row.phone, email: null });
    await recordContactOptOut(harness.db, {
      leadId: other.id,
      channels: ['whatsapp'],
      origin: 'crm',
      reason: null,
      createdBy: null,
    });
    const sim = platforms();
    await cycle(envOf(META_ON), sim.fetchImpl);
    expect((await sendsOf(row.id))[0]).toMatchObject({ state: 'skipped', skipReason: 'opt_out' });
    expect(sim.events().filter((c) => c.body.includes(row.externalId!))).toHaveLength(0);
  });

  it('blocks by the e-mail alone', async () => {
    const { lead: row } = await setup('meta');
    await recordContactOptOut(harness.db, {
      email: row.email,
      channels: ['email'],
      origin: 'crm',
      reason: null,
      createdBy: null,
    });
    const sim = platforms();
    await cycle(envOf(META_ON), sim.fetchImpl);
    expect((await sendsOf(row.id))[0]).toMatchObject({ state: 'skipped', skipReason: 'opt_out' });
    expect(sim.events().filter((c) => c.body.includes(row.externalId!))).toHaveLength(0);
  });
});

describe('a refused token', () => {
  it('Meta (code 190): the whole batch waits, no try spent, and goes once the token works', async () => {
    const first = await setup('meta');
    const second = await setup('meta');
    const sim = platforms({
      meta: [Response.json({ error: { code: 190, error_subcode: 463 } }, { status: 400 })],
    });
    const result = await cycle(envOf(META_ON), sim.fetchImpl);
    expect(result.ran && result.platforms.meta?.authError).toBe('http_400:190.463');
    expect(sim.events()).toHaveLength(1);
    for (const id of [first.lead.id, second.lead.id]) {
      expect((await sendsOf(id))[0]).toMatchObject({ state: 'pending', attempts: 0 });
    }
    await cycle(envOf(META_ON), sim.fetchImpl, later(1));
    for (const id of [first.lead.id, second.lead.id]) {
      expect((await sendsOf(id))[0]).toMatchObject({ state: 'sent', attempts: 1 });
    }
  });

  it('Google (403): the row waits, no try spent', async () => {
    const { lead: row } = await googleLead();
    const sim = platforms({
      google: [Response.json({ error: { status: 'PERMISSION_DENIED' } }, { status: 403 })],
    });
    const result = await cycle(envOf(GOOGLE_RECORDS), sim.fetchImpl);
    expect(result.ran && result.platforms.google?.authError).toBe('http_403:PERMISSION_DENIED');
    expect((await sendsOf(row.id))[0]).toMatchObject({ state: 'pending', attempts: 0 });
  });
});

describe("Meta's lead id", () => {
  it('is not used when it is not digits only, and the request stays valid JSON', async () => {
    const { lead: row } = await setup('meta', { externalId: '12345"6789' });
    const sim = platforms();
    await cycle(envOf({ ...META_ON, CRM_CONVERSIONS_HASHED_ENABLED: 'true' }), sim.fetchImpl);
    const [send] = await sendsOf(row.id);
    expect(send).toMatchObject({ state: 'sent', identifierKind: 'hashed' });
    const call = sim.events().find((c) => c.body.includes(send!.id))!;
    expect(JSON.parse(call.body).data[0].user_data.lead_id).toBeUndefined();
  });
});
