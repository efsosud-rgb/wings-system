import { describe, expect, it } from 'vitest';
import type { Job } from '../queue.js';
import { createMemoryStorage } from '../test/memory-storage.js';
import { runRenderJob } from './render.js';

describe('the render job (TODO)', () => {
  it('refuses rather than guess the contract', async () => {
    const job: Job = { id: '1', type: 'render', input: {}, attempts: 1 };
    await expect(
      runRenderJob(job, {
        storage: createMemoryStorage(),
        threads: 1,
        runFfprobe: async () => '',
        runWhisper: async () => '',
      }),
    ).rejects.toThrow(/docs\/studio\/jobs\.md/);
  });
});
