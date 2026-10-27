import { siteEventSchema, type SiteEvent } from '@wings/shared';
import type { FastifyPluginAsync } from 'fastify';
import { formPage, notFound, slugParam } from './site-forms.js';

/**
 * What a visitor does on a landing page before and after the form, counted on
 * the server: the page sends each step with `navigator.sendBeacon` to
 * `POST /public/site-forms/:slug/events` and the API writes one JSON log line
 * per event (`"msg":"site event"`), nothing else. No table and no migration:
 * the lines are counted on the API's log (docs/landing/fale-com-a-wings.md,
 * "Eventos para o servidor").
 *
 * Nothing personal travels or is kept: a closed list of events and steps
 * (`siteEventSchema`, @wings/shared), the ad's UTMs, a random id of the visit
 * the page keeps in its sessionStorage (no cookie), and the device read here
 * from the User-Agent (kind, system and app only; the string itself is not
 * logged). The IP is never in the line. The answer is 204 whatever the page
 * does with it (a beacon reads no answer).
 */

export const SITE_EVENT_LOG_MSG = 'site event';

export interface Device {
  kind: 'phone' | 'tablet' | 'desktop' | 'unknown';
  os: 'android' | 'ios' | 'other';
  app: 'instagram' | 'facebook' | 'browser';
}

/** The device behind a User-Agent, coarse on purpose: enough to tell the Instagram browser on a phone from a desktop. */
export function deviceOf(userAgent: string | undefined): Device {
  const ua = userAgent ?? '';
  if (!ua) return { kind: 'unknown', os: 'other', app: 'browser' };
  const ios = /iPhone|iPad|iPod/i.test(ua);
  const android = /Android/i.test(ua);
  const tablet = /iPad|Tablet/i.test(ua) || (android && !/Mobile/i.test(ua));
  return {
    kind: tablet ? 'tablet' : ios || android || /Mobile/i.test(ua) ? 'phone' : 'desktop',
    os: ios ? 'ios' : android ? 'android' : 'other',
    app: /Instagram/i.test(ua)
      ? 'instagram'
      : /FBAN|FBAV|FB_IAB/i.test(ua)
        ? 'facebook'
        : 'browser',
  };
}

/** A phone as people write it: digits with a "+", brackets, dashes or spaces between them. */
const FORMATTED_PHONE = /^\+?[\d\s().-]+$/;
/** A Brazilian mobile written bare: optional 55, two-digit area code, 9 and eight digits. */
const BARE_MOBILE = /^(55)?[1-9]{2}9\d{8}$/;

/**
 * A UTM is kept as text, ad ids included (Meta's are 15 to 19 digits,
 * Google's about 11). One that looks like an e-mail or a phone (a campaign
 * link may carry one) is not logged.
 * shortcut: a Google id shaped like a mobile (11 digits, the third a 9) is dropped too; tell them apart by the source if that matters.
 */
export function loggedUtm(value: string | undefined): string | null {
  if (!value) return null;
  if (value.includes('@')) return null;
  const digits = value.replace(/\D/g, '');
  const phoneLength = digits.length >= 10 && digits.length <= 13;
  if (phoneLength && FORMATTED_PHONE.test(value) && /[+\s()-]/.test(value)) return null;
  return BARE_MOBILE.test(value) ? null : value;
}

/** The log line one event becomes: the event as sent, the page's slug and the device; no IP, no User-Agent. */
export function siteEventLineOf(slug: string, event: SiteEvent, userAgent: string | undefined) {
  const device = deviceOf(userAgent);
  return {
    msg: SITE_EVENT_LOG_MSG,
    slug,
    event: event.event,
    step: event.step ?? null,
    visit: event.visit ?? null,
    utm_source: loggedUtm(event.utm_source),
    utm_medium: loggedUtm(event.utm_medium),
    utm_campaign: loggedUtm(event.utm_campaign),
    utm_content: loggedUtm(event.utm_content),
    utm_term: loggedUtm(event.utm_term),
    utm_id: loggedUtm(event.utm_id),
    device: device.kind,
    os: device.os,
    app: device.app,
  };
}

/** A beacon's body arrives as `text/plain` (no preflight), which Fastify hands over as a string; JSON that does not parse is an invalid event. */
function jsonOf(body: unknown): unknown {
  if (typeof body !== 'string') return body;
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

export const siteEventRoutes: FastifyPluginAsync = async (app) => {
  const publicEvents = app.publicRoute('landing page visitor events: rate limit, nothing personal');
  const { db } = app.wings;

  app.post(
    '/public/site-forms/:slug/events',
    {
      preHandler: publicEvents,
      bodyLimit: 1024,
      // A visit sends about ten events; the limit guards the log, keyed by IP like the form's.
      config: { rateLimit: { max: 300, timeWindow: '10 minutes' } },
      // No request line for a beacon: Fastify's own would carry the IP next to the event.
      logLevel: 'warn',
    },
    async (request, reply) => {
      const params = slugParam.safeParse(request.params);
      if (!params.success) return notFound(reply);
      // the body first (cheap), the page after: a bot's garbage never reaches the database
      const event = siteEventSchema.safeParse(jsonOf(request.body));
      if (!event.success) {
        return reply.status(400).send({ error: 'invalid_request', message: 'Evento inválido.' });
      }
      const page = await formPage(db, params.data.slug);
      if (!page) return notFound(reply);
      app.log.info(siteEventLineOf(page.pattern, event.data, request.headers['user-agent']));
      return reply.status(204).send();
    },
  );
};
