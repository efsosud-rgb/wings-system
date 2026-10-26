import { z } from 'zod';
import { normalizeBrazilianPhone } from './leads.js';
import { SECTOR_SLUGS, type SectorSlug } from './rbac/sectors.js';
import { canonicalWhatsAppPhone } from './whatsapp.js';

/**
 * The company's work numbers (docs/whatsapp/central.md, conectar-numero.md): an Admin Master
 * registers each one (owner, department, the phone checks) and later connects it by coexistence
 * through Meta's Embedded Signup, with the owner's phone in hand. Each number keeps its own WABA
 * and business portfolio; nothing assumes one portfolio for all. The ids are not secret; the
 * business token Meta gives never leaves the API.
 */

export const WA_NUMBER_STATUSES = ['registered', 'connected', 'disconnected'] as const;
export type WaNumberStatus = (typeof WA_NUMBER_STATUSES)[number];

export const WA_NUMBER_STATUS_LABELS: Record<WaNumberStatus, string> = {
  registered: 'Cadastrado, não conectado',
  connected: 'Conectado',
  disconnected: 'Desconectado',
};

/** Whether the number may be connected, as the registry's check found (Eric, 26/10). */
export const WA_NUMBER_ELIGIBILITIES = ['a_confirmar', 'confirmado', 'inelegivel'] as const;
export type WaNumberEligibility = (typeof WA_NUMBER_ELIGIBILITIES)[number];

export const WA_NUMBER_ELIGIBILITY_LABELS: Record<WaNumberEligibility, string> = {
  a_confirmar: 'A confirmar',
  confirmado: 'Confirmado',
  inelegivel: 'Inelegível',
};

/** What the owner checks on the phone before the connection (coexistência, 14/10). */
export const WA_NUMBER_CHECKS = {
  app: 'App WhatsApp Business 2.24.17 ou maior',
  work: 'Número de trabalho, não pessoal (pessoal só com autorização do Eric)',
  phone: 'O dono vai estar com o celular na mão na hora da conexão',
  history: 'Autorizar o histórico no celular nas primeiras 24 h',
} as const;
export type WaNumberCheck = keyof typeof WA_NUMBER_CHECKS;
export const WA_NUMBER_CHECK_KEYS = Object.keys(WA_NUMBER_CHECKS) as WaNumberCheck[];

/** Days before the token's end the screen warns (Meta's Embedded Signup token lasts 60). */
export const WA_TOKEN_WARN_DAYS = 10;

/**
 * One of the two syncs Meta allows once per connection, within 24 hours: the contacts, then the
 * history. `unknown`: Meta did not answer, so it may have been accepted; it is never sent again.
 * `declined`: the owner said no to the history on the phone (Meta's error 2593109).
 */
export type WaSyncState = 'requested' | 'failed' | 'unknown' | 'declined';

/** Meta lets the contacts and the history be asked for only in the first 24 hours. */
export const WA_SYNC_WINDOW_HOURS = 24;

export interface WaNumber {
  id: string;
  /** As registered (55 + DDD + number); null on a number connected before the registry. */
  phone: string | null;
  label: string | null;
  sector: SectorSlug | null;
  eligibility: WaNumberEligibility;
  eligibilityNotes: string | null;
  checks: WaNumberCheck[];
  /** Meta's ids: null until the number is connected. */
  phoneNumberId: string | null;
  wabaId: string | null;
  /** The business portfolio the WABA belongs to, as Meta reports it. */
  businessId: string | null;
  displayPhone: string | null;
  verifiedName: string | null;
  ownerEmployeeId: string;
  ownerName: string | null;
  status: WaNumberStatus;
  connectedAt: string | null;
  connectedByName: string | null;
  /** When the business token ends; null when Meta gave no end (or before the connection). */
  tokenExpiresAt: string | null;
  /** Meta's event (and reason) when the number left, e.g. "PARTNER_REMOVED: PRIMARY_INACTIVITY". */
  disconnectReason: string | null;
  disconnectedAt: string | null;
  /** Whether our app receives the number's webhooks (`subscribed_apps`). */
  webhooksSubscribed: boolean;
  contactsSync: WaSyncState | null;
  historySync: WaSyncState | null;
  /** 0–100 from Meta's `history` webhook; null until the first one arrives. */
  historyProgress: number | null;
  /** Until when the syncs still not asked for may be asked for; null before the connection. */
  syncDeadline: string | null;
}

/** What the browser needs to open Embedded Signup. Not secret: the app id and the config id. */
export interface WaSignupConfig {
  appId: string;
  configId: string;
  graphVersion: string;
}

export interface WaNumbersView {
  /** Null while a variable is missing; `missing` names it (names only, never values). */
  signup: WaSignupConfig | null;
  missing: string[];
  numbers: WaNumber[];
  /** Who may own a number: the active employees. */
  people: { id: string; name: string }[];
}

const metaId = z.string().regex(/^\d{1,32}$/);

/** A Brazilian number as typed ("(21) 99999-0000"), kept as 55 + DDD + number. */
const phoneField = z
  .string()
  .trim()
  .max(30)
  .transform((raw) => normalizeBrazilianPhone(raw))
  .refine((phone): phone is string => phone !== null, 'Telefone inválido: use DDD + número.')
  .transform((phone) => canonicalWhatsAppPhone(phone));

const registryFields = {
  phone: phoneField,
  label: z.string().trim().min(2, 'Dê um nome ao número.').max(80),
  ownerEmployeeId: z.uuid(),
  sector: z.enum(SECTOR_SLUGS as [SectorSlug, ...SectorSlug[]]).nullable(),
  eligibility: z.enum(WA_NUMBER_ELIGIBILITIES),
  eligibilityNotes: z.string().trim().max(2000).nullable(),
  checks: z.array(z.enum(WA_NUMBER_CHECK_KEYS as [WaNumberCheck, ...WaNumberCheck[]])),
};

export const waNumberRegisterSchema = z.object({
  ...registryFields,
  sector: registryFields.sector.default(null),
  eligibility: registryFields.eligibility.default('a_confirmar'),
  eligibilityNotes: registryFields.eligibilityNotes.default(null),
  checks: registryFields.checks.default([]),
});
export type WaNumberRegister = z.input<typeof waNumberRegisterSchema>;

/** Any field of the registry (no defaults: what is left out stays); the number only before the connection. */
export const waNumberUpdateSchema = z.object(registryFields).partial();
export type WaNumberUpdate = z.input<typeof waNumberUpdateSchema>;

/** What Embedded Signup handed the browser (the code lives 30 seconds), for a registered number. */
export const waNumberConnectSchema = z.object({
  code: z.string().min(1).max(4096),
  wabaId: metaId,
  /** Sent by Meta's session event in some versions; the API checks it belongs to the WABA. */
  phoneNumberId: metaId.optional(),
  numberId: z.uuid(),
});
export type WaNumberConnect = z.infer<typeof waNumberConnectSchema>;

/** A webhook body the queue gave up on: ids and codes only, never what it carried. */
export interface WaFailedEvent {
  id: string;
  receivedAt: string;
  attempts: number;
  lastError: string | null;
  /** False once the 90-day purge cleared it: nothing left to process again. */
  hasPayload: boolean;
}
