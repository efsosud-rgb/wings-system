import { normalizeBrazilianPhone, trackingCodeOf, type LeadLegalBasis, type LeadLinkChannel } from '@wings/shared';
import { eq, sql } from 'drizzle-orm';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { leadTrackingLinks } from '../../db/schema/index.js';
import { writeAudit } from '../../lib/audit.js';
import { tokensMatch } from '../../lib/tokens.js';
import { shapeOf } from '../media/kairogen-adapter.js';
import { fetchMetaLead, leadgenEventsOf, metaSignatureValid, MetaLeadFetchError } from './meta-leads.js';
import { resolveLandingPage, resolveMetaSource, trackingLinkByCode, upsertLead } from './service.js';

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
  typeof value === 'string' && value.trim().length > 0 ? value.trim() : typeof value === 'number' ? String(value) : null;

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

/**
 * RD Station Marketing sends `{ leads: [...] }` (classic) or an event with
 * `leads` (webhooks v2); each lead carries its last conversion. Read leniently.
 */
export function rdConversionsOf(body: unknown): RdConversion[] {
  const root = (body ?? {}) as Record<string, unknown>;
  const list = Array.isArray(root.leads) ? root.leads : root.email || root.uuid ? [root] : [];
  const eventAt = asDate(root.event_timestamp);
  return list
    .filter((lead): lead is Record<string, unknown> => Boolean(lead && typeof lead === 'object'))
    .map((lead) => {
      const last = (lead.last_conversion ?? {}) as Record<string, unknown>;
      const content = (last.content ?? {}) as Record<string, unknown>;
      const bases = Array.isArray(lead.legal_bases) ? (lead.legal_bases as Record<string, unknown>[]) : [];
      const granted = bases.find((basis) => basis.status === 'granted' || basis.status === undefined);
      const legalBasis: LeadLegalBasis =
        granted?.type === 'legitimate_interest' ? 'legitimate_interest' : 'consent';
      return {
        externalId: asString(lead.uuid) ?? asString(lead.id),
        name: asString(lead.name),
        email: asString(lead.email),
        phone:
          asString(lead.mobile_phone) ?? asString(lead.personal_phone) ?? asString(lead.phone) ?? asString(content.telefone) ?? asString(content.celular),
        identifier:
          asString(content.conversion_identifier) ?? asString(content.identificador) ?? asString(lead.conversion_identifier),
        url:
          asString(content.url) ?? asString(content.conversion_url) ?? asString(content.page_url) ?? asString(last.url) ?? asString(lead.landing_page_url),
        at: asDate(content.created_at) ?? asDate(last.created_at) ?? asDate(lead.created_at) ?? eventAt,
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

// --- the plugin --------------------------------------------------------------------

export const leadWebhookRoutes: FastifyPluginAsync = async (app) => {
  const { db, env } = app.wings;

  // Raw bodies, scoped to this plugin: Meta's signature is over the exact bytes.
  app.addContentTypeParser(
    ['application/json', 'text/plain', 'application/x-www-form-urlencoded'],
    { parseAs: 'buffer', bodyLimit: 1024 * 1024 },
    (_request, body, done) => done(null, body),
  );
  app.addContentTypeParser('*', { parseAs: 'buffer', bodyLimit: 1024 * 1024 }, (_request, body, done) =>
    done(null, body),
  );

  const unavailable = (reply: FastifyReply, what: string) =>
    reply.status(503).send({ error: 'webhook_not_configured', message: `${what} não está configurado.` });

  const logShape = (source: string, body: unknown, extra: Record<string, unknown> = {}) =>
    app.log.info({ msg: 'lead webhook', source, shape: shapeOf(body), ...extra });

  // --- RD Station ------------------------------------------------------------------

  app.post('/integrations/rd-station/webhook', { config: { rateLimit } }, async (request, reply) => {
    if (!env.RD_STATION_WEBHOOK_SECRET) return unavailable(reply, 'O webhook do RD Station');
    if (!sharedSecretOk(request, env.RD_STATION_WEBHOOK_SECRET)) {
      return reply.status(401).send({ error: 'bad_secret', message: 'Segredo inválido.' });
    }
    const body = parseJson(request.body);
    if (body === null) return reply.status(400).send({ error: 'invalid_json', message: 'Corpo inválido.' });
    const conversions = rdConversionsOf(body);
    logShape('rd_station', body, { conversions: conversions.length });

    const results: { leadId: string; created: boolean; clientMapped: boolean }[] = [];
    for (const conversion of conversions) {
      if (!conversion.email && !conversion.phone) continue;
      const client = await resolveLandingPage(db, { url: conversion.url, identifier: conversion.identifier });
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
        legalBasis: conversion.legalBasis,
        consentedAt: conversion.at ?? new Date(),
        consentSource: `rd_station:${conversion.identifier ?? 'conversao'}`,
        consentText: conversion.legalBasisText,
        event: {
          kind: 'lead.received.rd_station',
          detail: { ruleId: client.ruleId, hasUrl: Boolean(conversion.url), hasIdentifier: Boolean(conversion.identifier) },
        },
      });
      await writeAudit(db, {
        action: result.created ? 'lead.received' : 'lead.merged',
        entity: 'lead',
        entityId: result.lead.id,
        ip: request.ip,
        metadata: { source: 'rd_station', clientMapped: client.mapped },
      });
      results.push({ leadId: result.lead.id, created: result.created, clientMapped: client.mapped });
    }
    return reply.send({ received: conversions.length, leads: results });
  });

  // --- Z-API (WhatsApp) -------------------------------------------------------------

  app.post('/integrations/zapi/webhook', { config: { rateLimit } }, async (request, reply) => {
    if (!env.ZAPI_WEBHOOK_SECRET) return unavailable(reply, 'O webhook do Z-API');
    if (!sharedSecretOk(request, env.ZAPI_WEBHOOK_SECRET)) {
      return reply.status(401).send({ error: 'bad_secret', message: 'Segredo inválido.' });
    }
    const body = parseJson(request.body);
    if (body === null) return reply.status(400).send({ error: 'invalid_json', message: 'Corpo inválido.' });
    const inbound = zapiInboundOf(body);
    const code = trackingCodeOf(inbound.text);
    logShape('zapi', body, { hasCode: code !== null, fromMe: inbound.fromMe, isGroup: inbound.isGroup });

    if (inbound.fromMe || inbound.isGroup) return reply.send({ ignored: 'not_inbound' });
    const phone = normalizeBrazilianPhone(inbound.phone);
    if (!phone) return reply.send({ ignored: 'no_phone' });
    if (!code) return reply.send({ ignored: 'no_code' });
    const link = await trackingLinkByCode(db, code);
    if (!link) return reply.send({ ignored: 'unknown_code' });

    const at = inbound.at ?? new Date();
    const result = await upsertLead(db, {
      source: 'whatsapp_link',
      name: inbound.senderName,
      phone,
      clientId: link.clientId,
      clientMapped: true,
      channel: link.channel as LeadLinkChannel,
      trackingLinkId: link.id,
      firstMessage: inbound.text,
      whatsappProfileName: inbound.senderName,
      whatsappPhotoUrl: inbound.senderPhoto,
      // The person wrote first, asking about the franchise: LGPD art. 7º, V.
      legalBasis: 'pre_contract',
      consentedAt: at,
      consentSource: `whatsapp:${link.channel}:${link.code}`,
      consentText: 'A pessoa iniciou a conversa no WhatsApp da Wings pelo link rastreável, pedindo informações.',
      event: { kind: 'lead.received.whatsapp', detail: { trackingLinkId: link.id, channel: link.channel, code: link.code } },
    });
    await db
      .update(leadTrackingLinks)
      .set({ hits: sql`${leadTrackingLinks.hits} + 1`, lastHitAt: at })
      .where(eq(leadTrackingLinks.id, link.id));
    await writeAudit(db, {
      action: result.created ? 'lead.received' : 'lead.merged',
      entity: 'lead',
      entityId: result.lead.id,
      ip: request.ip,
      metadata: { source: 'whatsapp_link', channel: link.channel, trackingLinkId: link.id },
    });
    return reply.send({ leadId: result.lead.id, created: result.created, channel: link.channel });
  });

  // --- Meta Lead Ads --------------------------------------------------------------------

  const verifyQuery = z.object({
    'hub.mode': z.string(),
    'hub.verify_token': z.string(),
    'hub.challenge': z.string(),
  });

  /** Meta's subscription handshake: echo the challenge only for our verify token. */
  app.get('/integrations/meta/leadgen/webhook', { config: { rateLimit } }, async (request, reply) => {
    if (!env.META_LEADGEN_VERIFY_TOKEN) return unavailable(reply, 'O webhook do Meta Lead Ads');
    const query = verifyQuery.safeParse(request.query);
    if (
      !query.success ||
      query.data['hub.mode'] !== 'subscribe' ||
      !tokensMatch(query.data['hub.verify_token'], env.META_LEADGEN_VERIFY_TOKEN)
    ) {
      return reply.status(403).send({ error: 'bad_verify_token', message: 'Token de verificação inválido.' });
    }
    return reply.type('text/plain').send(query.data['hub.challenge']);
  });

  app.post('/integrations/meta/leadgen/webhook', { config: { rateLimit } }, async (request, reply) => {
    if (!env.META_APP_SECRET) return unavailable(reply, 'O webhook do Meta Lead Ads');
    const raw = Buffer.isBuffer(request.body) ? request.body : Buffer.from(JSON.stringify(request.body ?? {}));
    const signature = request.headers['x-hub-signature-256'];
    if (!metaSignatureValid(env.META_APP_SECRET, raw, Array.isArray(signature) ? signature[0] : signature)) {
      return reply.status(401).send({ error: 'bad_signature', message: 'Assinatura inválida.' });
    }
    const body = parseJson(raw);
    if (body === null) return reply.status(400).send({ error: 'invalid_json', message: 'Corpo inválido.' });
    const events = leadgenEventsOf(body);
    logShape('meta_leadgen', body, { events: events.length });

    const token = env.META_LEADS_ACCESS_TOKEN ?? env.META_WRITE_TOKEN;
    const results: { leadId: string; created: boolean; fetched: boolean }[] = [];
    for (const event of events) {
      let fetched = false;
      let details: Awaited<ReturnType<typeof fetchMetaLead>>['details'] | null = null;
      let fetchError: string | null = null;
      if (token) {
        try {
          const answer = await fetchMetaLead(event.leadgenId, { accessToken: token, fetchImpl: app.wings.platformFetch });
          details = answer.details;
          fetched = true;
          app.log.info({ msg: 'meta lead fetched', shape: shapeOf(answer.raw) });
        } catch (error) {
          fetchError = error instanceof MetaLeadFetchError ? `graph_${error.status}` : 'graph_unreachable';
          app.log.warn({ msg: 'meta lead fetch failed', reason: fetchError });
        }
      } else {
        fetchError = 'no_token';
      }
      const formId = details?.formId ?? event.formId;
      const campaignId = details?.campaignId ?? null;
      const client = await resolveMetaSource(db, { formId, campaignId });
      const result = await upsertLead(db, {
        source: 'meta_lead_ads',
        name: details?.name ?? null,
        email: details?.email ?? null,
        phone: details?.phone ?? null,
        clientId: client.clientId,
        clientMapped: client.mapped,
        pipeline: client.pipeline,
        brand: client.brand,
        channel: 'meta_lead_ads',
        campaignId,
        campaignName: details?.campaignName ?? null,
        formId,
        externalId: event.leadgenId,
        legalBasis: 'consent',
        consentedAt: details?.createdTime ?? event.createdTime ?? new Date(),
        consentSource: `meta_lead_ads:form:${formId ?? 'desconhecido'}`,
        consentText: 'Formulário de cadastro do Meta Lead Ads, com a política de privacidade do formulário.',
        event: {
          kind: 'lead.received.meta_lead_ads',
          detail: { ruleId: client.ruleId, formId, campaignId, fetched, fetchError },
        },
      });
      await writeAudit(db, {
        action: result.created ? 'lead.received' : 'lead.merged',
        entity: 'lead',
        entityId: result.lead.id,
        ip: request.ip,
        metadata: { source: 'meta_lead_ads', clientMapped: client.mapped, fetched },
      });
      results.push({ leadId: result.lead.id, created: result.created, fetched });
    }
    return reply.send({ received: events.length, leads: results });
  });
};
