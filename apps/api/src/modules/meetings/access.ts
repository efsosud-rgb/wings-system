import { grantedScope, type Actor } from '@wings/shared';
import { leadVisibleTo } from '../leads/access.js';

/**
 * Who may edit or delete a deal's meeting (Eric, 04/11): the deal's owner, who is also whoever
 * scheduled it for their own deal, and the roles that write on every lead (Admin Master, Gerente
 * comercial). It is the `leads.write` scope over the deal, not `leads.read`: a role that reads
 * every deal but writes only its own (or none, like Diretoria) never changes another's meeting.
 * Someone who scheduled a meeting and then lost the deal (it was reassigned) does not keep the
 * right: they no longer see the deal.
 */
export function canChangeMeeting(actor: Actor, lead: { ownerEmployeeId: string | null }): boolean {
  if (grantedScope(actor, 'leads.write') === null) return false;
  return leadVisibleTo(actor, 'leads.write', lead);
}

/** A meeting that has been held or cancelled is history: the card offers no edit or delete. */
export const meetingIsOpen = (status: string) => status === 'agendada' || status === 'em_andamento';
