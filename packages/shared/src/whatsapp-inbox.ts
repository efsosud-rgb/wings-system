/**
 * The WhatsApp inbox at a glance (docs/whatsapp/cloud-api.md, "Caixa como o WhatsApp
 * Desktop"): how many of the reader's conversations hold a message of the person they
 * have not opened, and a stamp that moves whenever their conversations do. Answered by
 * `GET /whatsapp/inbox/summary` and pushed by the `inbox` event of
 * `GET /whatsapp/calls/stream`; the screens fetch what they show again when the stamp moves.
 */
export interface WaInboxSummary {
  /** Conversations in the reader's reach with a message of the person they have not opened. */
  unread: number;
  /** Opaque: changes when one of their conversations gets a message, changes hands or is read. */
  stamp: string;
}

/**
 * A search shorter than this looks at names and phones only: inside the messages it would
 * match almost everything.
 */
export const WA_TEXT_SEARCH_MIN = 3;
