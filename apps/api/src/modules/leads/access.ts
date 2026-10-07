import { grantedScope, ROLE_PERMISSIONS, type Actor } from '@wings/shared';
import { eq } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import { leads } from '../../db/schema/index.js';
import type { LeadRow } from './service.js';

/**
 * Who may see and touch which lead: the one rule every route that returns or
 * changes a lead (or anything hanging from one: tasks, notes, files, e-mails,
 * meetings, contacts, the WhatsApp page, exports, counts) goes through.
 *
 *  - A holder of the permission with scope `all` (Admin Master, Diretoria,
 *    Gerente comercial) sees every lead, owned or not.
 *  - Anyone else (the sellers, scope `own`) sees only the leads they own. A
 *    lead nobody owns is out of their reach: its owner is NULL, which is never
 *    equal to an employee id. Do not hand a NULL owner to `can()` as the target
 *    owner: `scopeSatisfied` takes an undefined owner as "no owner to compare".
 *  - Any scope that is not `all`, or none at all, is treated as `own`: the rule
 *    fails closed.
 *  - Only a holder of `leads.assign` changes who owns a lead (`canChangeLeadOwner`).
 *
 * A lead out of reach is answered as not found (404), never as forbidden, so a
 * URL does not even tell a seller that the lead exists.
 */
export type LeadPermission = 'leads.read' | 'leads.write' | 'leads.whatsapp';

/**
 * The employee a query must filter `leads.owner_employee_id` by, or `undefined`
 * when the caller sees every lead. Pass it as `ownerEmployeeId` to the list,
 * board, summary, search and count helpers.
 */
export function leadOwnerFilter(actor: Actor, permission: LeadPermission): string | undefined {
  return grantedScope(actor, permission) === 'all' ? undefined : actor.employeeId;
}

/** Whether a lead row (anything with its owner) is in the caller's reach. */
export function leadVisibleTo(
  actor: Actor,
  permission: LeadPermission,
  lead: { ownerEmployeeId: string | null },
): boolean {
  const owner = leadOwnerFilter(actor, permission);
  return owner === undefined || lead.ownerEmployeeId === owner;
}

/**
 * The lead, when the caller may see (`leads.read`), change (`leads.write`) or talk and call about it
 * on the system's WhatsApp (`leads.whatsapp`); null otherwise. Each permission brings its own scope:
 * Diretoria reads and talks on every lead without editing any.
 */
export async function leadInScope(
  db: Database,
  actor: Actor,
  leadId: string,
  permission: LeadPermission,
): Promise<LeadRow | null> {
  const row = await db.query.leads.findFirst({ where: eq(leads.id, leadId) });
  if (!row) return null;
  return leadVisibleTo(actor, permission, row) ? row : null;
}

/** Only a holder of `leads.assign` (the Admin) moves a lead to another owner, or to nobody. */
export function canChangeLeadOwner(actor: Actor): boolean {
  return grantedScope(actor, 'leads.assign') !== null;
}

/**
 * The roles that see every lead (`leads.read` with scope `all`: Admin Master, Diretoria, Gerente comercial).
 * Notices that name a lead, above all one nobody owns, go only to these roles and to the lead's owner.
 */
export const LEAD_ADMIN_ROLE_KEYS: string[] = Object.entries(ROLE_PERMISSIONS)
  .filter(([, permissions]) => permissions['leads.read'] === 'all')
  .map(([role]) => role);
