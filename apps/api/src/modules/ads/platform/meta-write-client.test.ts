import { describe, expect, it } from 'vitest';
import { MetaWriteClient } from './meta-write-client.js';

/**
 * createCampaign against a scripted fetch. No network: what is pinned here is
 * what leaves the building (one POST, PAUSED when asked) and that every shade
 * of "not sure" comes back as `unknown`, never as a failure to retry.
 */

interface Recorded {
  method: string;
  url: string;
  body: URLSearchParams | null;
}

function scripted(post: () => Response | Promise<Response>) {
  const requests: Recorded[] = [];
  const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    requests.push({
      method,
      url: String(input),
      body: typeof init?.body === 'string' ? new URLSearchParams(init.body) : null,
    });
    if (method === 'POST') return post();
    return Response.json({
      id: '23850000000000001',
      name: 'Sacrifício',
      status: 'PAUSED',
      daily_budget: '600',
    });
  }) as typeof fetch;

  const client = new MetaWriteClient({
    accessToken: 'test-token',
    adAccountId: 'act_339',
    confirmWrites: true,
    fetchImpl,
  });
  return { client, requests };
}

const SPEC = {
  name: 'Sacrifício',
  objective: 'OUTCOME_LEADS',
  status: 'PAUSED',
  dailyBudgetCents: 600,
} as const;

describe('MetaWriteClient.createCampaign', () => {
  it('sends one POST to the account, paused, with the budget in integer cents', async () => {
    const { client, requests } = scripted(() => Response.json({ id: '23850000000000001' }));
    const outcome = await client.createCampaign(SPEC);

    const posts = requests.filter((request) => request.method === 'POST');
    expect(posts).toHaveLength(1);
    expect(posts[0]?.url).toBe('https://graph.facebook.com/v23.0/act_339/campaigns');
    expect(Object.fromEntries(posts[0]?.body ?? [])).toEqual({
      name: 'Sacrifício',
      objective: 'OUTCOME_LEADS',
      status: 'PAUSED',
      special_ad_categories: '[]',
      daily_budget: '600',
      bid_strategy: 'LOWEST_COST_WITHOUT_CAP',
    });
    // The token travels in the header, never in the URL or the body.
    expect(posts[0]?.url).not.toContain('test-token');
    expect(posts[0]?.body?.has('access_token')).toBe(false);

    expect(outcome).toMatchObject({
      status: 'applied',
      campaign: { id: '23850000000000001', status: 'PAUSED', dailyBudgetCents: 600 },
    });
  });

  it('reports a refusal as rejected, with the platform code', async () => {
    const { client } = scripted(() =>
      Response.json(
        { error: { message: 'Daily budget is below the minimum', code: 100 } },
        { status: 400 },
      ),
    );
    expect(await client.createCampaign(SPEC)).toEqual({
      status: 'rejected',
      code: '100',
      message: 'Daily budget is below the minimum',
    });
  });

  it('treats a 5xx, a lost connection and a missing id as unknown', async () => {
    const serverError = scripted(() => new Response('oops', { status: 502 }));
    expect((await serverError.client.createCampaign(SPEC)).status).toBe('unknown');

    const dropped = scripted(() => {
      throw new TypeError('fetch failed');
    });
    expect((await dropped.client.createCampaign(SPEC)).status).toBe('unknown');

    const noId = scripted(() => Response.json({ success: true }));
    expect((await noId.client.createCampaign(SPEC)).status).toBe('unknown');
  });
});
