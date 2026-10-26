import { describe, expect, it } from 'vitest';
import { jobTypesOf, loadEnv } from './env.js';

const validSource = {
  DATABASE_URL: 'postgresql://wings:pw@127.0.0.1:5433/wings_system',
  R2_ENDPOINT: 'https://account.r2.cloudflarestorage.com',
  R2_BUCKET: 'wings-files',
  R2_ACCESS_KEY_ID: 'AKID',
  R2_SECRET_ACCESS_KEY: 'secret',
};

describe('loadEnv', () => {
  it('defaults job types to everything the worker implements', () => {
    const env = loadEnv(validSource);
    expect(env.WORKER_JOB_TYPES).toBe(
      'ffprobe,transcribe,render,enrich_lead,transcribe_meeting,check_instagram,meta_capi_lead',
    );
    expect(jobTypesOf(env)).toEqual([
      'ffprobe',
      'transcribe',
      'render',
      'enrich_lead',
      'transcribe_meeting',
      'check_instagram',
      'meta_capi_lead',
    ]);
  });

  it('requires the R2 variables: no local-volume fallback for the worker', () => {
    const withoutBucket = { ...validSource, R2_BUCKET: '' };
    expect(() => loadEnv(withoutBucket)).toThrow(/Invalid environment configuration/);
  });
});

describe('the company research variables', () => {
  it('is off by default, with its own ceiling and the cheaper model', () => {
    const env = loadEnv(validSource);
    expect(env.LEAD_RESEARCH_ENABLED).toBeUndefined();
    expect(env.OPENROUTER_API_KEY).toBeUndefined();
    expect(env.LEAD_RESEARCH_DAILY_USD).toBe(1);
    expect(env.LEAD_RESEARCH_USD_PER_CALL).toBe(0.06);
    expect(env.LEAD_RESEARCH_MODEL).toBe('anthropic/claude-haiku-4.5');
  });

  it('takes a blank variable as unset, so a line copied from .env.example cannot stop the worker', () => {
    const env = loadEnv({
      ...validSource,
      LEAD_RESEARCH_ENABLED: '',
      LEAD_RESEARCH_DAILY_USD: '',
      LEAD_RESEARCH_USD_PER_CALL: '',
      LEAD_RESEARCH_MODEL: '',
      OPENROUTER_API_KEY: '',
    });
    expect(env.LEAD_RESEARCH_DAILY_USD).toBe(1);
    expect(env.LEAD_RESEARCH_MODEL).toBe('anthropic/claude-haiku-4.5');
    expect(env.OPENROUTER_API_KEY).toBeUndefined();
  });

  it('reads the ceiling and refuses nonsense: zero, above 100, a model nobody priced, a flag that is not true/false', () => {
    expect(
      loadEnv({
        ...validSource,
        LEAD_RESEARCH_DAILY_USD: '0.5',
        LEAD_RESEARCH_MODEL: 'anthropic/claude-sonnet-5',
      }),
    ).toMatchObject({
      LEAD_RESEARCH_DAILY_USD: 0.5,
      LEAD_RESEARCH_MODEL: 'anthropic/claude-sonnet-5',
    });
    expect(() => loadEnv({ ...validSource, LEAD_RESEARCH_DAILY_USD: '0' })).toThrow();
    expect(() => loadEnv({ ...validSource, LEAD_RESEARCH_DAILY_USD: '101' })).toThrow();
    expect(() => loadEnv({ ...validSource, LEAD_RESEARCH_MODEL: 'openai/gpt-x' })).toThrow();
    expect(() => loadEnv({ ...validSource, LEAD_RESEARCH_ENABLED: 'yes' })).toThrow();
  });
});

describe('the research cut-off', () => {
  it('defaults to the day of the 14/10 rules and reads a real day as written', () => {
    expect(loadEnv(validSource).LEAD_RESEARCH_SINCE).toBe('2026-10-14');
    expect(loadEnv({ ...validSource, LEAD_RESEARCH_SINCE: '2026-11-01' }).LEAD_RESEARCH_SINCE).toBe(
      '2026-11-01',
    );
    // A leap day that exists, and a blank line that means "unset".
    expect(loadEnv({ ...validSource, LEAD_RESEARCH_SINCE: '2028-02-29' }).LEAD_RESEARCH_SINCE).toBe(
      '2028-02-29',
    );
    expect(loadEnv({ ...validSource, LEAD_RESEARCH_SINCE: '' }).LEAD_RESEARCH_SINCE).toBe(
      '2026-10-14',
    );
  });

  it('refuses at start a day the calendar does not have, instead of rolling it to the next month', () => {
    for (const day of ['2026-02-30', '2026-02-29', '2026-04-31', '2026-13-01', '2026-00-10']) {
      expect(() => loadEnv({ ...validSource, LEAD_RESEARCH_SINCE: day }), day).toThrow(
        /LEAD_RESEARCH_SINCE/,
      );
    }
    expect(() => loadEnv({ ...validSource, LEAD_RESEARCH_SINCE: '14/10/2026' })).toThrow(
      /LEAD_RESEARCH_SINCE/,
    );
  });
});

describe('jobTypesOf', () => {
  it('refuses an unknown job type rather than silently ignore it', () => {
    const env = loadEnv({ ...validSource, WORKER_JOB_TYPES: 'ffprobe,made_up' });
    expect(() => jobTypesOf(env)).toThrow(/made_up/);
  });

  it('refuses an empty list', () => {
    const env = loadEnv({ ...validSource, WORKER_JOB_TYPES: ' , ' });
    expect(() => jobTypesOf(env)).toThrow(/at least one/);
  });
});

describe('the Instagram check variables', () => {
  it('is off, with a small ceiling of its own, unless it is switched on', () => {
    const env = loadEnv(validSource);
    expect(env.INSTAGRAM_CHECK_ENABLED).toBeUndefined();
    expect(env.INSTAGRAM_CHECK_DAILY_USD).toBe(0.5);
    expect(env.INSTAGRAM_CHECK_AI_USD_PER_CALL).toBe(0.004);
    expect(
      loadEnv({ ...validSource, INSTAGRAM_CHECK_DAILY_USD: '' }).INSTAGRAM_CHECK_DAILY_USD,
    ).toBe(0.5);
  });

  it('refuses a switch that is not true or false and an account id that is not a number', () => {
    expect(() => loadEnv({ ...validSource, INSTAGRAM_CHECK_ENABLED: 'yes' })).toThrow(/true/);
    expect(() => loadEnv({ ...validSource, INSTAGRAM_DISCOVERY_ACCOUNT_ID: 'abc' })).toThrow(
      /numeric/,
    );
  });
});
