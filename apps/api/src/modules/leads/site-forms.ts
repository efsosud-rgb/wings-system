import {
  instagramUsernameOf,
  LEAD_PIPELINES,
  normalizeBrazilianPhone,
  siteFormCopyOf,
  siteFormSpecSchema,
  siteFormSubmitSchema,
  whatsappLinkOf,
  type LeadPipeline,
  type SiteFormInfo,
  type SiteFormPublicSpec,
  type SiteFormQualifierValue,
  type SiteFormSpec,
  type SiteFormSubmitInput,
} from '@wings/shared';
import { attachFormRef } from './form-ref.js';
import { enqueueInstagramCheck, hasInstagramToCheck } from './instagram-check.js';
import { and, desc, eq } from 'drizzle-orm';
import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { Database } from '../../db/client.js';
import { clients, leadSourceRules, leadTrackingLinks } from '../../db/schema/index.js';
import { writeAudit } from '../../lib/audit.js';
import { RdMarketing } from '../expansion/rd.js';
import { shapeOf } from '../media/kairogen-adapter.js';
import { rdAttributionOf } from './rd-attribution.js';
import { brandOfLink, resolveLandingPage, upsertLead, type ClientResolution } from './service.js';
import { leadTriageEnabled } from './triage-schedule.js';

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
  ref: string | null = null,
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
  return link ? whatsappLinkOf(wingsNumber, link.code, brandOfLink(client), ref) : null;
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
      clientId: leadSourceRules.clientId,
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
function liveSiteForm(spec: unknown): SiteFormSpec | null {
  const parsed = siteFormSpecSchema.safeParse(spec);
  return parsed.success ? parsed.data : null;
}

/** The approved form as the public page reads it: the options' codes, never the funnel each one leads to. */
export function publicSiteForm(spec: SiteFormSpec | null): SiteFormPublicSpec | null {
  if (!spec) return null;
  const { qualifierValues, requiredFields = [], ...form } = spec;
  return qualifierValues?.length
    ? {
        ...form,
        requiredFields,
        qualifierValues: qualifierValues.map(({ value, option }) => ({ value, option })),
      }
    : { ...form, requiredFields };
}

/**
 * The multiple-choice answer, only when the page asks the question and the
 * answer is one of its options: the option's code when the spec lists codes
 * (the option's text names the same code, as the `/lp/<slug>` page sends it),
 * else the option's text.
 */
function qualifierChoiceOf(
  form: SiteFormSpec | null,
  answer: string | undefined,
): { option: string; code: SiteFormQualifierValue | null } | null {
  if (!form?.qualifier || !answer) return null;
  if (form.qualifierValues?.length) {
    const code =
      form.qualifierValues.find((entry) => entry.value === answer) ??
      form.qualifierValues.find((entry) => entry.option === answer);
    return code ? { option: code.option, code } : null;
  }
  return form.qualifier.options.includes(answer) ? { option: answer, code: null } : null;
}

export const INSTAGRAM_REQUIRED_MESSAGE =
  'Informe o @ do Instagram da marca (só letras, números, ponto e sublinhado).';

export type SiteFormAnswers =
  | {
      ok: true;
      /** The Instagram to keep: only the username when the page requires it, else as typed. */
      instagram: string | undefined;
      /** The multiple-choice answer under the question's text, as the option's text. */
      formAnswers: Record<string, string> | null;
      /** The chosen option's code, with the funnel it leads to when it names one. */
      choice: SiteFormQualifierValue | null;
    }
  | { ok: false; message: string };

/**
 * What the page's approved form asks of a submission (`requiredFields`), checked
 * after the body's own schema; a page without a form asks nothing more.
 */
export function siteFormAnswersOf(
  form: SiteFormSpec | null,
  body: SiteFormSubmitInput,
): SiteFormAnswers {
  const required = new Set(form?.requiredFields ?? []);
  const refuse = (message: string) => ({ ok: false as const, message });
  const missing = (value: string | undefined) => !value?.trim();
  if (required.has('email') && missing(body.email)) return refuse('Informe o seu e-mail.');
  if (required.has('companyName') && missing(body.companyName)) {
    return refuse('Informe o nome da empresa.');
  }
  let instagram = body.instagram;
  if (required.has('instagram')) {
    const username = instagramUsernameOf(body.instagram);
    if (!username) return refuse(INSTAGRAM_REQUIRED_MESSAGE);
    instagram = username;
  }
  if (required.has('siteUrl') && missing(body.siteUrl)) return refuse('Informe o site da empresa.');
  const choice = qualifierChoiceOf(form, body.qualifierAnswer);
  if (required.has('qualifierAnswer') && form?.qualifier && !choice) {
    return refuse(`Escolha uma opção em "${form.qualifier.question}".`);
  }
  return {
    ok: true,
    instagram,
    formAnswers: choice && form?.qualifier ? { [form.qualifier.question]: choice.option } : null,
    choice: choice?.code ?? null,
  };
}

/**
 * The funnel the lead goes to: the page's own, unless the chosen option names
 * another. "None" (null, the Jev triage decides) only while the triage is on:
 * off, nobody would ever give the lead a funnel, so it keeps the page's.
 * Expansão only for a page tied to a brand: without one, nobody would know
 * which franchise the lead wants, so it keeps the page's too.
 */
export function answerPipelineOf(
  choice: SiteFormQualifierValue | null,
  page: Pick<ClientResolution, 'pipeline' | 'brand'>,
  triageOn: boolean,
): LeadPipeline | null {
  const override = choice?.pipeline;
  if (override === undefined) return page.pipeline;
  if (override === null) return triageOn ? null : page.pipeline;
  if (override === 'expansao' && !page.brand) return page.pipeline;
  return override;
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
  const publicForm = app.publicRoute('landing page form, Turnstile and rate limit');
  const { db, env } = app.wings;

  app.get(
    '/public/site-forms/:slug',
    { preHandler: publicForm, config: { rateLimit: { max: 120, timeWindow: '1 minute' } } },
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
        form: publicSiteForm(liveSiteForm(page.siteFormSpec)),
        pipeline: pipelineOf(page.pipeline),
        // The same tracked link the POST answers, for a page that offers it before the form.
        whatsappUrl: page.clientId
          ? await siteWhatsappUrl(db, page.clientId, true, env.WINGS_WHATSAPP_NUMBER)
          : null,
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
    { preHandler: publicForm, config: { rateLimit: { max: 10, timeWindow: '10 minutes' } } },
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
        return reply.send({ ok: true, whatsappUrl: null });
      }
      // What the page's approved form makes required, checked before the captcha spends its token.
      const liveForm = liveSiteForm(page.siteFormSpec);
      const answers = siteFormAnswersOf(liveForm, body.data);
      if (!answers.ok) {
        return reply.status(400).send({ error: 'invalid_request', message: answers.message });
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
      // The chosen option may send the lead to another funnel, or to none (the Jev triage decides).
      const pipeline = answerPipelineOf(answers.choice, client, leadTriageEnabled());
      const now = new Date();
      // The consent line the page showed: its own when the spec names one, else the funnel's
      // (the rule is the same one the page read).
      const consentText =
        liveForm?.consentText ??
        siteFormCopyOf(pipelineOf(page.pipeline), page.clientName ?? page.brand ?? 'Wings Company')
          .consentText;
      const result = await upsertLead(db, {
        source: 'site_form',
        enteredAt: new Date(),
        enteredAtSource: 'form_submitted',
        name: body.data.name,
        email: body.data.email ?? null,
        phone,
        clientId: client.clientId,
        clientMapped: client.mapped,
        pipeline,
        brand: client.brand,
        channel: 'landing_page',
        landingPage: page.pattern,
        fields: {
          instagram: answers.instagram,
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
        formAnswers: answers.formAnswers,
        // Paid research only when Eric turns it on for the site form (off by default).
        skipResearch: env.SITE_FORM_RESEARCH_ENABLED !== 'true',
        event: {
          kind: 'lead.received.site_form',
          detail: {
            ruleId: client.ruleId,
            pipeline,
            qualifier: answers.choice?.value ?? null,
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
          pipeline,
          hasAttribution: attribution !== null,
          rdForward,
        },
      });
      // The form's reference in the WhatsApp text, and the Instagram check; neither may fail the
      // form: the lead already exists, and the person is not told about either.
      const formRef = await attachFormRef(db, result.lead.id).catch(() => null);
      if (env.INSTAGRAM_CHECK_ENABLED === 'true' && hasInstagramToCheck(body.data.instagram)) {
        await enqueueInstagramCheck(db, result.lead.id, null).catch(() =>
          app.log.warn({ msg: 'instagram check not queued', leadId: result.lead.id }),
        );
      }
      const whatsappUrl = await siteWhatsappUrl(
        db,
        client.clientId,
        client.mapped,
        env.WINGS_WHATSAPP_NUMBER,
        formRef,
      );
      return reply.send({ ok: true, whatsappUrl });
    },
  );
};
