import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { WINGS_CLIENT_ID } from '@wings/shared';
import { eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from '../../db/client.js';
import { leadEvents, leads } from '../../db/schema/index.js';
import { createTestDatabase, type TestDatabase } from '../../test/db.js';
import { loadLead, upsertLead } from './service.js';
import { hasCapitalDdd, hasRobotEmail, inBurst, suspectReasonsOf } from './suspect.js';

/**
 * The robot of Grupo Forte Fênix's page (orchestrator, 13/10): the robot's
 * e-mail and a capital's DDD, plus a burst or direct traffic, mark a lead as
 * suspect with the reasons; nothing closes, loses or deletes it. Migration
 * 0088 applies the same rule to the leads already there. All data made up.
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

const MINUTE = 60_000;
let counter = 0;
const robotEmail = () => `fulano.detal${String(1_000_000_000 + ++counter)}@gmail.com`;
const capitalPhone = () => `2198${String(1_000_000 + ++counter).slice(-7)}`;

const arrive = (extra: Record<string, unknown>) =>
  upsertLead(db, {
    source: 'rd_station',
    channel: 'landing_page',
    clientId: WINGS_CLIENT_ID,
    clientMapped: false,
    skipResearch: true,
    distribute: false,
    event: { kind: 'lead.received.rd_station' },
    ...extra,
  });

const rowOf = (id: string) => db.query.leads.findFirst({ where: eq(leads.id, id) });

describe('the signs, one by one', () => {
  it('reads the e-mail, the DDD and the burst as the orchestrator described them', () => {
    expect(hasRobotEmail('maria.souza4198765432@gmail.com', '5521999990000')).toBe(true);
    expect(hasRobotEmail('Maria.Souza4198765432@Gmail.com', '5521999990000')).toBe(true);
    // The digits are the phone's: a person who used their own number.
    expect(hasRobotEmail('maria.souza2199999000@gmail.com', '5521999990000')).toBe(false);
    expect(hasRobotEmail('maria.souza1199988877@gmail.com', '5511999888777')).toBe(false);
    expect(hasRobotEmail('maria.souza21999990000@gmail.com', '5521999990000')).toBe(false);
    expect(hasRobotEmail('maria.souza12345@gmail.com', null)).toBe(false);
    expect(hasRobotEmail('maria.souza1234567890@hotmail.com', null)).toBe(false);
    expect(hasCapitalDdd('5521987654321')).toBe(true);
    expect(hasCapitalDdd('5585987654321')).toBe(true);
    expect(hasCapitalDdd('5524987654321')).toBe(false);
    expect(hasCapitalDdd(null)).toBe(false);
    const t = Date.UTC(2026, 9, 7, 22, 6);
    expect(inBurst(t, [t, t + MINUTE, t + 2 * MINUTE, t + 3 * MINUTE])).toBe(true);
    expect(inBurst(t, [t, t + MINUTE, t + 2 * MINUTE, t + 4 * MINUTE])).toBe(false);
    expect(inBurst(t + 3 * MINUTE, [t, t + MINUTE, t + 2 * MINUTE, t + 3 * MINUTE])).toBe(true);
  });

  it('needs a burst or direct traffic on top of the e-mail and the DDD', () => {
    const lead = {
      email: 'maria.souza4198765432@gmail.com',
      phone: '5521999990000',
      utmSource: 'facebook',
      utmMedium: null,
      utmCampaign: null,
      utmContent: null,
      utmTerm: null,
      gclid: null,
      fbclid: null,
      gbraid: null,
      wbraid: null,
      referrer: null,
      adPlatform: null,
      adCampaignExternalId: null,
      adExternalId: null,
      campaignId: null,
    };
    expect(suspectReasonsOf(lead, false)).toBeNull();
    expect(suspectReasonsOf(lead, true)).toEqual(['robot_email', 'capital_ddd', 'burst']);
    expect(suspectReasonsOf({ ...lead, utmSource: null }, false)).toEqual([
      'robot_email',
      'capital_ddd',
      'direct_traffic',
    ]);
    expect(suspectReasonsOf({ ...lead, phone: '5524999990000', utmSource: null }, true)).toBeNull();
  });
});

describe('on arrival', () => {
  it('marks the four of a burst once the fourth arrives, and leaves the lead open', async () => {
    const start = new Date(Date.UTC(2026, 9, 7, 22, 6, 31));
    const page = 'pagina-de-teste-rajada';
    const ids: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      const result = await arrive({
        email: robotEmail(),
        phone: capitalPhone(),
        landingPage: page,
        // A UTM: only the burst can mark them.
        attribution: { utmSource: 'facebook' },
        enteredAt: new Date(start.getTime() + i * 40_000),
        enteredAtSource: 'rd_conversion',
      });
      ids.push(result.lead.id);
      const marked = (await rowOf(result.lead.id))?.suspectAt;
      // The first three are not a burst yet.
      expect(Boolean(marked)).toBe(i === 3);
    }
    const rows = await db.select().from(leads).where(inArray(leads.id, ids));
    for (const row of rows) {
      expect(row.suspectReasons).toEqual(['robot_email', 'capital_ddd', 'burst']);
      expect(row.won).toBeNull();
      expect(row.lostReason).toBeNull();
    }
    const events = await db.select().from(leadEvents).where(inArray(leadEvents.leadId, ids));
    expect(events.filter((event) => event.kind === 'lead.suspect_marked')).toHaveLength(4);
    const loaded = await loadLead(db, ids[0]!);
    expect(loaded?.lead.suspect?.reasons).toEqual(['robot_email', 'capital_ddd', 'burst']);
  });

  it('marks a lone lead that came by direct traffic, not a real person', async () => {
    const robot = await arrive({ email: robotEmail(), phone: capitalPhone(), landingPage: 'p1' });
    expect((await rowOf(robot.lead.id))?.suspectReasons).toEqual([
      'robot_email',
      'capital_ddd',
      'direct_traffic',
    ]);
    const person = await arrive({
      email: 'ana.lima@empresa.com.br',
      phone: capitalPhone(),
      landingPage: 'p1',
    });
    expect((await rowOf(person.lead.id))?.suspectAt).toBeNull();
    const countryside = await arrive({
      email: robotEmail(),
      phone: `2498${String(1_000_000 + ++counter).slice(-7)}`,
      landingPage: 'p1',
    });
    expect((await rowOf(countryside.lead.id))?.suspectAt).toBeNull();
  });

  it('leaves alone a lead a person cleared', async () => {
    const result = await arrive({ email: robotEmail(), phone: capitalPhone(), landingPage: 'p2' });
    await db
      .update(leads)
      .set({ suspectClearedAt: new Date() })
      .where(eq(leads.id, result.lead.id));
    expect((await loadLead(db, result.lead.id))?.lead.suspect).toBeNull();
  });
});

describe('migration 0088', () => {
  it('marks the same leads the code marks', async () => {
    const page = 'pagina-da-migracao';
    const start = Date.UTC(2026, 9, 10, 0, 17, 42);
    const contact = () => ({ email: robotEmail(), phone: `55${capitalPhone()}` });
    const rows = [
      // A burst of four with a UTM: marked for the burst.
      ...[0, 1, 2, 3].map((i) => ({
        ...contact(),
        landingPage: page,
        utmSource: 'facebook',
        enteredAt: new Date(start + i * 30_000),
      })),
      // Alone, direct: marked.
      { ...contact(), landingPage: 'outra', enteredAt: new Date(start) },
      // Alone, with a UTM: not marked.
      { ...contact(), landingPage: 'outra2', utmSource: 'google', enteredAt: new Date(start) },
    ];
    const inserted = await db
      .insert(leads)
      .values(
        rows.map((row) => ({
          ...row,
          source: 'rd_station',
          clientId: WINGS_CLIENT_ID,
        })),
      )
      .returning({ id: leads.id });
    const file = readFileSync(
      resolve(import.meta.dirname, '../../../migrations/0088_lead_suspect_backfill.sql'),
      'utf8',
    );
    const backfill = file.split('--> statement-breakpoint')[0]!;
    await db.execute(sql.raw(backfill));
    const after = await db
      .select()
      .from(leads)
      .where(
        inArray(
          leads.id,
          inserted.map((row) => row.id),
        ),
      );
    const byId = new Map(after.map((row) => [row.id, row]));
    const reasons = inserted.map((row) => byId.get(row.id)?.suspectReasons ?? null);
    expect(reasons).toEqual([
      ['robot_email', 'capital_ddd', 'burst'],
      ['robot_email', 'capital_ddd', 'burst'],
      ['robot_email', 'capital_ddd', 'burst'],
      ['robot_email', 'capital_ddd', 'burst'],
      ['robot_email', 'capital_ddd', 'direct_traffic'],
      null,
    ]);
    // Run again: nothing marked twice.
    await db.execute(sql.raw(backfill));
    const events = await db
      .select()
      .from(leadEvents)
      .where(
        inArray(
          leadEvents.leadId,
          inserted.map((row) => row.id),
        ),
      );
    expect(events).toHaveLength(5);
  });
});
