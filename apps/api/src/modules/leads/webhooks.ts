import {
  normalizeBrazilianPhone,
  trackingCodeOf,
  type LeadLegalBasis,
} from '@wings/shared';
import { googleLeadOf, ingestGoogleLead } from './google-leads.js';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { writeAudit } from '../../lib/audit.js';
import { linkIntakeDealToLead } from '../expansion/service.js';
import { tokensMatch } from '../../lib/tokens.js';
import { shapeOf } from '../media/kairogen-adapter.js';
import { enqueueMetaLeadgenEvents } from './meta-intake.js';
import { leadgenEventsOf, metaSignatureValid } from './meta-leads.js';
import { ingestTikTokLeads, secretMatches, tiktokLeadsIn } from './tiktok-leads.js';
import { rdAttributionOf } from './rd-attribution.js';
import { leadFromTrackedMessage } from './tracked-link.js';
import {
  resolveLandingPage,
  upsertLead,
  type LeadAttribution,
} from './service.js';

/**
 * Where leads come in from outside, with no session: RD Station conversions,
 * Z-API (WhatsApp) inbound messages and Meta Lead Ads. Three rules:
 *
 *  1. Nothing is accepted without the secret of that source; an unconfigured
 *     source answers 503, never a fake 200.
 *  2. Bodies are logged as shapes only (`shapeOf`): key names and numbers,
 *     never a name, e-mail, phone or message text.
 *  3. A retried delivery is the same lead (external id, then phone, then
 *     e-mail), so answering 200 is always safe.
 *
 * NOT verified live: the payload shapes of the three services follow their
 * published references and are read leniently (several field names each).
 * The shape log is how the real format gets checked on the first delivery.
 */

const rateLimit = { max: 300, timeWindow: '1 minute' };

/** The secret RD Station and Z-API send: a header, or `?secret=` in the URL they were given. */
function sharedSecretOk(request: FastifyRequest, expected: string): boolean {
  const header = request.headers['x-wings-webhook-secret'];
  const fromHeader = Array.isArray(header) ? header[0] : header;
  const fromQuery = (request.query as { secret?: unknown } | undefined)?.secret;
  const given = fromHeader ?? (typeof fromQuery === 'string' ? fromQuery : undefined);
  return typeof given === 'string' && tokensMatch(given, expected);
}

function parseJson(raw: unknown): unknown {
  if (Buffer.isBuffer(raw)) {
    try {
      return raw.length === 0 ? {} : JSON.parse(raw.toString('utf8'));
    } catch {
      return null;
    }
  }
  return raw ?? {};
}

const asString = (value: unknown): string | null =>
  typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : typeof value === 'number'
      ? String(value)
      : null;

const asDate = (value: unknown): Date | null => {
  if (typeof value === 'number') {
    const date = new Date(value > 1e12 ? value : value * 1000);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  if (typeof value === 'string') {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  return null;
};

// --- RD Station ------------------------------------------------------------------

interface RdConversion {
  attribution: LeadAttribution | null;
  externalId: string | null;
  name: string | null;
  email: string | null;
  phone: string | null;
  identifier: string | null;
  url: string | null;
  at: Date | null;
  legalBasis: LeadLegalBasis;
  legalBasisText: string;
}

/** The only event of the `contact` shape that is a landing-page conversion (RD spells it either way). */
const RD_CONVERTED_EVENT = 'webhook.converted';

/**
 * RD Station Marketing sends `{ leads: [...] }` (classic), or the webhook the RD screen
 * creates: `{ event_type, entity_type: 'CONTACT', event_identifier, contact: {...} }`, where
 * the contact carries no conversion and `event_identifier` names the form that converted.
 * Read leniently; a `contact` event that is not a conversion yields nothing.
 */
export function rdConversionsOf(body: unknown): RdConversion[] {
  const root = (body ?? {}) as Record<string, unknown>;
  const contact =
    root.contact && typeof root.contact === 'object' && !Array.isArray(root.contact)
      ? (root.contact as Record<string, unknown>)
      : null;
  const eventType = asString(root.event_type);
  const convertedEvent = eventType === null || eventType.toLowerCase() === RD_CONVERTED_EVENT;
  const eventIdentifier = convertedEvent ? asString(root.event_identifier) : null;
  const list = Array.isArray(root.leads)
    ? root.leads
    : contact
      ? convertedEvent
        ? [contact]
        : []
      : root.email || root.uuid
        ? [root]
        : [];
  const eventAt = asDate(root.event_timestamp);
  return list
    .filter((lead): lead is Record<string, unknown> => Boolean(lead && typeof lead === 'object'))
    .map((lead) => {
      const last = (lead.last_conversion ?? {}) as Record<string, unknown>;
      const content = (last.content ?? {}) as Record<string, unknown>;
      const bases = Array.isArray(lead.legal_bases)
        ? (lead.legal_bases as Record<string, unknown>[])
        : [];
      const granted = bases.find(
        (basis) => basis.status === 'granted' || basis.status === undefined,
      );
      const legalBasis: LeadLegalBasis =
        granted?.type === 'legitimate_interest' ? 'legitimate_interest' : 'consent';
      const url =
        asString(content.url) ??
        asString(content.conversion_url) ??
        asString(content.page_url) ??
        asString(last.url) ??
        asString(lead.landing_page_url);
      return {
        attribution: rdAttributionOf({
          content,
          url,
          trafficSource:
            asString(content.traffic_source) ??
            asString(last.traffic_source) ??
            asString(lead.traffic_source),
        }),
        externalId: asString(lead.uuid) ?? asString(lead.id),
        name: asString(lead.name),
        email: asString(lead.email),
        phone:
          asString(lead.mobile_phone) ??
          asString(lead.personal_phone) ??
          asString(lead.phone) ??
          asString(content.telefone) ??
          asString(content.celular),
        identifier:
          asString(content.conversion_identifier) ??
          asString(content.identificador) ??
          asString(lead.conversion_identifier) ??
          eventIdentifier,
        url,
        at:
          asDate(content.created_at) ??
          asDate(last.created_at) ??
          asDate(lead.created_at) ??
          eventAt,
        legalBasis,
        legalBasisText:
          legalBasis === 'consent'
            ? 'Formulário da landing page (RD Station), com aceite dos termos na conversão.'
            : 'Base legal informada pelo RD Station: legítimo interesse.',
      };
    });
}

// --- Z-API ---------------------------------------------------------------------------

interface ZapiInbound {
  phone: string | null;
  text: string | null;
  senderName: string | null;
  senderPhoto: string | null;
  at: Date | null;
  fromMe: boolean;
  isGroup: boolean;
}

/** Z-API's "on message received" callback, read leniently. */
export function zapiInboundOf(body: unknown): ZapiInbound {
  const root = (body ?? {}) as Record<string, unknown>;
  const text = (root.text ?? {}) as Record<string, unknown>;
  return {
    phone: asString(root.phone),
    text: asString(text.message) ?? asString(root.message) ?? asString(root.body),
    senderName: asString(root.senderName) ?? asString(root.chatName) ?? asString(root.pushName),
    senderPhoto: asString(root.senderPhoto) ?? asString(root.photo),
    at: asDate(root.momment) ?? asDate(root.moment) ?? asDate(root.timestamp),
    fromMe: root.fromMe === true,
    isGroup: root.isGroup === true,
  };
}

// --- TikTok Lead Ads ------------------------------------------------------------------

/** The secret in the header, as a bearer token, or in `?secret=` (Zapier and TikTok both can set one of them). */
function tiktokSecretOf(request: FastifyRequest): string | undefined {
  const header = request.headers['x-wings-webhook-secret'];
  const fromHeader = Array.isArray(header) ? header[0] : header;
  const bearer = /^Bearer\s+(.+)$/i.exec(request.headers.authorization ?? '')?.[1];
  const fromQuery = (request.query as { secret?: unknown } | undefined)?.secret;
  return fromHeader ?? bearer ?? (typeof fromQuery === 'string' ? fromQuery : undefined);
}

/** JSON, or the form-encoded body Zapier's Webhooks sends by default. null = unreadable. */
export function tiktokBodyOf(raw: unknown, contentType: string | undefined): unknown {
  if (!Buffer.isBuffer(raw)) return raw ?? {};
  const text = raw.toString('utf8').trim();
  if (text === '') return {};
  const form = () => {
    if (!text.includes('=')) return null;
    const out: Record<string, unknown> = {};
    for (const [key, value] of new URLSearchParams(text)) out[key] = value;
    return Object.keys(out).length > 0 ? out : null;
  };
  if (contentType?.includes('x-www-form-urlencoded')) return form();
  try {
    return JSON.parse(text);
  } catch {
    return form();
  }
}

// --- the plugin --------------------------------------------------------------------

export const leadWebhookRoutes: FastifyPluginAsync = async (app) => {
  const { db, env } = app.wings;

  // Raw bodies, scoped to this plugin: Meta's signature is over the exact bytes.
  app.addContentTypeParser(
    ['application/json', 'text/plain', 'application/x-www-form-urlencoded'],
    { parseAs: 'buffer', bodyLimit: 1024 * 1024 },
    (_request, body, done) => done(null, body),
  );
  app.addContentTypeParser(
    '*',
    { parseAs: 'buffer', bodyLimit: 1024 * 1024 },
    (_request, body, done) => done(null, body),
  );

  const unavailable = (reply: FastifyReply, what: string) =>
    reply
      .status(503)
      .send({ error: 'webhook_not_configured', message: `${what} não está configurado.` });

  const logShape = (source: string, body: unknown, extra: Record<string, unknown> = {}) =>
    app.log.info({ msg: 'lead webhook', source, shape: shapeOf(body), ...extra });

  // --- RD Station ------------------------------------------------------------------

  app.post(
    '/integrations/rd-station/webhook',
    { config: { rateLimit } },
    async (request, reply) => {
      if (!env.RD_STATION_WEBHOOK_SECRET) return unavailable(reply, 'O webhook do RD Station');
      if (!sharedSecretOk(request, env.RD_STATION_WEBHOOK_SECRET)) {
        return reply.status(401).send({ error: 'bad_secret', message: 'Segredo inválido.' });
      }
      const body = parseJson(request.body);
      if (body === null)
        return reply.status(400).send({ error: 'invalid_json', message: 'Corpo inválido.' });
      const conversions = rdConversionsOf(body);
      logShape('rd_station', body, { conversions: conversions.length });

      const results: { leadId: string; created: boolean; clientMapped: boolean }[] = [];
      for (const conversion of conversions) {
        if (!conversion.email && !conversion.phone) continue;
        const client = await resolveLandingPage(db, {
          url: conversion.url,
          identifier: conversion.identifier,
        });
        const result = await upsertLead(db, {
          source: 'rd_station',
          name: conversion.name,
          email: conversion.email,
          phone: conversion.phone,
          clientId: client.clientId,
          clientMapped: client.mapped,
          pipeline: client.pipeline,
          brand: client.brand,
          channel: 'landing_page',
          landingPage: conversion.url ?? conversion.identifier,
          externalId: conversion.externalId,
          attribution: conversion.attribution,
          legalBasis: conversion.legalBasis,
          consentedAt: conversion.at ?? new Date(),
          enteredAt: conversion.at,
          enteredAtSource: 'rd_conversion',
          consentSource: `rd_station:${conversion.identifier ?? 'conversao'}`,
          consentText: conversion.legalBasisText,
          event: {
            kind: 'lead.received.rd_station',
            detail: {
              ruleId: client.ruleId,
              hasUrl: Boolean(conversion.url),
              hasIdentifier: Boolean(conversion.identifier),
              pipeline: client.pipeline,
              adPlatform: conversion.attribution?.adPlatform ?? null,
              hasUtm: Boolean(
                conversion.attribution?.utmSource || conversion.attribution?.utmCampaign,
              ),
            },
          },
        });
        const linkedDeal = conversion.externalId
          ? await linkIntakeDealToLead(db, {
              leadId: result.lead.id,
              contactUuid: conversion.externalId,
              identifier: conversion.identifier,
            })
          : null;
        await writeAudit(db, {
          action: result.created ? 'lead.received' : 'lead.merged',
          entity: 'lead',
          entityId: result.lead.id,
          ip: request.ip,
          metadata: {
            source: 'rd_station',
            clientMapped: client.mapped,
            pipeline: client.pipeline,
            rdDealLinked: linkedDeal !== null,
          },
        });
        results.push({
          leadId: result.lead.id,
          created: result.created,
          clientMapped: client.mapped,
        });
      }
      // Still a 200 (RD would retry and then switch the webhook off), but saying why nothing came in.
      if (conversions.length === 0) {
        app.log.warn({ msg: 'rd webhook without a conversion', shape: shapeOf(body) });
        return reply.send({ received: 0, leads: [], ignored: 'no_conversion' });
      }
      return reply.send({ received: conversions.length, leads: results });
    },
  );

  // --- Z-API (WhatsApp) -------------------------------------------------------------

  app.post('/integrations/zapi/webhook', { config: { rateLimit } }, async (request, reply) => {
    if (!env.ZAPI_WEBHOOK_SECRET) return unavailable(reply, 'O webhook do Z-API');
    if (!sharedSecretOk(request, env.ZAPI_WEBHOOK_SECRET)) {
      return reply.status(401).send({ error: 'bad_secret', message: 'Segredo inválido.' });
    }
    const body = parseJson(request.body);
    if (body === null)
      return reply.status(400).send({ error: 'invalid_json', message: 'Corpo inválido.' });
    const inbound = zapiInboundOf(body);
    const code = trackingCodeOf(inbound.text);
    logShape('zapi', body, {
      hasCode: code !== null,
      fromMe: inbound.fromMe,
      isGroup: inbound.isGroup,
    });

    if (inbound.fromMe || inbound.isGroup) return reply.send({ ignored: 'not_inbound' });
    const phone = normalizeBrazilianPhone(inbound.phone);
    if (!phone) return reply.send({ ignored: 'no_phone' });
    if (!code) return reply.send({ ignored: 'no_code' });
    const result = await leadFromTrackedMessage(db, {
      code,
      phone,
      text: inbound.text,
      senderName: inbound.senderName,
      senderPhoto: inbound.senderPhoto,
      at: inbound.at,
      ip: request.ip,
      via: 'zapi',
    });
    if (!result) return reply.send({ ignored: 'unknown_code' });
    return reply.send({ leadId: result.lead.id, created: result.created, channel: result.channel });
  });

  // --- Meta Lead Ads --------------------------------------------------------------------

  const verifyQuery = z.object({
    'hub.mode': z.string(),
    'hub.verify_token': z.string(),
    'hub.challenge': z.string(),
  });

  /** Meta's subscription handshake: echo the challenge only for our verify token. */
  app.get(
    '/integrations/meta/leadgen/webhook',
    { config: { rateLimit } },
    async (request, reply) => {
      if (!env.META_LEADGEN_VERIFY_TOKEN) return unavailable(reply, 'O webhook do Meta Lead Ads');
      const query = verifyQuery.safeParse(request.query);
      if (
        !query.success ||
        query.data['hub.mode'] !== 'subscribe' ||
        !tokensMatch(query.data['hub.verify_token'], env.META_LEADGEN_VERIFY_TOKEN)
      ) {
        return reply
          .status(403)
          .send({ error: 'bad_verify_token', message: 'Token de verificação inválido.' });
      }
      return reply.type('text/plain').send(query.data['hub.challenge']);
    },
  );

  app.post(
    '/integrations/meta/leadgen/webhook',
    { config: { rateLimit } },
    async (request, reply) => {
      if (!env.META_APP_SECRET) return unavailable(reply, 'O webhook do Meta Lead Ads');
      const raw = Buffer.isBuffer(request.body)
        ? request.body
        : Buffer.from(JSON.stringify(request.body ?? {}));
      const signature = request.headers['x-hub-signature-256'];
      if (
        !metaSignatureValid(
          env.META_APP_SECRET,
          raw,
          Array.isArray(signature) ? signature[0] : signature,
        )
      ) {
        return reply.status(401).send({ error: 'bad_signature', message: 'Assinatura inválida.' });
      }
      const body = parseJson(raw);
      if (body === null)
        return reply.status(400).send({ error: 'invalid_json', message: 'Corpo inválido.' });
      const events = leadgenEventsOf(body);
      logShape('meta_leadgen', body, { events: events.length });
      // Stored and answered at once; the queue (`meta-intake.ts`) reads the
      // answers from the Graph API, makes the lead and the copy in RD CRM. A
      // re-sent leadgen id is a no-op here.
      const queued = await enqueueMetaLeadgenEvents(db, events);
      if (queued > 0) app.wings.metaLeadKick?.();
      return reply.send({ received: events.length, queued });
    },
  );

  // --- TikTok Lead Ads (TikTok's own webhook, or Zapier) ------------------------------------

  app.post(
    '/integrations/tiktok/leads/webhook',
    { config: { rateLimit } },
    async (request, reply) => {
      if (!env.TIKTOK_LEADS_WEBHOOK_SECRET) return unavailable(reply, 'O webhook do TikTok');
      if (!secretMatches(tiktokSecretOf(request), env.TIKTOK_LEADS_WEBHOOK_SECRET)) {
        return reply.status(401).send({ error: 'bad_secret', message: 'Segredo inválido.' });
      }
      const body = tiktokBodyOf(request.body, request.headers['content-type']);
      if (body === null)
        return reply.status(400).send({ error: 'invalid_body', message: 'Corpo inválido.' });
      const found = tiktokLeadsIn(body);
      logShape('tiktok_leads', body, { leads: found.length });
      const result = await ingestTikTokLeads(
        {
          db,
          rdCrmToken: env.RD_CRM_API_TOKEN ?? null,
          expansionOwnerId: env.EXPANSION_OWNER_RD_USER_ID ?? null,
          rdCopyEnabled: env.TIKTOK_LEADS_RD_COPY_ENABLED === 'true',
          rdFetch: app.wings.rdFetch,
          log: (facts) => app.log.info(facts),
        },
        found,
        { ip: request.ip },
      );
      // A failure is the sender's cue to try again; the lead id makes the repeat harmless.
      return reply.status(result.failed > 0 ? 500 : 200).send(result);
    },
  );

  // --- Google Ads lead forms (YouTube, Search) ------------------------------------
  // Same rules as TikTok's door: 503 without the key, 401 with a wrong one. Google
  // sends the key in the body (`google_key`); a header or ?secret= also works.
  app.post(
    '/integrations/google-ads/leads/webhook',
    { config: { rateLimit } },
    async (request, reply) => {
      if (!env.GOOGLE_ADS_LEADS_WEBHOOK_KEY) return unavailable(reply, 'O webhook do Google Ads');
      const body = tiktokBodyOf(request.body, request.headers['content-type']);
      const lead = body === null ? null : googleLeadOf(body);
      if (!secretMatches(lead?.key ?? tiktokSecretOf(request), env.GOOGLE_ADS_LEADS_WEBHOOK_KEY)) {
        return reply.status(401).send({ error: 'bad_secret', message: 'Segredo inválido.' });
      }
      if (!lead)
        return reply.status(400).send({ error: 'invalid_body', message: 'Corpo inválido.' });
      logShape('google_leads', body, { test: lead.isTest });
      try {
        const result = await ingestGoogleLead(
          { db, now: app.wings.now, log: (facts) => app.log.info(facts) },
          lead,
          { ip: request.ip },
        );
        return reply.send(result);
      } catch {
        // Google retries a failed delivery; the lead id makes the repeat harmless.
        app.log.warn({ msg: 'google lead failed' });
        return reply
          .status(500)
          .send({ error: 'intake_failed', message: 'Falha ao gravar o lead.' });
      }
    },
  );
};
