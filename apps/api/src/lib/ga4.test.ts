import { generateKeyPairSync, createVerify } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { Ga4Client, Ga4Error, parseGa4Credentials } from './ga4.js';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const credentials = {
  client_email: 'wings-ga4@projeto.iam.gserviceaccount.com',
  private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
};

function scripted(report: (body: { offset: number }) => Response) {
  const calls: { url: string; body: string }[] = [];
  const fetchImpl = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, body: String(init?.body ?? '') });
    if (url.includes('oauth2')) return Response.json({ access_token: 'tok', expires_in: 3600 });
    return report(JSON.parse(String(init?.body)) as { offset: number });
  }) as typeof fetch;
  return { calls, client: new Ga4Client({ propertyId: '123456789', credentials, fetchImpl }) };
}

describe('GA4 Data API client', () => {
  it('signs its own JWT with the service account key, scoped read-only', async () => {
    const { calls, client } = scripted(() => Response.json({ rows: [], rowCount: 0 }));
    await client.runReport({
      startDate: '2026-09-22',
      endDate: '2026-09-28',
      dimensions: ['date'],
      metrics: ['sessions'],
    });
    const assertion = new URLSearchParams(calls[0]!.body).get('assertion')!;
    const [header, claims, signature] = assertion.split('.');
    const verified = createVerify('RSA-SHA256')
      .update(`${header}.${claims}`)
      .verify(publicKey, Buffer.from(signature!, 'base64url'));
    expect(verified).toBe(true);
    const decoded = JSON.parse(Buffer.from(claims!, 'base64url').toString()) as Record<
      string,
      string
    >;
    expect(decoded.iss).toBe(credentials.client_email);
    expect(decoded.scope).toBe('https://www.googleapis.com/auth/analytics.readonly');
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

  it('says plainly when the account is not a Leitor, and never echoes the key', async () => {
    const { client } = scripted(() => new Response('{}', { status: 403 }));
    const error = await client
      .runReport({ startDate: 'x', endDate: 'y', dimensions: ['d'], metrics: ['m'] })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Ga4Error);
    expect((error as Ga4Error).code).toBe('forbidden');
    expect(String((error as Error).message)).not.toContain('PRIVATE KEY');
  });

  it('reads the key as base64 of the JSON file, wrapped or not, and as plain JSON', () => {
    const file = JSON.stringify({ type: 'service_account', ...credentials }, null, 2);
    const encoded = Buffer.from(file).toString('base64');
    const wrapped = encoded.replace(/.{76}/g, '$&\n');
    for (const raw of [encoded, `${wrapped}\n`, file]) {
      expect(parseGa4Credentials(raw)).toEqual({ ...credentials, token_uri: undefined });
    }
  });

  it('refuses a key file that is not a service account', () => {
    expect(() =>
      parseGa4Credentials(Buffer.from('{"type":"authorized_user"}').toString('base64')),
    ).toThrow(/client_email/);
    expect(() => parseGa4Credentials('{"type":"authorized_user"}')).toThrow(/client_email/);
    expect(() => parseGa4Credentials('não é json')).toThrow(Ga4Error);
  });
});
