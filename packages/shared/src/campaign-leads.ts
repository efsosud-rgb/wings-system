import type { AdPlatform } from './ads/dashboard.js';

/**
 * Leads das Campanhas: RD CRM deals that came from the paid campaigns
 * running now, one row per deal. The contract between the list screen and
 * the API; the API decides who sees which row (`campaign_leads.read`: all
 * for Diretoria and Gerente Comercial, own for Vendedor Formatação).
 */

/** The first moment counted: 28/09/2026 00:00 in Brasília. */
export const CAMPAIGN_LEADS_SINCE = '2026-09-28T00:00:00-03:00';

/** Pipelines of the Formatação funnel, where the deal may be now (it moves to "perdidos"/"vendidos" pipelines). */
export function isFormatacaoPipeline(name: string): boolean {
  return /formata[cç][aã]o/i.test(name);
}

/**
 * A test deal (made by the diagnostic or by hand to try the flow): its lost
 * reason or its name says "teste". Kept out of every figure.
 */
export function isTestDeal(name: string | null, lostReason: string | null): boolean {
  return /\bteste\b/i.test(lostReason ?? '') || /\bteste\b/i.test(name ?? '');
}

/**
 * A qualified lead: won, or in the Formatação pipeline at "Identificação de
 * interesse" (third stage) or later. Leads that moved to a "perdidos"
 * pipeline are not counted as qualified: RD keeps no history of how far they got.
 */
export function isQualifiedLead(lead: {
  pipeline: string;
  stageOrder: number;
  win: boolean | null;
}): boolean {
  if (lead.win === true) return true;
  if (lead.win === false) return false;
  return /^forma[cç][aã]o$/i.test(lead.pipeline.trim()) && lead.stageOrder >= 3;
}

export type LeadTemperature = 'frio' | 'morno' | 'quente';

/** RD CRM's 1–5 star rating, in the team's words: 1–2 Frio, 3 Morno, 4–5 Quente. */
export function temperatureOfRating(rating: number | null): LeadTemperature | null {
  if (rating === null || rating < 1) return null;
  if (rating <= 2) return 'frio';
  if (rating === 3) return 'morno';
  return 'quente';
}

export const TEMPERATURE_LABEL: Record<LeadTemperature, string> = {
  frio: 'Frio',
  morno: 'Morno',
  quente: 'Quente',
};

export type FirstContactBand = 'green' | 'amber' | 'red';

/** Green under 5 minutes, amber under 1 hour, red beyond. */
export function firstContactBand(minutes: number): FirstContactBand {
  if (minutes < 5) return 'green';
  if (minutes < 60) return 'amber';
  return 'red';
}

/** "(21) 9••••-••77": area code and the last two digits, nothing else. */
export function maskPhone(phone: string): string {
  const digits = phone.replace(/\D/g, '').replace(/^55(?=\d{10,11}$)/, '');
  if (digits.length < 4) return '••••';
  const area = digits.length >= 10 ? `(${digits.slice(0, 2)}) ` : '';
  return `${area}••••-••${digits.slice(-2)}`;
}

/** "j•••@g•••.com": first letter of each side and the ending. */
export function maskEmail(email: string): string {
  const [user = '', domain = ''] = email.trim().split('@');
  const dot = domain.lastIndexOf('.');
  const host = dot > 0 ? domain.slice(0, dot) : domain;
  const tld = dot > 0 ? domain.slice(dot) : '';
  return `${user.slice(0, 1)}•••@${host.slice(0, 1)}•••${tld}`;
}

export type AttributionMethod = 'utm' | 'rd_origin';

export const UNATTRIBUTED_REASONS = {
  not_paid: 'A origem no RD não é mídia paga (orgânico, indicação, site…)',
  paid_no_platform: 'Mídia paga sem dizer a plataforma, e sem UTM na conversão',
  utm_other_campaign: 'A UTM aponta para uma campanha que não está ativa',
  platform_ambiguous: 'Mais de uma campanha ativa na plataforma, e sem UTM para escolher',
  platform_without_active_campaign: 'Plataforma sem campanha ativa no momento da entrada',
} as const;
export type UnattributedReason = keyof typeof UNATTRIBUTED_REASONS;

export const ATTRIBUTION_METHOD_LABEL: Record<AttributionMethod, string> = {
  utm: 'UTM da conversão no RD',
  rd_origin: 'Origem do RD (única campanha ativa da plataforma)',
};

export interface CampaignLeadRow {
  id: string;
  /** When the deal was created in RD (ISO). */
  enteredAt: string;
  name: string | null;
  company: string | null;
  segment: string | null;
  city: string | null;
  platform: AdPlatform | null;
  campaignName: string | null;
  adName: string | null;
  attribution: AttributionMethod | null;
  utmCampaign: string | null;
  utmContent: string | null;
  pipeline: string;
  stage: string;
  owner: string | null;
  /** Minutes from entry to the first contact; null while nobody made one. */
  firstContactMinutes: number | null;
  /** How the first contact was seen: a note/task in RD, or the stage leaving "Sem contato" (seen within 15 minutes). */
  firstContactSource: 'activity' | 'stage' | null;
  temperature: LeadTemperature | null;
  lastActivityAt: string | null;
  phoneMasked: string | null;
  emailMasked: string | null;
  win: boolean | null;
  lostReason: string | null;
}

export interface CampaignLeadsSummary {
  since: string;
  /** When the RD read last finished (ISO); null before the first one. */
  fetchedAt: string | null;
  today: number;
  week: number;
  total: number;
  /** Share of the leads with a first contact, 0–100; null without leads. */
  contactedPercent: number | null;
  averageFirstContactMinutes: number | null;
  stages: { stage: string; count: number }[];
  lost: { reason: string; count: number }[];
  /** Formatação deals since `since` that are not from an active campaign, per reason. */
  unattributed: { reason: UnattributedReason; count: number }[];
  unattributedPercent: number | null;
  /** Test deals ignored everywhere. */
  tests: number;
  /** Fewer than 10 leads: read the rates with care. */
  smallSample: boolean;
}

export interface CampaignLeadsResponse {
  summary: CampaignLeadsSummary;
  leads: CampaignLeadRow[];
  /** Whether this person sees every lead or only their own. */
  scope: 'all' | 'own';
}
