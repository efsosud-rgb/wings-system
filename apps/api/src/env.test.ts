import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { loadEnv } from './env.js';

const valid = {
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
  SESSION_SECRET: randomBytes(48).toString('base64'),
  CPF_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
  CPF_INDEX_KEY: randomBytes(32).toString('base64'),
};

describe('env', () => {
  it('accepts a complete configuration', () => {
    const env = loadEnv(valid);
    expect(env.API_PORT).toBe(3000);
    expect(env.NODE_ENV).toBe('development');
  });

  it('rejects missing or malformed values', () => {
    expect(() => loadEnv({ ...valid, DATABASE_URL: undefined })).toThrow(/DATABASE_URL/);
    expect(() => loadEnv({ ...valid, CPF_ENCRYPTION_KEY: 'too-short' })).toThrow(/32 bytes/);
    expect(() => loadEnv({ ...valid, SESSION_SECRET: 'short' })).toThrow(/SESSION_SECRET/);
  });

  it('reads the YouTube channel and schedule, and refuses what they cannot be', () => {
    const env = loadEnv({
      ...valid,
      YOUTUBE_API_KEY: 'k',
      YOUTUBE_CHANNEL_ID: '@wingscompany',
      YOUTUBE_INGEST_CRON: '30 6 * * *',
    });
    expect(env.YOUTUBE_CHANNEL_ID).toBe('@wingscompany');
    expect(
      loadEnv({ ...valid, YOUTUBE_CHANNEL_ID: 'UCabcdefghijklmnopqrstuv' }).YOUTUBE_CHANNEL_ID,
    ).toBe('UCabcdefghijklmnopqrstuv');
    expect(loadEnv({ ...valid, YOUTUBE_INGEST_CRON: '' }).YOUTUBE_INGEST_CRON).toBeUndefined();
    expect(() =>
      loadEnv({ ...valid, YOUTUBE_CHANNEL_ID: 'https://www.youtube.com/@wings' }),
    ).toThrow(/YOUTUBE_CHANNEL_ID/);
    expect(() => loadEnv({ ...valid, YOUTUBE_INGEST_CRON: '0 7 * *' })).toThrow(
      /YOUTUBE_INGEST_CRON/,
    );
    expect(() => loadEnv({ ...valid, YOUTUBE_INGEST_CRON: '0 25 * * *' })).toThrow(
      /YOUTUBE_INGEST_CRON/,
    );
  });

  it('refuses reusing one key for both CPF purposes', () => {
    const key = randomBytes(32).toString('base64');
    expect(() => loadEnv({ ...valid, CPF_ENCRYPTION_KEY: key, CPF_INDEX_KEY: key })).toThrow(
      /must be different/,
    );
  });
});
