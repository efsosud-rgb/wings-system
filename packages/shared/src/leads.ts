import type { SiteFormRequiredField } from './ads/lead-form.js';
import { INSTAGRAM_LIST_FILTERS } from './instagram-list-filters.js';
import type { LeadInstagramCheck } from './instagram-check.js';
import type { LeadChecks } from './lead-fields.js';
import { z } from 'zod';
import type { LeadAiSummary, LeadContactRef } from './crm.js';

/**
 * Funil Sofia, part 1: how a lead enters the CRM (capture) and what the
 * worker finds out about it (enrichment). The contract between the API, the
 * worker and the screen: sources and channels, tracking codes, the rules
 * that map a landing page or a Meta form to a client, the DDD table, and the
 * "perfil de franqueado" score with its explainable criteria.
 *
 * Nothing here talks to a service: the score and the summary are pure
 * functions over facts the worker collected, so the screen and the tests can
 * reproduce every number.
 */

// --- sources and channels ---------------------------------------------------

/** How the lead entered the system. */
export const LEAD_SOURCES = [
  'rd_station',
  'whatsapp_link',
  'meta_lead_ads',
  'tiktok_lead_ads',
  'google_lead_form',
  'manual',
  'rd_crm',
  'site_form',
  'csv_import',
  'whatsapp',
  'google_places',
  'instagram_colagem',
] as const;
export type LeadSource = (typeof LEAD_SOURCES)[number];

export const LEAD_SOURCE_LABELS: Record<LeadSource, string> = {
  rd_station: 'Landing page (RD Station)',
  whatsapp_link: 'WhatsApp (link rastreável)',
  meta_lead_ads: 'Meta Lead Ads',
  tiktok_lead_ads: 'TikTok Lead Ads',
  google_lead_form: 'Formulário do Google Ads',
  manual: 'Cadastro manual',
  rd_crm: 'RD CRM (importado)',
  site_form: 'Formulário do site',
  csv_import: 'Planilha importada',
  whatsapp: 'WhatsApp (Sofia)',
  google_places: 'Prospecção Google Maps',
  instagram_colagem: 'Instagram (comentário em concorrente)',
};

/**
 * The sales funnels a lead is headed for (CRM phase 1): Formatação is the
 * Wings product, Expansão is selling a client brand's franchise.
 */
export const LEAD_PIPELINES = ['expansao', 'formatacao', 'consultoria'] as const;
export type LeadPipeline = (typeof LEAD_PIPELINES)[number];

export const LEAD_PIPELINE_LABELS: Record<LeadPipeline, string> = {
  expansao: 'Expansão',
  formatacao: 'Formatação',
  consultoria: 'Consultoria',
};

/**
 * The funnel a person opens Negociações on when the address names none: the one their level sells
 * (a Formatação seller lands on Formatação, not on an empty Expansão board). Every other level,
 * managers and the board included, keeps Expansão, the funnel that always opened first.
 */
export function defaultPipelineOfRole(role: string | null | undefined): LeadPipeline {
  return role === 'vendedor_formatacao' ? 'formatacao' : 'expansao';
}

/** RD CRM's funnel name -> ours; the "Vendidos"/"Negócios perdidos" archives count as their origin. */
export function pipelineOfRdFunnel(name: string | null | undefined): LeadPipeline | null {
  const text = (name ?? '')
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase();
  if (/expansao/.test(text)) return 'expansao';
  if (/formatacao/.test(text)) return 'formatacao';
  if (/consultoria/.test(text)) return 'consultoria';
  return null;
}

/** The channels a tracked WhatsApp link can be generated for. */
export const LEAD_LINK_CHANNELS = ['instagram', 'site', 'linktree', 'linkedin', 'tiktok'] as const;
export type LeadLinkChannel = (typeof LEAD_LINK_CHANNELS)[number];

/** Every channel a lead may carry: the link channels plus the two that come from a platform. */
export const LEAD_CHANNELS = [
  ...LEAD_LINK_CHANNELS,
  'landing_page',
  'meta_lead_ads',
  'tiktok_lead_ads',
  'google_lead_form',
] as const;
export type LeadChannel = (typeof LEAD_CHANNELS)[number];

export const LEAD_CHANNEL_LABELS: Record<LeadChannel, string> = {
  instagram: 'Instagram',
  site: 'Site',
  linktree: 'Linktree',
  linkedin: 'LinkedIn',
  tiktok: 'TikTok',
  landing_page: 'Landing page',
  meta_lead_ads: 'Meta Lead Ads',
  tiktok_lead_ads: 'TikTok Lead Ads',
  google_lead_form: 'Google Ads (formulário)',
};

// --- LGPD ---------------------------------------------------------------------

/**
 * The legal basis a lead's data is held under (LGPD art. 7º). Recorded with
 * the lead, with the moment it was given and where. Which basis applies to
 * each entry point is a decision for Jurídico to confirm; see docs/leads/intake.md.
 */
export const LEAD_LEGAL_BASES = ['consent', 'pre_contract', 'legitimate_interest'] as const;
export type LeadLegalBasis = (typeof LEAD_LEGAL_BASES)[number];

export const LEAD_LEGAL_BASIS_LABELS: Record<LeadLegalBasis, string> = {
  consent: 'Consentimento do titular (art. 7º, I)',
  pre_contract: 'Diligências pré-contratuais a pedido do titular (art. 7º, V)',
  legitimate_interest: 'Legítimo interesse (art. 7º, IX)',
};

// --- phone --------------------------------------------------------------------

/**
 * Normalises a Brazilian number to digits (55 + DDD + number). Returns null
 * for anything that is not a usable number, including placeholder values.
 */
export function normalizeBrazilianPhone(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const digits = raw.replace(/\D/g, '');
  if (digits.length === 0) return null;
  if (/^(\d)\1+$/.test(digits)) return null;
  if (digits.length === 10 || digits.length === 11) return `55${digits}`;
  if ((digits.length === 12 || digits.length === 13) && digits.startsWith('55')) return digits;
  return null;
}

/** The DDD of a normalised number (`5511999998888` -> `11`). */
export function dddOf(phone: string | null | undefined): string | null {
  if (!phone || !/^55\d{10,11}$/.test(phone)) return null;
  return phone.slice(2, 4);
}

/**
 * DDD -> the main city of the area and its state. A DDD covers a region, not
 * one city, so the screen says "região de São Paulo", never "mora em".
 */
export const DDD_REGIONS: Record<string, { city: string; uf: string }> = {
  '11': { city: 'São Paulo', uf: 'SP' },
  '12': { city: 'São José dos Campos', uf: 'SP' },
  '13': { city: 'Santos', uf: 'SP' },
  '14': { city: 'Bauru', uf: 'SP' },
  '15': { city: 'Sorocaba', uf: 'SP' },
  '16': { city: 'Ribeirão Preto', uf: 'SP' },
  '17': { city: 'São José do Rio Preto', uf: 'SP' },
  '18': { city: 'Presidente Prudente', uf: 'SP' },
  '19': { city: 'Campinas', uf: 'SP' },
  '21': { city: 'Rio de Janeiro', uf: 'RJ' },
  '22': { city: 'Campos dos Goytacazes', uf: 'RJ' },
  '24': { city: 'Volta Redonda', uf: 'RJ' },
  '27': { city: 'Vitória', uf: 'ES' },
  '28': { city: 'Cachoeiro de Itapemirim', uf: 'ES' },
  '31': { city: 'Belo Horizonte', uf: 'MG' },
  '32': { city: 'Juiz de Fora', uf: 'MG' },
  '33': { city: 'Governador Valadares', uf: 'MG' },
  '34': { city: 'Uberlândia', uf: 'MG' },
  '35': { city: 'Poços de Caldas', uf: 'MG' },
  '37': { city: 'Divinópolis', uf: 'MG' },
  '38': { city: 'Montes Claros', uf: 'MG' },
  '41': { city: 'Curitiba', uf: 'PR' },
  '42': { city: 'Ponta Grossa', uf: 'PR' },
  '43': { city: 'Londrina', uf: 'PR' },
  '44': { city: 'Maringá', uf: 'PR' },
  '45': { city: 'Foz do Iguaçu', uf: 'PR' },
  '46': { city: 'Francisco Beltrão', uf: 'PR' },
  '47': { city: 'Joinville', uf: 'SC' },
  '48': { city: 'Florianópolis', uf: 'SC' },
  '49': { city: 'Chapecó', uf: 'SC' },
  '51': { city: 'Porto Alegre', uf: 'RS' },
  '53': { city: 'Pelotas', uf: 'RS' },
  '54': { city: 'Caxias do Sul', uf: 'RS' },
  '55': { city: 'Santa Maria', uf: 'RS' },
  '61': { city: 'Brasília', uf: 'DF' },
  '62': { city: 'Goiânia', uf: 'GO' },
  '63': { city: 'Palmas', uf: 'TO' },
  '64': { city: 'Rio Verde', uf: 'GO' },
  '65': { city: 'Cuiabá', uf: 'MT' },
  '66': { city: 'Rondonópolis', uf: 'MT' },
  '67': { city: 'Campo Grande', uf: 'MS' },
  '68': { city: 'Rio Branco', uf: 'AC' },
  '69': { city: 'Porto Velho', uf: 'RO' },
  '71': { city: 'Salvador', uf: 'BA' },
  '73': { city: 'Ilhéus', uf: 'BA' },
  '74': { city: 'Juazeiro', uf: 'BA' },
  '75': { city: 'Feira de Santana', uf: 'BA' },
  '77': { city: 'Vitória da Conquista', uf: 'BA' },
  '79': { city: 'Aracaju', uf: 'SE' },
  '81': { city: 'Recife', uf: 'PE' },
  '82': { city: 'Maceió', uf: 'AL' },
  '83': { city: 'João Pessoa', uf: 'PB' },
  '84': { city: 'Natal', uf: 'RN' },
  '85': { city: 'Fortaleza', uf: 'CE' },
  '86': { city: 'Teresina', uf: 'PI' },
  '87': { city: 'Petrolina', uf: 'PE' },
  '88': { city: 'Juazeiro do Norte', uf: 'CE' },
  '89': { city: 'Picos', uf: 'PI' },
  '91': { city: 'Belém', uf: 'PA' },
  '92': { city: 'Manaus', uf: 'AM' },
  '93': { city: 'Santarém', uf: 'PA' },
  '94': { city: 'Marabá', uf: 'PA' },
  '95': { city: 'Boa Vista', uf: 'RR' },
  '96': { city: 'Macapá', uf: 'AP' },
  '97': { city: 'Coari', uf: 'AM' },
  '98': { city: 'São Luís', uf: 'MA' },
  '99': { city: 'Imperatriz', uf: 'MA' },
};

export interface LeadRegion {
  ddd: string;
  city: string;
  uf: string;
}

export function regionOfPhone(phone: string | null | undefined): LeadRegion | null {
  const ddd = dddOf(phone);
  const region = ddd ? DDD_REGIONS[ddd] : undefined;
  return ddd && region ? { ddd, ...region } : null;
}

// --- e-mail -------------------------------------------------------------------

const PERSONAL_EMAIL_DOMAINS = new Set([
  'gmail.com',
  'hotmail.com',
  'hotmail.com.br',
  'outlook.com',
  'outlook.com.br',
  'live.com',
  'msn.com',
  'yahoo.com',
  'yahoo.com.br',
  'icloud.com',
  'me.com',
  'uol.com.br',
  'bol.com.br',
  'terra.com.br',
  'globo.com',
  'ig.com.br',
  'protonmail.com',
  'proton.me',
  'aol.com',
  'zipmail.com.br',
  // More Brazilian providers, and foreign webmails Brazilians also use.
  'oi.com.br',
  'ibest.com.br',
  'pop.com.br',
  'r7.com',
  'superig.com.br',
  'sapo.pt',
  'pm.me',
  'fastmail.com',
  'fastmail.fm',
  'tutanota.com',
  'tutanota.de',
  'tutamail.com',
  'tuta.io',
  'hey.com',
  'qq.com',
  'web.de',
]);

/**
 * Unmistakable webmail brands: under ANY ending ("yahoo.ne.jp", and a typo like "gmail.con" or
 * "hotmail.comm") the domain is still the provider, and a typo in the ending is exactly what a
 * lead form lets through. No company's own domain starts like these.
 */
const FREE_MAIL_ANY_ENDING =
  /^(?:gmail|googlemail|hotmail|outlook|yahoo|ymail|icloud|aol|msn|protonmail|rocketmail|yandex)\.[a-z]{2,6}(?:\.[a-z]{2,6})?$/;

/**
 * Shorter or more ordinary names (a company can be "live", "mail" or "r7"): only with a plain
 * ending ("com", "net", "org", "co", optionally with a country, or a country alone), so
 * "mail.empresa.com.br" or "r7.ind.br" stay companies.
 */
const FREE_MAIL_PLAIN_ENDING =
  /^(?:live|me|mac|uol|bol|terra|ig|globo|globomail|proton|zipmail|gmx|mail|zoho|ibest|superig|r7|sapo|fastmail|tutanota|tutamail|qq)\.(?:(?:com|net|org|co)(?:\.[a-z]{2})?|[a-z]{2})$/;

/** A free webmail (the lead's address says nothing about a company), by exact domain or by brand. */
export function isFreeMailDomain(domain: string): boolean {
  return (
    PERSONAL_EMAIL_DOMAINS.has(domain) ||
    FREE_MAIL_ANY_ENDING.test(domain) ||
    FREE_MAIL_PLAIN_ENDING.test(domain)
  );
}

export interface LeadEmailDomain {
  domain: string;
  /** `personal` is a webmail; `corporate` is anything else, which may be a company of the lead's. */
  kind: 'personal' | 'corporate';
}

export function normalizeEmail(raw: string | null | undefined): string | null {
  const email = raw?.trim().toLowerCase() ?? '';
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null;
}

export function emailDomainOf(email: string | null | undefined): LeadEmailDomain | null {
  const normalized = normalizeEmail(email);
  if (!normalized) return null;
  const domain = normalized.slice(normalized.indexOf('@') + 1);
  return { domain, kind: isFreeMailDomain(domain) ? 'personal' : 'corporate' };
}

// --- tracking codes -----------------------------------------------------------

/** No 0/O/1/I: the code is typed by nobody, but read by everybody. */
export const TRACKING_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const TRACKING_CODE_LENGTH = 6;
const TRACKING_CODE_RE = /^[A-HJ-NP-Z2-9]{6}$/;

/** A fresh code; `random` is injectable so tests get fixed codes. */
export function generateTrackingCode(random: () => number = Math.random): string {
  let code = '';
  for (let i = 0; i < TRACKING_CODE_LENGTH; i++) {
    const index = Math.min(
      TRACKING_CODE_ALPHABET.length - 1,
      Math.floor(random() * TRACKING_CODE_ALPHABET.length),
    );
    code += TRACKING_CODE_ALPHABET[index];
  }
  return code;
}

export function isTrackingCode(value: string): boolean {
  return TRACKING_CODE_RE.test(value);
}

/** `(K7M2QX)` or `(K7M2QX ABC234)`: the code, and the form's ref, in brackets (`siteLinkText`). */
const BRACKETED_CODES = /\(\s*#?([A-Za-z2-9]{6})(?:\s+([A-Za-z2-9]{6}))?\s*\)/g;

/** The last bracketed code in a message, with the ref after it when there is one. */
function bracketedCodesOf(message: string): { code: string; ref: string | null } | null {
  for (const match of [...message.matchAll(BRACKETED_CODES)].reverse()) {
    const code = match[1]?.toUpperCase() ?? '';
    const ref = match[2]?.toUpperCase() ?? '';
    if (isTrackingCode(code)) return { code, ref: isTrackingCode(ref) ? ref : null };
  }
  return null;
}

/**
 * The code an inbound WhatsApp message carries, or null: its first word (a
 * leading `#` and surrounding spaces are ignored; the rest is the person's own
 * text), else the last code in brackets, where the Wings site's sentence puts
 * it (`siteLinkText`).
 */
export function trackingCodeOf(message: string | null | undefined): string | null {
  const first = (message ?? '').trim().replace(/^#/, '').split(/\s+/)[0]?.toUpperCase() ?? '';
  if (isTrackingCode(first)) return first;
  return bracketedCodesOf(message ?? '')?.code ?? null;
}

/**
 * What a tracked link pre-fills: the code first (the inbound side reads only
 * the first word), then the brand, so the person and whoever answers see
 * which franchise it is about.
 */
export function trackedLinkText(code: string, brand?: string | null, ref?: string | null): string {
  const start = ref ? `${code} ${ref}` : code;
  return brand ? `${start} Olá! Quero saber sobre a franquia ${brand}.` : start;
}

/**
 * What the Wings site's link pre-fills: a sentence a person would send, with
 * the code (and the form's ref) in brackets at the end. A bare code reads as
 * junk and was not being sent (Eric, 22/10); `trackingCodeOf` and
 * `trackingRefOf` read the brackets.
 */
export function siteLinkText(code: string, ref?: string | null): string {
  return `Olá! Vim pelo site da Wings e quero saber como formatar a minha franquia. (${ref ? `${code} ${ref}` : code})`;
}

/**
 * The short reference of one site-form submission: six characters of the tracking-code alphabet,
 * stored on the lead (`leads.form_ref`) and sent in the wa.me text right after the link's code
 * (`<code> <ref>`), so the first WhatsApp message can be tied to the lead the form made.
 */
export const FORM_REF_LENGTH = 6;
export function generateFormRef(random: () => number = Math.random): string {
  let ref = '';
  for (let i = 0; i < FORM_REF_LENGTH; i++) {
    const index = Math.min(
      TRACKING_CODE_ALPHABET.length - 1,
      Math.floor(random() * TRACKING_CODE_ALPHABET.length),
    );
    ref += TRACKING_CODE_ALPHABET[index];
  }
  return ref;
}

/**
 * The form reference an inbound message carries: the word right after the tracking code, when the
 * message starts with one, else the one after the code in brackets (`siteLinkText`). The shape is
 * only a hint; a ref counts when a recent lead holds it.
 */
export function trackingRefOf(message: string | null | undefined): string | null {
  const words = (message ?? '').trim().replace(/^#/, '').split(/\s+/);
  if (!isTrackingCode(words[0]?.toUpperCase() ?? '')) {
    return bracketedCodesOf(message ?? '')?.ref ?? null;
  }
  const second = words[1]?.toUpperCase() ?? '';
  return isTrackingCode(second) ? second : null;
}

/**
 * `https://wa.me/5521999470288?text=K7M2QX%20Ol%C3%A1!...` Every tracked link,
 * Expansão brands included, opens the Wings WhatsApp (Eric, 01/10): the brand
 * is told by the code and the text, never by sending the lead to the brand's
 * own number, which stays on the client record as a contact only.
 */
export function whatsappLinkOf(
  phone: string,
  code: string,
  brand?: string | null,
  ref?: string | null,
): string {
  return wameLinkOf(phone, trackedLinkText(code, brand, ref));
}

/** `https://wa.me/<phone>?text=<text>`, the text encoded. */
export function wameLinkOf(phone: string, text: string): string {
  return `https://wa.me/${phone}?text=${encodeURIComponent(text)}`;
}

// --- source rules: landing page / Meta form -> client -------------------------

export const LEAD_SOURCE_RULE_KINDS = [
  'landing_page',
  'meta_form',
  'meta_campaign',
  'tiktok_form',
  'tiktok_campaign',
  'google_form',
  'google_campaign',
] as const;
export type LeadSourceRuleKind = (typeof LEAD_SOURCE_RULE_KINDS)[number];

export const LEAD_SOURCE_RULE_KIND_LABELS: Record<LeadSourceRuleKind, string> = {
  landing_page: 'Landing page (slug, domínio ou identificador da conversão)',
  meta_form: 'Formulário do Meta Lead Ads (id do formulário)',
  meta_campaign: 'Campanha do Meta (id da campanha)',
  tiktok_form: 'Formulário do TikTok Lead Ads (id do formulário)',
  tiktok_campaign: 'Campanha do TikTok (id da campanha)',
  google_form: 'Formulário de lead do Google Ads (id do formulário)',
  google_campaign: 'Campanha do Google Ads (id da campanha)',
};

export interface LeadSourceRule {
  id: string;
  kind: LeadSourceRuleKind;
  pattern: string;
  /** Null while the rule names a brand that is not a client yet (see `brand`). */
  clientId: string | null;
  clientName: string | null;
  pipeline: LeadPipeline | null;
  brand: string | null;
  active: boolean;
  createdAt: string;
}

/** The franchise landing pages live at franquia.wingscompany.com.br/<slug>. */
export const FRANCHISE_LP_HOST = 'franquia.wingscompany.com.br';

/** Lower-case, no scheme, no `www.`, no query, no trailing slash. */
export function normalizeSourcePattern(pattern: string): string {
  return pattern
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/[?#].*$/, '')
    .replace(/\/+$/, '');
}

/**
 * Every key a landing-page rule may match for one conversion: the full
 * address, the host alone, the first path segment (the franchise slug when
 * the host is one of ours, `franchiseHosts`) and the raw identifier RD
 * Station sent. The API passes FRANCHISE_LP_HOST plus the host of its
 * configured base (LANDING_PAGE_BASE_URL), so a page keeps mapping while it moves.
 */
export function landingPageKeysOf(
  input: {
    url?: string | null;
    identifier?: string | null;
  },
  franchiseHosts: readonly string[] = [FRANCHISE_LP_HOST],
): string[] {
  const ours = new Set(franchiseHosts.map(normalizeSourcePattern));
  const keys = new Set<string>();
  if (input.identifier) keys.add(normalizeSourcePattern(input.identifier));
  if (input.url) {
    const address = normalizeSourcePattern(input.url);
    if (address) keys.add(address);
    const [host = '', ...segments] = address.split('/');
    if (host) keys.add(host);
    const slug = segments.find((segment) => segment.length > 0);
    if (slug) {
      keys.add(`${host}/${slug}`);
      if (ours.has(host)) keys.add(slug);
    }
  }
  keys.delete('');
  return [...keys];
}

/** The rule a set of keys matches, the most specific (longest) pattern first. */
export function matchSourceRule<Rule extends { kind: LeadSourceRuleKind; pattern: string }>(
  rules: readonly Rule[],
  kind: LeadSourceRuleKind,
  keys: readonly string[],
): Rule | null {
  const wanted = new Set(keys.map(normalizeSourcePattern));
  const candidates = rules
    .filter((rule) => rule.kind === kind && wanted.has(normalizeSourcePattern(rule.pattern)))
    .sort((a, b) => b.pattern.length - a.pattern.length);
  return candidates[0] ?? null;
}

// --- expansion area -----------------------------------------------------------

export const BRAZIL_UFS = [
  'AC',
  'AL',
  'AP',
  'AM',
  'BA',
  'CE',
  'DF',
  'ES',
  'GO',
  'MA',
  'MT',
  'MS',
  'MG',
  'PA',
  'PB',
  'PR',
  'PE',
  'PI',
  'RJ',
  'RN',
  'RS',
  'RO',
  'RR',
  'SC',
  'SP',
  'SE',
  'TO',
] as const;
export type BrazilUf = (typeof BRAZIL_UFS)[number];

/** One entry of a client's expansion area: a whole state, or a city in it. */
export interface ExpansionEntry {
  uf: BrazilUf;
  city: string | null;
}

const plainText = (text: string) =>
  text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

/**
 * "SP", "Campinas/SP", "Campinas - SP" and "Campinas, SP" are all accepted;
 * anything else is refused so the area stays checkable against the DDD table.
 */
export function parseExpansionEntry(raw: string): ExpansionEntry | null {
  const text = raw.trim();
  const ufOnly = text.toUpperCase();
  if ((BRAZIL_UFS as readonly string[]).includes(ufOnly))
    return { uf: ufOnly as BrazilUf, city: null };
  const match = /^(.+?)\s*[/,\-–]\s*([A-Za-z]{2})$/.exec(text);
  if (!match) return null;
  const uf = (match[2] as string).toUpperCase();
  const city = (match[1] as string).trim();
  if (!(BRAZIL_UFS as readonly string[]).includes(uf) || city.length < 2) return null;
  return { uf: uf as BrazilUf, city };
}

export function formatExpansionEntry(entry: ExpansionEntry): string {
  return entry.city ? `${entry.city}/${entry.uf}` : entry.uf;
}

// --- enrichment facts ---------------------------------------------------------

export type FoundLinkKind = 'linkedin' | 'instagram' | 'other';

export interface FoundLink {
  kind: FoundLinkKind;
  url: string;
  title: string;
  snippet: string;
}

export interface LeadCompany {
  cnpj: string;
  name: string;
  legalName: string;
  /** In reais, as the Receita publishes it; null when it did not say. */
  capitalSocialBrl: number | null;
  openedAt: string | null;
  mainActivity: string | null;
  /** ME, EPP, DEMAIS or whatever the Receita answered. */
  size: string | null;
  city: string | null;
  uf: string | null;
  /** The lead's name appears in the company's partners (QSA). */
  leadIsPartner: boolean;
  /** How the company was tied to the lead, for the reasons column. */
  matchedBy: 'partner' | 'email_domain';
}

export interface LeadWhatsappProfile {
  profileName: string | null;
  photoUrl: string | null;
}

// --- company research by web search + model (OpenRouter) --------------------------

/** What the research tries to say about the company, in the order the card shows it. */
export const WEB_RESEARCH_FIELD_KEYS = [
  'activity',
  'location',
  'size',
  'time_in_market',
  'online_presence',
] as const;
export type WebResearchFieldKey = (typeof WEB_RESEARCH_FIELD_KEYS)[number];

export const WEB_RESEARCH_FIELD_LABELS: Record<WebResearchFieldKey, string> = {
  activity: 'O que a empresa faz',
  location: 'Cidade e estado',
  size: 'Porte',
  time_in_market: 'Tempo de mercado',
  online_presence: 'Presença online',
};

/** done: it ran; skipped: nothing to search; refused: the daily ceiling; failed: the provider did not answer. */
export type WebResearchStatus = 'done' | 'skipped' | 'refused' | 'failed';

export interface WebResearchField {
  key: WebResearchFieldKey;
  /** Null when the sources did not say; then `reason` says why. Never a guess. */
  value: string | null;
  reason: string | null;
  /**
   * The page that backs `value`: always one of the result's `sources`, never a link the model
   * made up. A value without it is not shown ("—"). Absent on research stored before 14/10/2026.
   */
  sourceUrl?: string | null;
}

export interface WebResearchSource {
  url: string;
  title: string | null;
}

/**
 * What the web research of the lead's COMPANY found (company name, site,
 * Instagram and a corporate e-mail domain were the only things sent; research
 * stored before 14/10/2026 may also have sent a CNPJ). `sources` are the pages
 * the search itself returned, never links the model wrote.
 */
export interface LeadWebResearch {
  status: WebResearchStatus;
  /** When the research ran (ISO 8601). */
  at: string;
  /** Why there is nothing, when `status` is not "done". */
  reason: string | null;
  fields: WebResearchField[];
  sources: WebResearchSource[];
  model: string | null;
}

/**
 * A finished research stored before each value named its page (until 14/10/2026 20:53Z on staging):
 * its fields have no `sourceUrl` at all, so the deal page shows "—" for every one. It cannot be
 * upgraded without asking again (nothing says which page backs which value), so it is the one kind
 * of finished research that may be redone. A research that already names a page for its values,
 * or has none to show, is not.
 */
export function isLegacyWebResearch(research: LeadWebResearch | null | undefined): boolean {
  return (
    research?.status === 'done' &&
    research.sources.length > 0 &&
    // Something is hidden: a research whose values are all "sem dado" has nothing to recover.
    research.fields.some((field) => field.value !== null) &&
    research.fields.every((field) => field.sourceUrl === undefined)
  );
}

/** The day (São Paulo, YYYY-MM-DD) from which a lead is researched, unless the worker's LEAD_RESEARCH_SINCE says otherwise. */
export const LEAD_RESEARCH_DEFAULT_SINCE = '2026-10-14';

/**
 * Whether a lead is inside the research cut-off: it arrived, by the earlier of its creation and its
 * entry (a lead imported today from an old deal is old), from 00:00 of `since` in São Paulo
 * (UTC-3 all year) on. The worker decides with the same rule; the page uses it to offer a new
 * research only where the worker will accept it.
 */
export function arrivedFromResearchCutoff(
  lead: { createdAt: string; enteredAt?: string | null },
  since: string = LEAD_RESEARCH_DEFAULT_SINCE,
): boolean {
  const start = new Date(`${since}T03:00:00Z`).getTime();
  const created = new Date(lead.createdAt).getTime();
  const entered = lead.enteredAt ? new Date(lead.enteredAt).getTime() : created;
  return Math.min(created, entered) >= start;
}

/** Everything the worker found. Every field may be null: a step that failed leaves its fact empty. */
export interface EnrichmentFacts {
  region: LeadRegion | null;
  emailDomain: LeadEmailDomain | null;
  whatsapp: LeadWhatsappProfile | null;
  links: FoundLink[];
  company: LeadCompany | null;
  /** How many web searches were run (each is a paid call). */
  searches: number;
  /** The company research (OpenRouter); absent on leads researched before it existed. */
  webResearch?: LeadWebResearch | null;
}

export const EMPTY_FACTS: EnrichmentFacts = {
  region: null,
  emailDomain: null,
  whatsapp: null,
  links: [],
  company: null,
  searches: 0,
};

// --- the score ----------------------------------------------------------------

export type ScoreCriterionKey = 'capital' | 'management' | 'location';

export interface ScoreCriterion {
  key: ScoreCriterionKey;
  label: string;
  points: number;
  max: number;
  /** False when nothing allowed a judgement (no phone, no expansion area): left out of the total. */
  evaluated: boolean;
  reasons: string[];
}

export interface FranchiseeScore {
  /** 0–100 over the criteria that could be evaluated; null when none could. */
  score: number | null;
  criteria: ScoreCriterion[];
}

const MANAGEMENT_TERMS =
  /\b(s[oó]ci[oa]|fundador|founder|co-?founder|ceo|cfo|coo|diret|gerent|propriet[aá]ri|empres[aá]ri|owner|head of|coordenad|supervis|gestor)/i;

const formatBrl = (value: number) => `R$ ${Math.round(value).toLocaleString('pt-BR')}`;

/**
 * "Perfil de franqueado", 0–100, from three explainable criteria: probable
 * capital (40), management experience (30) and the region against the
 * client's expansion area (30). Every point comes with its reason, and a
 * criterion nothing could judge is left out of the total instead of counting
 * as zero.
 */
export function franchiseeScoreOf(
  facts: EnrichmentFacts,
  expansionArea: readonly ExpansionEntry[],
): FranchiseeScore {
  const capital: ScoreCriterion = {
    key: 'capital',
    label: 'Capital provável',
    points: 0,
    max: 40,
    evaluated: true,
    reasons: [],
  };
  if (facts.company?.leadIsPartner) {
    capital.points += 15;
    capital.reasons.push(
      `Consta como sócio de ${facts.company.name} (CNPJ ${facts.company.cnpj}).`,
    );
  }
  if (facts.company && facts.company.capitalSocialBrl !== null) {
    const value = facts.company.capitalSocialBrl;
    if (value >= 100_000) {
      capital.points += 15;
      capital.reasons.push(`Capital social de ${formatBrl(value)} na empresa encontrada.`);
    } else if (value >= 30_000) {
      capital.points += 8;
      capital.reasons.push(`Capital social de ${formatBrl(value)} na empresa encontrada.`);
    } else {
      capital.reasons.push(
        `Capital social de ${formatBrl(value)} na empresa encontrada, abaixo de R$ 30.000.`,
      );
    }
  }
  if (facts.emailDomain?.kind === 'corporate') {
    capital.points += 10;
    capital.reasons.push(`E-mail em domínio próprio (${facts.emailDomain.domain}).`);
  } else if (facts.emailDomain?.kind === 'personal') {
    capital.reasons.push(`E-mail pessoal (${facts.emailDomain.domain}).`);
  }
  if (capital.reasons.length === 0) capital.reasons.push('Nenhum sinal de capital encontrado.');

  const management: ScoreCriterion = {
    key: 'management',
    label: 'Experiência em gestão',
    points: 0,
    max: 30,
    evaluated: true,
    reasons: [],
  };
  const linkedin = facts.links.find((link) => link.kind === 'linkedin');
  if (linkedin) {
    management.points += 5;
    management.reasons.push('Perfil público no LinkedIn encontrado.');
  }
  const managementHit = facts.links.find(
    (link) => MANAGEMENT_TERMS.test(link.title) || MANAGEMENT_TERMS.test(link.snippet),
  );
  if (managementHit) {
    management.points += 15;
    const term = (MANAGEMENT_TERMS.exec(`${managementHit.title} ${managementHit.snippet}`) ?? [
      '',
    ])[0];
    management.reasons.push(`Cargo de gestão citado em resultado público ("${term}").`);
  }
  if (facts.company?.leadIsPartner) {
    management.points += 10;
    management.reasons.push('Sócio ou administrador de empresa ativa na Receita.');
  }
  if (management.reasons.length === 0)
    management.reasons.push('Nenhum sinal de gestão encontrado.');

  const location: ScoreCriterion = {
    key: 'location',
    label: 'Cidade na área de expansão',
    points: 0,
    max: 30,
    evaluated: true,
    reasons: [],
  };
  if (!facts.region) {
    location.evaluated = false;
    location.reasons.push('Sem telefone com DDD conhecido: região não avaliada.');
  } else if (expansionArea.length === 0) {
    location.evaluated = false;
    location.reasons.push('O cliente não tem área de expansão cadastrada: região não avaliada.');
  } else {
    const region = facts.region;
    const cityHit = expansionArea.find(
      (entry) =>
        entry.city !== null &&
        entry.uf === region.uf &&
        plainText(entry.city) === plainText(region.city),
    );
    const ufHit = expansionArea.find((entry) => entry.uf === region.uf);
    if (cityHit) {
      location.points = 30;
      location.reasons.push(
        `DDD ${region.ddd} é a região de ${region.city}/${region.uf}, cidade da área de expansão.`,
      );
    } else if (ufHit) {
      location.points = 15;
      location.reasons.push(
        `DDD ${region.ddd} (região de ${region.city}/${region.uf}): o estado está na área de expansão, a cidade não.`,
      );
    } else {
      location.reasons.push(
        `DDD ${region.ddd} (região de ${region.city}/${region.uf}) fora da área de expansão.`,
      );
    }
  }

  const criteria = [capital, management, location];
  const evaluated = criteria.filter((criterion) => criterion.evaluated);
  const max = evaluated.reduce((sum, criterion) => sum + criterion.max, 0);
  const points = evaluated.reduce((sum, criterion) => sum + criterion.points, 0);
  return { score: max === 0 ? null : Math.round((100 * points) / max), criteria };
}

// --- the summary --------------------------------------------------------------

/** Five lines, one per subject, each a full sentence a seller can read in a glance. */
export function enrichmentSummaryOf(
  lead: { name: string | null },
  facts: EnrichmentFacts,
  score: FranchiseeScore,
): string {
  const name = lead.name ?? 'Lead sem nome';
  const where = facts.region
    ? `região de ${facts.region.city}/${facts.region.uf} pelo DDD ${facts.region.ddd}`
    : 'região desconhecida (sem telefone)';
  const email = facts.emailDomain
    ? facts.emailDomain.kind === 'corporate'
      ? `e-mail em domínio próprio (${facts.emailDomain.domain})`
      : `e-mail pessoal (${facts.emailDomain.domain})`
    : 'sem e-mail';
  const line1 = `${name}: ${where}; ${email}.`;

  const line2 = facts.whatsapp
    ? `WhatsApp: perfil "${facts.whatsapp.profileName ?? 'sem nome'}"${facts.whatsapp.photoUrl ? ', com foto' : ', sem foto'}.`
    : 'WhatsApp: perfil não consultado.';

  const linkedin = facts.links.find((link) => link.kind === 'linkedin');
  const instagram = facts.links.find((link) => link.kind === 'instagram');
  const presence = [
    linkedin ? `LinkedIn: ${linkedin.title || linkedin.url}` : null,
    instagram ? `Instagram: ${instagram.title || instagram.url}` : null,
  ].filter((part): part is string => part !== null);
  const line3 =
    presence.length > 0
      ? `${presence.join('; ')}.`
      : facts.searches > 0
        ? `Nenhum perfil público encontrado em ${facts.searches} busca(s).`
        : 'Busca web não realizada.';

  const company = facts.company;
  const line4 = company
    ? `Empresa: ${company.name} (CNPJ ${company.cnpj})${company.capitalSocialBrl !== null ? `, capital social ${formatBrl(company.capitalSocialBrl)}` : ''}${company.openedAt ? `, desde ${company.openedAt.slice(0, 4)}` : ''}${company.mainActivity ? `, ${company.mainActivity}` : ''}; ${company.leadIsPartner ? 'o lead consta como sócio' : 'ligada pelo domínio do e-mail'}.`
    : 'Empresa: nenhum CNPJ ligado ao lead.';

  const parts = score.criteria.map((criterion) =>
    criterion.evaluated
      ? `${criterion.label.toLowerCase()} ${criterion.points}/${criterion.max}`
      : `${criterion.label.toLowerCase()} não avaliada`,
  );
  const line5 =
    score.score === null
      ? `Perfil de franqueado: sem nota (${parts.join(', ')}).`
      : `Perfil de franqueado: ${score.score}/100 (${parts.join(', ')}).`;

  return [line1, line2, line3, line4, line5].join('\n');
}

// --- what the screen receives ---------------------------------------------------

export type LeadEnrichmentState = 'none' | 'pending' | 'running' | 'done' | 'failed';

export interface LeadOrigin {
  clientId: string;
  clientName: string;
  /** False when no rule mapped the landing page or form: filed under Wings Company until someone adds one. */
  clientMapped: boolean;
  source: LeadSource;
  channel: LeadChannel | null;
  landingPage: string | null;
  campaignId: string | null;
  campaignName: string | null;
  formId: string | null;
  trackingCode: string | null;
  externalId: string | null;
  /** The ad behind the lead, by the ids the lead keeps, with the names the ad tables know. */
  ad: LeadOriginAd | null;
  /** The UTMs the visit carried; null when none. */
  utm: LeadOriginUtm | null;
  /** RD's origin label for the visit or the deal ("Tráfego Direto", "Busca Paga | Google"…). */
  trafficSource: string | null;
  /** The form that converted: RD's `conversion_identifier`, or the site form's page. */
  conversionIdentifier: string | null;
}

/** An ad object by its platform id; `name` is null when our copy of the account does not have it. */
export interface LeadOriginRef {
  externalId: string;
  name: string | null;
}

export interface LeadOriginAd {
  /** 'meta', 'google', 'tiktok'… as the lead says. */
  platform: string | null;
  campaign: LeadOriginRef | null;
  adSet: LeadOriginRef | null;
  ad: LeadOriginRef | null;
}

export interface LeadOriginUtm {
  source: string | null;
  medium: string | null;
  campaign: string | null;
  content: string | null;
  term: string | null;
}

export interface LeadConsent {
  legalBasis: LeadLegalBasis | null;
  consentedAt: string | null;
  source: string | null;
  text: string | null;
}

export interface LeadResearch {
  state: LeadEnrichmentState;
  summary: string | null;
  score: number | null;
  criteria: ScoreCriterion[];
  links: FoundLink[];
  facts: EnrichmentFacts | null;
  error: string | null;
  updatedAt: string | null;
  costUsd: number;
}

export interface LeadEvent {
  id: string;
  at: string;
  kind: string;
  detail: Record<string, unknown>;
}

export interface LeadFormFields {
  instagram: string | null;
  website: string | null;
  companyName: string | null;
  cnpj: string | null;
}

/**
 * Whose clock a lead's `enteredAt` is. 'received' = the source brought no date, so it is when the
 * system received the lead (the screens say "recebido pelo sistema").
 */
export const LEAD_ENTERED_SOURCES = [
  'meta_created_time',
  'tiktok_created_time',
  'rd_deal_created',
  'rd_conversion',
  'form_submitted',
  'whatsapp_message',
  'received',
] as const;
export type LeadEnteredSource = (typeof LEAD_ENTERED_SOURCES)[number];

export const LEAD_ENTERED_SOURCE_LABELS: Record<LeadEnteredSource, string> = {
  meta_created_time: 'data de criação do lead na Meta',
  tiktok_created_time: 'data de criação do lead no TikTok',
  rd_deal_created: 'data de criação do negócio no RD',
  rd_conversion: 'data da conversão no RD Marketing',
  form_submitted: 'hora do envio do formulário',
  whatsapp_message: 'hora da primeira mensagem no WhatsApp',
  received: 'recebido pelo sistema',
};

/** A source's date more than this far ahead of now is a clock error: the lead gets the receipt time. */
export const LEAD_ENTERED_FUTURE_TOLERANCE_MS = 5 * 60_000;

/**
 * The date and source a new lead is stored with: the source's own date when it brought a usable
 * one, else the moment the system received it. A date in the future (beyond a little clock skew)
 * or not a real date is not used.
 */
export function resolveLeadEntered(
  given: { enteredAt?: Date | null; enteredAtSource?: LeadEnteredSource | null },
  now: Date = new Date(),
): { enteredAt: Date; enteredAtSource: LeadEnteredSource } {
  const at = given.enteredAt;
  const source = given.enteredAtSource;
  if (
    !(at instanceof Date) ||
    Number.isNaN(at.getTime()) ||
    at.getTime() > now.getTime() + LEAD_ENTERED_FUTURE_TOLERANCE_MS ||
    source == null ||
    source === 'received'
  ) {
    return { enteredAt: now, enteredAtSource: 'received' };
  }
  return { enteredAt: at.getTime() > now.getTime() ? now : at, enteredAtSource: source };
}

export interface Lead {
  id: string;
  name: string | null;
  email: string | null;
  phone: string | null;
  /** The city the person gave on a form, as typed; null when none. */
  city: string | null;
  /** A form's other answers (question -> answer), without the contact fields; null when none. */
  formAnswers: Record<string, string> | null;
  /** The form fields in their own place (Instagram, site, company, CNPJ); null when the form did not bring them. */
  fields: LeadFormFields;
  /** What was checked on arrival, per field; a missing key = not checked yet. */
  checks: LeadChecks;
  status: 'new';
  ownerEmployeeId: string | null;
  firstMessage: string | null;
  whatsapp: LeadWhatsappProfile | null;
  origin: LeadOrigin;
  pipeline: LeadPipeline | null;
  brand: string | null;
  /** Estimated value of the deal in cents; null while nobody said. */
  valueCents: number | null;
  /** The day the seller expects to close, `AAAA-MM-DD`; null while nobody said. */
  expectedCloseAt: string | null;
  /** The company the deal is with, when one is tied. */
  company: { id: string; name: string; clientId: string | null } | null;
  /** The people of the deal; the main one first. */
  contacts: LeadContactRef[];
  /** Where the lead is in the Wings System's funnel (CRM Fase 1). */
  work: LeadWork;
  /** The RD CRM deal, when the lead has one. */
  crm: LeadCrm | null;
  consent: LeadConsent;
  /** The Google Maps place the lead came from (Prospecção); only the id is kept, the rest is read live. */
  googlePlaceId: string | null;
  research: LeadResearch;
  /** The AI summary of the deal (ficha do cliente, Etapa 4); null until asked for. */
  aiSummary: LeadAiSummary | null;
  /** Marked as a likely robot sign-up, with the reasons; null when not (or cleared by a person). */
  suspect: LeadSuspect | null;
  /** The Instagram check of a site-form lead (docs/leads/instagram.md); null when none was made. */
  instagramCheck: LeadInstagramCheck | null;
  /** When the person entered, by the source's own clock (see `LEAD_ENTERED_SOURCES`). */
  enteredAt: string;
  enteredAtSource: LeadEnteredSource;
  createdAt: string;
  updatedAt: string;
}

/**
 * The signs of the robot that fills the brands' pages with made-up people
 * (Grupo Forte Fênix, October 2026). A lead is marked when it has the robot's
 * e-mail and a capital's DDD, and also comes in a burst or by direct traffic.
 * Marking never closes, loses or deletes the lead: the seller confirms.
 */
export const LEAD_SUSPECT_REASONS = {
  robot_email: 'E-mail nome.sobrenome + 10 dígitos @gmail.com, e os dígitos não são o telefone',
  capital_ddd: 'Telefone com DDD de capital',
  burst: '4 envios ou mais em até 3 minutos na mesma página',
  direct_traffic: 'Origem Tráfego Direto: sem UTM, clique de anúncio nem página de origem',
} as const;
export type LeadSuspectReason = keyof typeof LEAD_SUSPECT_REASONS;

/** The DDDs of the capitals the robot uses. */
export const SUSPECT_CAPITAL_DDDS = ['11', '21', '31', '41', '51', '61', '81', '85', '91'] as const;

export interface LeadSuspect {
  reasons: LeadSuspectReason[];
  /** When the system marked it. */
  at: string;
}

export interface LeadListItem {
  id: string;
  name: string | null;
  email: string | null;
  phone: string | null;
  clientName: string;
  clientMapped: boolean;
  source: LeadSource;
  channel: LeadChannel | null;
  score: number | null;
  researchState: LeadEnrichmentState;
  enteredAt: string;
  enteredAtSource: LeadEnteredSource;
  createdAt: string;
  /** CRM phase 1: funnel, brand and the stage read from RD CRM (null when the lead has no RD deal). */
  pipeline: LeadPipeline | null;
  brand: string | null;
  stage: string | null;
  won: boolean | null;
  valueCents: number | null;
  /** The day the seller expects to close, `AAAA-MM-DD`; null while nobody said. */
  expectedCloseAt: string | null;
  companyName: string | null;
  city: string | null;
  campaignName: string | null;
  lastActivityAt: string | null;
  nextTask: { title: string; dueAt: string } | null;
  ownerEmployeeId: string | null;
  ownerName: string | null;
  /**
   * The RD deal's owner is no one of ours who still works it: no owner, an
   * RD user inactive in RD, one marked "saiu da empresa", or one not linked
   * to an employee. False when the lead has no RD deal.
   */
  ownerInactive: boolean;
  /** When the deal entered its current stage; null when unknown (never a guess). */
  stageChangedAt: string | null;
}

/** The lead's place in the Wings funnel: stage, owner and outcome, as the team works it here. */
export interface LeadWork {
  stageId: string | null;
  stage: string | null;
  stageChangedAt: string | null;
  won: boolean | null;
  closedAt: string | null;
  lostReason: string | null;
  ownerName: string | null;
  /** `wings` once the Wings System runs it; `rd` while it only mirrors RD CRM. */
  managedBy: 'wings' | 'rd';
}

/** The deal of a lead in RD CRM, as last read (a copy since 05/10/2026). */
export interface LeadCrm {
  rdDealId: string;
  rdUrl: string;
  rdPipeline: string | null;
  stage: string | null;
  stageOrder: number | null;
  stageChangedAt: string | null;
  firstContactAt: string | null;
  won: boolean | null;
  closedAt: string | null;
  lostReason: string | null;
  ownerName: string | null;
  syncedAt: string | null;
}

export const rdDealUrl = (rdDealId: string) => `https://crm.rdstation.com/app/deals/${rdDealId}`;

/** One line of the mini-funnel at the top of the Funil: a brand of Expansão, or Formatação. */
export interface FunnelSummaryRow {
  pipeline: LeadPipeline;
  /** The brand, or "Formatação"; "(sem marca)" for Expansão leads no one named. */
  label: string;
  arrived: number;
  /** Left the first stage, or closed. */
  worked: number;
  /** At "Reunião realizada" or later, or won (RD keeps no history of lost ones). */
  meeting: number;
  won: number;
}

export interface FunnelSummary {
  days: number;
  rows: FunnelSummaryRow[];
  /** The owners and stages present, for the filters. */
  owners: { id: string; name: string }[];
  /** Open deals whose owner is inactive (see `LeadListItem.ownerInactive`), in the caller's scope. */
  inactiveOwnerOpen: number;
  stages: { pipeline: LeadPipeline; stage: string; order: number }[];
  /** Last time a lead's stage was read from RD CRM; null when never. */
  syncedAt: string | null;
}

/** The owner filter's value for deals with no active owner of ours. */
export const INACTIVE_OWNER = 'inactive';
export const INACTIVE_OWNER_LABEL = 'Dono inativo';
/** The owner filter's value for deals nobody owns (e.g. brought from RD without a seller of ours). */
export const NO_OWNER = 'none';
export const NO_OWNER_LABEL = 'Sem dono';

export const LEAD_OUTCOMES = ['open', 'won', 'lost'] as const;
export type LeadOutcome = (typeof LEAD_OUTCOMES)[number];
export const LEAD_OUTCOME_LABELS: Record<LeadOutcome, string> = {
  open: 'Em andamento',
  won: 'Ganho',
  lost: 'Perdido',
};

export interface LeadTrackingLink {
  id: string;
  clientId: string;
  channel: LeadLinkChannel;
  code: string;
  /** The Wings number the link opens, digits only, as it was when the link was made. */
  phone: string;
  url: string;
  /** False when WINGS_WHATSAPP_NUMBER changed since: the link opens a number that is no longer Wings'. */
  current: boolean;
  hits: number;
  lastHitAt: string | null;
  createdAt: string;
}

// --- request schemas ------------------------------------------------------------

export const LEAD_NAME_MAX = 120;

/**
 * "Criar negociação": the deal's name is the person's (the contact), with the
 * company, funnel, stage, owner (the rotation when left empty), value and
 * where it came from. Phone or e-mail is required so the person is found
 * again. The LGPD basis is kept, with a short default for a deal typed in.
 */
export const leadCreateSchema = z.object({
  name: z.string().trim().min(2, 'Informe o nome').max(LEAD_NAME_MAX),
  email: z.string().trim().max(200).optional().or(z.literal('')),
  phone: z.string().trim().max(30).optional().or(z.literal('')),
  companyName: z.string().trim().max(120).optional().or(z.literal('')),
  /** The brand of interest (Expansão) or the client; optional. */
  clientId: z.uuid().optional().or(z.literal('')),
  pipeline: z.enum(LEAD_PIPELINES).optional().or(z.literal('')),
  stageId: z.uuid().optional().or(z.literal('')),
  /** Empty: the funnel's rotation decides; `me` is the caller. */
  ownerEmployeeId: z.uuid().optional().or(z.literal('')).or(z.literal('me')),
  valueCents: z.number().int().min(0).max(100_000_000_00).nullable().optional(),
  channel: z.enum(LEAD_CHANNELS).optional().or(z.literal('')),
  legalBasis: z.enum(LEAD_LEGAL_BASES).default('legitimate_interest'),
  consentText: z.string().trim().max(500).optional().or(z.literal('')),
});
export type LeadCreateInput = z.infer<typeof leadCreateSchema>;

export const trackingLinkCreateSchema = z.object({
  channel: z.enum(LEAD_LINK_CHANNELS),
});

export const sourceRuleCreateSchema = z.object({
  kind: z.enum(LEAD_SOURCE_RULE_KINDS),
  pattern: z
    .string()
    .trim()
    .min(2, 'Informe o padrão')
    .max(200)
    .transform(normalizeSourcePattern)
    .refine((pattern) => pattern.length >= 2, 'Informe o padrão'),
  clientId: z.uuid(),
  pipeline: z.enum(LEAD_PIPELINES).optional(),
});

export const EXPANSION_AREA_MAX = 200;

export const expansionAreaSchema = z.object({
  expansionArea: z
    .array(z.string().trim().min(2).max(80))
    .max(EXPANSION_AREA_MAX)
    .transform((entries, ctx) => {
      const parsed: ExpansionEntry[] = [];
      for (const raw of entries) {
        const entry = parseExpansionEntry(raw);
        if (!entry) {
          ctx.addIssue({
            code: 'custom',
            message: `"${raw}" não é uma UF nem "Cidade/UF".`,
          });
          return z.NEVER;
        }
        if (!parsed.some((seen) => seen.uf === entry.uf && seen.city === entry.city))
          parsed.push(entry);
      }
      return parsed;
    }),
});

export const leadListQuerySchema = z.object({
  q: z
    .string()
    .trim()
    .max(120)
    .optional()
    .or(z.literal('').transform(() => undefined)),
  clientId: z
    .uuid()
    .optional()
    .or(z.literal('').transform(() => undefined)),
  source: z
    .enum(LEAD_SOURCES)
    .optional()
    .or(z.literal('').transform(() => undefined)),
  pipeline: z
    .enum(LEAD_PIPELINES)
    .optional()
    .or(z.literal('').transform(() => undefined)),
  stage: z
    .string()
    .trim()
    .max(120)
    .optional()
    .or(z.literal('').transform(() => undefined)),
  /** An employee id, `inactive` for deals with an inactive owner (no one is reassigned), or `none` for deals with no owner. */
  owner: z
    .uuid()
    .or(z.literal(INACTIVE_OWNER))
    .or(z.literal(NO_OWNER))
    .optional()
    .or(z.literal('').transform(() => undefined)),
  outcome: z
    .enum(LEAD_OUTCOMES)
    .optional()
    .or(z.literal('').transform(() => undefined)),
  /** Open leads whose stage has not changed for more than this many days. */
  staleDays: z.coerce
    .number()
    .int()
    .min(1)
    .max(3650)
    .optional()
    .or(z.literal('').transform(() => undefined)),
  /** Created on or after / before (YYYY-MM-DD). */
  createdFrom: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional()
    .or(z.literal('').transform(() => undefined)),
  createdTo: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional()
    .or(z.literal('').transform(() => undefined)),
  /** Last activity (any event on the lead) within this many days, or `none` for no activity in the window. */
  activityDays: z.coerce
    .number()
    .int()
    .min(1)
    .max(3650)
    .optional()
    .or(z.literal('').transform(() => undefined)),
  /** Campaign name or id, as the lead carries it. */
  campaign: z
    .string()
    .trim()
    .max(200)
    .optional()
    .or(z.literal('').transform(() => undefined)),
  /** `mine` keeps only the caller's deals (the "Minhas" tab). */
  mine: z.coerce.boolean().optional(),
  /** Only deals whose Instagram check says suspect and/or fake (the seller's correction counts). */
  instagram: z
    .enum(INSTAGRAM_LIST_FILTERS)
    .optional()
    .or(z.literal('').transform(() => undefined)),
  /**
   * Open deals whose first contact is past its deadline while they still sit in the funnel's entry stage
   * ("Sem contato"): the list the "1º contato atrasado" counter of Negociações opens.
   */
  firstContactOverdue: z.coerce.boolean().optional(),
  sort: z
    .enum(['recent', 'oldest', 'value_desc', 'value_asc', 'stage_time', 'next_task', 'name'])
    .optional()
    .or(z.literal('').transform(() => undefined)),
});
export type LeadListQuery = z.infer<typeof leadListQuerySchema>;

export const LEAD_SORT_LABELS: Record<NonNullable<LeadListQuery['sort']>, string> = {
  recent: 'Entrada mais recente',
  oldest: 'Entrada mais antiga',
  value_desc: 'Maior valor',
  value_asc: 'Menor valor',
  stage_time: 'Mais tempo na etapa',
  next_task: 'Próxima tarefa',
  name: 'Nome',
};

export const funnelSummaryQuerySchema = z.object({
  days: z.coerce
    .number()
    .int()
    .refine((days) => days === 30 || days === 90, 'use 30 ou 90')
    .default(30),
});

// Routes (docs/leads/intake.md):
//   GET    /leads?q=&clientId=&source=            -> { leads: LeadListItem[] }         leads.read (own / all)
//   POST   /leads                                  -> { lead: Lead }                   leads.write
//   GET    /leads/:id                              -> { lead: Lead, events: LeadEvent[] } leads.read
//   POST   /leads/:id/research                     -> { lead: Lead }  (enqueue again)  leads.write
//   GET    /leads/source-rules                     -> { rules: LeadSourceRule[] }      clients.manage
//   POST   /leads/source-rules                     -> { rule }                         clients.manage
//   DELETE /leads/source-rules/:id                 -> 204                              clients.manage
//   GET    /clients/:id/tracking-links             -> { links: LeadTrackingLink[] }    clients.manage
//   POST   /clients/:id/tracking-links { channel } -> { link }                         clients.manage
//   PATCH  /clients/:id/expansion-area             -> { client }                       clients.manage
//   POST   /integrations/rd-station/webhook        (secret)                            no session
//   POST   /integrations/zapi/webhook              (secret)                            no session
//   GET    /integrations/meta/leadgen/webhook      (hub.verify_token)                  no session
//   POST   /integrations/meta/leadgen/webhook      (X-Hub-Signature-256)               no session

// --- CRM Vendas → Landing pages (CRM phase 1, Eric's list of 30/09) ---------------

/** A landing page: a source rule of kind `landing_page`, with its client and funnel. */
export interface LandingPageItem {
  id: string;
  /** The slug (or RD conversion identifier) the rule matches. */
  pattern: string;
  /** The public address, when the page was generated here or is known. */
  url: string | null;
  clientId: string | null;
  clientName: string | null;
  brand: string | null;
  pipeline: LeadPipeline | null;
  active: boolean;
  archivedAt: string | null;
  createdAt: string;
  /** Leads of the Funil that came through this page (webhook/site). */
  leads: number;
  performance: LandingPagePerformance;
  /** Whether the page takes the Wings System's own form (T5, `/lp/<slug>`). */
  siteFormEnabled: boolean;
  /**
   * The RD CRM deal source ("Origem") of the deals the intake makes for this
   * page's NEW conversions; null keeps the default (the "Referência | <host>"
   * source when RD has it, else "Contato pelo Site"). Never applied to deals
   * that already exist.
   */
  dealSource: string | null;
  /** Whether the Expansão intake makes RD CRM deals from this page's conversions. */
  rdDealIntake: boolean;
  /** YYYY-MM-DD the page was switched off in RD; the rule still maps its late conversions. */
  rdUnpublishedOn: string | null;
}

/** Only numbers with a source; a missing one is null with the reason. */
export interface LandingPagePerformance {
  visits: number | null;
  visitsSource: string | null;
  visitsReason: string | null;
  conversions: number | null;
  conversionsSource: string | null;
  conversionsSince: string | null;
  conversionsReason: string | null;
  /** conversions ÷ visits, only when both exist. */
  rate: number | null;
}

/**
 * Where franchise pages live today (RD Station) until our own pages replace
 * them: the default of the API's LANDING_PAGE_BASE_URL, which new rules use.
 */
export const LANDING_PAGE_BASE_URL = `https://${FRANCHISE_LP_HOST}`;

export const landingPageCreateSchema = z.object({
  clientId: z.uuid(),
  pipeline: z.enum(LEAD_PIPELINES),
  /** Optional: when absent the server makes one from the client's name. */
  slug: z
    .string()
    .trim()
    .max(80)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Use letras minúsculas, números e hífen')
    .optional()
    .or(z.literal('').transform(() => undefined)),
});
export type LandingPageCreateInput = z.infer<typeof landingPageCreateSchema>;

export const DEAL_SOURCE_MAX = 120;

/** CRM Vendas → Landing pages: what is edited on an existing page. */
export const landingPageUpdateSchema = z
  .object({
    siteFormEnabled: z.boolean().optional(),
    rdDealIntake: z.boolean().optional(),
    dealSource: z
      .string()
      .trim()
      .max(DEAL_SOURCE_MAX)
      .nullable()
      .optional()
      .transform((value) => (value === '' ? null : value)),
  })
  .refine(
    (body) =>
      body.siteFormEnabled !== undefined ||
      body.rdDealIntake !== undefined ||
      body.dealSource !== undefined,
    'Nada para alterar',
  );
export type LandingPageUpdateInput = z.infer<typeof landingPageUpdateSchema>;

// --- the site form (CRM phase 1, T5) --------------------------------------------
//
//   GET  /public/site-forms/:slug  -> SiteFormInfo     no session
//   POST /public/site-forms/:slug  -> { ok, whatsappUrl }  no session; Turnstile, honeypot, per-IP limit

/**
 * The page's approved spec as the public page reads it: the codes of the
 * question's options without the funnel each one leads to.
 */
export interface SiteFormPublicSpec {
  qualifier: { question: string; options: string[] } | null;
  privacyPolicyUrl: string;
  thankYou: { title: string; body: string; buttonText: string; buttonUrl: string };
  /** Asked on top of name, WhatsApp and consent; the API refuses a form without them. */
  requiredFields: SiteFormRequiredField[];
  /** When present, `qualifierAnswer` is one of these values (the option's code) or its text. */
  qualifierValues?: { value: string; option: string }[];
  /** The consent line the page shows and the lead keeps; absent: the funnel's (`siteFormCopyOf`). */
  consentText?: string;
}

/** What the public page needs to draw the form: no id, no client data beyond the brand's name. */
export interface SiteFormInfo {
  slug: string;
  brand: string;
  /** Cloudflare Turnstile's site key (public by design); null when not configured. */
  turnstileSiteKey: string | null;
  /** The brand's own Instagram, `@perfil`, or null. */
  instagram: string | null;
  /**
   * The page's standard form, when Diretoria approved one: the optional
   * multiple-choice question and the thank-you screen (`SiteFormSpec`); null
   * is the page's plain form.
   */
  form?: SiteFormPublicSpec | null;
  /**
   * The tracked "Site" link of the page's client on the current Wings
   * WhatsApp (the same one the POST answers), or null: no client, no number
   * configured, or no link made for it.
   */
  whatsappUrl: string | null;
  /** The page's funnel (its rule's); null when the rule does not say. The copy follows it. */
  pipeline?: LeadPipeline | null;
  /**
   * The ad platforms' conversion tags the page fires (2026-10-07): Meta's
   * pixel (PageView on load, Lead on a sent form) and Google Ads' conversion
   * (`AW-<id>/<label>`, on a sent form). Null means the tag is not loaded. Both
   * are public ids, set in the API's environment, never typed into the page.
   */
  tracking?: {
    metaPixelId: string | null;
    googleAdsConversion: string | null;
  };
}

/**
 * What the page says, by funnel: a Formatação page talks to the owner of a
 * business, an Expansão page to someone who wants the brand's franchise. The
 * consent line is kept on the lead as it was read, so it says what the contact
 * is about.
 */
export interface SiteFormCopy {
  title: string;
  subtitle: string;
  button: string;
  consentText: string;
}

export function siteFormCopyOf(
  pipeline: LeadPipeline | null | undefined,
  brand: string,
): SiteFormCopy {
  if (pipeline === 'formatacao') {
    return {
      title: 'Transforme a sua empresa em franquia',
      subtitle: 'Deixe seus dados e o time da Wings entra em contato pelo WhatsApp.',
      button: 'Quero formatar minha franquia',
      consentText:
        'Autorizo a Wings Company a entrar em contato comigo sobre a formatação da minha empresa em franquia, por telefone e WhatsApp.',
    };
  }
  if (pipeline === 'consultoria') {
    return {
      title: 'Fale com a consultoria da Wings',
      subtitle: 'Deixe seus dados e o time da Wings entra em contato pelo WhatsApp.',
      button: 'Quero falar com a Wings',
      consentText:
        'Autorizo a Wings Company a entrar em contato comigo sobre a consultoria, por telefone e WhatsApp.',
    };
  }
  return {
    title: `Seja um franqueado ${brand}`,
    subtitle: 'Deixe seus dados e o time de expansão entra em contato.',
    button: 'Quero ser franqueado',
    consentText: SITE_FORM_CONSENT_TEXT,
  };
}

/** `AW-123456789/AbCdEfGhIj`: a Google Ads conversion action's id and label. */
export const GOOGLE_ADS_CONVERSION_PATTERN = /^AW-\d{6,15}\/[A-Za-z0-9_-]{4,40}$/;

/** The hidden attribution fields the page collects (first visit's address, cookie) and sends. */
export const SITE_FORM_TRACKING_KEYS = [
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_content',
  'utm_term',
  'gclid',
  'fbclid',
  'gbraid',
  'wbraid',
  'campaign_id',
  'campaignid',
  'gad_campaignid',
  'adset_id',
  'adgroupid',
  'ad_id',
  'creative',
  'hsa_cam',
  'hsa_grp',
  'hsa_ad',
  'referrer',
] as const;
export type SiteFormTrackingKey = (typeof SITE_FORM_TRACKING_KEYS)[number];

export const SITE_FORM_CONSENT_TEXT =
  'Autorizo a Wings Company a entrar em contato comigo sobre a franquia, por telefone, WhatsApp e e-mail.';

/**
 * "Faturamento mensal da empresa" on "Fale com a Wings" (Eric, 27/10/2026): the
 * page sends the code; the lead keeps the option's text under the question.
 */
export const SITE_FORM_REVENUE_QUESTION = 'Faturamento mensal da empresa';
export const SITE_FORM_REVENUE_VALUES = [
  'ate-50k',
  '50k-100k',
  '100k-300k',
  '300k-1mi',
  'acima-1mi',
  'nao-informar',
] as const;
export type SiteFormRevenue = (typeof SITE_FORM_REVENUE_VALUES)[number];
export const SITE_FORM_REVENUE_OPTIONS: Record<SiteFormRevenue, string> = {
  'ate-50k': 'Até R$ 50 mil',
  '50k-100k': 'De R$ 50 mil a R$ 100 mil',
  '100k-300k': 'De R$ 100 mil a R$ 300 mil',
  '300k-1mi': 'De R$ 300 mil a R$ 1 milhão',
  'acima-1mi': 'Acima de R$ 1 milhão',
  'nao-informar': 'Prefiro não informar',
};

export const siteFormSubmitSchema = z.object({
  name: z.string().trim().min(2, 'Informe o nome').max(LEAD_NAME_MAX),
  /** The standard form (2026-10-07) asks no e-mail: the WhatsApp is the contact. An older page may still send one. */
  email: z.email('E-mail inválido').trim().max(200).optional(),
  phone: z
    .string()
    .trim()
    .max(30)
    .refine((value) => value.replace(/\D/g, '').length >= 10, 'Telefone com DDD'),
  consent: z.literal(true, { error: 'É preciso autorizar o contato' }),
  turnstileToken: z.string().min(1, 'Confirme que você não é um robô').max(4096),
  /**
   * The form fields every campaign asks (docs/leads/formularios.md). Optional
   * here so an older page still works; the page asks for them. `siteUrl`, not
   * `website`: that name is the honeypot below.
   */
  instagram: z.string().trim().max(120).optional(),
  siteUrl: z.string().trim().max(300).optional(),
  companyName: z.string().trim().max(200).optional(),
  cnpj: z.string().trim().max(30).optional(),
  /** Honeypot: a field people never see; anything in it is a robot. */
  website: z.string().max(500).optional(),
  /** The page the form was sent from (origin + path + query). */
  page: z.string().max(2000).optional(),
  /** Only the keys above: anything else is refused, never kept. */
  tracking: z
    .partialRecord(
      z.enum(SITE_FORM_TRACKING_KEYS),
      z.string().trim().max(500, 'Dado de rastreamento longo demais'),
      { error: 'Dados de rastreamento inválidos' },
    )
    .optional(),
  /**
   * The answer to the page's optional multiple-choice question (the standard
   * form's `qualifier`, `site_form_spec`): the option's text, or its code when
   * the spec lists `qualifierValues` (the text still counts there). Kept with
   * the form's answers as the option's text, never read as a contact field.
   */
  qualifierAnswer: z.string().trim().max(80).optional(),
  /**
   * The monthly revenue band (`SITE_FORM_REVENUE_VALUES`). Optional here so an
   * older page or a cached one still sends; the page itself requires it.
   */
  monthlyRevenue: z
    .enum(SITE_FORM_REVENUE_VALUES, {
      error: `Escolha uma opção em "${SITE_FORM_REVENUE_QUESTION}".`,
    })
    .optional(),
});
export type SiteFormSubmitInput = z.infer<typeof siteFormSubmitSchema>;

// --- what the visitor does on the page, counted on the server --------------------

/**
 * The steps a landing page reports to `POST /public/site-forms/:slug/events`
 * (apps/api leads site-events.ts), one small beacon each, so the server can
 * count where visitors stop before the form. Nothing personal: a closed list
 * of events and steps, the ad's UTMs and a random id of the visit.
 */
export const SITE_EVENT_NAMES = [
  'page_view',
  'form_view',
  'form_start',
  'submit_attempt',
  'submit_error',
  'submit_ok',
  'whatsapp_click',
] as const;
export type SiteEventName = (typeof SITE_EVENT_NAMES)[number];

/** Which WhatsApp button (`whatsapp_click`) or why the send failed (`submit_error`). */
export const SITE_EVENT_STEPS = [
  'header',
  'final',
  'thanks',
  'validation',
  'captcha',
  'network',
  'rate_limited',
] as const;
export type SiteEventStep = (typeof SITE_EVENT_STEPS)[number];

/** The UTMs an event carries, from the first touch kept in the browser (never a click id). */
export const SITE_EVENT_UTM_KEYS = [
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_content',
  'utm_term',
  'utm_id',
] as const;

const siteEventUtm = z.string().trim().max(100).optional();

/** One event, as the page sends it; any other key is refused. */
export const siteEventSchema = z.strictObject({
  event: z.enum(SITE_EVENT_NAMES),
  step: z.enum(SITE_EVENT_STEPS).optional(),
  /** This visit's random id, made by the page and kept in its sessionStorage only. */
  visit: z
    .string()
    .regex(/^[a-z0-9]{8,32}$/)
    .optional(),
  utm_source: siteEventUtm,
  utm_medium: siteEventUtm,
  utm_campaign: siteEventUtm,
  utm_content: siteEventUtm,
  utm_term: siteEventUtm,
  utm_id: siteEventUtm,
});
export type SiteEvent = z.infer<typeof siteEventSchema>;

/** The channels a UTM link is made for, with the source/medium the team uses. */
export const UTM_CHANNELS = [
  { key: 'instagram_ads', label: 'Instagram (anúncio)', source: 'instagram', medium: 'cpc' },
  { key: 'facebook_ads', label: 'Facebook (anúncio)', source: 'facebook', medium: 'cpc' },
  { key: 'google_ads', label: 'Google (anúncio)', source: 'google', medium: 'cpc' },
  {
    key: 'instagram_bio',
    label: 'Instagram (bio/orgânico)',
    source: 'instagram',
    medium: 'social',
  },
  { key: 'whatsapp', label: 'WhatsApp', source: 'whatsapp', medium: 'social' },
  { key: 'email', label: 'E-mail', source: 'email', medium: 'email' },
  { key: 'linkedin', label: 'LinkedIn', source: 'linkedin', medium: 'social' },
] as const;

/** A slug for a UTM value: lower-case, no accents, words joined by "_". */
export function utmValueOf(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80);
}

/** One ready link per channel: the page's address with utm_source, utm_medium, utm_campaign (and utm_content when given). */
export function utmLinksFor(
  pageUrl: string,
  input: { campaign: string; content?: string },
): { key: string; label: string; url: string }[] {
  const campaign = utmValueOf(input.campaign);
  const content = input.content ? utmValueOf(input.content) : '';
  const [base = '', hash] = pageUrl.split('#');
  const [path = '', query] = base.split('?');
  // Existing parameters stay, except the UTMs this sets.
  const kept = (query ?? '')
    .split('&')
    .filter((pair) => pair && !/^utm_(source|medium|campaign|content)=/.test(pair));
  return UTM_CHANNELS.map((channel) => {
    const utms = [
      ['utm_source', channel.source],
      ['utm_medium', channel.medium],
      ...(campaign ? [['utm_campaign', campaign]] : []),
      ...(content ? [['utm_content', content]] : []),
    ].map(([key, value]) => `${key}=${encodeURIComponent(value as string)}`);
    const url = `${path}?${[...kept, ...utms].join('&')}${hash !== undefined ? `#${hash}` : ''}`;
    return { key: channel.key, label: channel.label, url };
  });
}
