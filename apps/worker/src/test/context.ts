import { tmpdir } from 'node:os';
import type { Pool } from '../db/client.js';
import type { JobContext } from '../jobs/types.js';
import { createMemoryStorage } from './memory-storage.js';

/** A `JobContext` every field of which fails loudly if a test actually calls
 * it without overriding — so a test only ever exercises the collaborators it
 * names. */
export function baseContext(overrides: Partial<JobContext> = {}): JobContext {
  return {
    storage: createMemoryStorage(),
    threads: 1,
    runFfprobe: async () => {
      throw new Error('runFfprobe was not stubbed for this test');
    },
    runWhisper: async () => {
      throw new Error('runWhisper was not stubbed for this test');
    },
    runFfmpeg: async () => {
      throw new Error('runFfmpeg was not stubbed for this test');
    },
    renderLimits: {
      maxSeconds: 3600,
      timeoutSeconds: 7200,
      maxInputBytes: 8 * 1024 * 1024 * 1024,
      tmpDir: tmpdir(),
    },
    db: new Proxy({} as Pool, {
      get() {
        throw new Error('db was not provided for this test');
      },
    }),
    enrichment: {
      zapi: null,
      search: null,
      cnpj: {
        lookup: async () => {
          throw new Error('cnpj lookup was not stubbed for this test');
        },
      },
      budget: { dailyUsd: 2, searchUsdPerQuery: 0.005, researchDailyUsd: 1 },
    },
    ...overrides,
  };
}
