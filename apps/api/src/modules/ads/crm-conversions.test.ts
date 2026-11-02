import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from '../../db/client.js';
import { leadAdIdentifiers } from '../../db/schema/index.js';
import { createTestDatabase, type TestDatabase } from '../../test/db.js';
import { recordContactOptOut } from '../leads/contact-block.js';
import {
  conversionsKit,
  ENTERED,
  GOOGLE_ON,
  HOUR,
  META_ON,
  NOW,
  platforms,
  STAGE_AT,
} from './crm-conversions-fixtures.js';
import { metaEmail, metaPhone, sha256Hex } from './crm-conversions-hash.js';
import { MAX_ATTEMPTS } from './crm-conversions.js';

let harness: TestDatabase;
let db: Database;

beforeAll(async () => {
  harness = await createTestDatabase();
  db = harness.db;
}, 60_000);

afterAll(async () => {
  await harness?.drop();
});

const { envOf, cycle, stage, mapStage, lead, enter, sendsOf, setup } = conversionsKit(
  () => harness,
);

describe('flags', () => {
  it('sends nothing and queues nothing while the platform is off', async () => {
    const { lead: row } = await setup('meta');
    const sim = platforms();
    const result = await cycle(envOf(), sim.fetchImpl);
    expect(result).toEqual({ ran: true, platforms: {} });
    expect(sim.calls).toHaveLength(0);
    expect(await sendsOf(row.id)).toHaveLength(0);
  });

  it('sends nothing without the cut-off day, even with the switch on', async () => {
    const { lead: row } = await setup('meta');
    const sim = platforms();
    await cycle(envOf({ ...META_ON, CRM_CONVERSIONS_SINCE: '' }), sim.fetchImpl);
    expect(sim.calls).toHaveLength(0);
    expect(await sendsOf(row.id)).toHaveLength(0);
  });
});

describe('Meta, instant form lead (CRM integration)', () => {
  it('sends one event with the lead id, unhashed, and nothing personal', async () => {
    const { lead: row } = await setup('meta');
    const sim = platforms();
    await cycle(envOf(META_ON), sim.fetchImpl);

    const [send] = await sendsOf(row.id);
    expect(send).toMatchObject({ state: 'sent', identifierKind: 'meta_lead_id', attempts: 1 });
    expect(send!.fieldsSent).toEqual(['lead_id']);
    const call = sim.events().find((c) => c.body.includes(send!.id));
    expect(call?.url).toBe('https://graph.facebook.com/v26.0/123456789012345/events');
    expect(call?.authorization).toBe('Bearer token-de-teste-meta');
    expect(call?.url).not.toContain('token');
    // The lead id travels as a number, exactly.
    expect(call?.body).toContain(`"lead_id":${row.externalId}`);
    const event = JSON.parse(call!.body).data[0];
    expect(event).toMatchObject({
      event_name: 'reuniao_agendada',
      event_time: STAGE_AT.getTime() / 1000,
      event_id: send!.id,
      action_source: 'system_generated',
      custom_data: { event_source: 'crm', lead_event_source: 'Wings System' },
    });
    expect(call?.body).not.toContain(row.email!);
    expect(call?.body).not.toContain(row.phone!);
  });

  it('sends once per stage: a second cycle and a second entry into the stage add nothing', async () => {
    const { stageId, lead: row } = await setup('meta');
    const sim = platforms();
    await cycle(envOf(META_ON), sim.fetchImpl);
    await enter(row.id, stageId, new Date(STAGE_AT.getTime() + 5 * HOUR));
    await cycle(envOf(META_ON), sim.fetchImpl, new Date(NOW.getTime() + HOUR));

    const sends = await sendsOf(row.id);
    expect(sends).toHaveLength(1);
    expect(sim.events().filter((c) => c.body.includes(sends[0]!.id))).toHaveLength(1);
  });

  it('a platform failure goes back to the queue and the next try carries the same event id', async () => {
    const { lead: row } = await setup('meta');
    const sim = platforms({ meta: [Response.json({ error: { code: 2 } }, { status: 500 })] });
    await cycle(envOf(META_ON), sim.fetchImpl);

    const [waiting] = await sendsOf(row.id);
    expect(waiting).toMatchObject({ state: 'pending', lastError: 'http_500:2', attempts: 1 });
    expect(waiting!.nextAttemptAt.getTime()).toBeGreaterThan(NOW.getTime());
    // Not due yet: nothing goes.
    await cycle(envOf(META_ON), sim.fetchImpl);
    expect(sim.events().filter((c) => c.body.includes(waiting!.id))).toHaveLength(1);

    await cycle(envOf(META_ON), sim.fetchImpl, new Date(NOW.getTime() + HOUR));
    const [sent] = await sendsOf(row.id);
    expect(sent).toMatchObject({ state: 'sent', attempts: 2, lastError: null });
    expect(sim.events().filter((c) => c.body.includes(waiting!.id))).toHaveLength(2);
  });

  it(`gives up after ${MAX_ATTEMPTS} failed tries`, async () => {
    const { lead: row } = await setup('meta');
    const failing = Array.from({ length: MAX_ATTEMPTS }, () => new Response('{}', { status: 503 }));
    const sim = platforms({ meta: failing });
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      await cycle(envOf(META_ON), sim.fetchImpl, new Date(NOW.getTime() + i * 7 * HOUR));
    }
    const [send] = await sendsOf(row.id);
    expect(send).toMatchObject({ state: 'failed', lastError: 'http_503', attempts: MAX_ATTEMPTS });
  });

  it('a refusal is failed for good, and a timeout is not tried again (it may have arrived)', async () => {
    const refused = await setup('meta');
    const timedOut = await setup('meta');
    const timeout = Object.assign(new Error('timed out'), { name: 'TimeoutError' });
    const sim = platforms({
      meta: [
        Response.json({ error: { code: 100, error_subcode: 2804003 } }, { status: 400 }),
        timeout,
      ],
    });
    await cycle(envOf(META_ON), sim.fetchImpl);
    await cycle(envOf(META_ON), sim.fetchImpl, new Date(NOW.getTime() + 7 * HOUR));
    const states = [(await sendsOf(refused.lead.id))[0], (await sendsOf(timedOut.lead.id))[0]];
    expect(states.map((s) => s?.state)).toEqual(['failed', 'failed']);
    expect(states.map((s) => s?.lastError).sort()).toEqual(['http_400:100.2804003', 'timeout']);
    expect(states.map((s) => s?.attempts)).toEqual([1, 1]);
  });
});

describe('a lead without a platform id', () => {
  it('is skipped while the hashed path is off', async () => {
    const { lead: row } = await setup('meta', { source: 'site_form', externalId: null });
    const sim = platforms();
    await cycle(envOf(META_ON), sim.fetchImpl);
    expect((await sendsOf(row.id))[0]).toMatchObject({
      state: 'skipped',
      skipReason: 'no_identifier',
    });
    expect(sim.events()).toHaveLength(0);
  });

  it('goes by the hashed path when it is on: e-mail and phone hashed, never in clear', async () => {
    const { lead: row } = await setup('meta', { source: 'site_form', externalId: null });
    const sim = platforms();
    await cycle(envOf({ ...META_ON, CRM_CONVERSIONS_HASHED_ENABLED: 'true' }), sim.fetchImpl);
    const [send] = await sendsOf(row.id);
    expect(send).toMatchObject({ state: 'sent', identifierKind: 'hashed' });
    expect(send!.fieldsSent).toEqual(['em', 'ph', 'external_id']);
    const call = sim.events().find((c) => c.body.includes(send!.id))!;
    const userData = JSON.parse(call.body).data[0].user_data;
    expect(userData.em).toEqual([sha256Hex(metaEmail(row.email)!)]);
    expect(userData.ph).toEqual([sha256Hex(metaPhone(row.phone)!)]);
    expect(call.body).not.toContain(row.email!);
    expect(call.body).not.toContain(row.phone!);
    // Nothing of the hash is kept in our tables.
    expect(JSON.stringify(send)).not.toContain(userData.em[0]);
  });

  it('with a click id from the site, sends fbc (built from the fbclid) without hashing anything', async () => {
    const { lead: row } = await setup('meta', { source: 'site_form', externalId: null });
    const seen = new Date('2026-10-30T08:59:00.000Z');
    await db.insert(leadAdIdentifiers).values({
      leadId: row.id,
      kind: 'fbclid',
      value: 'IwAR-teste',
      source: 'site_form',
      capturedAt: seen,
    });
    const sim = platforms();
    await cycle(envOf(META_ON), sim.fetchImpl);
    const [send] = await sendsOf(row.id);
    expect(send).toMatchObject({ state: 'sent', identifierKind: 'click_id', fieldsSent: ['fbc'] });
    const call = sim.events().find((c) => c.body.includes(send!.id))!;
    expect(JSON.parse(call.body).data[0].user_data).toEqual({
      fbc: `fb.1.${seen.getTime()}.IwAR-teste`,
    });
  });
});

describe('what never goes', () => {
  it('a person who asked "não me contate" (by any key)', async () => {
    const { lead: row } = await setup('meta');
    await recordContactOptOut(db, {
      leadId: row.id,
      channels: ['email'],
      origin: 'crm',
      reason: null,
      createdBy: null,
    });
    const sim = platforms();
    await cycle(envOf(META_ON), sim.fetchImpl);
    expect((await sendsOf(row.id))[0]).toMatchObject({ state: 'skipped', skipReason: 'opt_out' });
    expect(sim.events()).toHaveLength(0);
  });

  it('a stage change from an import or the RD mirror, a stage not mapped, an inactive mapping', async () => {
    const stageId = await stage();
    await mapStage(stageId, 'meta');
    const imported = await lead();
    await enter(imported.id, stageId, STAGE_AT, 'import');
    const mirrored = await lead();
    await enter(mirrored.id, stageId, STAGE_AT, 'rd');
    const unmapped = await lead();
    await enter(unmapped.id, await stage());
    const inactiveStage = await stage();
    await mapStage(inactiveStage, 'meta', false);
    const inactive = await lead();
    await enter(inactive.id, inactiveStage);
    await cycle(envOf(META_ON), platforms().fetchImpl);
    for (const row of [imported, mirrored, unmapped, inactive]) {
      expect(await sendsOf(row.id)).toHaveLength(0);
    }
  });

  it('a first entry before the cut-off day, even when the lead comes back to the stage later', async () => {
    const stageId = await stage();
    await mapStage(stageId, 'meta');
    const row = await lead({ enteredAt: new Date('2026-10-01T09:00:00.000Z') });
    await enter(row.id, stageId, new Date('2026-10-10T09:00:00.000Z'));
    await enter(row.id, stageId);
    await cycle(envOf(META_ON), platforms().fetchImpl);
    expect(await sendsOf(row.id)).toHaveLength(0);
  });

  it('a Meta event older than 7 days when its turn comes', async () => {
    const { lead: row } = await setup('meta');
    const sim = platforms({ meta: [new Response('{}', { status: 503 })] });
    await cycle(envOf(META_ON), sim.fetchImpl);
    await cycle(envOf(META_ON), sim.fetchImpl, new Date(STAGE_AT.getTime() + 8 * 24 * HOUR));
    expect((await sendsOf(row.id))[0]).toMatchObject({ state: 'skipped', skipReason: 'expired' });
  });
});

describe('Google (Data Manager)', () => {
  async function withGclid() {
    const setupResult = await setup('google', { source: 'site_form', externalId: null });
    await db.insert(leadAdIdentifiers).values({
      leadId: setupResult.lead.id,
      kind: 'gclid',
      value: 'Cj0KCQ-teste',
      source: 'site_form',
      capturedAt: ENTERED,
    });
    return setupResult;
  }

  it('sends the gclid to the conversion action, only validating by default (never "sent")', async () => {
    const { lead: row } = await withGclid();
    const sim = platforms();
    await cycle(envOf(GOOGLE_ON), sim.fetchImpl);
    const [send] = await sendsOf(row.id);
    expect(send).toMatchObject({
      state: 'validated',
      sentAt: null,
      identifierKind: 'click_id',
      destination: '987654321',
      platformRequestId: 'pedido-de-teste',
    });
    const call = sim.events().find((c) => c.body.includes(send!.id))!;
    expect(call.url).toBe('https://datamanager.googleapis.com/v1/events:ingest');
    expect(call.authorization).toBe('Bearer acesso-de-teste');
    const body = JSON.parse(call.body);
    expect(body).toMatchObject({
      destinations: [
        {
          operatingAccount: { accountType: 'GOOGLE_ADS', accountId: '1112223333' },
          productDestinationId: '987654321',
        },
      ],
      encoding: 'HEX',
      validateOnly: true,
      events: [
        {
          transactionId: send!.id,
          eventTimestamp: STAGE_AT.toISOString(),
          adIdentifiers: { gclid: 'Cj0KCQ-teste' },
        },
      ],
    });
    expect(body.events[0].userData).toBeUndefined();
  });

  it('a 503 goes back to the queue and is sent again with the same transactionId', async () => {
    const { lead: row } = await withGclid();
    // Two: the row the test above only validated is due too, now that validation is off.
    const unavailable = () => new Response('{}', { status: 503 });
    const sim = platforms({ google: [unavailable(), unavailable()] });
    await cycle(
      envOf({ ...GOOGLE_ON, CRM_CONVERSIONS_GOOGLE_VALIDATE_ONLY: 'false' }),
      sim.fetchImpl,
    );
    const [waiting] = await sendsOf(row.id);
    expect(waiting).toMatchObject({ state: 'pending', lastError: 'http_503' });
    await cycle(
      envOf({ ...GOOGLE_ON, CRM_CONVERSIONS_GOOGLE_VALIDATE_ONLY: 'false' }),
      sim.fetchImpl,
      new Date(NOW.getTime() + HOUR),
    );
    const [sent] = await sendsOf(row.id);
    expect(sent).toMatchObject({ state: 'sent', attempts: 2 });
    const calls = sim.events().filter((c) => c.body.includes(waiting!.id));
    expect(calls).toHaveLength(2);
    expect(JSON.parse(calls[1]!.body).validateOnly).toBe(false);
  });

  it('a gclid older than 90 days is out of the window', async () => {
    const { lead: row } = await setup('google', { source: 'site_form', externalId: null });
    await db.insert(leadAdIdentifiers).values({
      leadId: row.id,
      kind: 'gclid',
      value: 'Cj0KCQ-velho',
      source: 'site_form',
      capturedAt: new Date(NOW.getTime() - 91 * 24 * HOUR),
    });
    const sim = platforms();
    await cycle(envOf(GOOGLE_ON), sim.fetchImpl);
    expect((await sendsOf(row.id))[0]).toMatchObject({ state: 'skipped', skipReason: 'expired' });
    expect(sim.events()).toHaveLength(0);
  });

  it('without a token from Google, nothing is claimed and no try is spent', async () => {
    const { lead: row } = await withGclid();
    const fetchImpl = (async () =>
      Response.json({ error: 'invalid_grant' }, { status: 400 })) as unknown as typeof fetch;
    const result = await cycle(envOf(GOOGLE_ON), fetchImpl);
    expect(result.ran && result.platforms.google?.authError).toBe('google_auth_400:invalid_grant');
    expect((await sendsOf(row.id))[0]).toMatchObject({ state: 'pending', attempts: 0 });
  });
});
