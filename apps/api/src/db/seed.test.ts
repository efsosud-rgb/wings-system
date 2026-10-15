import { isTrackingCode, siteFormSpecSchema, WINGS_CLIENT_ID } from '@wings/shared';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../test/db.js';
import { auditLog, leadSourceRules, leadTrackingLinks } from './schema/index.js';
import { FALE_COM_A_WINGS, seed } from './seed.js';

let harness: TestDatabase;

beforeAll(async () => {
  // The harness seeds once already, without a WhatsApp number.
  harness = await createTestDatabase();
}, 60_000);

afterAll(async () => {
  await harness?.drop();
});

const faleRules = () =>
  harness.db
    .select()
    .from(leadSourceRules)
    .where(
      and(
        eq(leadSourceRules.kind, 'landing_page'),
        eq(leadSourceRules.pattern, FALE_COM_A_WINGS.pattern),
      ),
    );
const wingsSiteLinks = () =>
  harness.db
    .select()
    .from(leadTrackingLinks)
    .where(
      and(eq(leadTrackingLinks.clientId, WINGS_CLIENT_ID), eq(leadTrackingLinks.channel, 'site')),
    );

describe('seed: "Fale com a Wings"', () => {
  it('makes one rule however many times it runs, with a spec the schema accepts', async () => {
    await seed(harness.db);
    await seed(harness.db);
    const rules = await faleRules();
    expect(rules).toHaveLength(1);
    expect(rules[0]).toMatchObject({
      clientId: WINGS_CLIENT_ID,
      pipeline: 'formatacao',
      active: true,
      siteFormEnabled: true,
      url: 'https://fale.wingscompany.com.br',
    });
    const spec = siteFormSpecSchema.parse(rules[0]?.siteFormSpec);
    expect(spec.requiredFields).toEqual(['email', 'companyName', 'instagram', 'qualifierAnswer']);
    expect(spec.qualifierValues?.map((entry) => [entry.value, entry.pipeline])).toEqual([
      ['formatacao', undefined],
      ['expansao', undefined],
      ['consultoria', undefined],
      ['nao-sei', null],
    ]);
  });

  it('never overwrites the rule a person changed', async () => {
    const [rule] = await faleRules();
    await harness.db
      .update(leadSourceRules)
      .set({ siteFormEnabled: false, pipeline: 'consultoria' })
      .where(eq(leadSourceRules.id, rule!.id));
    await seed(harness.db);
    const [after] = await faleRules();
    expect(after).toMatchObject({ siteFormEnabled: false, pipeline: 'consultoria' });
  });

  it('makes no WhatsApp link without the number, nor with one that is not a number', async () => {
    await seed(harness.db, { wingsWhatsappNumber: '' });
    await seed(harness.db, { wingsWhatsappNumber: '21999990000' });
    expect(await wingsSiteLinks()).toEqual([]);
  });

  it("makes Wings' Site link once for the number, and again only for a new number", async () => {
    await seed(harness.db, { wingsWhatsappNumber: '5521999990000' });
    await seed(harness.db, { wingsWhatsappNumber: '5521999990000' });
    const links = await wingsSiteLinks();
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({ phone: '5521999990000', createdBy: null });
    expect(isTrackingCode(links[0]!.code)).toBe(true);
    const audits = await harness.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.entityId, links[0]!.id));
    expect(audits.map((row) => [row.action, row.metadata])).toEqual([
      ['lead_tracking_link.created', { clientId: WINGS_CLIENT_ID, channel: 'site', via: 'seed' }],
    ]);

    await seed(harness.db, { wingsWhatsappNumber: '5521988880000' });
    expect((await wingsSiteLinks()).map((link) => link.phone).sort()).toEqual([
      '5521988880000',
      '5521999990000',
    ]);
  });
});
