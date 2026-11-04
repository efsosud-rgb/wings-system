import {
  brazilianPhoneVariants,
  type LeadContactChange,
  type LeadContactField,
  type LeadContactPatch,
} from '@wings/shared';
import { and, desc, eq, inArray, isNull, ne, or, sql } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import {
  crmContacts,
  employees,
  leadContactChanges,
  leadContacts,
  leadEvents,
  leads,
} from '../../db/schema/index.js';
import { leadContactOptOuts, recordContactOptOut } from './contact-block.js';
import { contactOnForeignDeal, numberInAttendance } from './contacts.js';
import type { Executor } from './crm.js';

/**
 * Editing a lead's contact data from the ficha (t089, docs/crm/editar-contato.md). The lead's own
 * columns are what WhatsApp, calls, e-mail and the automations read at the moment they act, so
 * writing them is what makes the new number the channel. The deal's main contact is kept in step,
 * the trail goes to `lead_contact_changes` (values, off every report) and the timeline gets the
 * field names only.
 */

export type ContactEditResult =
  | { ok: true; changed: LeadContactField[] }
  | { ok: false; reason: 'not_found' | 'no_contact_key' | 'contact_in_use' };

export interface ContactEdit {
  leadId: string;
  /** Already validated and normalised (`checkLeadContactUpdate`). */
  patch: LeadContactPatch;
  actorEmployeeId: string;
  /** The caller's own scope: the lead must be theirs and its phone or e-mail must not sit on a deal they do not see. */
  ownerScope?: string;
}

/** The stored check a field makes stale when it changes. */
const STALE_CHECK: Partial<Record<LeadContactField, string>> = {
  phone: 'whatsapp',
  instagram: 'instagram',
  website: 'website',
};

/** Whether another deal, outside the caller's reach, already holds this phone or e-mail. */
async function heldByForeignDeal(
  tx: Executor,
  edit: ContactEdit,
  next: { phone?: string | null; email?: string | null },
): Promise<boolean> {
  const owner = edit.ownerScope;
  if (owner === undefined) return false;
  const keys = [
    next.phone ? inArray(leads.phone, brazilianPhoneVariants(next.phone)) : undefined,
    next.email ? eq(leads.email, next.email) : undefined,
  ].filter((key) => key !== undefined);
  if (keys.length > 0) {
    const [other] = await tx
      .select({ one: sql<number>`1` })
      .from(leads)
      .where(
        and(
          ne(leads.id, edit.leadId),
          or(...keys),
          or(isNull(leads.ownerEmployeeId), ne(leads.ownerEmployeeId, owner)),
        ),
      )
      .limit(1);
    if (other) return true;
  }
  if (await contactOnForeignDeal(tx, next, owner)) return true;
  return Boolean(next.phone && (await numberInAttendance(tx, next.phone)));
}

/** The deal's main contact follows the lead where it held the same value (a second person is never touched). */
async function syncMainContact(
  tx: Executor,
  lead: typeof leads.$inferSelect,
  patch: LeadContactPatch,
  now: Date,
) {
  const [main] = await tx
    .select({ contact: crmContacts })
    .from(leadContacts)
    .innerJoin(crmContacts, eq(crmContacts.id, leadContacts.contactId))
    .where(and(eq(leadContacts.leadId, lead.id), isNull(crmContacts.mergedIntoId)))
    .orderBy(desc(leadContacts.primary), leadContacts.createdAt)
    .limit(1);
  if (!main) return;
  const contact = main.contact;
  const set: Partial<typeof crmContacts.$inferInsert> = {};
  for (const field of ['name', 'phone', 'email'] as const) {
    const next = patch[field];
    if (next === undefined || contact[field] !== lead[field]) continue;
    // A phone or an e-mail another person already holds stays where it is (unique keys).
    if (next && field !== 'name') {
      const clash = await tx.query.crmContacts.findFirst({
        where: and(
          eq(crmContacts[field], next),
          isNull(crmContacts.mergedIntoId),
          ne(crmContacts.id, contact.id),
        ),
        columns: { id: true },
      });
      if (clash) continue;
    }
    if (field === 'name' && !next) continue;
    set[field] = next;
  }
  // A contact keeps at least one key to be found by.
  if (
    !(set.phone === undefined ? contact.phone : set.phone) &&
    !(set.email === undefined ? contact.email : set.email)
  )
    return;
  if (Object.keys(set).length === 0) return;
  await tx
    .update(crmContacts)
    .set({ ...set, updatedAt: now })
    .where(eq(crmContacts.id, contact.id));
}

export async function changeLeadContact(
  db: Database,
  edit: ContactEdit,
): Promise<ContactEditResult> {
  return db.transaction(async (tx) => {
    // A key is locked for the transaction, in a fixed order, as the arrival of a lead does.
    const keys = [
      edit.patch.phone ? `lead:phone:${edit.patch.phone}` : null,
      edit.patch.email ? `lead:email:${edit.patch.email}` : null,
    ]
      .filter((key): key is string => key !== null)
      .sort();
    for (const key of keys) await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${key}))`);

    const [lead] = await tx.select().from(leads).where(eq(leads.id, edit.leadId)).for('update');
    if (!lead || (edit.ownerScope !== undefined && lead.ownerEmployeeId !== edit.ownerScope))
      return { ok: false, reason: 'not_found' };

    const changed = (Object.keys(edit.patch) as LeadContactField[]).filter(
      (field) => edit.patch[field] !== undefined && edit.patch[field] !== lead[field],
    );
    if (changed.length === 0) return { ok: true, changed };

    const after = (field: 'phone' | 'email') =>
      edit.patch[field] === undefined ? lead[field] : edit.patch[field];
    if ((lead.phone || lead.email) && !after('phone') && !after('email'))
      return { ok: false, reason: 'no_contact_key' };
    const next = {
      phone: changed.includes('phone') ? edit.patch.phone : undefined,
      email: changed.includes('email') ? edit.patch.email : undefined,
    };
    if (await heldByForeignDeal(tx, edit, next)) return { ok: false, reason: 'contact_in_use' };

    // A "não me contate" follows the person to the new keys: fixing a number never lifts it.
    const optOuts =
      changed.includes('phone') || changed.includes('email') || changed.includes('instagram')
        ? (await leadContactOptOuts(tx, lead.id, lead.tenantId)).entries
        : [];

    const now = new Date();
    const stale = changed.map((field) => STALE_CHECK[field]).filter((key) => key !== undefined);
    await tx
      .update(leads)
      .set({
        ...Object.fromEntries(changed.map((field) => [field, edit.patch[field]])),
        ...(stale.length > 0
          ? {
              fieldChecks: sql`coalesce(${leads.fieldChecks}, '{}'::jsonb) - ${sql.raw(
                `ARRAY[${stale.map((key) => `'${key}'`).join(',')}]::text[]`,
              )}`,
            }
          : {}),
        updatedAt: now,
      })
      .where(eq(leads.id, lead.id));
    await syncMainContact(tx, lead, edit.patch, now);
    // Only what a prospect row implies (no register row, keyed by place_id or lead) stays out: its keys do not change.
    for (const entry of optOuts.filter((e) => !(e.id === null && e.origin === 'prospeccao')))
      await recordContactOptOut(tx, {
        tenantId: lead.tenantId,
        leadId: lead.id,
        channels: [entry.channel],
        origin: entry.origin,
        reason: 'Mantido ao alterar os dados de contato',
        createdBy: edit.actorEmployeeId,
      });

    await tx.insert(leadContactChanges).values(
      changed.map((field) => ({
        leadId: lead.id,
        field,
        oldValue: lead[field],
        newValue: edit.patch[field] ?? null,
        actorEmployeeId: edit.actorEmployeeId,
        at: now,
      })),
    );
    await tx.insert(leadEvents).values({
      leadId: lead.id,
      kind: 'lead.contact_changed',
      actorEmployeeId: edit.actorEmployeeId,
      detail: { fields: changed },
    });
    return { ok: true, changed };
  });
}

/** The history of a lead's contact data, newest first; the caller has already been checked against the lead. */
export async function contactChangesOf(
  db: Executor,
  leadId: string,
  limit = 100,
): Promise<LeadContactChange[]> {
  const rows = await db
    .select({ change: leadContactChanges, actorName: employees.fullName })
    .from(leadContactChanges)
    .leftJoin(employees, eq(employees.id, leadContactChanges.actorEmployeeId))
    .where(eq(leadContactChanges.leadId, leadId))
    .orderBy(desc(leadContactChanges.at), desc(leadContactChanges.id))
    .limit(limit);
  return rows.map(({ change, actorName }) => ({
    id: change.id,
    at: change.at.toISOString(),
    field: change.field as LeadContactField,
    from: change.oldValue,
    to: change.newValue,
    actorName,
  }));
}
