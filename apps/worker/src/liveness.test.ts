import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { touchLiveness } from './liveness.js';

describe('touchLiveness', () => {
  let dir: string;
  let file: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'wings-worker-liveness-'));
    file = join(dir, 'alive');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('creates the file if it does not exist yet', async () => {
    await touchLiveness(file);
    await expect(stat(file)).resolves.toBeDefined();
  });

  it('bumps the file mtime on every call', async () => {
    await touchLiveness(file);
    const first = (await stat(file)).mtimeMs;
    await new Promise((resolve) => setTimeout(resolve, 10));
    await touchLiveness(file);
    const second = (await stat(file)).mtimeMs;
    expect(second).toBeGreaterThan(first);
  });
});
