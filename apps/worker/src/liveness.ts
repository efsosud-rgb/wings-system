import { writeFile } from 'node:fs/promises';

/** The polling loop touches this file every round so the container's
 * HEALTHCHECK (docker/worker.Dockerfile) can tell the process is alive
 * without needing a port. Unlike `jobs.heartbeat_at`, this stays fresh
 * even when the worker is idle. */
export const WORKER_LIVENESS_FILE = '/tmp/worker-alive';

export async function touchLiveness(path: string): Promise<void> {
  await writeFile(path, '');
}
