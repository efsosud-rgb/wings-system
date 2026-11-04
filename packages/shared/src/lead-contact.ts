import { z } from 'zod';
import { normalizeInstagram, normalizeWebsite } from './lead-fields.js';
import { DDD_REGIONS, LEAD_NAME_MAX, normalizeBrazilianPhone } from './leads.js';
import { canonicalWhatsAppPhone } from './whatsapp.js';

/**
 * Editing a lead's contact data from the ficha (t089): name, phone, e-mail, Instagram and site.
 * The API and the form share this one validator, so the screen never accepts what the API refuses.
 * Values are stored normalised: phone digits with 55 (the 9th digit restored on a mobile), e-mail
 * lower-cased, Instagram without `@`, site as an https/http address.
 */

export const LEAD_CONTACT_FIELDS = ['name', 'phone', 'email', 'instagram', 'website'] as const;
export type LeadContactField = (typeof LEAD_CONTACT_FIELDS)[number];

export const LEAD_CONTACT_FIELD_LABELS: Record<LeadContactField, string> = {
  name: 'Nome',
  phone: 'Telefone',
  email: 'E-mail',
  instagram: 'Instagram',
  website: 'Site',
};

const EMAIL_MAX = 254;
const EMAIL_PATTERN =
  /^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*@(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/;

/** The stored e-mail (lower-cased), or null when the text is not a usable address. */
export function validLeadEmail(raw: string): string | null {
  const email = raw.trim().toLowerCase();
  if (email.length > EMAIL_MAX || !EMAIL_PATTERN.test(email)) return null;
  return (email.split('@')[0] ?? '').length <= 64 ? email : null;
}

/**
 * The stored phone (digits, 55 + DDD + number), or null. The DDD must exist; a mobile (starts with
 * 9, or an old 8-digit one starting 6 to 9) is stored with its 9th digit; a landline starts 2 to 5.
 * Accepts a mask, spaces, `+55` and a trunk `0`.
 */
export function validLeadPhone(raw: string): string | null {
  const trimmed = raw.trim().replace(/^\+/, '');
  const digits = trimmed.replace(/\D/g, '');
  // A trunk 0 before the DDD ("011 9...") is dropped; normalizeBrazilianPhone does not know it.
  const phone = normalizeBrazilianPhone(
    /^0\d{10,11}$/.test(digits) && !digits.startsWith('55') ? digits.slice(1) : digits,
  );
  if (!phone) return null;
  const ddd = phone.slice(2, 4);
  const number = phone.slice(4);
  if (!(ddd in DDD_REGIONS)) return null;
  if (number.length === 8 && /^[2-5]/.test(number)) return phone;
  if (number.length === 9 && number.startsWith('9')) return phone;
  if (number.length === 8 && /^[6-9]/.test(number)) return canonicalWhatsAppPhone(phone);
  return null;
}

/** What the form sends: a field left out is not touched, `null` or empty clears it (name cannot be cleared). */
export const leadContactUpdateSchema = z.object({
  name: z.string().trim().max(LEAD_NAME_MAX).optional(),
  phone: z.string().trim().max(40).nullable().optional(),
  email: z
    .string()
    .trim()
    .max(EMAIL_MAX + 20)
    .nullable()
    .optional(),
  instagram: z.string().trim().max(120).nullable().optional(),
  website: z.string().trim().max(300).nullable().optional(),
});
export type LeadContactUpdateInput = z.infer<typeof leadContactUpdateSchema>;

/** The normalised values to store; `null` clears the field. */
export type LeadContactPatch = Partial<Record<LeadContactField, string | null>>;

export type LeadContactCheck =
  | { ok: true; patch: LeadContactPatch }
  | { ok: false; field: LeadContactField | null; message: string };

const blank = (value: string | null | undefined) => value === null || value?.trim() === '';

/** Validates and normalises an update; the first problem comes back with the field and a message for the person. */
export function checkLeadContactUpdate(input: LeadContactUpdateInput): LeadContactCheck {
  const patch: LeadContactPatch = {};
  if (input.name !== undefined) {
    if (input.name.length < 2) return { ok: false, field: 'name', message: 'Informe o nome.' };
    patch.name = input.name;
  }
  if (input.phone !== undefined) {
    if (blank(input.phone)) patch.phone = null;
    else {
      const phone = validLeadPhone(input.phone!);
      if (!phone)
        return {
          ok: false,
          field: 'phone',
          message: 'Telefone inválido: informe o DDD e o número, por exemplo (11) 91234-5678.',
        };
      patch.phone = phone;
    }
  }
  if (input.email !== undefined) {
    if (blank(input.email)) patch.email = null;
    else {
      const email = validLeadEmail(input.email!);
      if (!email) return { ok: false, field: 'email', message: 'E-mail inválido.' };
      patch.email = email;
    }
  }
  if (input.instagram !== undefined) {
    if (blank(input.instagram)) patch.instagram = null;
    else {
      const handle = normalizeInstagram(input.instagram!);
      if (!handle)
        return { ok: false, field: 'instagram', message: 'Instagram inválido: use o @ do perfil.' };
      patch.instagram = handle;
    }
  }
  if (input.website !== undefined) {
    if (blank(input.website)) patch.website = null;
    else {
      const site = normalizeWebsite(input.website!);
      if (!site)
        return { ok: false, field: 'website', message: 'Site inválido: use o endereço completo.' };
      patch.website = site;
    }
  }
  if (Object.keys(patch).length === 0)
    return { ok: false, field: null, message: 'Nada para alterar.' };
  return { ok: true, patch };
}

/** One line of the lead's contact-data history: who changed what, when, and the value it had. */
export interface LeadContactChange {
  id: string;
  at: string;
  field: LeadContactField;
  from: string | null;
  to: string | null;
  actorName: string | null;
}
