/**
 * Google Analytics 4 Data API, read-only, with a person's OAuth consent.
 *
 * The organisation blocks service account keys, so GA4 is read like Google
 * Ads: the existing OAuth client (same Google Cloud project) plus a refresh
 * token granted once, in a browser, by an account that can read the property,
 * with the analytics.readonly scope only. The refresh token is traded for a
 * short access token; neither is logged, returned or put in an error message.
 * NOT verified live until the first collection with the real token.
 */

export interface Ga4Credentials {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}

export interface Ga4Row {
  dimensions: string[];
  metrics: number[];
}

export class Ga4Error extends Error {
  constructor(
    readonly code: 'auth_failed' | 'forbidden' | 'report_failed' | 'unavailable',
    message: string,
  ) {
    super(message);
    this.name = 'Ga4Error';
  }
}

/** The three pieces from the environment, or null while any is missing. */
export function ga4CredentialsOf(env: {
  GOOGLE_ADS_CLIENT_ID?: string;
  GOOGLE_ADS_CLIENT_SECRET?: string;
  GA4_REFRESH_TOKEN?: string;
}): Ga4Credentials | null {
  const { GOOGLE_ADS_CLIENT_ID, GOOGLE_ADS_CLIENT_SECRET, GA4_REFRESH_TOKEN } = env;
  if (!GOOGLE_ADS_CLIENT_ID || !GOOGLE_ADS_CLIENT_SECRET || !GA4_REFRESH_TOKEN) return null;
  return {
    clientId: GOOGLE_ADS_CLIENT_ID,
    clientSecret: GOOGLE_ADS_CLIENT_SECRET,
    refreshToken: GA4_REFRESH_TOKEN,
  };
}

export const GA4_SCOPE = 'https://www.googleapis.com/auth/analytics.readonly';
const TOKEN_URI = 'https://oauth2.googleapis.com/token';

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
    const { clientId, clientSecret, refreshToken } = this.options.credentials;
    const response = await this.fetchImpl(TOKEN_URI, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
      }).toString(),
      signal: AbortSignal.timeout(20_000),
    }).catch(() => null);
    if (!response) throw new Ga4Error('unavailable', 'the token endpoint did not answer');
    const body = (await response.json().catch(() => ({}))) as {
      access_token?: string;
      expires_in?: number;
      error?: string;
    };
    if (!response.ok || !body.access_token) {
      // `invalid_grant`: the consent was revoked or the token expired; grant it again.
      throw new Ga4Error(
        'auth_failed',
        `token request refused (${response.status} ${body.error ?? ''})`.trim(),
      );
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
        throw new Ga4Error('forbidden', 'the consenting account cannot read this property, or the Data API is off');
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
