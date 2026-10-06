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
    expect(env.WORKER_JOB_TYPES).toBe('ffprobe,transcribe,render,enrich_lead,transcribe_meeting');
    expect(jobTypesOf(env)).toEqual([
      'ffprobe',
      'transcribe',
      'render',
      'enrich_lead',
      'transcribe_meeting',
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
