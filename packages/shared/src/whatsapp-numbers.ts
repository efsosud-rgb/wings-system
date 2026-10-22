import { z } from 'zod';

/**
 * The sellers' own WhatsApp Business numbers, mirrored by coexistence (Eric, 20/10;
 * docs/whatsapp/conectar-numero.md): an Admin Master connects each one through Meta's
 * Embedded Signup with the seller's phone in hand. Each number keeps its own WABA and
 * business portfolio; nothing assumes one portfolio for all. The ids are not secret;
 * the business token Meta gives never leaves the API.
 */

export const WA_NUMBER_STATUSES = ['connected', 'disconnected'] as const;
export type WaNumberStatus = (typeof WA_NUMBER_STATUSES)[number];

export const WA_NUMBER_STATUS_LABELS: Record<WaNumberStatus, string> = {
  connected: 'Conectado',
  disconnected: 'Desconectado',
};

/**
 * One of the two syncs Meta allows once per connection, within 24 hours: the contacts, then the
 * history. `unknown`: Meta did not answer, so it may have been accepted; it is never sent again.
 */
export type WaSyncState = 'requested' | 'failed' | 'unknown';

/** Meta lets the contacts and the history be asked for only in the first 24 hours. */
export const WA_SYNC_WINDOW_HOURS = 24;

export interface WaNumber {
  id: string;
  phoneNumberId: string;
  wabaId: string;
  /** The business portfolio the WABA belongs to, as Meta reports it. */
  businessId: string | null;
  displayPhone: string | null;
  verifiedName: string | null;
  ownerEmployeeId: string;
  ownerName: string | null;
  status: WaNumberStatus;
  connectedAt: string;
  connectedByName: string | null;
  /** Meta's event (and reason) when the number left, e.g. "PARTNER_REMOVED: PRIMARY_INACTIVITY". */
  disconnectReason: string | null;
  disconnectedAt: string | null;
  /** Whether our app receives the number's webhooks (`subscribed_apps`). */
  webhooksSubscribed: boolean;
  contactsSync: WaSyncState | null;
  historySync: WaSyncState | null;
  /** 0–100 from Meta's `history` webhook; null until the first one arrives. */
  historyProgress: number | null;
  /** Until when the syncs still not asked for may be asked for. */
  syncDeadline: string;
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
}

const metaId = z.string().regex(/^\d{1,32}$/);

/** What Embedded Signup handed the browser: the code (valid for 30 seconds) and the WABA. */
export const waNumberConnectSchema = z.object({
  code: z.string().min(1).max(4096),
  wabaId: metaId,
  /** Sent by Meta's session event in some versions; the API checks it belongs to the WABA. */
  phoneNumberId: metaId.optional(),
  ownerEmployeeId: z.uuid(),
});
export type WaNumberConnect = z.infer<typeof waNumberConnectSchema>;
