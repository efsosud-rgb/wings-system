import { instagramUsernameOf } from '@wings/shared/instagram';
import { phoneDigitsOf, siteUrlOf } from './form-rules.js';
import type { Tracking } from './tracking.js';
import type { SiteFormSpec } from './api.js';

/** What the person typed, by field, as the form holds it. */
export interface FormValues {
  name: string;
  phone: string;
  email: string;
  companyName: string;
  instagram: string;
  siteUrl: string;
  /** The chosen option's value (`formatacao`, `expansao`, …). */
  qualifierValue: string;
  /** The chosen option's visible text. */
  qualifierText: string;
  /** The honeypot, sent as it is: the server decides. */
  website: string;
}

/** The POST body of `/public/site-forms/:slug` (siteFormSubmitSchema in @wings/shared). */
export interface SubmitBody {
  name: string;
  phone: string;
  email?: string;
  companyName?: string;
  instagram?: string;
  siteUrl?: string;
  qualifierAnswer?: string;
  consent: true;
  page?: string;
  tracking?: Tracking;
  turnstileToken: string;
  website?: string;
}

/**
 * The qualifier answer the API takes: the option's value when the API lists
 * the values it maps (`qualifierValues`), else the option's text when the
 * page's question has it (the older contract checks the text), else the value.
 */
export function qualifierAnswerOf(
  value: string,
  text: string,
  form: SiteFormSpec | null | undefined,
): string | undefined {
  if (!value) return undefined;
  if (form?.qualifierValues?.some((entry) => entry.value === value)) return value;
  if (form?.qualifier?.options.includes(text)) return text;
  return value;
}

/** The page's address as sent: no fragment. */
export const pageOf = (href: string): string => href.split('#')[0] ?? href;

export function submitBodyOf(input: {
  values: FormValues;
  tracking: Tracking;
  turnstileToken: string;
  href: string;
  form?: SiteFormSpec | null;
}): SubmitBody {
  const { values } = input;
  const body: SubmitBody = {
    name: values.name.trim(),
    phone: phoneDigitsOf(values.phone),
    consent: true,
    turnstileToken: input.turnstileToken,
    page: pageOf(input.href),
    website: values.website,
  };
  const email = values.email.trim();
  if (email) body.email = email;
  const companyName = values.companyName.trim();
  if (companyName) body.companyName = companyName;
  const instagram = instagramUsernameOf(values.instagram);
  if (instagram) body.instagram = instagram;
  const siteUrl = siteUrlOf(values.siteUrl);
  if (siteUrl) body.siteUrl = siteUrl;
  const qualifierAnswer = qualifierAnswerOf(
    values.qualifierValue,
    values.qualifierText,
    input.form,
  );
  if (qualifierAnswer) body.qualifierAnswer = qualifierAnswer;
  if (Object.keys(input.tracking).length) body.tracking = input.tracking;
  return body;
}
