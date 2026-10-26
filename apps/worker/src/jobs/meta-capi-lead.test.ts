import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { baseContext } from '../test/context.js';
import { createTestDatabase, type TestDatabase } from '../test/db.js';
import { runMetaCapiLeadJob } from './meta-capi-lead.js';

/**
 * The Conversions API job against a throwaway database and a scripted Meta:
 * no test reaches graph.facebook.com (the no-network guard would refuse it).
 */

const WINGS_CLIENT_ID = '00000000-0000-4000-8000-0000000000c1';
const NOW = new Date('2026-10-26T15:00:00Z');
const NOW_SECONDS = Math.floor(NOW.getTime() / 1000);
const sha = (value: string) => createHash('sha256').update(value).digest('hex');

describe('the meta_capi_lead job', () => {
  let database: TestDatabase;
  beforeAll(async () => {
    database = await createTestDatabase();
  }, 60_000);
  afterAll(() => database.drop());

  async function insertLead(fields: Record<string, unknown> = {}) {
    const all = {
      client_id: WINGS_CLIENT_ID,
      name: 'Pessoa de Teste',
      source: 'site_form',
      email: ' Pessoa.Teste@Example.com ',
      phone: '5521999990001',
      fbclid: 'IwAR-teste',
      legal_basis: 'consent',
      consented_at: NOW,
      ...fields,
    };
    const columns = Object.keys(all);
    const result = await database.pool.query<{ id: string }>(
      `insert into leads (${columns.join(', ')}) values (${columns.map((_, i) => `$${i + 1}`).join(', ')}) returning id`,
      Object.values(all),
    );
    return result.rows[0]!.id;
  }

  const jobFor = (leadId: string, eventTime = NOW_SECONDS - 60) => ({
    id: randomUUID(),
    type: 'meta_capi_lead' as const,
    input: {
      leadId,
      eventId: `lead-${randomUUID()}`,
      eventTime,
      userAgent: 'Mozilla/5.0 (teste)',
      sourceUrl: 'https://wingscompany.com.br/fale-com-a-wings',
    },
    attempts: 1,
  });

  function meta(status = 200, answer: unknown = { events_received: 1 }) {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify(answer), { status });
    }) as unknown as typeof fetch;
    return { calls, fetchImpl };
  }

  const context = (fetchImpl: typeof fetch, over: Record<string, unknown> = {}) =>
    baseContext({
      db: database.pool,
      now: () => NOW,
      metaCapi: {
        enabled: true,
        pixelId: '1116678872845520',
        token: 'token-de-teste',
        testEventCode: null,
        fetchImpl,
        ...over,
      },
    });

  it('sends one Lead with hashed identifiers, the shared event id and the token in a header', async () => {
    const leadId = await insertLead();
    const job = jobFor(leadId);
    const fake = meta();
    const output = await runMetaCapiLeadJob(job, context(fake.fetchImpl));

    expect(output).toEqual({ leadId, eventId: job.input.eventId, eventsReceived: 1 });
    expect(fake.calls).toHaveLength(1);
    const [call] = fake.calls;
    expect(call!.url).toBe('https://graph.facebook.com/v23.0/1116678872845520/events');
    expect(call!.url).not.toContain('token');
    expect((call!.init.headers as Record<string, string>).authorization).toBe(
      'Bearer token-de-teste',
    );
    const body = JSON.parse(String(call!.init.body)) as {
      data: { user_data: Record<string, unknown>; [key: string]: unknown }[];
    };
    const [event] = body.data;
    expect(event).toMatchObject({
      event_name: 'Lead',
      event_id: job.input.eventId,
      action_source: 'website',
      event_source_url: 'https://wingscompany.com.br/fale-com-a-wings',
    });
    expect(event!.user_data).toEqual({
      em: [sha('pessoa.teste@example.com')],
      ph: [sha('5521999990001')],
      external_id: [sha(leadId)],
      fbc: `fb.1.${job.input.eventTime * 1000}.IwAR-teste`,
      client_user_agent: 'Mozilla/5.0 (teste)',
    });
    // Nothing readable about the person leaves: no e-mail, phone or name in clear.
    const raw = String(call!.init.body);
    expect(raw).not.toMatch(/pessoa|example\.com|5521999990001|Pessoa de Teste/i);
  });

  it('sends nothing while off, unconfigured, without consent, or too late for Meta', async () => {
    const leadId = await insertLead();
    const fake = meta();
    expect(
      await runMetaCapiLeadJob(jobFor(leadId), context(fake.fetchImpl, { enabled: false })),
    ).toMatchObject({ skipped: 'disabled' });
    expect(
      await runMetaCapiLeadJob(jobFor(leadId), context(fake.fetchImpl, { token: null })),
    ).toMatchObject({ skipped: 'not_configured' });
    const noConsent = await insertLead({ legal_basis: 'legitimate_interest', consented_at: null });
    expect(await runMetaCapiLeadJob(jobFor(noConsent), context(fake.fetchImpl))).toMatchObject({
      skipped: 'no_consent',
    });
    expect(
      await runMetaCapiLeadJob(
        jobFor(leadId, NOW_SECONDS - 8 * 24 * 3600),
        context(fake.fetchImpl),
      ),
    ).toMatchObject({ skipped: 'too_old' });
    expect(fake.calls).toHaveLength(0);
  });

  it('a refusal fails with Meta’s codes only, never its message', async () => {
    const leadId = await insertLead();
    const fake = meta(400, {
      error: {
        message: 'Invalid parameter: pessoa.teste@example.com',
        code: 100,
        error_subcode: 2804003,
      },
    });
    await expect(runMetaCapiLeadJob(jobFor(leadId), context(fake.fetchImpl))).rejects.toThrow(
      /^meta_capi_http_400 code=100 subcode=2804003$/,
    );
  });

  it('the test event code goes along when set, for Events Manager only', async () => {
    const leadId = await insertLead();
    const fake = meta();
    await runMetaCapiLeadJob(jobFor(leadId), context(fake.fetchImpl, { testEventCode: 'TEST123' }));
    expect(JSON.parse(String(fake.calls[0]!.init.body))).toMatchObject({
      test_event_code: 'TEST123',
    });
  });
});
