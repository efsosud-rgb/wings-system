import { runFfprobe, runWhisper } from './lib/commands.js';
import { createS3Storage } from './lib/storage.js';
import { concurrencyOf, threadsPerJob } from './concurrency.js';
import { createPool, waitForJobsTable } from './db/client.js';
import { jobTypesOf, loadEnv } from './env.js';
import { runWorker } from './worker.js';

async function main() {
  const env = loadEnv();
  const jobTypes = jobTypesOf(env);
  const pool = createPool(env.DATABASE_URL);
  await waitForJobsTable(pool);

  const storage = createS3Storage({
    endpoint: env.R2_ENDPOINT,
    bucket: env.R2_BUCKET,
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    region: env.R2_REGION,
  });

  const concurrency = concurrencyOf(env);
  const threads = threadsPerJob(env, concurrency);
  console.warn(
    `wings-worker: claiming [${jobTypes.join(', ')}], concurrency=${concurrency}, threads/job=${threads}`,
  );

  const stop = runWorker(
    pool,
    { storage, threadsPerJob: threads, runFfprobe, runWhisper },
    { jobTypes, concurrency, pollIntervalMs: env.WORKER_POLL_INTERVAL_MS, maxAttempts: env.WORKER_MAX_ATTEMPTS },
  );

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.warn(`wings-worker: ${signal} received, finishing in-flight jobs`);
    stop()
      .then(() => pool.end())
      .then(() => process.exit(0))
      .catch((error: unknown) => {
        console.error('wings-worker: error while shutting down', error);
        process.exit(1);
      });
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((error: unknown) => {
  console.error('wings-worker: fatal error at startup', error);
  process.exit(1);
});
