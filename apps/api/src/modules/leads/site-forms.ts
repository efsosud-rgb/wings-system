import {
  LEAD_PIPELINES,
  normalizeBrazilianPhone,
  siteFormCopyOf,
  siteFormSpecSchema,
  siteFormSubmitSchema,
  whatsappLinkOf,
  type LeadPipeline,
  type SiteFormInfo,
} from '@wings/shared';
import { and, desc, eq } from 'drizzle-orm';
import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { Database } from '../../db/client.js';
import { clients, leadSourceRules, leadTrackingLinks } from '../../db/schema/index.js';
import { writeAudit } from '../../lib/audit.js';
import { RdMarketing } from '../expansion/rd.js';
import { shapeOf } from '../media/kairogen-adapter.js';
import { rdAttributionOf } from './rd-attribution.js';
import { brandOfLink, resolveLandingPage, upsertLead } from './service.js';

/**
 * The site form (CRM phase 1, T5): the Wings System's own form on a landing
 * page, `/lp/<slug>`, for the pages CRM Vendas → Landing pages turned it on.
 * Public, no session. In front of every write: Cloudflare Turnstile checked on
 * the server, a honeypot field and a per-IP limit. The lead lands in the
 * page's client and funnel (Expansão for the brands) with the same first-touch
 * attribution as the RD webhook (T4): UTMs, click ids and ad ids, read from
 * the hidden fields the page collected and from the page's own address.
 *
 * Personal data (name, e-mail, phone) goes into `leads` and nowhere else: the
 * log keeps the body's shape, the audit keeps ids and flags.
 *
 * Sending the conversion on to RD Marketing is a write to RD, so it is off
 * unless SITE_FORM_RD_FORWARD_ENABLED is "true" (Eric's to turn on); then it
 * is one call, never retried.
 */

/**
 * The brand's tracked "Site" link the page opens after the form (T6), or null.
 * It opens the Wings WhatsApp, where Sofia answers every Expansão lead, with
 * the brand in the text; never the brand's own number. Only a page tied to a
 * brand, only a link made for the current Wings number; nothing is created here.
 */
export async function siteWhatsappUrl(
  db: Database,
  clientId: string,
  mapped: boolean,
  wingsNumber: string | undefined,
): Promise<string | null> {
  if (!mapped || !wingsNumber) return null;
  const client = await db.query.clients.findFirst({ where: eq(clients.id, clientId) });
  if (!client?.active) return null;
  const [link] = await db
    .select({ code: leadTrackingLinks.code })
    .from(leadTrackingLinks)
    .where(
      and(
        eq(leadTrackingLinks.clientId, clientId),
        eq(leadTrackingLinks.channel, 'site'),
        eq(leadTrackingLinks.phone, wingsNumber),
      ),
    )
    .orderBy(desc(leadTrackingLinks.createdAt))
    .limit(1);
  return link ? whatsappLinkOf(wingsNumber, link.code, brandOfLink(client)) : null;
}

/** `@perfil` from what the record keeps (`@perfil`, `perfil` or an instagram.com address), or null. */
export function instagramHandleOf(value: string | null | undefined): string | null {
  const handle = (value ?? '')
    .trim()
    .replace(/^https?:\/\/(www\.)?instagram\.com\//i, '')
    .replace(/^@/, '')
    .replace(/[/?#].*$/, '');
  return /^[A-Za-z0-9._]{1,30}$/.test(handle) ? `@${handle}` : null;
}

const TURNSTILE_VERIFY = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

const slugParam = z.object({ slug: z.string().trim().min(1).max(80) });

/** The page, when it exists, is active and takes the form; anything else is one 404. */
async function formPage(db: Database, slug: string) {
  const [row] = await db
    .select({
      id: leadSourceRules.id,
      pattern: leadSourceRules.pattern,
      brand: leadSourceRules.brand,
      pipeline: leadSourceRules.pipeline,
      clientName: clients.name,
      social: clients.social,
      siteFormSpec: leadSourceRules.siteFormSpec,
    })
    .from(leadSourceRules)
    .leftJoin(clients, eq(clients.id, leadSourceRules.clientId))
    .where(
      and(
        eq(leadSourceRules.kind, 'landing_page'),
        eq(leadSourceRules.pattern, slug.toLowerCase()),
        eq(leadSourceRules.active, true),
        eq(leadSourceRules.siteFormEnabled, true),
      ),
    )
    .limit(1);
  return row ?? null;
}

type CaptchaOutcome = 'ok' | 'refused' | 'unavailable';

async function verifyTurnstile(
  fetchImpl: typeof fetch,
  secret: string,
  token: string,
  ip: string,
): Promise<{ outcome: CaptchaOutcome; codes: string[] }> {
  try {
    const response = await fetchImpl(TURNSTILE_VERIFY, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ secret, response: token, remoteip: ip }).toString(),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return { outcome: 'unavailable', codes: [`http_${response.status}`] };
    const body = (await response.json()) as { success?: boolean; 'error-codes'?: unknown };
    const codes = Array.isArray(body['error-codes'])
      ? body['error-codes'].filter((code): code is string => typeof code === 'string').slice(0, 5)
      : [];
    return { outcome: body.success === true ? 'ok' : 'refused', codes };
  } catch {
    return { outcome: 'unavailable', codes: ['network'] };
  }
}

/** The page's approved standard form, or null when it shows the plain one. */
function liveSiteForm(spec: unknown): SiteFormInfo['form'] {
  const parsed = siteFormSpecSchema.safeParse(spec);
  return parsed.success ? parsed.data : null;
}

/** The multiple-choice answer only when the page asks the question and the answer is one of its options. */
function qualifierAnswerOf(
  spec: unknown,
  answer: string | undefined,
): Record<string, string> | null {
  const form = liveSiteForm(spec);
  if (!form?.qualifier || !answer) return null;
  if (!form.qualifier.options.includes(answer)) return null;
  return { [form.qualifier.question]: answer };
}

/** The rule's funnel, when it names one. */
function pipelineOf(value: string | null): LeadPipeline | null {
  return (LEAD_PIPELINES as readonly string[]).includes(value ?? '')
    ? (value as LeadPipeline)
    : null;
}

const notFound = (reply: FastifyReply) =>
  reply.status(404).send({ error: 'not_found', message: 'Formulário não encontrado.' });

export const siteFormRoutes: FastifyPluginAsync = async (app) => {
  const { db, env } = app.wings;

  app.get(
    '/public/site-forms/:slug',
    { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const params = slugParam.safeParse(request.params);
      if (!params.success) return notFound(reply);
      const page = await formPage(db, params.data.slug);
      if (!page) return notFound(reply);
      return reply.send({
        slug: page.pattern,
        brand: page.clientName ?? page.brand ?? 'Wings Company',
        turnstileSiteKey: env.TURNSTILE_SITE_KEY ?? null,
        // The brand's own Instagram (T6); its WhatsApp is never shown here.
        instagram: instagramHandleOf(page.social?.instagram),
        // The standard form Diretoria approved for this page, if any.
        form: liveSiteForm(page.siteFormSpec),
        pipeline: pipelineOf(page.pipeline),
        // Public ids only; the page loads a tag only when its id is here.
        tracking: {
          metaPixelId: env.SITE_FORM_META_PIXEL_ENABLED === 'true' ? env.META_PIXEL_ID : null,
          googleAdsConversion: env.SITE_FORM_GOOGLE_ADS_CONVERSION ?? null,
        },
      } satisfies SiteFormInfo);
    },
  );

  app.post(
    '/public/site-forms/:slug',
    { config: { rateLimit: { max: 10, timeWindow: '10 minutes' } } },
    async (request, reply) => {
      const params = slugParam.safeParse(request.params);
      if (!params.success) return notFound(reply);
      const page = await formPage(db, params.data.slug);
      if (!page) return notFound(reply);
      if (!env.TURNSTILE_SECRET_KEY) {
        return reply.status(503).send({
          error: 'site_form_not_configured',
          message: 'O formulário ainda não está configurado.',
        });
      }

      const body = siteFormSubmitSchema.safeParse(request.body);
      app.log.info({
        msg: 'site form',
        slug: page.pattern,
        shape: shapeOf(request.body),
        valid: body.success,
      });
      if (!body.success) {
        return reply.status(400).send({
          error: 'invalid_request',
          message: body.error.issues[0]?.message ?? 'Dados inválidos',
        });
      }
      // A robot filled the field people never see: same answer as a success, nothing kept.
      if (body.data.website && body.data.website.trim().length > 0) {
        await writeAudit(db, {
          action: 'site_form.honeypot',
          entity: 'lead_source_rule',
          entityId: page.id,
          ip: request.ip,
          metadata: { slug: page.pattern },
        });
        return reply.send({ ok: true });
      }

      const captcha = await verifyTurnstile(
        app.wings.captchaFetch ?? fetch,
        env.TURNSTILE_SECRET_KEY,
        body.data.turnstileToken,
        request.ip,
      );
      if (captcha.outcome !== 'ok') {
        await writeAudit(db, {
          action: 'site_form.captcha_refused',
          entity: 'lead_source_rule',
          entityId: page.id,
          ip: request.ip,
          metadata: { slug: page.pattern, outcome: captcha.outcome, codes: captcha.codes },
        });
        return captcha.outcome === 'refused'
          ? reply.status(403).send({
              error: 'captcha_refused',
              message: 'Não foi possível confirmar que você não é um robô. Tente de novo.',
            })
          : reply.status(503).send({
              error: 'captcha_unavailable',
              message: 'A verificação está fora do ar agora. Tente de novo em instantes.',
            });
      }

      const phone = normalizeBrazilianPhone(body.data.phone);
      if (!phone) {
        return reply
          .status(400)
          .send({ error: 'invalid_request', message: 'Telefone com DDD inválido.' });
      }
      const pageUrl =
        body.data.page && /^https?:\/\//i.test(body.data.page) ? body.data.page : null;
      const attribution = rdAttributionOf({
        content: body.data.tracking ?? {},
        url: pageUrl,
        trafficSource: null,
      });
      const client = await resolveLandingPage(db, { identifier: page.pattern });
      const now = new Date();
      // The consent line the page showed is the funnel's (the rule is the same one the page read).
      const consentText = siteFormCopyOf(
        pipelineOf(page.pipeline),
        page.clientName ?? page.brand ?? 'Wings Company',
      ).consentText;
      const result = await upsertLead(db, {
        source: 'site_form',
        name: body.data.name,
        email: body.data.email ?? null,
        phone,
        clientId: client.clientId,
        clientMapped: client.mapped,
        pipeline: client.pipeline,
        brand: client.brand,
        channel: 'landing_page',
        landingPage: page.pattern,
        fields: {
          instagram: body.data.instagram,
          website: body.data.siteUrl,
          companyName: body.data.companyName,
          cnpj: body.data.cnpj,
        },
        attribution,
        legalBasis: 'consent',
        consentedAt: now,
        consentSource: `site_form:${page.pattern}`,
        consentText,
        // The page's optional multiple-choice answer, kept as a form answer
        // under the question's text; never read as a contact field.
        formAnswers: qualifierAnswerOf(page.siteFormSpec, body.data.qualifierAnswer),
        // Paid research only when Eric turns it on for the site form (off by default).
        skipResearch: env.SITE_FORM_RESEARCH_ENABLED !== 'true',
        event: {
          kind: 'lead.received.site_form',
          detail: {
            ruleId: client.ruleId,
            pipeline: client.pipeline,
            adPlatform: attribution?.adPlatform ?? null,
            hasUtm: Boolean(attribution?.utmSource || attribution?.utmCampaign),
          },
        },
      });

      // To RD Marketing, only when Eric turned it on: one call, never retried.
      // RD identifies a conversion by e-mail, which the standard form no longer asks: no e-mail, no copy.
      let rdForward: 'off' | 'not_configured' | 'no_email' | 'sent' | 'refused' | 'failed' = 'off';
      if (env.SITE_FORM_RD_FORWARD_ENABLED === 'true') {
        if (!env.RD_MKT_CLIENT_ID || !env.RD_MKT_CLIENT_SECRET || !env.RD_MKT_REFRESH_TOKEN) {
          rdForward = 'not_configured';
        } else if (!body.data.email) {
          rdForward = 'no_email';
        } else {
          try {
            const status = await new RdMarketing(
              {
                clientId: env.RD_MKT_CLIENT_ID,
                clientSecret: env.RD_MKT_CLIENT_SECRET,
                refreshToken: env.RD_MKT_REFRESH_TOKEN,
              },
              app.wings.rdFetch,
            ).sendConversion({
              identifier: page.pattern,
              name: body.data.name,
              email: body.data.email,
              phone,
              utmSource: attribution?.utmSource,
              utmMedium: attribution?.utmMedium,
              utmCampaign: attribution?.utmCampaign,
              utmTerm: attribution?.utmTerm,
            });
            rdForward = status >= 200 && status < 300 ? 'sent' : 'refused';
            app.log.info({ msg: 'site form rd forward', slug: page.pattern, status });
          } catch {
            rdForward = 'failed';
          }
        }
      }

      await writeAudit(db, {
        action: result.created ? 'lead.received' : 'lead.merged',
        entity: 'lead',
        entityId: result.lead.id,
        ip: request.ip,
        metadata: {
          source: 'site_form',
          slug: page.pattern,
          clientMapped: client.mapped,
          pipeline: client.pipeline,
          hasAttribution: attribution !== null,
          rdForward,
        },
      });
      const whatsappUrl = await siteWhatsappUrl(
        db,
        client.clientId,
        client.mapped,
        env.WINGS_WHATSAPP_NUMBER,
      );
      return reply.send({ ok: true, whatsappUrl });
    },
  );
};
