import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from '../../db/client.js';
import { ga4TrafficDaily, rdCrmDeals } from '../../db/schema/index.js';
import type { Ga4Client } from '../../lib/ga4.js';
import { createTestDatabase, type TestDatabase } from '../../test/db.js';
import { platformOfRdLabels, syncGa4Traffic, syncRdCrmDeals } from './funnel-sync.js';

let harness: TestDatabase;
let db: Database;

beforeAll(async () => {
  harness = await createTestDatabase();
  db = harness.db;
}, 60_000);

afterAll(async () => {
  await harness?.drop();
});

describe('GA4 into ga4_traffic_daily', () => {
  it('stores one row per day, source, medium and campaign, and a re-read replaces it', async () => {
    const report = (sessions: string) =>
      ({
        runReport: async () => [
          {
            dimensions: ['20260928', 'facebook', 'cpc', 'formatacao_jimmyogro_set26'],
            metrics: [Number(sessions), 30, 1200.4, 90, 2],
          },
          {
            dimensions: ['20260928', '(direct)', '(none)', '(not set)'],
            metrics: [10, 4, 100, 12, 0],
          },
        ],
      }) as unknown as Ga4Client;
    await syncGa4Traffic(db, report('40'), {
      propertyId: '1',
      since: '2026-09-22',
      until: '2026-09-28',
    });
    const read = await syncGa4Traffic(db, report('42'), {
      propertyId: '1',
      since: '2026-09-22',
      until: '2026-09-28',
    });
    expect(read).toEqual({ rows: 2, sessions: 52 });
    const rows = await db.select().from(ga4TrafficDaily);
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.source === 'facebook')).toMatchObject({
      day: '2026-09-28',
      sessions: 42,
      engagementSeconds: 1200,
      keyEvents: 2,
    });
    expect(rows.find((row) => row.source === '(direct)')?.campaign).toBe('(não definido)');
  });
});

describe('RD CRM deals into rd_crm_deals', () => {
  const pipelines = [
    {
      name: 'Formatação',
      deal_stages: [
        { id: 's1', name: 'Sem contato' },
        { id: 's2', name: 'Reunião agendada' },
        { id: 's3', name: 'Reunião realizada' },
        { id: 's4', name: 'Proposta enviada' },
      ],
    },
  ];
  const deals = [
    {
      id: 'd1',
      name: 'Fulano de Tal',
      win: null,
      created_at: '2026-09-28T10:00:00-03:00',
      deal_stage: { id: 's4' },
      deal_source: { name: 'Busca Paga | Facebook Ads' },
      campaign: { name: 'Meta - Formatação' },
      contacts: [{ emails: [{ email: 'x@y.z' }] }],
    },
    {
      id: 'd2',
      name: 'Beltrano',
      win: null,
      created_at: '2026-09-28T11:00:00-03:00',
      deal_stage: { id: 's2' },
      deal_source: { name: 'Busca Paga | Google' },
      campaign: null,
    },
    {
      id: 'd3',
      name: 'Ciclano',
      win: true,
      created_at: '2026-09-20T11:00:00-03:00',
      closed_at: '2026-09-27T11:00:00-03:00',
      deal_stage: { id: 's1' },
      deal_source: { name: 'Social | Instagram' },
      campaign: { name: 'LP/LE Casal dos Churros' },
    },
    {
      id: 'd4',
      name: 'Perdido',
      win: false,
      created_at: '2026-09-21T11:00:00-03:00',
      deal_stage: { id: 's4' },
      deal_source: { name: 'Busca Paga | Facebook Ads' },
      campaign: null,
    },
  ];
  const fetchImpl = (async (input: unknown) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/deal_pipelines')) return Response.json(pipelines);
    return Response.json({ deals, has_more: false });
  }) as typeof fetch;

  it('keeps stage, meeting, win and labels, and nothing personal', async () => {
    expect(
      await syncRdCrmDeals(db, { token: 't', since: '2026-07-01', until: '2026-09-28', fetchImpl }),
    ).toMatchObject({ deals: 4 });
    const rows = await db.select().from(rdCrmDeals);
    const by = new Map(rows.map((row) => [row.rdId, row]));
    expect(by.get('d1')).toMatchObject({
      stage: 'Proposta enviada',
      reachedMeeting: true,
      platform: 'meta',
    });
    expect(by.get('d2')).toMatchObject({ reachedMeeting: false, platform: 'google' });
    expect(by.get('d3')).toMatchObject({ win: true, reachedMeeting: true, platform: null });
    // Lost after the proposal: RD keeps no history, so it is not counted as a meeting.
    expect(by.get('d4')).toMatchObject({ win: false, reachedMeeting: false });
    const stored = JSON.stringify(rows);
    for (const personal of ['Fulano', 'Beltrano', 'x@y.z']) expect(stored).not.toContain(personal);
  });

  it("names a paid platform only when RD's labels say which", () => {
    expect(platformOfRdLabels('Busca Paga | Facebook Ads', null)).toBe('meta');
    expect(platformOfRdLabels(null, 'META ADS')).toBe('meta');
    expect(platformOfRdLabels('Busca Paga | Google', null)).toBe('google');
    expect(platformOfRdLabels('Tráfego pago - msg direta', null)).toBeNull();
    // The source names the platform: a campaign typed "Meta - Formatação" on a Google deal does not win.
    expect(platformOfRdLabels('Busca Paga | google', 'Meta - Formatação')).toBe('google');
    expect(platformOfRdLabels('Busca Paga | Facebook', 'Google - Alta Intenção')).toBe('meta');
    // A source that says only "Busca Paga" still reads the campaign beside it.
    expect(platformOfRdLabels('Busca Paga', 'Meta - Formatação')).toBe('meta');
    expect(platformOfRdLabels('Busca Paga', 'Google Ads - Marca')).toBe('google');
    expect(
      platformOfRdLabels('Referência | casaldochurros.com.br', 'LP/LE Casal dos Churros'),
    ).toBeNull();
  });
});

describe('rdCrmGetter', () => {
  it('reads again after a timeout (a GET is safe to repeat), and names only the path when it gives up', async () => {
    const { rdCrmGetter } = await import('./funnel-sync.js');
    let calls = 0;
    const flaky = (async () => {
      calls += 1;
      if (calls === 1)
        throw Object.assign(new Error('The operation was aborted due to timeout'), {
          name: 'TimeoutError',
        });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as typeof fetch;
    await expect(rdCrmGetter('t', flaky)('/users', {})).resolves.toEqual({ ok: true });
    expect(calls).toBe(2);
  }, 15_000);
});
