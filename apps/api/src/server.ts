import { buildApp } from './app.js';
import { createDb } from './db/client.js';
import { loadDotEnv } from './db/load-env.js';
import { loadEnv } from './env.js';
import { createOpenRouterLlm } from './modules/agent/llm.js';
import { startInsightsScheduler } from './modules/insights/scheduler.js';

async function main() {
  loadDotEnv();
  const env = loadEnv();
  const { db } = createDb(env.DATABASE_URL);
  const app = await buildApp({ env, db });

  // Monday's insights and campaign suggestions. Only the server process
  // starts it, and only with a model to call: tests never do either. Hooks
  // must be registered before `listen`: Fastify refuses them afterwards, and
  // on staging that refusal put the API in a restart loop.
  if (env.OPENROUTER_API_KEY) {
    const stop = startInsightsScheduler({
      db,
      llm: createOpenRouterLlm({ apiKey: env.OPENROUTER_API_KEY }),
      model: env.AGENT_MODEL,
      dailyLimitUsd: env.INSIGHTS_DAILY_USD,
      log: (facts) => app.log.info(facts),
    });
    app.addHook('onClose', async () => stop());
  }

  await app.listen({ port: env.API_PORT, host: '0.0.0.0' });
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
