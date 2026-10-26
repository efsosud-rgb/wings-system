import { z } from 'zod';
import { SECTOR_SLUGS, type SectorSlug } from './rbac/sectors.js';
import type { SofiaFact } from './sofia.js';

/**
 * Who answers a WhatsApp conversation (docs/whatsapp/central.md, "Atendimento", Eric 26/10). One
 * person holds it: the one assigned, else the deal's owner on the official number or the number's
 * owner on a work number. Only the holder writes; anyone else who sees it takes it first ("Assumir"),
 * and the one who had it is told. Every change of hands moves the conversation's `version`: an
 * action made on an older one is refused, so two people (or Sofia and a person) never both win.
 */

/** Who gets a conversation nobody holds: it waits in its queue, or the funnel's rotation picks. */
export const WA_ASSIGNMENT_MODES = ['manual', 'rodizio'] as const;
export type WaAssignmentMode = (typeof WA_ASSIGNMENT_MODES)[number];

export const WA_ASSIGNMENT_MODE_LABELS: Record<WaAssignmentMode, string> = {
  manual: 'Fica na fila até alguém assumir',
  rodizio: 'Rodízio do funil (o mesmo das negociações)',
};

export const waAssignmentSettingsSchema = z.object({ mode: z.enum(WA_ASSIGNMENT_MODES) });

export const WA_CONVERSATION_EVENT_KINDS = [
  'taken',
  'transferred',
  'queued',
  'distributed',
  'resolved',
  'reopened',
  'sofia_paused',
  'sofia_resumed',
  'sofia_handoff',
  'sofia_suspended',
] as const;
export type WaConversationEventKind = (typeof WA_CONVERSATION_EVENT_KINDS)[number];

export const WA_CONVERSATION_EVENT_LABELS: Record<WaConversationEventKind, string> = {
  taken: 'Assumiu a conversa',
  transferred: 'Transferiu a conversa',
  queued: 'Mandou para a fila',
  distributed: 'Rodízio atribuiu a conversa',
  resolved: 'Resolveu a conversa',
  reopened: 'Reabriu a conversa',
  sofia_paused: 'Pausou a Sofia nesta conversa',
  sofia_resumed: 'Ligou a Sofia nesta conversa',
  sofia_handoff: 'A Sofia passou para uma pessoa',
  sofia_suspended: 'Mensagem de uma pessoa: a Sofia parou',
};

/** One line of the conversation's history: names of our people, codes, never the person's data. */
export interface WaConversationEvent {
  id: string;
  kind: WaConversationEventKind;
  fromName: string | null;
  toName: string | null;
  queue: SectorSlug | null;
  /** The reason in Portuguese (Sofia's handover, a pause). */
  reason: string | null;
  /** Null: the system or Sofia. */
  actorName: string | null;
  at: string;
}

export interface WaAttendance {
  conversationId: string;
  /** Pass back with every action: a stale one answers 409 `conversation_changed`. */
  version: number;
  /** Who holds it now, and whether that is an assignment (or the deal's or number's owner). */
  holderId: string | null;
  holderName: string | null;
  assigned: boolean;
  /** The department queue it waits in, when nobody holds it. */
  queue: SectorSlug | null;
  /** Someone else is typing in it right now. */
  replyingName: string | null;
  /** Official number only: Sofia paused here, and what she left when she passed it on. */
  sofiaPaused: boolean;
  sofia: { reason: string | null; facts: SofiaFact[] } | null;
  can: {
    take: boolean;
    transfer: boolean;
    resolve: boolean;
    reopen: boolean;
    pauseSofia: boolean;
    resumeSofia: boolean;
  };
}

export interface WaAttendanceView {
  attendance: WaAttendance;
  events: WaConversationEvent[];
  /** Who it may go to (active people who talk on WhatsApp); empty when the reader cannot transfer. */
  people: { id: string; name: string }[];
}

const version = z.number().int().min(0);

/** Take (`employeeId` = the reader), transfer (someone else) or send to a queue (`employeeId` null). */
export const waAssignSchema = z.object({
  version,
  employeeId: z.uuid().nullable(),
  queue: z
    .enum(SECTOR_SLUGS as [SectorSlug, ...SectorSlug[]])
    .nullable()
    .optional(),
});
export type WaAssignInput = z.infer<typeof waAssignSchema>;

export const waVersionSchema = z.object({ version });

export const waSofiaSwitchSchema = z.object({ version, action: z.enum(['pause', 'resume']) });

/** How long "está respondendo" lasts without the composer renewing it. */
export const WA_REPLYING_SECONDS = 45;
