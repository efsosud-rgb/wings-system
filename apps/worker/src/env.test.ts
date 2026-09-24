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
    expect(env.WORKER_JOB_TYPES).toBe('ffprobe,transcribe,render,enrich_lead,caption_layout');
    expect(jobTypesOf(env)).toEqual(['ffprobe', 'transcribe', 'render', 'enrich_lead', 'caption_layout']);
  });

  it('requires the R2 variables: no local-volume fallback for the worker', () => {
    const withoutBucket = { ...validSource, R2_BUCKET: '' };
    expect(() => loadEnv(withoutBucket)).toThrow(/Invalid environment configuration/);
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
