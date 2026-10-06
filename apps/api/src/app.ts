import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Database } from './db/client.js';
import type { Env } from './env.js';
import { createCpfCrypto, type CpfCrypto } from './lib/cpf-crypto.js';
import { createMailer, type Mailer } from './lib/mailer.js';
import { loggedUrl } from './lib/log-url.js';
import type { ObjectStorage } from './lib/storage/index.js';
import { authRoutes } from './modules/auth/routes.js';
import { audienceRoutes } from './modules/ads/audience-routes.js';
import { campaignLeadsRoutes } from './modules/ads/campaign-leads-routes.js';
import { cockpitRoutes } from './modules/ads/cockpit-routes.js';
import { creativeRoutes } from './modules/ads/creative-routes.js';
import { dashboardRoutes } from './modules/ads/dashboard/routes.js';
import { metaRoutes } from './modules/ads/meta-routes.js';
import { videoUploadRoutes } from './modules/ads/video-upload-routes.js';
import { adsRoutes } from './modules/ads/routes.js';
import { savedDraftRoutes } from './modules/ads/saved-draft-routes.js';
import type { AgentLlm } from './modules/agent/llm.js';
import { agentRoutes } from './modules/agent/routes.js';
import { clientRecordRoutes } from './modules/clients/record-routes.js';
import { clientRoutes } from './modules/clients/routes.js';
import { insightsRoutes } from './modules/insights/routes.js';
import { driveBlobRoutes, driveRoutes } from './modules/drive/routes.js';
import { expansionRecoveryRoutes } from './modules/expansion/recovery.js';
import { expansionRoutes } from './modules/expansion/routes.js';
import { kairogenRoutes } from './modules/integrations/kairogen/routes.js';
import { landingPageRoutes } from './modules/leads/landing-pages.js';
import { rdUserRoutes } from './modules/leads/rd-users.js';
import { configureCrm, onStageEnteredHook } from './modules/leads/crm.js';
import { onStageEntered } from './modules/leads/automations.js';
import { createCrmMailTransport } from './modules/leads/crm-mail.js';
import { crmRoutes } from './modules/leads/crm-routes.js';
import { automationRoutes } from './modules/leads/automation-routes.js';
import { leadEmailRoutes } from './modules/leads/lead-email-routes.js';
import { leadFilesRoutes } from './modules/leads/lead-files-routes.js';
import { nucleoRoutes } from './modules/leads/nucleo-routes.js';
import { leadRoutes } from './modules/leads/routes.js';
import { siteFormRoutes } from './modules/leads/site-forms.js';
import { leadWebhookRoutes } from './modules/leads/webhooks.js';
import { mediaRoutes } from './modules/media/routes.js';
import { mediaStudioRoutes } from './modules/media/studio-routes.js';
import { projectRoutes } from './modules/projects/routes.js';
import { createRegistryLookup } from './modules/clients/lookup.js';
import {
  configureLeadChecks,
  createInstagramDiscovery,
  type LeadCheckDeps,
} from './modules/leads/field-checks.js';
import { probePublicUrl } from './lib/public-probe.js';
import { officeRoutes } from './modules/office/routes.js';
import { roadmapRoutes } from './modules/roadmap/routes.js';
import { siteRoutes } from './modules/site/routes.js';
import { studioRoutes } from './modules/studio/routes.js';
import { employeeRoutes } from './modules/employees/routes.js';
import { authPlugin } from './plugins/auth.js';

declare module 'fastify' {
  interface FastifyInstance {
    wings: {
      env: Env;
      db: Database;
      mailer: Mailer;
      cpfCrypto: CpfCrypto;
      /** Set only by tests, so no test ever reaches a real ad platform. */
      platformFetch?: typeof fetch;
      /** Set by the server once the Meta Lead Ads queue runs: the webhook pokes it after storing an event. */
      metaLeadKick?: () => void;
      /** Set only by tests, so no test ever reaches OpenRouter. */
      agentLlm?: AgentLlm;
      /** Set only by tests, so no test ever reaches Kairogen. */
      kairogenFetch?: typeof fetch;
      /** Set only by tests, so no test ever reaches another media provider. */
      mediaFetch?: typeof fetch;
      /** Set only by tests, so no test ever reaches a real bucket. */
      storageFetch?: typeof fetch;
      /** Set only by tests, so no test ever reaches RD Station. */
      rdFetch?: typeof fetch;
      /** Set only by tests, so no test ever reaches BrasilAPI, ReceitaWS or ViaCEP. */
      registryFetch?: typeof fetch;
      /** Set only by tests, so no test ever reaches Cloudflare Turnstile. */
      captchaFetch?: typeof fetch;
      storage?: ObjectStorage;
      /** Set only by tests, so a screen that reasons about "today" can be pinned to a day. */
      now?: () => Date;
    };
  }
}

const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export async function buildApp(deps: {
  env: Env;
  db: Database;
  /** Overridable so tests can capture messages instead of sending them. */
  mailer?: Mailer;
  /** Overridable so tests never reach a real WordPress site. */
  wordpressFetch?: typeof fetch;
  /** Overridable so tests never reach Meta or Google. */
  platformFetch?: typeof fetch;
  /** Overridable so tests script the language model instead of calling it. */
  agentLlm?: AgentLlm;
  /** Overridable so tests talk to a simulated Kairogen. */
  kairogenFetch?: typeof fetch;
  /** Overridable so tests never reach RD Station. */
  rdFetch?: typeof fetch;
  /** Overridable so tests talk to simulated media providers. */
  mediaFetch?: typeof fetch;
  storageFetch?: typeof fetch;
  /** Overridable so tests answer CNPJ and CEP lookups themselves. */
  registryFetch?: typeof fetch;
  /** Arrival checks of a lead's form fields; tests pass stubs, or get none at all. */
  leadChecks?: Partial<LeadCheckDeps>;
  /** Overridable so tests answer Turnstile themselves. */
  captchaFetch?: typeof fetch;
  storage?: ObjectStorage;
  /** Overridable so tests pin the dashboard's "today". */
  now?: () => Date;
}): Promise<FastifyInstance> {
  const app = Fastify({
    // Personal data must never reach the logs (LGPD), so request bodies are
    // never logged and only a minimal request line is kept, without the query
    // string (a webhook secret may travel there).
    logger: {
      level: deps.env.NODE_ENV === 'test' ? 'silent' : 'info',
      redact: ['req.headers.cookie', 'req.headers.authorization'],
      serializers: {
        req(request) {
          return { method: request.method, url: loggedUrl(request.url), ip: request.ip };
        },
      },
    },
    // Behind Traefik: needed for real client IPs in the audit log.
    trustProxy: true,
  });

  if (deps.env.CRM_FIRST_CONTACT_SLA_HOURS) {
    configureCrm({ firstContactSlaHours: Number(deps.env.CRM_FIRST_CONTACT_SLA_HOURS) });
  }
  // Lead arrival checks (docs/leads/formularios.md). Off in tests unless a test brings its stubs.
  {
    const env = deps.env;
    const log = app.log.child({ module: 'lead-checks' });
    const online = env.LEAD_CHECKS_ENABLED !== 'false';
    const registry = createRegistryLookup({ fetch: deps.registryFetch, log });
    const now = () => deps.now?.() ?? new Date();
    configureLeadChecks(
      deps.db,
      env.NODE_ENV === 'test' && !deps.leadChecks
        ? null
        : {
            probe: deps.leadChecks?.probe ?? (online ? probePublicUrl : null),
            instagram:
              deps.leadChecks?.instagram ??
              (online && env.INSTAGRAM_DISCOVERY_ACCOUNT_ID && env.INSTAGRAM_DISCOVERY_TOKEN
                ? createInstagramDiscovery({
                    accountId: env.INSTAGRAM_DISCOVERY_ACCOUNT_ID,
                    token: env.INSTAGRAM_DISCOVERY_TOKEN,
                    now,
                    log,
                  })
                : null),
            cnpj: deps.leadChecks?.cnpj ?? (online ? (cnpj) => registry.cnpj(cnpj) : null),
            now,
            log,
          },
    );
  }
  // Regras de automação: a deal entering a stage starts that stage's rules.
  const crmMail = createCrmMailTransport(deps.env);
  onStageEnteredHook(async (lead) => {
    await onStageEntered(deps.db, lead, { mail: crmMail });
  });

  app.decorate('wings', {
    env: deps.env,
    db: deps.db,
    platformFetch: deps.platformFetch,
    agentLlm: deps.agentLlm,
    kairogenFetch: deps.kairogenFetch,
    rdFetch: deps.rdFetch,
    mediaFetch: deps.mediaFetch,
    storageFetch: deps.storageFetch,
    registryFetch: deps.registryFetch,
    captchaFetch: deps.captchaFetch,
    storage: deps.storage,
    now: deps.now,
    mailer: deps.mailer ?? createMailer(deps.env, { info: (msg) => app.log.info(msg) }),
    cpfCrypto: createCpfCrypto(deps.env.CPF_ENCRYPTION_KEY, deps.env.CPF_INDEX_KEY),
  });

  await app.register(cookie, { secret: deps.env.SESSION_SECRET });
  await app.register(rateLimit, { global: false });
  await app.register(authPlugin);

  /**
   * CSRF defence. SameSite=Lax already blocks cross-site cookie sends for these
   * methods; this rejects anything that still arrives with a foreign Origin.
   * Requests without a session cookie are left alone (login itself needs to work
   * from the login page, which does send an Origin).
   */
  app.addHook('onRequest', async (request, reply) => {
    if (!UNSAFE_METHODS.has(request.method)) return;
    const origin = request.headers.origin;
    if (!origin) return;

    const host =
      (request.headers['x-forwarded-host'] as string | undefined) ?? request.headers.host;
    let originHost: string;
    try {
      originHost = new URL(origin).host;
    } catch {
      return reply.status(403).send({ error: 'bad_origin', message: 'Origem inválida' });
    }
    if (host && originHost !== host) {
      return reply.status(403).send({ error: 'bad_origin', message: 'Origem inválida' });
    }
  });

  // Routes are registered WITHOUT the /api prefix: Traefik strips it before
  // forwarding and the Vite dev proxy rewrites the same way.
  app.get('/health', async () => ({
    status: 'ok',
    service: 'wings-system-api',
    time: new Date().toISOString(),
  }));

  await app.register(authRoutes);
  await app.register(employeeRoutes);
  await app.register(adsRoutes);
  await app.register(savedDraftRoutes);
  await app.register(cockpitRoutes);
  await app.register(dashboardRoutes);
  await app.register(campaignLeadsRoutes);
  await app.register(creativeRoutes);
  await app.register(audienceRoutes);
  await app.register(agentRoutes);
  await app.register(insightsRoutes);
  await app.register(clientRoutes);
  await app.register(clientRecordRoutes);
  await app.register(projectRoutes);
  await app.register(roadmapRoutes);
  await app.register(officeRoutes);
  await app.register(leadRoutes);
  await app.register(crmRoutes);
  await app.register(automationRoutes);
  await app.register(leadEmailRoutes);
  await app.register(nucleoRoutes);
  await app.register(leadFilesRoutes);
  await app.register(rdUserRoutes);
  await app.register(landingPageRoutes);
  await app.register(leadWebhookRoutes);
  await app.register(siteFormRoutes);
  await app.register(driveRoutes);
  await app.register(driveBlobRoutes);
  await app.register(kairogenRoutes);
  await app.register(expansionRoutes);
  await app.register(expansionRecoveryRoutes);
  await app.register(mediaRoutes);
  await app.register(mediaStudioRoutes);
  await app.register(studioRoutes);
  await app.register(metaRoutes);
  await app.register(videoUploadRoutes);
  await app.register(siteRoutes, { wordpressFetch: deps.wordpressFetch });

  return app;
}
