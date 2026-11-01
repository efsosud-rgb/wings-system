import { z } from 'zod';
import { normalizeBrazilianPhone } from './leads.js';
import { canonicalWhatsAppPhone } from './whatsapp.js';

/**
 * The one "não me contate" register (docs/crm/nao-me-contate.md, Eric 29/10): a person who asked
 * not to be contacted, on one channel or on all, is not contacted by Wings on it from anywhere.
 */

export const CONTACT_CHANNELS = ['all', 'whatsapp', 'phone', 'email', 'instagram'] as const;
export type ContactChannel = (typeof CONTACT_CHANNELS)[number];

export const CONTACT_CHANNEL_LABELS: Record<ContactChannel, string> = {
  all: 'todos os canais',
  whatsapp: 'WhatsApp',
  phone: 'telefone',
  email: 'e-mail',
  instagram: 'Instagram',
};

export const CONTACT_KEY_KINDS = [
  'lead',
  'phone',
  'email',
  'instagram_user',
  'place_id',
  'cnpj',
] as const;
export type ContactKeyKind = (typeof CONTACT_KEY_KINDS)[number];

export const CONTACT_OPT_OUT_ORIGINS = [
  'crm',
  'whatsapp_palavra',
  'prospeccao',
  'instagram',
  'importacao',
] as const;
export type ContactOptOutOrigin = (typeof CONTACT_OPT_OUT_ORIGINS)[number];

export const CONTACT_OPT_OUT_ORIGIN_LABELS: Record<ContactOptOutOrigin, string> = {
  crm: 'registrado no CRM',
  whatsapp_palavra: 'pediu para sair pelo WhatsApp',
  prospeccao: 'prospecção',
  instagram: 'Instagram',
  importacao: 'importação',
};

/**
 * The one form a key is stored and looked up in, or null when it is unusable: a phone as
 * `normalizeBrazilianPhone` gives it with the WhatsApp 9th digit back, an e-mail in lower case,
 * an Instagram user without the @, a CNPJ in digits.
 */
export function normalizeContactKey(kind: ContactKeyKind, raw: string | null | undefined) {
  const value = raw?.trim();
  if (!value) return null;
  switch (kind) {
    case 'phone': {
      const phone = normalizeBrazilianPhone(value);
      return phone ? canonicalWhatsAppPhone(phone) : null;
    }
    case 'email':
      return value.includes('@') ? value.toLowerCase() : null;
    case 'instagram_user':
      return value.replace(/^@/, '').toLowerCase() || null;
    case 'cnpj':
      return value.replace(/\D/g, '').length === 14 ? value.replace(/\D/g, '') : null;
    default:
      return value;
  }
}

/** What stops Wings from starting a contact, or `blocked: false`. */
export interface ContactBlock {
  blocked: boolean;
  /** In Portuguese, for the screen. */
  reason: string | null;
  origin: ContactOptOutOrigin | null;
}

/** One active "não me contate" on a lead, for the badge (channel, since when, origin). */
export interface ContactOptOutEntry {
  /** The register row; null for the older sources (WhatsApp SAIR, prospect "não contatar"). */
  id: string | null;
  channel: ContactChannel;
  origin: ContactOptOutOrigin;
  reason: string | null;
  since: string;
}

export interface LeadContactOptOuts {
  entries: ContactOptOutEntry[];
  /** Per channel, whether Wings may start a contact (the opt-in rule included, for WhatsApp). */
  blocks: Record<Exclude<ContactChannel, 'all'>, ContactBlock>;
}

export const contactOptOutCreateSchema = z.object({
  channels: z.array(z.enum(CONTACT_CHANNELS)).min(1).max(CONTACT_CHANNELS.length),
  reason: z.string().trim().min(3).max(500),
});
export type ContactOptOutCreateInput = z.infer<typeof contactOptOutCreateSchema>;

export const contactOptOutRevokeSchema = z.object({
  channel: z.enum(CONTACT_CHANNELS),
  reason: z.string().trim().min(3).max(500),
});
export type ContactOptOutRevokeInput = z.infer<typeof contactOptOutRevokeSchema>;

export const CONTACT_BLOCKED_ERROR = 'contact_blocked';

/** What the conversation says when nothing may go to the person (text, file, audio, template). */
export const CONTACT_BLOCKED_TEXT = 'Este contato pediu para não ser contatado.';
