import { describe, expect, it } from 'vitest';
import { concurrencyOf, threadsPerJob } from './concurrency.js';
import type { Env } from './env.js';

const baseEnv = {
  WORKER_MEMORY_LIMIT_MB: 2048,
  WORKER_MEMORY_PER_JOB_MB: 1024,
} as Env;

describe('concurrencyOf', () => {
  it('is the smaller of the CPU limit and what memory allows', () => {
    expect(concurrencyOf({ ...baseEnv, WORKER_CPU_LIMIT: 4 })).toBe(2); // memory caps it at 2
    expect(concurrencyOf({ ...baseEnv, WORKER_CPU_LIMIT: 1 })).toBe(1); // CPU caps it at 1
  });

  it('never goes below 1, even on a tight memory budget', () => {
    expect(
      concurrencyOf({ ...baseEnv, WORKER_CPU_LIMIT: 4, WORKER_MEMORY_LIMIT_MB: 100 }),
    ).toBe(1);
  });
});

describe('threadsPerJob', () => {
  it('splits the CPU limit evenly across the concurrent jobs', () => {
    expect(threadsPerJob({ ...baseEnv, WORKER_CPU_LIMIT: 8 }, 4)).toBe(2);
    expect(threadsPerJob({ ...baseEnv, WORKER_CPU_LIMIT: 3 }, 4)).toBe(1); // rounds down, never 0
  });
});
