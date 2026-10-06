import { randomBytes } from 'node:crypto';
import {
  campaignDraftSchema,
  LEAD_FORM_QUALIFIER_META_KEY,
  LEAD_FORM_THANK_YOU_DEFAULT,
  type CampaignDraft,
} from '@wings/shared';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from '../../db/client.js';
import {
  adAccounts,
  adCreativeUploads,
  adLeadForms,
  budgetPeriods,
  leadSourceRules,
  metaLeadForms,
} from '../../db/schema/index.js';
import { createTestDatabase, type TestDatabase } from '../../test/db.js';
import { createEmployee } from '../../test/factories.js';
import { stepsOfExecution } from './ad-tree.js';
import { decideApproval, gateChange } from './approvals.js';
import { openPeriod, reserveCampaignCreation } from './budget-guard.js';
import { executeApprovedChange } from './executor.js';
import { metaLeadFormSpecOf } from './lead-forms.js';
import { fakeMetaApi, type FakeMetaApiOptions } from './platform/fake-meta-api.js';
import { MetaWriteClient } from './platform/meta-write-client.js';

/**
 * A Meta lead campaign with Wings' standard form on the ad, against the
 * scripted Graph API: the form is created on the Page before the ad set (with
 * the Page's token, used once), registered for the lead intake with its
 * funnel rule the moment it exists, reused by a later campaign with the same
 * definition, and refused before any write when the token cannot act for the
 * Page.
 */

const NOW = new Date();
const TODAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(NOW);
const PERIOD = `${TODAY.slice(0, 7)}-01`;
const PAGE = '104567890123456';

let harness: TestDatabase;
let db: Database;
let imageId: string;

beforeAll(async () => {
  harness = await createTestDatabase();
  db = harness.db;
  const [image] = await db
    .insert(adCreativeUploads)
    .values({
      mimeType: 'image/png',
      width: 1080,
      height: 1080,
      byteSize: 8,
      sha256: 'f'.repeat(64),
      data: Buffer.from('png-f'),
    })
    .returning({ id: adCreativeUploads.id });
  imageId = image?.id as string;
}, 60_000);

afterAll(async () => {
  await harness?.drop();
});

/** A form is reused by definition across the whole Page, so each test gets its own policy link. */
const form = (overrides: Record<string, unknown> = {}) => ({
  qualifier: null,
  privacyPolicyUrl: `https://wingscompany.com.br/politica-${randomBytes(4).toString('hex')}/`,
  thankYou: { ...LEAD_FORM_THANK_YOU_DEFAULT, buttonUrl: 'https://wingscompany.com.br/' },
  funnel: { pipeline: 'formatacao', brand: null, clientId: null },
  ...overrides,
});

function draftOf(overrides: Record<string, unknown> = {}): CampaignDraft {
  return campaignDraftSchema.parse({
    platform: 'meta',
    name: `Formulário ${randomBytes(3).toString('hex')}`,
    objective: 'lead',
    idealCustomerProfile: 'Empreendedor de 30 a 50 anos, com experiência em gestão.',
    reach: { states: ['SP'], cities: [] },
    formatKey: 'feed_square',
    destinationUrl: 'https://wingscompany.com.br/franquia',
    leadCapture: 'instant_form',
    leadForm: form(),
    variations: [
      {
        creativeId: imageId,
        headline: 'Leve a Wings',
        primaryText: 'Fale com a gente.',
        callToAction: 'SIGN_UP',
      },
    ],
    ageMin: 25,
    ageMax: 65,
    placements: { mode: 'automatic' },
    identity: { pageId: PAGE, instagramActorId: '17841400000000000' },
    startDate: TODAY,
    endDate: TODAY,
    dailyBudgetCents: 600,
    utms: { utm_source: 'meta', utm_medium: 'paid_social', utm_campaign: 'x', utm_content: 'lead' },
    startPaused: true,
    ...overrides,
  });
}

async function world(options: FakeMetaApiOptions = {}) {
  const accountId = `act_${Math.floor(1e9 + Math.random() * 9e9)}`;
  const api = fakeMetaApi({ ...options, accountId });
  const client = new MetaWriteClient({
    accessToken: 'account-token',
    adAccountId: accountId,
    confirmWrites: true,
    fetchImpl: api.impl,
  });
  const [account] = await db
    .insert(adAccounts)
    .values({ platform: 'meta', externalId: accountId, name: 'Fly High' })
    .returning({ id: adAccounts.id });
  if (!account) throw new Error('failed');
  await openPeriod(db, {
    adAccountId: account.id,
    periodMonth: PERIOD,
    capCents: 250_000,
    usablePercent: 70,
  });
  await db
    .update(budgetPeriods)
    .set({ lastReconciledAt: new Date() })
    .where(eq(budgetPeriods.adAccountId, account.id));
  return { accountDbId: account.id, api, client };
}

async function requestAndApprove(accountDbId: string, draft: CampaignDraft) {
  const requester = await createEmployee(db, { role: 'marketing', sector: 'marketing' });
  const reserved = await reserveCampaignCreation(db, {
    adAccountId: accountDbId,
    draft,
    requestedBy: requester.id,
  });
  if (!reserved.ok) throw new Error(reserved.message);
  const gate = await gateChange(db, { changeRequestId: reserved.value.changeRequestId });
  if (!gate.approvalId) throw new Error('expected an approval');
  const admin = await createEmployee(db, { role: 'admin_master', sector: 'diretoria' });
  const decision = await decideApproval(db, {
    approvalId: gate.approvalId,
    approverEmployeeId: admin.id,
    decision: 'approved',
  });
  if (!decision.ok) throw new Error(decision.message);
  return { changeRequestId: reserved.value.changeRequestId, executor: admin.id };
}

const run = (client: MetaWriteClient, changeRequestId: string, actorEmployeeId?: string) =>
  executeApprovedChange(db, client, changeRequestId, {
    allowWrites: true,
    metaPixelId: '1116678872845520',
    actorEmployeeId,
  });

describe('the shared form as Meta takes it', () => {
  it('asks the five contact questions with the keys the intake maps, the qualifier first when on', () => {
    const spec = metaLeadFormSpecOf({
      form: campaignDraftSchema.parse(
        draftOf({
          leadForm: form({
            qualifier: { question: 'Quantas unidades você tem hoje?', options: ['1', '2 a 5'] },
          }),
        }),
      ).leadForm!,
      pageId: PAGE,
      name: 'Teste — formulário',
    });
    expect(spec.questions.map((question) => [question.type, question.key])).toEqual([
      ['CUSTOM', LEAD_FORM_QUALIFIER_META_KEY],
      ['FULL_NAME', 'full_name'],
      ['PHONE', 'phone_number'],
      ['COMPANY_NAME', 'company_name'],
      ['CUSTOM', 'instagram'],
      ['CUSTOM', 'site'],
    ]);
    expect(spec.questions[0]).toMatchObject({
      options: [
        { value: '1', key: '1' },
        { value: '2 a 5', key: '2_a_5' },
      ],
    });
    expect(spec.locale).toBe('pt_BR');
    expect(spec.privacyPolicy.url).toMatch(/^https:\/\/wingscompany\.com\.br\/politica-/);
  });
});

describe('a lead campaign with the form on the ad', () => {
  it('creates the form on the Page with its token, then the ad set and ads as Lead Ads, and registers the funnel rule', async () => {
    const { accountDbId, api, client } = await world();
    const draft = draftOf();
    const { changeRequestId, executor } = await requestAndApprove(accountDbId, draft);

    const result = await run(client, changeRequestId, executor);
    expect(result).toMatchObject({ ok: true, outcome: 'applied' });

    expect(api.writes().map((call) => call.path.split('/')[1])).toEqual([
      'campaigns',
      'adimages',
      'leadgen_forms',
      'adsets',
      'ads',
      'adcreatives',
      'ads',
    ]);

    // The Page's token was read with the account token and used for the one call.
    const formCall = api.writes('leadgen_forms')[0];
    expect(formCall?.path).toBe(`${PAGE}/leadgen_forms`);
    expect(formCall?.headers.authorization).toBe(`Bearer page-${PAGE}`);
    expect(formCall?.fields.locale).toBe('pt_BR');
    expect(JSON.parse(formCall?.fields.questions ?? '[]')).toHaveLength(5);
    expect(JSON.parse(formCall?.fields.privacy_policy ?? '{}')).toEqual({
      url: draft.leadForm?.privacyPolicyUrl,
      link_text: 'Política de Privacidade',
    });
    expect(JSON.parse(formCall?.fields.thank_you_page ?? '{}')).toMatchObject({
      title: LEAD_FORM_THANK_YOU_DEFAULT.title,
      button_type: 'VIEW_WEBSITE',
      website_url: 'https://wingscompany.com.br/',
    });
    for (const call of api.writes().filter((item) => !item.path.endsWith('leadgen_forms'))) {
      expect(call.headers.authorization).toBe('Bearer account-token');
    }

    // Lead Ads: the form is on the ad, the Page is the promoted object.
    const adSet = api.writes('adsets')[0]?.fields ?? {};
    expect(adSet).toMatchObject({
      optimization_goal: 'LEAD_GENERATION',
      destination_type: 'ON_AD',
      status: 'PAUSED',
    });
    expect(JSON.parse(adSet.promoted_object ?? '{}')).toEqual({ page_id: PAGE });

    const formId = api.state.leadForms.get(PAGE)?.[0]?.id as string;
    const story = JSON.parse(api.writes('adcreatives')[0]?.fields.object_story_spec ?? '{}');
    expect(story.link_data.call_to_action).toEqual({
      type: 'SIGN_UP',
      value: { lead_gen_form_id: formId },
    });
    expect(story.link_data.link).toBe(`https://www.facebook.com/${PAGE}/`);

    const steps = await stepsOfExecution(db, 'executionId' in result ? result.executionId : '');
    expect(steps.map((step) => [step.seq, step.kind, step.status])).toEqual([
      [1, 'campaign', 'created'],
      [2, 'image', 'created'],
      [3, 'lead_form', 'created'],
      [4, 'ad_set', 'created'],
      [5, 'creative', 'created'],
      [6, 'ad', 'created'],
    ]);
    expect(steps[2]?.externalId).toBe(formId);

    // The moment the form exists: our record, the polled form, the funnel rule.
    const recorded = await db.query.adLeadForms.findFirst({
      where: eq(adLeadForms.externalId, formId),
    });
    expect(recorded).toMatchObject({ platform: 'meta', pageId: PAGE, createdBy: executor });
    expect((recorded?.spec as { funnel?: unknown }).funnel).toBeUndefined();
    expect(
      await db.query.metaLeadForms.findFirst({ where: eq(metaLeadForms.formId, formId) }),
    ).toMatchObject({ pageId: PAGE, name: `${draft.name} — formulário` });
    const rule = await db.query.leadSourceRules.findFirst({
      where: and(eq(leadSourceRules.kind, 'meta_form'), eq(leadSourceRules.pattern, formId)),
    });
    expect(rule).toMatchObject({
      pipeline: 'formatacao',
      brand: null,
      active: true,
      rdDealIntake: false,
      createdBy: executor,
    });
    expect(rule?.clientId).toBeTruthy();
  });

  it('uses the same form again for a campaign with the same definition, and makes no second one', async () => {
    const { accountDbId, api, client } = await world();
    const shared = form();
    const first = await requestAndApprove(accountDbId, draftOf({ leadForm: shared }));
    await run(client, first.changeRequestId, first.executor);
    const formId = api.state.leadForms.get(PAGE)?.[0]?.id as string;

    const second = await requestAndApprove(
      accountDbId,
      draftOf({
        leadForm: { ...shared, funnel: { pipeline: 'expansao', brand: 'Marca Y', clientId: null } },
      }),
    );
    const result = await run(client, second.changeRequestId, second.executor);
    expect(result).toMatchObject({ ok: true, outcome: 'applied' });

    expect(api.writes('leadgen_forms')).toHaveLength(1);
    const steps = await stepsOfExecution(db, 'executionId' in result ? result.executionId : '');
    const reused = steps.find((step) => step.kind === 'lead_form');
    expect(reused).toMatchObject({ status: 'created', externalId: formId });
    expect(reused?.label).toContain('reaproveitado');
    const creatives = api.writes('adcreatives');
    expect(
      JSON.parse(creatives[1]?.fields.object_story_spec ?? '{}').link_data.call_to_action.value,
    ).toEqual({ lead_gen_form_id: formId });

    // The rule written first stays: the form keeps the funnel it was born with.
    const rules = await db
      .select()
      .from(leadSourceRules)
      .where(and(eq(leadSourceRules.kind, 'meta_form'), eq(leadSourceRules.pattern, formId)));
    expect(rules).toHaveLength(1);
    expect(rules[0]?.pipeline).toBe('formatacao');
  });

  it('a different thank-you is a different form', async () => {
    const { accountDbId, api, client } = await world();
    const shared = form();
    const first = await requestAndApprove(accountDbId, draftOf({ leadForm: shared }));
    await run(client, first.changeRequestId, first.executor);
    const second = await requestAndApprove(
      accountDbId,
      draftOf({
        leadForm: {
          ...shared,
          thankYou: {
            ...LEAD_FORM_THANK_YOU_DEFAULT,
            title: 'Obrigado!',
            buttonUrl: 'https://wingscompany.com.br/',
          },
        },
      }),
    );
    await run(client, second.changeRequestId, second.executor);
    expect(api.writes('leadgen_forms')).toHaveLength(2);
  });

  it('a token that cannot act for the Page: the form step is refused, nothing after it is written', async () => {
    const { accountDbId, api, client } = await world({ noPageToken: true });
    const { changeRequestId, executor } = await requestAndApprove(accountDbId, draftOf());

    const result = await run(client, changeRequestId, executor);
    // The campaign exists and the rest does not: a state a person must look at.
    expect(result).toMatchObject({ ok: false, outcome: 'unknown' });
    expect(api.writes().map((call) => call.path.split('/')[1])).toEqual(['campaigns', 'adimages']);

    const steps = await stepsOfExecution(db, 'executionId' in result ? result.executionId : '');
    const formStep = steps.find((step) => step.kind === 'lead_form');
    expect(formStep).toMatchObject({ status: 'failed', externalId: null });
    expect(formStep?.message).toContain('pages_manage_ads');
    expect(
      await db.query.leadSourceRules.findFirst({
        where: and(eq(leadSourceRules.kind, 'meta_form'), eq(leadSourceRules.createdBy, executor)),
      }),
    ).toBeUndefined();
  });

  it('a lead campaign without the form on the ad is what it always was: pixel, website, link', async () => {
    const { accountDbId, api, client } = await world();
    const { changeRequestId, executor } = await requestAndApprove(
      accountDbId,
      draftOf({ leadCapture: 'page', leadForm: undefined }),
    );
    await run(client, changeRequestId, executor);
    expect(api.writes('leadgen_forms')).toHaveLength(0);
    const adSet = api.writes('adsets')[0]?.fields ?? {};
    expect(adSet).toMatchObject({
      optimization_goal: 'OFFSITE_CONVERSIONS',
      destination_type: 'WEBSITE',
    });
    const story = JSON.parse(api.writes('adcreatives')[0]?.fields.object_story_spec ?? '{}');
    expect(story.link_data.call_to_action.value).toHaveProperty('link');
  });
});
