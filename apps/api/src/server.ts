import { buildApp } from './app.js';
import { createDb } from './db/client.js';
import { loadDotEnv } from './db/load-env.js';
import { loadEnv } from './env.js';
import { storageOf } from './lib/storage/index.js';
import { createOpenRouterLlm } from './modules/agent/llm.js';
import { startFormatacaoIntakeScheduler } from './modules/expansion/formatacao.js';
import { startExpansionIntakeScheduler } from './modules/expansion/scheduler.js';
import { startInsightsScheduler } from './modules/insights/scheduler.js';
import { startCrmAutomationsScheduler } from './modules/leads/automations-scheduler.js';
import { startEmailRepliesScheduler } from './modules/leads/email-replies.js';
import { googleWorkspaceDepsOf } from './modules/google-workspace/service.js';
import { onLeadArrivedKick } from './modules/leads/crm-alerts.js';
import { createCrmMailTransport } from './modules/leads/crm-mail.js';
import { sendPendingNoticeMails } from './modules/leads/crm-notice-mail.js';
import { startMetaLeadgenIntake } from './modules/leads/meta-intake.js';
import { startInstagramHousekeeping } from './modules/prospect-ai/housekeeping.js';
import { startProspectingRetentionScheduler } from './modules/prospecting/retention.js';
import { startSofia } from './modules/sofia/engine.js';
import { whatsappConfigOf } from './modules/whatsapp/graph.js';
import { startWhatsAppIntake } from './modules/whatsapp/intake.js';
import { startWhatsAppMediaStore } from './modules/whatsapp/media-store.js';
import { numberConfigOf, numbersDepsOf } from './modules/whatsapp/numbers.js';
import { createSecretBox } from './lib/secret-box.js';
import { startYoutubeScheduler } from './modules/youtube/scheduler.js';

const pageIdsOf = (value: string | undefined) =>
  value
    ? value
        .split(',')
        .map((id) => id.trim())
        .filter(Boolean)
    : [];

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
  // The key alone is enough: with META_LEADS_ACCESS_TOKEN the loop also reads the
  // forms every 5 minutes, webhook or not (META_LEADS_POLL=false turns that off).
  if (env.META_APP_SECRET || env.META_LEADS_ACCESS_TOKEN) {
    const intake = startMetaLeadgenIntake({
      db,
      accessToken: env.META_LEADS_ACCESS_TOKEN ?? env.META_WRITE_TOKEN ?? null,
      rdCrmToken: env.RD_CRM_API_TOKEN ?? null,
      expansionOwnerId: env.EXPANSION_OWNER_RD_USER_ID ?? null,
      rdCopyEnabled: env.META_LEADS_RD_COPY_ENABLED !== 'false',
      log: (facts) => app.log.info(facts),
      poll: {
        enabled: Boolean(env.META_LEADS_ACCESS_TOKEN) && env.META_LEADS_POLL !== 'false',
        extraPageIds: pageIdsOf(env.META_LEADS_PAGE_IDS),
      },
    });
    app.wings.metaLeadKick = intake.kick;
    app.addHook('onClose', async () => intake.stop());
  }

  // WhatsApp (Cloud API) queue: runs whenever the webhook can receive. The
  // webhook stores each signed body; this reads them into the deals.
  if (env.WHATSAPP_APP_SECRET && env.WHATSAPP_WEBHOOK_VERIFY_TOKEN) {
    const whatsappConfig = whatsappConfigOf(env);
    const whatsappSend = whatsappConfig ? { config: whatsappConfig, fetch } : null;
    const intake = startWhatsAppIntake({
      db,
      phoneNumberId: env.WHATSAPP_PHONE_NUMBER_ID ?? null,
      wabaId: env.WHATSAPP_WABA_ID ?? null,
      log: (facts) => app.log.info(facts),
      send: whatsappSend,
      numbers: numbersDepsOf({ db, env }),
    });
    app.wings.whatsappKick = intake.kick;
    app.addHook('onClose', async () => intake.stop());

    // Sofia answers the conversations that are hers (docs/whatsapp/sofia.md).
    // Her on/off switch is on the screen; this loop only finds the due turns.
    const sofia = startSofia({
      db,
      llm: env.OPENROUTER_API_KEY ? createOpenRouterLlm({ apiKey: env.OPENROUTER_API_KEY }) : null,
      fetchImpl: fetch,
      config: whatsappConfigOf(env),
      dailyUsd: env.SOFIA_DAILY_USD,
      now: () => new Date(),
      log: (facts) => app.log.info(facts),
    });
    app.addHook('onClose', async () => sofia.stop());

    // Received files go to our storage, so they outlive Meta's 30 days (docs/whatsapp/cloud-api.md).
    const storage = storageOf(app.wings);
    const config = whatsappConfigOf(env);
    if (storage && config) {
      const box = env.INTEGRATIONS_ENCRYPTION_KEY
        ? createSecretBox(env.INTEGRATIONS_ENCRYPTION_KEY)
        : null;
      const files = startWhatsAppMediaStore({
        db,
        storage,
        config,
        numberConfig: (numberId) => numberConfigOf(db, box, numberId),
        fetchImpl: fetch,
        log: (facts) => app.log.info(facts),
      });
      app.addHook('onClose', async () => files.stop());
    }
  }

  // CRM automations: due rules and sequence steps, then the deadline alerts, then
  // the owners' notice e-mails, every CRM_AUTOMATIONS_CRON minutes (5 by default).
  // Registered before `listen`. A new lead's e-mail does not wait for the cycle:
  // the arrival kicks one pass of the e-mail step on its own.
  {
    const log = (facts: Record<string, unknown>) => app.log.info(facts);
    const noticeMail = {
      mailer: app.wings.mailer,
      enabled: env.CRM_NOTICE_EMAIL_ENABLED === 'true',
      escalationEnabled: env.CRM_ESCALATION_EMAIL_ENABLED === 'true',
      baseUrl: env.APP_BASE_URL,
      log,
    };
    const stop = startCrmAutomationsScheduler({
      db,
      mail: createCrmMailTransport(env),
      cron: env.CRM_AUTOMATIONS_CRON,
      stageStuckDays: env.CRM_STAGE_STUCK_DAYS === undefined ? 7 : Number(env.CRM_STAGE_STUCK_DAYS),
      noticeMail,
      log,
    });
    onLeadArrivedKick(() => {
      sendPendingNoticeMails(db, noticeMail).catch((error: unknown) => {
        log({
          job: 'crm-notice-mail',
          error: error instanceof Error ? error.name : 'unknown',
        });
      });
    });
    app.addHook('onClose', async () => {
      onLeadArrivedKick(null);
      stop();
    });
  }

  // The leads' e-mail replies from the sellers' Gmail (docs/crm/automacoes.md "E-mail recebido"):
  // every 5 minutes, only with CRM_EMAIL_REPLIES_ENABLED=true and the Google client configured.
  const google = googleWorkspaceDepsOf(app.wings);
  if (env.CRM_EMAIL_REPLIES_ENABLED === 'true' && google) {
    const stop = startEmailRepliesScheduler({
      db,
      google,
      storage: storageOf(app.wings),
      maxFileBytes: env.DRIVE_MAX_FILE_BYTES,
      minutes: 5,
      log: (facts) => app.log.info(facts),
    });
    app.addHook('onClose', async () => stop());
  }

  // Prospecção: expired reservations back to free, old enrichment cleared, every
  // 6 hours (docs/crm/prospeccao.md). Our own data only: no call to Google.
  {
    const stop = startProspectingRetentionScheduler({
      db,
      log: (facts) => app.log.info(facts),
    });
    app.addHook('onClose', async () => stop());
  }

  // Prospecção Instagram (docs/prospeccao/instagram-meta-lgpd.md §8.4): a prospect that did not
  // become a lead in 30 days is deleted with its comments, every hour. Runs even with the paste off.
  {
    const stop = startInstagramHousekeeping({ db, log: (facts) => app.log.info(facts) });
    app.addHook('onClose', async () => stop());
  }

  // YouTube channel (public data, docs/integracoes/youtube-data-api.md): one
  // reading a day at YOUTUBE_INGEST_CRON (07:00 by default). Off without a key.
  if (env.YOUTUBE_API_KEY) {
    const stop = startYoutubeScheduler({
      db,
      apiKey: env.YOUTUBE_API_KEY,
      channelEnv: env.YOUTUBE_CHANNEL_ID,
      cron: env.YOUTUBE_INGEST_CRON,
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
