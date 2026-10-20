import { z } from 'zod';
import type { SofiaState } from './sofia.js';

/**
 * The official WhatsApp (Cloud API) in the CRM (docs/whatsapp/cloud-api.md):
 * the contract between the API and the deal's WhatsApp screen. Free text goes
 * out only inside Meta's 24-hour window, which opens on the person's last
 * message; outside it only an approved template goes. Reading, sending and
 * calling are one permission, `leads.whatsapp`, in the lead's owner scope.
 */

export const WA_WINDOW_HOURS = 24;

export const WA_MESSAGE_STATUSES = [
  'pending',
  'sent',
  'delivered',
  'read',
  'played',
  'failed',
] as const;
export type WaMessageStatus = (typeof WA_MESSAGE_STATUSES)[number];

export const WA_STATUS_LABELS: Record<WaMessageStatus, string> = {
  pending: 'Enviando',
  sent: 'Enviada',
  delivered: 'Entregue',
  read: 'Lida',
  played: 'Ouvida',
  failed: 'Não enviada',
};

const STATUS_RANK: Record<Exclude<WaMessageStatus, 'failed'>, number> = {
  pending: 0,
  sent: 1,
  delivered: 2,
  read: 3,
  played: 4,
};

/**
 * Whether `next` may replace `current`. Forward only: Meta's statuses can
 * arrive out of order, and a late "delivered" never undoes a "read". A
 * failure counts only before delivery, and nothing follows a failure.
 */
export function waStatusAdvances(current: WaMessageStatus, next: WaMessageStatus): boolean {
  if (current === next || current === 'failed') return false;
  if (next === 'failed') return current === 'pending' || current === 'sent';
  return STATUS_RANK[next] > STATUS_RANK[current];
}

export const WA_MESSAGE_KINDS = [
  'text',
  'template',
  'image',
  'audio',
  'video',
  'document',
  'sticker',
  'location',
  'contacts',
  'interactive',
  'button',
  'reaction',
  'unsupported',
] as const;
export type WaMessageKind = (typeof WA_MESSAGE_KINDS)[number];

export const WA_KIND_LABELS: Record<WaMessageKind, string> = {
  text: 'Texto',
  template: 'Modelo',
  image: 'Imagem',
  audio: 'Áudio',
  video: 'Vídeo',
  document: 'Documento',
  sticker: 'Figurinha',
  location: 'Localização',
  contacts: 'Contato',
  interactive: 'Resposta',
  button: 'Resposta',
  reaction: 'Reação',
  unsupported: 'Mensagem que o WhatsApp não mostra aqui',
};

/** Kinds that carry a file the screen can open through the API. */
export const WA_MEDIA_KINDS: readonly WaMessageKind[] = [
  'image',
  'audio',
  'video',
  'document',
  'sticker',
];

/**
 * The message a reply quotes, looked up only in the same conversation. Not found: older than the
 * number's connection to the system, or kept only on the phone.
 */
export type WaQuote =
  | { found: true; id: string; direction: 'in' | 'out'; kind: WaMessageKind; text: string | null }
  | { found: false };

export interface WaMessage {
  id: string;
  direction: 'in' | 'out';
  kind: WaMessageKind;
  text: string | null;
  /** A reply: the message it quotes. Optional only so fixtures of other branches still type. */
  replyTo?: WaQuote | null;
  /** Present when the message has a file, opened at `/whatsapp/messages/:id/media`. */
  media: { mimeType: string | null; filename: string | null } | null;
  template: { name: string; language: string } | null;
  /**
   * A template that went as a common message inside the 24-hour window (no
   * charge): its name, for the bubble.
   */
  fromTemplate: string | null;
  /** The brand's (or Wings') art went in the header. */
  withArt: boolean;
  /** Outgoing only. */
  status: WaMessageStatus | null;
  /** Why it was not sent, in plain Portuguese (from Meta's error code). */
  error: string | null;
  /** Who in the team sent it (outgoing), or null. */
  authorName: string | null;
  /** Sent by Sofia, the virtual SDR. */
  bySofia: boolean;
  /** Brought in from a phone's export: the media file the line named, or that it was left out. */
  imported: { file: string | null; omitted: boolean } | null;
  at: string;
}

export interface DealWhatsApp {
  /** The conversation shown, when there is one yet. */
  conversationId: string | null;
  leadId: string | null;
  /** The name on the person's WhatsApp profile. */
  profileName: string | null;
  /** The official API is connected on this server (token and number set). */
  configured: boolean;
  /** WhatsApp calling is on for this server (item 4; false until then). */
  calling: boolean;
  phone: string | null;
  /** Meta's 24-hour window for free text, from the person's last message. */
  window: { open: boolean; expiresAt: string | null };
  optedOut: boolean;
  /** Whether the person lets the business call them, as last known. */
  callPermission: WaCallPermissionState;
  /** Who has the conversation now (Sofia, a seller, ...); null before any message. */
  attendance: SofiaState | null;
  /**
   * The brand whose expansion team this conversation speaks for (a franchise
   * lead never hears of Wings), or null for Wings Company.
   */
  speaksFor: string | null;
  messages: WaMessage[];
}

export interface WaTemplate {
  name: string;
  language: string;
  category: string | null;
  /** The body text with its {{1}} {{2}} placeholders, for the screen. */
  body: string | null;
  /** How many {{n}} the body takes. */
  paramCount: number;
  /** An approved `<name>_arte` exists: with the art registered, that one goes. */
  artVersion: boolean;
}

export const waSendTextSchema = z.object({
  text: z.string().trim().min(1, 'Escreva a mensagem.').max(4096, 'Até 4096 caracteres.'),
});
export type WaSendText = z.infer<typeof waSendTextSchema>;

/**
 * The forms a Brazilian mobile takes on WhatsApp: Meta's `wa_id` may lack the
 * 9th digit (55 DD 8 digits) while the CRM keeps 55 DD 9 8 digits. Both are
 * the same person; landlines (first digit 2–5) have only one form.
 */
export function brazilianPhoneVariants(phone: string): string[] {
  const digits = phone.replace(/\D/g, '');
  if (/^55\d{2}9\d{8}$/.test(digits)) return [digits, digits.slice(0, 4) + digits.slice(5)];
  if (/^55\d{2}[6-9]\d{7}$/.test(digits))
    return [`${digits.slice(0, 4)}9${digits.slice(4)}`, digits];
  return [digits];
}

/** The CRM's form of a WhatsApp number: a 12-digit Brazilian mobile gets its 9th digit back. */
export function canonicalWhatsAppPhone(phone: string): string {
  return brazilianPhoneVariants(phone)[0]!;
}

/** Placeholders a template body takes ({{1}}, {{2}} ...). */
export function templateParamCount(body: string | null | undefined): number {
  if (!body) return 0;
  const found = [...body.matchAll(/\{\{\s*(\d+)\s*\}\}/g)].map((m) => Number(m[1]));
  return found.length === 0 ? 0 : Math.max(...found);
}

/** A row of the WhatsApp inbox: conversations in the reader's scope, newest first. */
export interface WaConversationItem {
  conversationId: string;
  /** Null for a conversation no deal took yet (only a full-scope reader sees those). */
  leadId: string | null;
  leadName: string | null;
  profileName: string | null;
  phone: string;
  lastAt: string | null;
  lastDirection: 'in' | 'out' | null;
  /** The last message, cut short; a file shows its kind. */
  preview: string | null;
  /** The person wrote last. */
  unanswered: boolean;
  windowOpen: boolean;
  /** The person's messages this reader has not opened yet. */
  unreadCount: number;
  /** The last message's status, when it was ours. */
  lastStatus: WaMessageStatus | null;
  /** Who has the conversation (Sofia, a seller, ...). */
  attendance: SofiaState;
  /** The deal's owner, when there is a deal. */
  ownerName: string | null;
}

/** "Nova conversa": a deal (or a contact's deal) in the reader's scope to write to. */
export interface WaNewTarget {
  leadId: string;
  name: string | null;
  /** The person written to: the deal's own phone, or the contact's. */
  phone: string;
  /** The contact's name when the match was a contact of the deal. */
  contactName: string | null;
  pipeline: string | null;
  ownerName: string | null;
  open: boolean;
  /** The conversation of that phone and deal, when one exists. */
  conversationId: string | null;
}

export interface WaTargets {
  targets: WaNewTarget[];
  /**
   * The typed number is already being attended with no deal (Sofia or the
   * team): a seller may not start it as their own deal.
   */
  busy?: boolean;
}

// --- calls (Calling API) ---------------------------------------------------------------

/**
 * Meta's words for the person's call permission, plus `requested` while our
 * request waits. Temporary lasts 7 days; four unanswered calls revoke it.
 */
export const WA_CALL_PERMISSIONS = [
  'no_permission',
  'requested',
  'temporary',
  'permanent',
] as const;
export type WaCallPermission = (typeof WA_CALL_PERMISSIONS)[number];

export const WA_CALL_PERMISSION_LABELS: Record<WaCallPermission, string> = {
  no_permission: 'Sem permissão para ligar',
  requested: 'Permissão pedida, esperando a resposta',
  temporary: 'Permitiu ligações',
  permanent: 'Permitiu ligações (sem prazo)',
};

export interface WaCallPermissionState {
  /** Null while nobody asked Meta yet. */
  status: WaCallPermission | null;
  expiresAt: string | null;
  requestedAt: string | null;
}

/** What Meta answers live: the state, and whether a request or a call may go now. */
export interface WaCallPermissionLive extends WaCallPermissionState {
  canRequest: boolean | null;
  canCall: boolean | null;
}

export const WA_CALL_STATUSES = [
  'dialing',
  'ringing',
  'accepted',
  'completed',
  'rejected',
  'missed',
  'failed',
] as const;
export type WaCallStatus = (typeof WA_CALL_STATUSES)[number];

export const WA_CALL_STATUS_LABELS: Record<WaCallStatus, string> = {
  dialing: 'Chamando…',
  ringing: 'Tocando',
  accepted: 'Em ligação',
  completed: 'Encerrada',
  rejected: 'Recusada',
  missed: 'Não atendida',
  failed: 'Não completou',
};

/** A call still being set up or going on. */
export const WA_CALL_LIVE: readonly WaCallStatus[] = ['dialing', 'ringing', 'accepted'];

export interface WaCall {
  id: string;
  direction: 'in' | 'out';
  status: WaCallStatus;
  leadId: string | null;
  /** The deal's name, or the person's WhatsApp profile name. */
  name: string | null;
  phone: string;
  /** Meta's SDP answer (outgoing), for the browser that placed the call only. */
  answerSdp: string | null;
  error: string | null;
  startedAt: string;
  connectedAt: string | null;
  endedAt: string | null;
  durationSeconds: number | null;
}

/**
 * What a screen shows of the calls ringing for the person: `calling` is whether
 * the number takes calls at all. The same shape comes from `GET /whatsapp/calls/ringing`
 * and, on every change, from the `ringing` event of `GET /whatsapp/calls/stream`.
 */
export interface WaRingingSnapshot {
  calling: boolean;
  calls: WaCall[];
}

/** An SDP as the browser made it: the offer (to call) or the answer (to pick up). */
export const waCallSdpSchema = z.object({
  sdp: z
    .string()
    .min(20, 'Descrição de mídia inválida.')
    .max(20_000, 'Descrição de mídia grande demais.')
    .refine((sdp) => sdp.startsWith('v=0'), 'Descrição de mídia inválida.'),
});
export type WaCallSdp = z.infer<typeof waCallSdpSchema>;

/**
 * A conversation brought in from a phone's "Exportar conversa" (docs/whatsapp/importar-conversa.md):
 * the browser takes the `.txt` out of the `.zip`, the server reads it, shows a preview, and writes
 * the messages to the deal as one import that "Desfazer" removes. `leads.whatsapp`, owner scope.
 */
export const WA_IMPORT_MAX_CHARS = 10_000_000;

/** The messages a conversation screen loads at a time ("Mostrar anteriores" loads the next ones). */
export const WA_MESSAGES_PAGE = 500;

export const waImportPreviewSchema = z.object({
  text: z
    .string()
    .min(1, 'O arquivo está vazio.')
    .max(WA_IMPORT_MAX_CHARS, 'Conversa grande demais para importar de uma vez.'),
});
export type WaImportPreviewInput = z.infer<typeof waImportPreviewSchema>;

export const waImportApplySchema = waImportPreviewSchema.extend({
  /** The name in the file that is the Wings side (the business profile). */
  ourName: z.string().trim().min(1, 'Escolha qual nome é a Wings.').max(200),
  /** The exported file, already among the deal's files. */
  fileId: z.uuid(),
});
export type WaImportApplyInput = z.infer<typeof waImportApplySchema>;

export interface WaImportLine {
  at: string;
  author: string;
  kind: WaMessageKind;
  text: string | null;
  file: string | null;
}

export interface WaImportPreview {
  platform: 'android' | 'ios';
  /** Who wrote, most messages first. */
  participants: { name: string; messages: number }[];
  /** The name that looks like the business profile, when exactly one does. */
  ourName: string | null;
  messages: number;
  /** Not in this deal's conversation yet (the rest came in an earlier import). */
  newMessages: number;
  /** Lines with a photo, audio, video or document (the files stay inside the exported file). */
  media: number;
  /** The app's own notices (encryption, someone joined), left out. */
  skipped: number;
  first: WaImportLine;
  last: WaImportLine;
}

export interface WaImportBatch {
  id: string;
  fileId: string | null;
  platform: 'android' | 'ios';
  messages: number;
  from: string;
  to: string;
  importedAt: string;
  importedByName: string | null;
  undoneAt: string | null;
  undoneByName: string | null;
}
