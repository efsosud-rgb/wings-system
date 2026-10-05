import { buildApp } from './app.js';
import { createDb } from './db/client.js';
import { loadDotEnv } from './db/load-env.js';
import { loadEnv } from './env.js';
import { createOpenRouterLlm } from './modules/agent/llm.js';
import { startFormatacaoIntakeScheduler } from './modules/expansion/formatacao.js';
import { startExpansionIntakeScheduler } from './modules/expansion/scheduler.js';
import { startInsightsScheduler } from './modules/insights/scheduler.js';
import { startCrmAutomationsScheduler } from './modules/leads/automations-scheduler.js';
import { createCrmMailTransport } from './modules/leads/crm-mail.js';
import { startMetaLeadgenIntake } from './modules/leads/meta-intake.js';

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

  // Expansion intake: off unless EXPANSION_INTAKE_ENABLED=true and both RD
  // products are configured. Registered before `listen`, like the one above.
  if (
    env.EXPANSION_INTAKE_ENABLED === 'true' &&
    env.RD_CRM_API_TOKEN &&
    env.RD_MKT_CLIENT_ID &&
    env.RD_MKT_CLIENT_SECRET &&
    env.RD_MKT_REFRESH_TOKEN
  ) {
    const stop = startExpansionIntakeScheduler({
      db,
      credentials: {
        expansionOwnerId: env.EXPANSION_OWNER_RD_USER_ID ?? null,
        rdCrmToken: env.RD_CRM_API_TOKEN,
        rdMarketing: {
          clientId: env.RD_MKT_CLIENT_ID,
          clientSecret: env.RD_MKT_CLIENT_SECRET,
          refreshToken: env.RD_MKT_REFRESH_TOKEN,
        },
      },
      log: (facts) => app.log.info(facts),
    });
    app.addHook('onClose', async () => stop());
  }

  // Formatação safety net: off unless FORMATACAO_INTAKE_ENABLED=true. Its own
  // switch, so the Expansão job above stays off while this one runs.
  if (
    env.FORMATACAO_INTAKE_ENABLED === 'true' &&
    env.RD_CRM_API_TOKEN &&
    env.RD_MKT_CLIENT_ID &&
    env.RD_MKT_CLIENT_SECRET &&
    env.RD_MKT_REFRESH_TOKEN
  ) {
    const stop = startFormatacaoIntakeScheduler({
      db,
      credentials: {
        rdCrmToken: env.RD_CRM_API_TOKEN,
        rdMarketing: {
          clientId: env.RD_MKT_CLIENT_ID,
          clientSecret: env.RD_MKT_CLIENT_SECRET,
          refreshToken: env.RD_MKT_REFRESH_TOKEN,
        },
      },
      dryRun: env.FORMATACAO_INTAKE_DRY_RUN === 'true',
      log: (facts) => app.log.info(facts),
    });
    app.addHook('onClose', async () => stop());
  }

  // Meta Lead Ads queue: runs whenever the webhook can receive (app secret
  // set). Without a leads token the events wait in the queue, not lost.
  if (env.META_APP_SECRET) {
    const intake = startMetaLeadgenIntake({
      db,
      accessToken: env.META_LEADS_ACCESS_TOKEN ?? env.META_WRITE_TOKEN ?? null,
      rdCrmToken: env.RD_CRM_API_TOKEN ?? null,
      expansionOwnerId: env.EXPANSION_OWNER_RD_USER_ID ?? null,
      rdCopyEnabled: env.META_LEADS_RD_COPY_ENABLED !== 'false',
      log: (facts) => app.log.info(facts),
    });
    app.wings.metaLeadKick = intake.kick;
    app.addHook('onClose', async () => intake.stop());
  }

  // CRM automations: due rules and sequence steps, then the deadline alerts,
  // every CRM_AUTOMATIONS_CRON minutes (5 by default). Registered before `listen`.
  {
    const stop = startCrmAutomationsScheduler({
      db,
      mail: createCrmMailTransport(env),
      cron: env.CRM_AUTOMATIONS_CRON,
      stageStuckDays: env.CRM_STAGE_STUCK_DAYS === undefined ? 7 : Number(env.CRM_STAGE_STUCK_DAYS),
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
