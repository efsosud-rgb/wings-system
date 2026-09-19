import { limitFrom, type PlatformSpendLimit } from './limits.js';
import type { Cents } from './money.js';

/**
 * Read-only Google Ads client — currently just the account's spending ceiling.
 *
 * This is deliberately NOT an `AdsPlatformClient`. Mirroring campaigns, ads and
 * metrics from Google needs decisions this wave does not take (exposure per
 * budget rather than per campaign, Performance Max asset groups, the second
 * overdelivery factor). What it does provide is the one number the budget guard
 * needs today: how much the prepaid account can still spend.
 *
 * ## Why no `login-customer-id` header
 *
 * The header is only for reaching a client account *through* a manager. The
 * Google user who authorised this token has **direct** access to the ad account
 * and is not a member of the MCC, so sending the header makes Google check the
 * MCC instead and refuse:
 *
 *     without header -> 200 OK
 *     with header    -> 403 USER_PERMISSION_DENIED
 *
 * Verified against the live account on 2026-09-18. `GOOGLE_ADS_LOGIN_CUSTOMER_ID`
 * stays in the environment as documentation of who owns the developer token,
 * but this client must never send it while access is direct. A test locks that
 * down, because "fixing" it by adding the header is an easy and plausible
 * mistake.
 */

export const GOOGLE_ADS_API_VERSION = 'v22';

export interface GoogleAdsCredentials {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  developerToken: string;
  /** Digits only, no dashes. */
  customerId: string;
}

export interface GoogleAdsClientOptions {
  credentials: GoogleAdsCredentials;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

interface AccountBudgetRow {
  accountBudget?: {
    id?: string;
    status?: string;
    adjustedSpendingLimitMicros?: string;
    approvedSpendingLimitMicros?: string;
    amountServedMicros?: string;
    totalAdjustmentsMicros?: string;
  };
}

/** Google reports money in micros: 1 unit of currency = 1_000_000 micros. */
export function centsFromMicros(micros: string | number | undefined | null): Cents {
  if (micros === undefined || micros === null || micros === '') return 0;
  const value = Number(micros);
  if (!Number.isFinite(value)) {
    throw new Error('google: non-numeric micros value');
  }
  return Math.round(value / 10_000);
}

export class GoogleAdsReadClient {
  readonly platform = 'google' as const;

  private readonly fetchImpl: typeof fetch;
  private accessToken: { value: string; expiresAt: number } | null = null;

  constructor(private readonly options: GoogleAdsClientOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  private nowMs(): number {
    return (this.options.now?.() ?? new Date()).getTime();
  }

  private async token(): Promise<string> {
    if (this.accessToken && this.accessToken.expiresAt > this.nowMs() + 60_000) {
      return this.accessToken.value;
    }

    const { clientId, clientSecret, refreshToken } = this.options.credentials;
    const response = await this.fetchImpl('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
        grant_type: 'refresh_token',
      }),
    });

    const body = (await response.json()) as { access_token?: string; expires_in?: number };
    if (!response.ok || !body.access_token) {
      throw new Error(`google: token refresh failed (${response.status})`);
    }

    this.accessToken = {
      value: body.access_token,
      expiresAt: this.nowMs() + (body.expires_in ?? 3600) * 1000,
    };
    return this.accessToken.value;
  }

  /**
   * Headers for a search call.
   *
   * Exposed so a test can assert what goes on the wire — specifically, that
   * `login-customer-id` is absent.
   */
  async requestHeaders(): Promise<Record<string, string>> {
    return {
      authorization: `Bearer ${await this.token()}`,
      'developer-token': this.options.credentials.developerToken,
      'content-type': 'application/json',
    };
  }

  async search<T>(query: string): Promise<T[]> {
    const { customerId } = this.options.credentials;
    const response = await this.fetchImpl(
      `https://googleads.googleapis.com/${GOOGLE_ADS_API_VERSION}/customers/${customerId}/googleAds:search`,
      {
        method: 'POST',
        headers: await this.requestHeaders(),
        // No pageSize: v22 rejects it outright ("PAGE_SIZE_NOT_SUPPORTED").
        body: JSON.stringify({ query }),
      },
    );

    const body = (await response.json()) as {
      results?: T[];
      error?: { message?: string; details?: { errors?: { message?: string }[] }[] };
    };

    if (!response.ok) {
      const detail = body.error?.details?.[0]?.errors?.[0]?.message ?? body.error?.message;
      throw new Error(`google: search failed (${response.status}): ${detail ?? 'unknown'}`);
    }
    return body.results ?? [];
  }

  /**
   * How much this account can still spend, from `account_budget`.
   *
   * On a prepaid account this is the balance: Google models added funds as the
   * approved spending limit, credits as adjustments, and spend as the amount
   * served. Verified live — a R$500 Pix moved the approved limit from
   * R$12.600,00 to R$13.100,00 within minutes.
   */
  async getSpendLimit(): Promise<PlatformSpendLimit> {
    const budget = await this.getAccountBudget();
    if (!budget) {
      // No approved account budget: the account sets no ceiling we can read.
      // Saying "unlimited" is the honest answer; saying zero would freeze a
      // working account over a missing row.
      return limitFrom(null, 0, 'google.account_budget:absent');
    }
    return limitFrom(budget.limitCents, budget.servedCents, 'google.account_budget');
  }

  /** The approved account budget as limit and amount served; null when absent. */
  async getAccountBudget(): Promise<{ limitCents: Cents; servedCents: Cents } | null> {
    const rows = await this.search<AccountBudgetRow>(`
      SELECT account_budget.id, account_budget.status,
             account_budget.approved_spending_limit_micros,
             account_budget.adjusted_spending_limit_micros,
             account_budget.amount_served_micros,
             account_budget.total_adjustments_micros
        FROM account_budget
       WHERE account_budget.status = 'APPROVED'
    `);

    const budget = rows[0]?.accountBudget;
    if (!budget) return null;

    // The adjusted limit already folds in credits and refunds; fall back to the
    // approved limit when Google has not computed an adjusted one.
    return {
      limitCents: centsFromMicros(
        budget.adjustedSpendingLimitMicros ?? budget.approvedSpendingLimitMicros,
      ),
      servedCents: centsFromMicros(budget.amountServedMicros),
    };
  }

  /** The customer this client is credentialed for, digits only. */
  get customerId(): string {
    return this.options.credentials.customerId;
  }

  /** The `fetch` this client was built with, for the write client to share. */
  get transport(): typeof fetch {
    return this.fetchImpl;
  }
}

/** Builds the client when every credential is present; null otherwise. */
export function createGoogleClient(
  env: {
    GOOGLE_ADS_CLIENT_ID?: string;
    GOOGLE_ADS_CLIENT_SECRET?: string;
    GOOGLE_ADS_REFRESH_TOKEN?: string;
    GOOGLE_ADS_DEVELOPER_TOKEN?: string;
    GOOGLE_ADS_CUSTOMER_ID?: string;
  },
  fetchImpl?: typeof fetch,
): GoogleAdsReadClient | null {
  const {
    GOOGLE_ADS_CLIENT_ID,
    GOOGLE_ADS_CLIENT_SECRET,
    GOOGLE_ADS_REFRESH_TOKEN,
    GOOGLE_ADS_DEVELOPER_TOKEN,
    GOOGLE_ADS_CUSTOMER_ID,
  } = env;

  if (
    !GOOGLE_ADS_CLIENT_ID ||
    !GOOGLE_ADS_CLIENT_SECRET ||
    !GOOGLE_ADS_REFRESH_TOKEN ||
    !GOOGLE_ADS_DEVELOPER_TOKEN ||
    !GOOGLE_ADS_CUSTOMER_ID
  ) {
    return null;
  }

  return new GoogleAdsReadClient({
    credentials: {
      clientId: GOOGLE_ADS_CLIENT_ID,
      clientSecret: GOOGLE_ADS_CLIENT_SECRET,
      refreshToken: GOOGLE_ADS_REFRESH_TOKEN,
      developerToken: GOOGLE_ADS_DEVELOPER_TOKEN,
      customerId: GOOGLE_ADS_CUSTOMER_ID.replace(/-/g, ''),
    },
    fetchImpl,
  });
}
