import { describe, expect, it } from 'vitest';
import { Ga4Client, Ga4Error } from './ga4.js';

const credentials = {
  clientId: 'client.apps.googleusercontent.com',
  clientSecret: 'not-a-real-secret',
  refreshToken: '1//not-a-real-refresh-token',
};

function scripted(
  report: (body: { offset: number }) => Response,
  token: () => Response = () => Response.json({ access_token: 'tok', expires_in: 3600 }),
) {
  const calls: { url: string; body: string }[] = [];
  const fetchImpl = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, body: String(init?.body ?? '') });
    if (url.includes('oauth2')) return token();
    return report(JSON.parse(String(init?.body)) as { offset: number });
  }) as typeof fetch;
  return { calls, client: new Ga4Client({ propertyId: '123456789', credentials, fetchImpl }) };
}

describe('GA4 Data API client', () => {
  it('trades the refresh token for an access token, then reads the property', async () => {
    const { calls, client } = scripted(() => Response.json({ rows: [], rowCount: 0 }));
    await client.runReport({
      startDate: '2026-09-22',
      endDate: '2026-09-28',
      dimensions: ['date'],
      metrics: ['sessions'],
    });
    expect(calls[0]?.url).toBe('https://oauth2.googleapis.com/token');
    expect(Object.fromEntries(new URLSearchParams(calls[0]!.body))).toEqual({
      grant_type: 'refresh_token',
      client_id: credentials.clientId,
      client_secret: credentials.clientSecret,
      refresh_token: credentials.refreshToken,
    });
    expect(calls[1]?.url).toBe(
      'https://analyticsdata.googleapis.com/v1beta/properties/123456789:runReport',
    );
  });

  it('reads every page of a report', async () => {
    const { calls, client } = scripted(({ offset }) =>
      Response.json({
        rowCount: 10_001,
        rows: [
          {
            dimensionValues: [{ value: offset === 0 ? 'a' : 'b' }],
            metricValues: [{ value: '3' }],
          },
        ],
      }),
    );
    const rows = await client.runReport({
      startDate: 'x',
      endDate: 'y',
      dimensions: ['d'],
      metrics: ['m'],
    });
    expect(rows.map((row) => row.dimensions[0])).toEqual(['a', 'b']);
    // One token, two report pages.
    expect(calls).toHaveLength(3);
  });

  it('says plainly when the account cannot read the property, and never echoes the token', async () => {
    const { client } = scripted(() => new Response('{}', { status: 403 }));
    const error = await client
      .runReport({ startDate: 'x', endDate: 'y', dimensions: ['d'], metrics: ['m'] })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Ga4Error);
    expect((error as Ga4Error).code).toBe('forbidden');
    expect(String((error as Error).message)).not.toContain(credentials.refreshToken);
  });

  it('says the consent must be granted again when the refresh token is refused', async () => {
    const { client } = scripted(
      () => Response.json({}),
      () => Response.json({ error: 'invalid_grant' }, { status: 400 }),
    );
    const error = await client
      .runReport({ startDate: 'x', endDate: 'y', dimensions: ['d'], metrics: ['m'] })
      .catch((caught: unknown) => caught);
    expect((error as Ga4Error).code).toBe('auth_failed');
    expect(String((error as Error).message)).toContain('invalid_grant');
    expect(String((error as Error).message)).not.toContain(credentials.refreshToken);
  });
});
