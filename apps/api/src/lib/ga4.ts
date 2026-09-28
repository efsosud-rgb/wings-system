import { createSign } from 'node:crypto';

/**
 * Google Analytics 4 Data API, read-only, with a service account.
 *
 * The account signs its own JWT (RS256) and trades it for an access token
 * scoped to analytics.readonly: no library, no refresh token to keep. The
 * key never leaves this module: it is not logged, not returned and not put in
 * an error message. NOT verified live: nothing here has met the real API yet
 * (the property still has to add the account as Leitor).
 */

export interface Ga4Credentials {
  client_email: string;
  private_key: string;
  token_uri?: string;
}

export interface Ga4Row {
  dimensions: string[];
  metrics: number[];
}

export class Ga4Error extends Error {
  constructor(
    readonly code:
      'bad_credentials' | 'auth_failed' | 'forbidden' | 'report_failed' | 'unavailable',
    message: string,
  ) {
    super(message);
    this.name = 'Ga4Error';
  }
}

const SCOPE = 'https://www.googleapis.com/auth/analytics.readonly';
const TOKEN_URI = 'https://oauth2.googleapis.com/token';

/**
 * The key as Coolify holds it: the downloaded JSON file encoded in base64
 * (`base64 -w0 chave.json`), so its line breaks survive the variable. Plain
 * JSON is still accepted. Line breaks inside the base64 (`base64` without
 * `-w0` wraps at 76 columns) are ignored.
 */
export function parseGa4Credentials(raw: string): Ga4Credentials {
  const value = raw.trim();
  const json = value.startsWith('{')
    ? value
    : Buffer.from(value.replace(/\s+/g, ''), 'base64').toString('utf8');
  let parsed: Partial<Ga4Credentials>;
  try {
    parsed = JSON.parse(json) as Partial<Ga4Credentials>;
  } catch {
    throw new Ga4Error(
      'bad_credentials',
      'GA4_SERVICE_ACCOUNT_JSON is neither base64 of the JSON key nor JSON',
    );
  }
  if (!parsed.client_email || !parsed.private_key) {
    throw new Ga4Error(
      'bad_credentials',
      'GA4_SERVICE_ACCOUNT_JSON lacks client_email or private_key',
    );
  }
  return {
    client_email: parsed.client_email,
    private_key: parsed.private_key,
    token_uri: parsed.token_uri,
  };
}

const base64url = (value: Buffer | string) => Buffer.from(value).toString('base64url');

export class Ga4Client {
  private token: { value: string; expiresAt: number } | null = null;

  constructor(
    private readonly options: {
      propertyId: string;
      credentials: Ga4Credentials;
      fetchImpl?: typeof fetch;
      now?: () => Date;
    },
  ) {}

  private get fetchImpl(): typeof fetch {
    return this.options.fetchImpl ?? fetch;
  }

  private async accessToken(): Promise<string> {
    const now = (this.options.now?.() ?? new Date()).getTime();
    if (this.token && this.token.expiresAt - 60_000 > now) return this.token.value;
    const issuedAt = Math.floor(now / 1000);
    const tokenUri = this.options.credentials.token_uri ?? TOKEN_URI;
    const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const claims = base64url(
      JSON.stringify({
        iss: this.options.credentials.client_email,
        scope: SCOPE,
        aud: tokenUri,
        iat: issuedAt,
        exp: issuedAt + 3600,
      }),
    );
    let signature: string;
    try {
      signature = createSign('RSA-SHA256')
        .update(`${header}.${claims}`)
        .sign(this.options.credentials.private_key)
        .toString('base64url');
    } catch {
      throw new Ga4Error('bad_credentials', 'the service account key could not sign');
    }
    const response = await this.fetchImpl(tokenUri, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: `${header}.${claims}.${signature}`,
      }).toString(),
      signal: AbortSignal.timeout(20_000),
    }).catch(() => null);
    if (!response) throw new Ga4Error('unavailable', 'the token endpoint did not answer');
    const body = (await response.json().catch(() => ({}))) as {
      access_token?: string;
      expires_in?: number;
    };
    if (!response.ok || !body.access_token) {
      throw new Ga4Error('auth_failed', `token request refused (${response.status})`);
    }
    this.token = { value: body.access_token, expiresAt: now + (body.expires_in ?? 3600) * 1000 };
    return body.access_token;
  }

  /** One `runReport`, every page of it. */
  async runReport(input: {
    startDate: string;
    endDate: string;
    dimensions: string[];
    metrics: string[];
  }): Promise<Ga4Row[]> {
    const token = await this.accessToken();
    const rows: Ga4Row[] = [];
    const pageSize = 10_000;
    for (let offset = 0; ; offset += pageSize) {
      const response = await this.fetchImpl(
        `https://analyticsdata.googleapis.com/v1beta/properties/${this.options.propertyId}:runReport`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            dateRanges: [{ startDate: input.startDate, endDate: input.endDate }],
            dimensions: input.dimensions.map((name) => ({ name })),
            metrics: input.metrics.map((name) => ({ name })),
            limit: pageSize,
            offset,
          }),
          signal: AbortSignal.timeout(60_000),
        },
      ).catch(() => null);
      if (!response) throw new Ga4Error('unavailable', 'the Data API did not answer');
      const body = (await response.json().catch(() => ({}))) as {
        rows?: { dimensionValues?: { value?: string }[]; metricValues?: { value?: string }[] }[];
        rowCount?: number;
        error?: { status?: string };
      };
      if (response.status === 403) {
        throw new Ga4Error('forbidden', 'the service account is not a Leitor on this property');
      }
      if (!response.ok) {
        throw new Ga4Error(
          'report_failed',
          `runReport refused (${response.status} ${body.error?.status ?? ''})`,
        );
      }
      for (const row of body.rows ?? []) {
        rows.push({
          dimensions: (row.dimensionValues ?? []).map((value) => value.value ?? ''),
          metrics: (row.metricValues ?? []).map((value) => Number(value.value ?? 0)),
        });
      }
      if (offset + pageSize >= (body.rowCount ?? 0)) break;
    }
    return rows;
  }
}
