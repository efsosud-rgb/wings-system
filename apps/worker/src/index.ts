import { tmpdir } from 'node:os';
import { runFfmpeg, runFfprobe, runWhisper } from './lib/commands.js';
import { createBraveSearch, createBrasilApi, createZapiProfileClient } from './lib/enrichment.js';
import { createLeadResearchProvider } from './lib/lead-research.js';
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

  // Shapes only (key names and numbers): these answers carry a person's name.
  const log = (facts: Record<string, unknown>) => console.warn(JSON.stringify({ worker: 'enrich_lead', ...facts }));
  const zapi =
    env.ZAPI_INSTANCE_ID && env.ZAPI_INSTANCE_TOKEN && env.ZAPI_CLIENT_TOKEN
      ? createZapiProfileClient({
          instanceId: env.ZAPI_INSTANCE_ID,
          instanceToken: env.ZAPI_INSTANCE_TOKEN,
          clientToken: env.ZAPI_CLIENT_TOKEN,
          log,
        })
      : null;
  const search = env.BRAVE_SEARCH_API_KEY ? createBraveSearch({ apiKey: env.BRAVE_SEARCH_API_KEY, log }) : null;
  const research = createLeadResearchProvider({
    enabled: env.LEAD_RESEARCH_ENABLED === 'true',
    apiKey: env.OPENROUTER_API_KEY,
    model: env.LEAD_RESEARCH_MODEL,
    reserveUsd: env.LEAD_RESEARCH_USD_PER_CALL,
    log,
  });
  console.warn(
    `wings-worker: enrich_lead with zapi=${zapi ? 'on' : 'off'}, search=${search ? 'brave' : 'off'}, ceiling US$ ${env.ENRICH_DAILY_USD}/day; company research=${research ? `openrouter (${env.LEAD_RESEARCH_MODEL})` : 'off'}, ceiling US$ ${env.LEAD_RESEARCH_DAILY_USD}/day, leads from ${env.LEAD_RESEARCH_SINCE}`,
  );

  const stop = runWorker(
    pool,
    {
      storage,
      threadsPerJob: threads,
      runFfprobe,
      runWhisper,
      runFfmpeg,
      renderLimits: {
        maxSeconds: env.RENDER_MAX_SECONDS,
        timeoutSeconds: env.RENDER_TIMEOUT_SECONDS,
        maxInputBytes: env.RENDER_MAX_INPUT_BYTES,
        tmpDir: env.RENDER_TMP_DIR ?? tmpdir(),
      },
      db: pool,
      enrichment: {
        zapi,
        search,
        cnpj: createBrasilApi({ baseUrl: env.BRASILAPI_BASE_URL, log }),
        budget: {
          dailyUsd: env.ENRICH_DAILY_USD,
          searchUsdPerQuery: env.ENRICH_SEARCH_USD_PER_QUERY,
          researchDailyUsd: env.LEAD_RESEARCH_DAILY_USD,
        },
        research,
        // 00:00 of that day in São Paulo (UTC-3, no DST since 2019).
        researchSince: new Date(`${env.LEAD_RESEARCH_SINCE}T03:00:00Z`),
      },
    },
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
