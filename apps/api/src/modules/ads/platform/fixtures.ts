/**
 * Recorded response shapes from Meta's Marketing API reference (v23/v25).
 *
 * These exist so parsing can be tested without touching the network. Two
 * traps are captured deliberately, because both are money bugs waiting to
 * happen:
 *
 *  1. **Numbers arrive as strings.** `daily_budget: "5000"`, not 5000.
 *  2. **Units are inconsistent.** Budgets and `spend_cap` are integer cents,
 *     while Insights `spend` is a decimal string in whole currency ("12.34").
 *     Mixing them up is a 100x error in real money.
 *
 * Stage 3 verifies these units read-only against the live account before any
 * write is attempted — documentation alone is not enough, and Meta's own docs
 * disagree about `spend_cap`.
 */

export const AD_ACCOUNT_RESPONSE = {
  id: 'act_123456789',
  account_id: '123456789',
  currency: 'BRL',
  timezone_name: 'America/Sao_Paulo',
  // Integer cents, as strings: R$10.000,00 cap, R$1.234,56 spent.
  spend_cap: '1000000',
  amount_spent: '123456',
  account_status: 1,
} as const;

export const CAMPAIGNS_RESPONSE = {
  data: [
    {
      id: '23851234567890123',
      name: 'Wings Matriz — Institucional',
      status: 'ACTIVE',
      effective_status: 'ACTIVE',
      daily_budget: '5000', // R$50,00/dia
      lifetime_budget: '0',
    },
    {
      id: '23851234567890124',
      name: 'Wings Matriz — Remarketing',
      status: 'PAUSED',
      effective_status: 'PAUSED',
      daily_budget: '3000',
      lifetime_budget: '0',
    },
  ],
  paging: { cursors: { before: 'MAZDZD', after: 'MQZDZD' } },
} as const;

/** Insights spend is a DECIMAL STRING in whole currency, unlike budgets. */
export const INSIGHTS_RESPONSE = {
  data: [
    {
      campaign_id: '23851234567890123',
      date_start: '2026-09-15',
      date_stop: '2026-09-15',
      spend: '48.71',
    },
    {
      campaign_id: '23851234567890123',
      date_start: '2026-09-16',
      date_stop: '2026-09-16',
      spend: '61.02',
    },
  ],
} as const;

export const ERROR_INVALID_TOKEN = {
  error: {
    message: 'Error validating access token: The session has been invalidated.',
    type: 'OAuthException',
    code: 190,
    error_subcode: 463,
    fbtrace_id: 'A1bCdEfGhIjK',
  },
} as const;

export const ERROR_RATE_LIMIT = {
  error: {
    message: '(#80004) There have been too many calls to this ad-account.',
    type: 'OAuthException',
    code: 80004,
    fbtrace_id: 'B2cDeFgHiJkL',
  },
} as const;

export const ERROR_BUDGET_TOO_LOW = {
  error: {
    message: 'Invalid parameter: daily budget is below the minimum for this account.',
    type: 'OAuthException',
    code: 100,
    error_subcode: 1487079,
    fbtrace_id: 'C3dEfGhIjKlM',
  },
} as const;

/** Meta permits delivery to exceed the daily budget by up to this factor. */
export const META_DAILY_OVERDELIVERY_FACTOR = 1.25;
