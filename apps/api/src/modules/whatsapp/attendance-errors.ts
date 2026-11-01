/** Why an attendance action was refused, and the words the screen shows (attendance.ts). */

export type AttendanceErrorCode =
  | 'conversation_changed'
  | 'not_holder'
  | 'person_invalid'
  | 'has_owner'
  | 'closed'
  | 'not_closed'
  | 'sofia_off'
  | 'not_official'
  | 'not_allowed';

export class AttendanceError extends Error {
  constructor(
    readonly code: AttendanceErrorCode,
    /** Who holds it, for "está com Fulano". */
    readonly holderName: string | null = null,
  ) {
    super(code);
  }
}

const STATUS: Record<AttendanceErrorCode, number> = {
  conversation_changed: 409,
  not_holder: 409,
  person_invalid: 400,
  has_owner: 409,
  closed: 409,
  not_closed: 409,
  sofia_off: 409,
  not_official: 409,
  not_allowed: 403,
};

/** The answer for a refused action, in the words the screen shows. */
export function attendanceRefusal(error: AttendanceError) {
  const who = error.holderName ?? 'outra pessoa';
  const messages: Record<AttendanceErrorCode, string> = {
    conversation_changed: `A conversa mudou de mãos agora (está com ${who}). Veja de novo antes de agir.`,
    not_holder: `Esta conversa está com ${who}. Assuma a conversa antes (${who} recebe um aviso).`,
    person_invalid: 'Escolha uma pessoa ativa que atende pelo WhatsApp.',
    has_owner: `Esta conversa é de ${who} (dono da negociação ou do número): passe para uma pessoa em vez da fila.`,
    closed: 'A conversa está resolvida: reabra antes.',
    not_closed: 'A conversa já está aberta.',
    sofia_off: 'A Sofia está desligada. Ligue-a na configuração antes.',
    not_official: 'A Sofia só atende no número oficial.',
    not_allowed: 'Você não pode fazer isso nesta conversa.',
  };
  return {
    status: STATUS[error.code],
    body: { error: error.code, message: messages[error.code] },
  };
}
