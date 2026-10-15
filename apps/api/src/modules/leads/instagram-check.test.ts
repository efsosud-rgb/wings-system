import { SESSION_COOKIE, WINGS_CLIENT_ID } from '@wings/shared';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../app.js';
import type { Database } from '../../db/client.js';
import {
  clients,
  crmNotifications,
  jobs,
  leadEvents,
  leadSourceRules,
  leadTrackingLinks,
  leads,
} from '../../db/schema/index.js';
import { loadEnv } from '../../env.js';
import { createTestDatabase, type TestDatabase } from '../../test/db.js';
import { createEmployee, TEST_CPF_KEY, TEST_INDEX_KEY } from '../../test/factories.js';
import { runLeadChecks, type LeadCheckDeps } from './field-checks.js';
import { attachFormRef, leadByFormRef } from './form-ref.js';
import { enqueueInstagramCheck, instagramCheckOf, setInstagramManual } from './instagram-check.js';
import { salesDashboardOf } from './sales-dashboard.js';
import { linkMessageToFormLead } from './tracked-link.js';

/**
 * The Instagram check from the API's side (docs/leads/instagram.md): the job is queued once per
 * lead, a person's correction wins and is on the timeline, the list filters on it, "Conferir de
 * novo" and the arrival hand the Instagram to the worker, the site form issues the WhatsApp ref,
 * and the ref ties a message to the lead for seven days. No network: Turnstile and the checks
 * are simulated.
 */

let harness: TestDatabase;
let db: Database;
const apps: FastifyInstance[] = [];
let brandId: string;

const env = (extra: Record<string, string> = {}) =>
  loadEnv({
    NODE_ENV: 'test',
    DATABASE_URL: harness.url,
    SESSION_SECRET: 'x'.repeat(48),
    CPF_ENCRYPTION_KEY: TEST_CPF_KEY,
    CPF_INDEX_KEY: TEST_INDEX_KEY,
    APP_BASE_URL: 'http://localhost:5173',
    ...extra,
  });
const captcha = (async () =>
  new Response(JSON.stringify({ success: true, 'error-codes': [] }), {
    status: 200,
  })) as typeof fetch;

beforeAll(async () => {
  harness = await createTestDatabase();
  db = harness.db;
  const [brand] = await db
    .insert(clients)
    .values({ name: 'Aurora', slug: 'aurora', number: 31 })
    .returning();
  brandId = brand!.id;
  await db.insert(leadSourceRules).values({
    kind: 'landing_page',
    pattern: 'aurora',
    clientId: brandId,
    pipeline: 'expansao',
    siteFormEnabled: true,
  });
  await db.insert(leadTrackingLinks).values({
    clientId: brandId,
    channel: 'site',
    code: 'AUR0RA'.replace('0', '2'),
    phone: '5521999470288',
  });
}, 60_000);

afterAll(async () => {
  for (const app of apps) await app.close();
  await harness?.drop();
});

let n = 0;
async function newLead(fields: Partial<typeof leads.$inferInsert> = {}) {
  const [lead] = await db
    .insert(leads)
    .values({
      clientId: WINGS_CLIENT_ID,
      name: 'Pessoa de Teste',
      email: `ig${(n += 1)}@example.com`,
      source: 'site_form',
      pipeline: 'formatacao',
      instagram: 'padaria.aurora',
      ...fields,
    })
    .returning();
  return lead!;
}
const jobsFor = async (leadId: string) =>
  (await db.select().from(jobs).where(eq(jobs.type, 'check_instagram'))).filter(
    (job) => (job.input as { leadId?: string }).leadId === leadId,
  );
const rowOf = async (id: string) => (await db.select().from(leads).where(eq(leads.id, id)))[0]!;

async function adminCookies(app: FastifyInstance) {
  const employee = await createEmployee(db, { role: 'admin_master', sector: 'diretoria' });
  const login = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { email: employee.email, password: employee.password },
  });
  const token = login.cookies.find((c) => c.name === SESSION_COOKIE)?.value;
  if (!token) throw new Error('login failed in setup');
  return { id: employee.id, cookies: { [SESSION_COOKIE]: token } };
}

describe('queueing the check', () => {
  it('queues one job per lead, marks it waiting and says nothing for "não tenho"', async () => {
    const lead = await newLead();
    expect(await enqueueInstagramCheck(db, lead.id, null)).toBe('queued');
    expect(await enqueueInstagramCheck(db, lead.id, null)).toBe('in_progress');
    expect(await jobsFor(lead.id)).toHaveLength(1);
    const row = await rowOf(lead.id);
    expect(row.instagramCheckStatus).toBe('pendente');
    expect((row.fieldChecks as { instagram: { status: string } }).instagram.status).toBe(
      'pendente',
    );
    expect(instagramCheckOf(row)).toMatchObject({
      status: 'pendente',
      checkedAt: null,
      effectiveVerdict: null,
    });

    const none = await newLead({ instagram: 'Não tenho' });
    expect(await enqueueInstagramCheck(db, none.id, null)).toBe('nothing_to_check');
    expect(await jobsFor(none.id)).toHaveLength(0);
  });

  it('the site form queues it and issues the ref; the ref goes in the wa.me text after the link code', async () => {
    const app = await buildApp({
      env: env({
        TURNSTILE_SECRET_KEY: '0x4AAAAAAA-secret',
        INSTAGRAM_CHECK_ENABLED: 'true',
        WINGS_WHATSAPP_NUMBER: '5521999470288',
      }),
      db,
      captchaFetch: captcha,
    });
    apps.push(app);
    const payload = {
      name: 'Pessoa Teste',
      phone: '(21) 99999-0007',
      consent: true,
      turnstileToken: 'good',
      website: '',
      instagram: 'padaria.aurora',
      companyName: 'Padaria Aurora',
    };
    const response = await app.inject({
      method: 'POST',
      url: '/public/site-forms/aurora',
      payload,
    });
    expect(response.statusCode).toBe(200);
    const [lead] = await db.select().from(leads).where(eq(leads.phone, '5521999990007'));
    expect(lead?.formRef).toMatch(/^[A-HJ-NP-Z2-9]{6}$/);
    expect(lead?.formRefAt).toBeInstanceOf(Date);
    expect(await jobsFor(lead!.id)).toHaveLength(1);
    const url = new URL((response.json() as { whatsappUrl: string }).whatsappUrl);
    expect(decodeURIComponent(url.searchParams.get('text') ?? '')).toMatch(
      new RegExp(`^AUR2RA ${lead!.formRef} Olá! Quero saber`),
    );
    // Nothing of the check reaches the person.
    expect(JSON.stringify(response.json())).not.toMatch(/instagram|suspeito|falso/i);

    // The same person again: a new ref replaces the old one, and still one job waits.
    const again = await app.inject({ method: 'POST', url: '/public/site-forms/aurora', payload });
    expect(again.statusCode).toBe(200);
    const [same] = await db.select().from(leads).where(eq(leads.phone, '5521999990007'));
    expect(same?.id).toBe(lead!.id);
    expect(same?.formRef).not.toBe(lead!.formRef);
    expect(await jobsFor(lead!.id)).toHaveLength(1);
  });

  it('the form queues nothing while the switch is off', async () => {
    const app = await buildApp({
      env: env({ TURNSTILE_SECRET_KEY: '0x4AAAAAAA-secret' }),
      db,
      captchaFetch: captcha,
    });
    apps.push(app);
    const response = await app.inject({
      method: 'POST',
      url: '/public/site-forms/aurora',
      payload: {
        name: 'Outra Pessoa',
        phone: '(21) 99999-0008',
        consent: true,
        turnstileToken: 'good',
        website: '',
        instagram: 'outra.conta',
      },
    });
    expect(response.statusCode).toBe(200);
    const [lead] = await db.select().from(leads).where(eq(leads.phone, '5521999990008'));
    expect(await jobsFor(lead!.id)).toHaveLength(0);
    expect(lead?.instagramCheckStatus).toBeNull();
  });

  it('"Conferir de novo" and the arrival give the Instagram to the worker, never to Meta, and keep the other checks', async () => {
    let metaCalls = 0;
    const deps: LeadCheckDeps = {
      instagramViaWorker: true,
      probe: null,
      instagram: async () => {
        metaCalls += 1;
        return { status: 'confere', reason: null, checkedAt: null };
      },
      cnpj: null,
      now: () => new Date(),
      log: { info() {}, warn() {} } as unknown as LeadCheckDeps['log'],
    };
    const site = await newLead({ phone: '5521999990101' });
    await runLeadChecks(db, site.id, deps);
    expect(await jobsFor(site.id)).toHaveLength(1);
    const checks = (await rowOf(site.id)).fieldChecks as Record<string, { status: string }>;
    expect(checks.instagram?.status).toBe('pendente');
    expect(checks.whatsapp?.status).toBe('confere');

    // Another source on arrival keeps the old path; the button always uses the worker.
    const meta = await newLead({ source: 'meta_lead_ads', phone: '5521999990102' });
    await runLeadChecks(db, meta.id, deps);
    expect(await jobsFor(meta.id)).toHaveLength(0);
    await runLeadChecks(db, meta.id, deps, { manual: true });
    expect(await jobsFor(meta.id)).toHaveLength(1);
    expect(metaCalls).toBe(1);
  });
});

describe("a person's correction, the list and the numbers", () => {
  it('the correction wins, is on the timeline and can be taken back', async () => {
    const app = await buildApp({ env: env(), db });
    apps.push(app);
    const admin = await adminCookies(app);
    const lead = await newLead({
      instagramCheckStatus: 'nao_encontrado',
      instagramCheckSource: 'nenhuma',
      instagramCheckedAt: new Date(),
      instagramCheckDetail: {
        reason: 'x',
        steps: { format: 'ok', meta: 'not_found', search: 'skipped', ai: 'skipped' },
      },
      instagramVerdict: 'suspeito',
      instagramVerdictEffective: 'suspeito',
    });
    const post = (verdict: unknown) =>
      app.inject({
        method: 'POST',
        url: `/leads/${lead.id}/instagram`,
        cookies: admin.cookies,
        payload: { verdict },
      });
    expect((await post('inexistente')).statusCode).toBe(400);

    expect((await post('falso')).statusCode).toBe(200);
    expect(await rowOf(lead.id)).toMatchObject({
      instagramManual: 'falso',
      instagramVerdict: 'suspeito',
      instagramVerdictEffective: 'falso',
    });
    expect((await post('confere')).statusCode).toBe(200);
    expect(await rowOf(lead.id)).toMatchObject({ instagramVerdictEffective: null });
    const taken = await post(null);
    expect(taken.statusCode).toBe(200);
    expect(
      (
        taken.json() as {
          lead: { instagramCheck: { effectiveVerdict: string | null; manual: unknown } };
        }
      ).lead.instagramCheck,
    ).toMatchObject({
      effectiveVerdict: 'suspeito',
      manual: null,
    });
    const events = await db
      .select()
      .from(leadEvents)
      .where(and(eq(leadEvents.leadId, lead.id), eq(leadEvents.kind, 'instagram.corrected')));
    expect(events.map((e) => e.detail)).toEqual([
      { from: null, to: 'falso' },
      { from: 'falso', to: 'confere' },
      { from: 'confere', to: null },
    ]);
    expect(events.every((e) => e.actorEmployeeId === admin.id)).toBe(true);
    // Without a session nothing changes.
    const anonymous = await app.inject({
      method: 'POST',
      url: `/leads/${lead.id}/instagram`,
      payload: { verdict: 'falso' },
    });
    expect(anonymous.statusCode).toBe(401);
  });

  it('filters Negociações by suspect and/or fake, a correction counting', async () => {
    const app = await buildApp({ env: env(), db });
    apps.push(app);
    const admin = await adminCookies(app);
    const suspect = await newLead({
      instagramVerdict: 'suspeito',
      instagramVerdictEffective: 'suspeito',
      instagramCheckStatus: 'nao_encontrado',
    });
    const fake = await newLead({
      instagramVerdict: 'falso',
      instagramVerdictEffective: 'falso',
      instagramCheckStatus: 'nao_encontrado',
    });
    const cleared = await newLead({
      instagramVerdict: 'falso',
      instagramVerdictEffective: null,
      instagramManual: 'confere',
      instagramCheckStatus: 'nao_encontrado',
    });
    const ids = async (filter: string) =>
      (
        (
          await app.inject({
            method: 'GET',
            url: `/leads?instagram=${filter}`,
            cookies: admin.cookies,
          })
        ).json() as { leads: { id: string }[] }
      ).leads.map((i) => i.id);
    const falso = await ids('falso');
    expect(falso).toContain(fake.id);
    expect(falso).not.toContain(suspect.id);
    const both = await ids('suspeito_ou_falso');
    expect(both).toEqual(expect.arrayContaining([suspect.id, fake.id]));
    expect(both).not.toContain(cleared.id);
    expect(
      (await app.inject({ method: 'GET', url: '/leads?instagram=outra', cookies: admin.cookies }))
        .statusCode,
    ).toBe(400);
  });

  it('counts suspects and fakes by campaign and by page, and shows no zero where nothing was checked', async () => {
    await newLead({
      landingPage: 'pagina-a',
      utmCampaign: 'camp-a',
      instagramCheckStatus: 'confere',
    });
    await newLead({
      landingPage: 'pagina-a',
      utmCampaign: 'camp-a',
      instagramCheckStatus: 'nao_encontrado',
      instagramVerdict: 'suspeito',
      instagramVerdictEffective: 'suspeito',
    });
    await newLead({
      landingPage: 'pagina-a',
      utmCampaign: 'camp-a',
      instagramCheckStatus: 'nao_encontrado',
      instagramVerdict: 'falso',
      instagramVerdictEffective: 'falso',
    });
    await newLead({ landingPage: 'pagina-b', utmCampaign: 'camp-b', instagramCheckStatus: 'erro' });
    const dashboard = await salesDashboardOf(db, {
      period: 'month',
      pipeline: 'formatacao',
      spendVisible: false,
    } as never);
    const campaign = (name: string) => dashboard.campaigns.find((row) => row.campaign === name);
    expect(campaign('camp-a')?.instagram).toEqual({ checked: 3, suspect: 1, fake: 1 });
    // "erro" decided nothing: the row exists, but nothing was checked there.
    expect(campaign('camp-b')?.instagram).toEqual({ checked: 0, suspect: 0, fake: 0 });
    expect(dashboard.pages.find((row) => row.page === 'pagina-a')).toMatchObject({
      leads: 3,
      instagram: { checked: 3, suspect: 1, fake: 1 },
    });
    expect(dashboard.pages.find((row) => row.page === 'pagina-b')).toBeUndefined();
  });
});

describe('the ref that ties a WhatsApp message to the lead', () => {
  it('holds for seven days and only for the latest submission', async () => {
    const lead = await newLead();
    const ref = await attachFormRef(db, lead.id, new Date('2026-10-10T12:00:00Z'));
    expect(ref).toMatch(/^[A-HJ-NP-Z2-9]{6}$/);
    const text = `AUR2RA ${ref} Olá!`;
    expect((await leadByFormRef(db, text, new Date('2026-10-16T12:00:00Z')))?.id).toBe(lead.id);
    expect(await leadByFormRef(db, text, new Date('2026-10-17T12:01:00Z'))).toBeNull();
    expect(
      await leadByFormRef(db, `AUR2RA ${'ZZZZZZ'}`, new Date('2026-10-10T12:30:00Z')),
    ).toBeNull();
    // A ref without the link code before it is just a word.
    expect(await leadByFormRef(db, `${ref} Olá!`, new Date('2026-10-10T12:30:00Z'))).toBeNull();
    const second = await attachFormRef(db, lead.id, new Date('2026-10-11T12:00:00Z'));
    expect(second).not.toBe(ref);
    expect(await leadByFormRef(db, text, new Date('2026-10-11T12:30:00Z'))).toBeNull();
  });

  it('the Z-API door links the message to the lead and tells the owner once, without a second lead', async () => {
    const owner = await createEmployee(db, { role: 'vendedor_expansao', sector: 'comercial' });
    const lead = await newLead({ ownerEmployeeId: owner.id });
    const before = (await db.select().from(leads)).length;
    const input = { code: 'AUR2RA', leadId: lead.id, at: new Date(), via: 'zapi' as const };
    expect(await linkMessageToFormLead(db, input)).toMatchObject({ channel: 'site' });
    expect(await linkMessageToFormLead(db, input)).toMatchObject({ channel: 'site' });
    expect(await linkMessageToFormLead(db, { ...input, code: 'NAOEXI' })).toBeNull();
    expect((await db.select().from(leads)).length).toBe(before);
    const notices = await db
      .select()
      .from(crmNotifications)
      .where(eq(crmNotifications.leadId, lead.id));
    expect(notices.filter((n) => n.kind === 'lead_whatsapp')).toHaveLength(1);
    expect(notices[0]?.recipientEmployeeId).toBe(owner.id);
    expect(notices[0]?.message).not.toMatch(/Pessoa de Teste/);
  });

  it("is kept by the lead's own correction path (manual write needs a person)", async () => {
    const lead = await newLead();
    const employee = await createEmployee(db, { role: 'admin_master', sector: 'diretoria' });
    await setInstagramManual(db, lead.id, employee.id, 'falso');
    expect((await rowOf(lead.id)).instagramManualBy).toBe(employee.id);
    await setInstagramManual(db, lead.id, employee.id, null);
    expect((await rowOf(lead.id)).instagramManualBy).toBeNull();
  });
});
