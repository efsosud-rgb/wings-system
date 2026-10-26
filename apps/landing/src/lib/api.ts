import type { SubmitBody } from './payload.js';
import { whatsappUrlOf } from './whatsapp.js';

/**
 * The API's public site form (`/public/site-forms/:slug`, apps/api leads
 * site-forms.ts). The page calls it across origins (CORS for LANDING_ORIGINS),
 * never with cookies.
 */

export interface SiteFormSpec {
  qualifier: { question: string; options: string[] } | null;
  privacyPolicyUrl: string;
  thankYou: { title: string; body: string; buttonText: string; buttonUrl: string };
  requiredFields: ('email' | 'companyName' | 'instagram' | 'siteUrl' | 'qualifierAnswer')[];
  /** The option values the API maps to its options' texts. */
  qualifierValues?: { value: string; option: string }[];
}

export interface SiteFormInfo {
  slug: string;
  brand: string;
  turnstileSiteKey: string | null;
  instagram: string | null;
  pipeline: string | null;
  tracking: { metaPixelId: string | null; googleAdsConversion: string | null };
  whatsappUrl: string | null;
  form: SiteFormSpec | null;
}

export type LoadResult =
  { kind: 'ok'; info: SiteFormInfo } | { kind: 'not_found' } | { kind: 'error' };

export type SubmitResult =
  | { kind: 'ok'; whatsappUrl: string | null; eventId: string | null }
  | { kind: 'invalid'; message: string }
  | { kind: 'captcha_refused' }
  | { kind: 'rate_limited' }
  | { kind: 'unavailable' };

export const formUrlOf = (apiBase: string, slug: string): string =>
  `${apiBase}/public/site-forms/${encodeURIComponent(slug)}`;

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const text = (value: unknown) => (typeof value === 'string' && value ? value : null);
const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];

const REQUIRED_FIELDS = new Set([
  'email',
  'companyName',
  'instagram',
  'siteUrl',
  'qualifierAnswer',
]);

/** The page's form spec, or null; arrays and texts that are not what they claim are dropped. */
export function siteFormSpecOf(raw: unknown): SiteFormSpec | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const form = record(raw);
  const qualifier = record(form.qualifier);
  const thankYou = record(form.thankYou);
  const spec: SiteFormSpec = {
    qualifier: text(qualifier.question)
      ? { question: text(qualifier.question) ?? '', options: strings(qualifier.options) }
      : null,
    privacyPolicyUrl: text(form.privacyPolicyUrl) ?? '',
    thankYou: {
      title: text(thankYou.title) ?? '',
      body: text(thankYou.body) ?? '',
      buttonText: text(thankYou.buttonText) ?? '',
      buttonUrl: text(thankYou.buttonUrl) ?? '',
    },
    requiredFields: strings(form.requiredFields).filter((field) =>
      REQUIRED_FIELDS.has(field),
    ) as SiteFormSpec['requiredFields'],
  };
  if (Array.isArray(form.qualifierValues)) {
    spec.qualifierValues = form.qualifierValues
      .map(record)
      .filter((entry) => typeof entry.value === 'string' && typeof entry.option === 'string')
      .map((entry) => ({ value: entry.value as string, option: entry.option as string }));
  }
  return spec;
}

/** The GET answer, read defensively: what is missing or malformed counts as absent. */
export function siteFormInfoOf(raw: unknown): SiteFormInfo {
  const body = record(raw);
  const tracking = record(body.tracking);
  const form = siteFormSpecOf(body.form);
  return {
    slug: text(body.slug) ?? '',
    brand: text(body.brand) ?? '',
    turnstileSiteKey: text(body.turnstileSiteKey),
    instagram: text(body.instagram),
    pipeline: text(body.pipeline),
    tracking: {
      metaPixelId: text(tracking.metaPixelId),
      googleAdsConversion: text(tracking.googleAdsConversion),
    },
    whatsappUrl: whatsappUrlOf(body.whatsappUrl),
    form,
  };
}

/** The POST answer by status code (the API contract). */
export function submitResultOf(status: number, raw: unknown): SubmitResult {
  const body = record(raw);
  if (status === 200 && body.ok === true) {
    // The Conversions API's event id, for the pixel to send the same one; null while it is off.
    const eventId = typeof body.eventId === 'string' ? body.eventId : null;
    return { kind: 'ok', whatsappUrl: whatsappUrlOf(body.whatsappUrl), eventId };
  }
  if (status === 400) {
    const message = typeof body.message === 'string' ? body.message.trim() : '';
    return { kind: 'invalid', message: message || 'Confira os dados do formulário.' };
  }
  if (status === 403 && body.error === 'captcha_refused') return { kind: 'captcha_refused' };
  if (status === 429) return { kind: 'rate_limited' };
  return { kind: 'unavailable' };
}

async function jsonOf(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

export async function loadSiteForm(
  apiBase: string,
  slug: string,
  fetchImpl: typeof fetch = fetch,
): Promise<LoadResult> {
  try {
    const response = await fetchImpl(formUrlOf(apiBase, slug), {
      credentials: 'omit',
      headers: { accept: 'application/json' },
    });
    if (response.status === 404) return { kind: 'not_found' };
    if (!response.ok) return { kind: 'error' };
    return { kind: 'ok', info: siteFormInfoOf(await jsonOf(response)) };
  } catch {
    return { kind: 'error' };
  }
}

export async function submitSiteForm(
  apiBase: string,
  slug: string,
  body: SubmitBody,
  fetchImpl: typeof fetch = fetch,
): Promise<SubmitResult> {
  try {
    const response = await fetchImpl(formUrlOf(apiBase, slug), {
      method: 'POST',
      credentials: 'omit',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(body),
    });
    return submitResultOf(response.status, await jsonOf(response));
  } catch {
    return { kind: 'unavailable' };
  }
}
