import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import {
  adConversionSends,
  adConversionStageEvents,
  crmStages,
  leads,
  leadStageHistory,
} from '../../db/schema/index.js';
import { loadEnv } from '../../env.js';
import type { TestDatabase } from '../../test/db.js';
import { TEST_CPF_KEY, TEST_INDEX_KEY } from '../../test/factories.js';
import { runConversionsCycle } from './crm-conversions.js';

/** What the closing-the-loop tests share: a fixed clock (lição 2), made-up leads, both platforms simulated. */

export const NOW = new Date('2026-11-02T12:00:00.000Z');
/** The stage change is a day old, the lead three. */
export const STAGE_AT = new Date('2026-11-01T10:00:00.000Z');
export const ENTERED = new Date('2026-10-30T09:00:00.000Z');
export const HOUR = 3_600_000;
export const META_ON = { CRM_CONVERSIONS_META_ENABLED: 'true' };
export const GOOGLE_ON = { CRM_CONVERSIONS_GOOGLE_ENABLED: 'true' };

export interface Call {
  url: string;
  body: string;
  authorization: string | null;
}
type Answer = Response | Error;

/** Meta and Google simulated: every call kept; `answers` decides the next ones (200 when empty). */
export function platforms(answers: { meta?: Answer[]; google?: Answer[] } = {}) {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const href = String(url);
    const headers = new Headers(init?.headers);
    calls.push({
      url: href,
      body: String(init?.body ?? ''),
      authorization: headers.get('authorization'),
    });
    if (href.startsWith('https://oauth2.googleapis.com/token')) {
      return Response.json({ access_token: 'acesso-de-teste', expires_in: 3600 });
    }
    const queue = href.startsWith('https://graph.facebook.com') ? answers.meta : answers.google;
    const next = queue?.shift();
    if (next instanceof Error) throw next;
    if (next) return next;
    return href.startsWith('https://graph.facebook.com')
      ? Response.json({ events_received: 1, fbtrace_id: 'trace-de-teste' })
      : Response.json({ requestId: 'pedido-de-teste' });
  }) as typeof fetch;
  const events = () => calls.filter((call) => !call.url.includes('oauth2'));
  return { calls, events, fetchImpl };
}

/** The helpers bound to the file's throwaway database, read when called (it exists after beforeAll). */
export function conversionsKit(harness: () => TestDatabase) {
  const db = () => harness().db;

  const envOf = (extra: Record<string, string> = {}) =>
    loadEnv({
      NODE_ENV: 'test',
      DATABASE_URL: harness().url,
      SESSION_SECRET: 'x'.repeat(48),
      CPF_ENCRYPTION_KEY: TEST_CPF_KEY,
      CPF_INDEX_KEY: TEST_INDEX_KEY,
      CRM_CONVERSIONS_SINCE: '2026-10-20',
      CRM_CONVERSIONS_META_DATASET_ID: '123456789012345',
      META_CAPI_TOKEN: 'token-de-teste-meta',
      GOOGLE_ADS_CUSTOMER_ID: '111-222-3333',
      GOOGLE_ADS_CLIENT_ID: 'cliente-de-teste',
      GOOGLE_ADS_CLIENT_SECRET: 'segredo-de-teste',
      CRM_CONVERSIONS_GOOGLE_REFRESH_TOKEN: 'refresh-de-teste',
      ...extra,
    });

  const cycle = (env: ReturnType<typeof envOf>, fetchImpl: typeof fetch, now = NOW) =>
    runConversionsCycle({ db: db(), env, fetchImpl, log: () => {} }, now);

  async function stage(): Promise<string> {
    const [row] = await db()
      .insert(crmStages)
      .values({
        pipeline: 'expansao',
        name: `Reunião agendada ${randomBytes(4).toString('hex')}`,
        position: 3,
      })
      .returning({ id: crmStages.id });
    return row!.id;
  }

  async function mapStage(stageId: string, platform: 'meta' | 'google', active = true) {
    await db()
      .insert(adConversionStageEvents)
      .values({
        stageId,
        platform,
        eventName: 'reuniao_agendada',
        googleConversionActionId: platform === 'google' ? '987654321' : null,
        active,
      });
  }

  /** A made-up lead: a Meta instant-form lead by default. */
  async function lead(values: Partial<typeof leads.$inferInsert> = {}) {
    const [row] = await db()
      .insert(leads)
      .values({
        source: 'meta_lead_ads',
        externalId: `9${Math.floor(Math.random() * 1e15)}`.padEnd(16, '0'),
        phone: `55119${Math.floor(10_000_000 + Math.random() * 89_999_999)}`,
        email: `pessoa-${randomBytes(3).toString('hex')}@exemplo.com.br`,
        legalBasis: 'consent',
        enteredAt: ENTERED,
        ...values,
      })
      .returning();
    return row!;
  }

  async function enter(leadId: string, stageId: string, at = STAGE_AT, source = 'wings') {
    await db().insert(leadStageHistory).values({ leadId, toStageId: stageId, at, source });
  }

  const sendsOf = (leadId: string) =>
    db().select().from(adConversionSends).where(eq(adConversionSends.leadId, leadId));

  /** A mapped stage, and a lead that entered it a day ago. */
  async function setup(
    platform: 'meta' | 'google',
    values: Partial<typeof leads.$inferInsert> = {},
  ) {
    const stageId = await stage();
    await mapStage(stageId, platform);
    const row = await lead(values);
    await enter(row.id, stageId);
    return { stageId, lead: row };
  }

  return { envOf, cycle, stage, mapStage, lead, enter, sendsOf, setup };
}
