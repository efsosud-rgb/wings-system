import {
  companyKey,
  isValidCnpj,
  normalizeBrazilianPhone,
  normalizeCnpj,
  normalizeEmail,
  type CrmCompany,
  type CrmContact,
  type CrmDuplicatePair,
  type CrmRelatedLead,
  type LeadContactRef,
  type LeadPipeline,
} from '@wings/shared';
import { and, asc, desc, eq, isNull, ne, or, sql } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import {
  clients,
  crmCompanies,
  crmContacts,
  employees,
  leadContacts,
  leadEvents,
  leads,
} from '../../db/schema/index.js';
import { createClientRecord } from '../clients/create.js';
import type { Executor } from './crm.js';

/**
 * Contacts and companies of the CRM (núcleo, 05/10/2026). A lead is a deal;
 * the person and the company are records found again by e-mail, phone, CNPJ
 * or name, so nothing is registered twice. Merging keeps the row chosen,
 * fills its gaps from the other, moves every link and retires the other with
 * `merged_into_id`. Personal data is returned to the screen only; events and
 * audit rows carry ids.
 */

type CompanyRow = typeof crmCompanies.$inferSelect;
type ContactRow = typeof crmContacts.$inferSelect;

const iso = (date: Date) => date.toISOString();

const live = (table: typeof crmContacts | typeof crmCompanies) => isNull(table.mergedIntoId);

// --- companies ------------------------------------------------------------------------

export interface CompanyInput {
  name: string;
  cnpj?: string | null;
  phone?: string | null;
  email?: string | null;
  website?: string | null;
  city?: string | null;
  state?: string | null;
  segment?: string | null;
}

/** The CNPJ as stored, or null when the text is not one (an invalid CNPJ is refused by the route). */
export const cnpjOf = (raw: string | null | undefined): string | null => {
  if (!raw?.trim()) return null;
  const cnpj = normalizeCnpj(raw);
  return cnpj.length === 14 ? cnpj : null;
};

function companyColumns(input: Partial<CompanyInput>): Partial<typeof crmCompanies.$inferInsert> {
  const patch: Partial<typeof crmCompanies.$inferInsert> = {};
  if (input.name !== undefined) {
    patch.name = input.name.trim().slice(0, 120);
    patch.nameKey = companyKey(patch.name);
  }
  if (input.cnpj !== undefined) patch.cnpj = cnpjOf(input.cnpj);
  if (input.phone !== undefined) patch.phone = normalizeBrazilianPhone(input.phone);
  if (input.email !== undefined) patch.email = normalizeEmail(input.email);
  if (input.website !== undefined) patch.website = input.website?.trim().slice(0, 200) || null;
  if (input.city !== undefined) patch.city = input.city?.trim().slice(0, 120) || null;
  if (input.state !== undefined)
    patch.state = input.state?.trim().toUpperCase().slice(0, 2) || null;
  if (input.segment !== undefined) patch.segment = input.segment?.trim().slice(0, 80) || null;
  return patch;
}

/** The live company a CNPJ or a name already names, if any. */
export async function findCompany(
  db: Executor,
  input: { cnpj?: string | null; name?: string | null },
): Promise<CompanyRow | null> {
  const cnpj = cnpjOf(input.cnpj);
  if (cnpj) {
    const byCnpj = await db.query.crmCompanies.findFirst({
      where: and(eq(crmCompanies.cnpj, cnpj), live(crmCompanies)),
    });
    if (byCnpj) return byCnpj;
  }
  const key = input.name ? companyKey(input.name) : '';
  if (!key) return null;
  return (
    (await db.query.crmCompanies.findFirst({
      where: and(eq(crmCompanies.nameKey, key), live(crmCompanies)),
    })) ?? null
  );
}

/**
 * The company for a name (and CNPJ when given): found by CNPJ, then by name;
 * made when neither matches. A found company gets its gaps filled, never
 * overwritten.
 */
export async function findOrCreateCompany(
  db: Executor,
  input: CompanyInput,
  actorEmployeeId: string | null,
): Promise<{ company: CompanyRow; created: boolean } | null> {
  const columns = companyColumns(input);
  if (!columns.nameKey) return null;
  await db.execute(
    sql`select pg_advisory_xact_lock(hashtext(${`crm:company:${columns.nameKey}`}))`,
  );
  const existing = await findCompany(db, input);
  if (existing) {
    const gaps: Partial<typeof crmCompanies.$inferInsert> = {};
    for (const key of ['cnpj', 'phone', 'email', 'website', 'city', 'state', 'segment'] as const) {
      if (!existing[key] && columns[key]) gaps[key] = columns[key];
    }
    if (Object.keys(gaps).length === 0) return { company: existing, created: false };
    const [updated] = await db
      .update(crmCompanies)
      .set({ ...gaps, updatedAt: new Date() })
      .where(eq(crmCompanies.id, existing.id))
      .returning();
    return { company: updated ?? existing, created: false };
  }
  const [created] = await db
    .insert(crmCompanies)
    .values({
      ...columns,
      name: columns.name!,
      nameKey: columns.nameKey,
      createdBy: actorEmployeeId,
    })
    .onConflictDoNothing()
    .returning();
  if (created) return { company: created, created: true };
  const theirs = await findCompany(db, input);
  return theirs ? { company: theirs, created: false } : null;
}

export type CompanyUpdateResult =
  | { ok: true; company: CompanyRow }
  | { ok: false; reason: 'not_found' | 'cnpj_taken' | 'name_taken' | 'invalid_cnpj' };

export async function updateCompany(
  db: Database,
  id: string,
  input: Partial<CompanyInput>,
): Promise<CompanyUpdateResult> {
  return db.transaction(async (tx) => {
    const row = await tx.query.crmCompanies.findFirst({
      where: and(eq(crmCompanies.id, id), live(crmCompanies)),
    });
    if (!row) return { ok: false, reason: 'not_found' };
    if (input.cnpj?.trim() && !isValidCnpj(input.cnpj))
      return { ok: false, reason: 'invalid_cnpj' };
    const patch = companyColumns(input);
    if (patch.cnpj && patch.cnpj !== row.cnpj) {
      const clash = await tx.query.crmCompanies.findFirst({
        where: and(eq(crmCompanies.cnpj, patch.cnpj), live(crmCompanies), ne(crmCompanies.id, id)),
      });
      if (clash) return { ok: false, reason: 'cnpj_taken' };
    }
    if (patch.nameKey && patch.nameKey !== row.nameKey) {
      const clash = await tx.query.crmCompanies.findFirst({
        where: and(
          eq(crmCompanies.nameKey, patch.nameKey),
          live(crmCompanies),
          ne(crmCompanies.id, id),
        ),
      });
      if (clash) return { ok: false, reason: 'name_taken' };
    }
    const [updated] = await tx
      .update(crmCompanies)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(crmCompanies.id, id))
      .returning();
    return { ok: true, company: updated ?? row };
  });
}

const companyCounts = {
  contacts: sql<number>`(select count(*) from ${crmContacts} c where c.company_id = ${crmCompanies.id} and c.merged_into_id is null)::int`,
  leads: sql<number>`(select count(*) from ${leads} l where l.company_id = ${crmCompanies.id})::int`,
  openLeads: sql<number>`(select count(*) from ${leads} l where l.company_id = ${crmCompanies.id} and l.won is null)::int`,
};

function companyQuery(db: Executor) {
  return db
    .select({
      row: crmCompanies,
      clientName: clients.name,
      ...companyCounts,
    })
    .from(crmCompanies)
    .leftJoin(clients, eq(clients.id, crmCompanies.clientId));
}

const toCompany = (item: {
  row: CompanyRow;
  clientName: string | null;
  contacts: number;
  leads: number;
  openLeads: number;
}): CrmCompany => ({
  id: item.row.id,
  name: item.row.name,
  cnpj: item.row.cnpj,
  phone: item.row.phone,
  email: item.row.email,
  website: item.row.website,
  city: item.row.city,
  state: item.row.state,
  segment: item.row.segment,
  clientId: item.row.clientId,
  clientName: item.clientName,
  contacts: item.contacts,
  leads: item.leads,
  openLeads: item.openLeads,
  createdAt: iso(item.row.createdAt),
  updatedAt: iso(item.row.updatedAt),
});

export const COMPANY_LIST_LIMIT = 200;

export async function listCompanies(db: Executor, input: { q?: string }): Promise<CrmCompany[]> {
  const needle = input.q ? `%${companyKey(input.q)}%` : null;
  const digits = input.q?.replace(/\D/g, '') ?? '';
  const rows = await companyQuery(db)
    .where(
      and(
        live(crmCompanies),
        needle
          ? or(
              sql`${crmCompanies.nameKey} like ${needle}`,
              digits.length >= 4
                ? sql`coalesce(${crmCompanies.cnpj}, '') like ${`%${digits}%`}`
                : sql`false`,
              sql`coalesce(${crmCompanies.email}, '') like ${`%${input.q!.toLowerCase()}%`}`,
            )
          : undefined,
      ),
    )
    .orderBy(asc(crmCompanies.name))
    .limit(COMPANY_LIST_LIMIT);
  return rows.map(toCompany);
}

export async function companyOf(db: Executor, id: string): Promise<CrmCompany | null> {
  const [row] = await companyQuery(db).where(eq(crmCompanies.id, id)).limit(1);
  if (!row) return null;
  // A merged row answers as the one it was merged into.
  if (row.row.mergedIntoId) return companyOf(db, row.row.mergedIntoId);
  return toCompany(row);
}

/** Pairs of live companies that share a name key or a CNPJ (a CNPJ clash cannot exist, so by name only). */
export async function duplicateCompanies(db: Executor): Promise<CrmDuplicatePair<CrmCompany>[]> {
  // Name keys are unique among live rows; near-duplicates are two rows whose
  // keys share the first two words. Kept simple on purpose: the screen shows
  // the pair and a person decides.
  const rows = await db.execute<{ a: string; b: string }>(sql`
    select x.id as a, y.id as b
    from ${crmCompanies} x
    join ${crmCompanies} y on y.id > x.id and y.merged_into_id is null
      and split_part(y.name_key, ' ', 1) = split_part(x.name_key, ' ', 1)
      and split_part(y.name_key, ' ', 2) = split_part(x.name_key, ' ', 2)
      and split_part(x.name_key, ' ', 2) <> ''
    where x.merged_into_id is null
    limit 100`);
  const pairs: CrmDuplicatePair<CrmCompany>[] = [];
  for (const row of rows.rows) {
    const [first, second] = await Promise.all([companyOf(db, row.a), companyOf(db, row.b)]);
    if (first && second) pairs.push({ by: 'name', a: first, b: second });
  }
  return pairs;
}

export type MergeResult = { ok: true } | { ok: false; reason: 'not_found' | 'same' | 'merged' };

/** `from` into `into`: the kept company fills its gaps, contacts and leads move, `from` is retired. */
export async function mergeCompanies(
  db: Database,
  input: { fromId: string; intoId: string; actorEmployeeId: string },
): Promise<MergeResult> {
  if (input.fromId === input.intoId) return { ok: false, reason: 'same' };
  return db.transaction(async (tx) => {
    const [from] = await tx
      .select()
      .from(crmCompanies)
      .where(eq(crmCompanies.id, input.fromId))
      .for('update');
    const [into] = await tx
      .select()
      .from(crmCompanies)
      .where(eq(crmCompanies.id, input.intoId))
      .for('update');
    if (!from || !into) return { ok: false, reason: 'not_found' };
    if (from.mergedIntoId || into.mergedIntoId) return { ok: false, reason: 'merged' };
    const gaps: Partial<typeof crmCompanies.$inferInsert> = {};
    for (const key of [
      'cnpj',
      'phone',
      'email',
      'website',
      'city',
      'state',
      'segment',
      'clientId',
    ] as const) {
      if (!into[key] && from[key]) gaps[key] = from[key];
    }
    const now = new Date();
    // The retired row frees its unique keys before the kept one takes them.
    await tx
      .update(crmCompanies)
      .set({ mergedIntoId: into.id, updatedAt: now })
      .where(eq(crmCompanies.id, from.id));
    if (Object.keys(gaps).length > 0)
      await tx
        .update(crmCompanies)
        .set({ ...gaps, updatedAt: now })
        .where(eq(crmCompanies.id, into.id));
    await tx
      .update(crmContacts)
      .set({ companyId: into.id, updatedAt: now })
      .where(eq(crmContacts.companyId, from.id));
    const moved = await tx
      .update(leads)
      .set({ companyId: into.id, updatedAt: now })
      .where(eq(leads.companyId, from.id))
      .returning({ id: leads.id });
    for (const lead of moved) {
      await tx.insert(leadEvents).values({
        leadId: lead.id,
        kind: 'lead.company_merged',
        actorEmployeeId: input.actorEmployeeId,
        detail: { fromCompanyId: from.id, intoCompanyId: into.id },
      });
    }
    return { ok: true };
  });
}

/**
 * A won deal's company becomes a client of the Formatação register (Novo
 * cliente's path: number, Drive tree, project when Formatação). Returns the
 * client id, the existing one when the company already is a client.
 */
export async function companyToClient(
  db: Database,
  input: { companyId: string; relationship: 'formatacao' | 'expansao' | 'ambos' },
): Promise<{ clientId: string; created: boolean } | 'not_found' | 'name_taken'> {
  const row = await db.query.crmCompanies.findFirst({
    where: and(eq(crmCompanies.id, input.companyId), live(crmCompanies)),
  });
  if (!row) return 'not_found';
  if (row.clientId) return { clientId: row.clientId, created: false };
  const primaryContact = await db.query.crmContacts.findFirst({
    where: and(eq(crmContacts.companyId, row.id), live(crmContacts)),
    orderBy: asc(crmContacts.createdAt),
  });
  const made = await createClientRecord(db, {
    name: row.name,
    cnpj: row.cnpj,
    relationship: input.relationship,
    company: { city: row.city, state: row.state },
    contact: primaryContact?.name
      ? {
          name: primaryContact.name,
          email: primaryContact.email,
          whatsapp: primaryContact.phone?.replace(/^55/, '') ?? null,
          jobTitle: primaryContact.jobTitle,
        }
      : null,
    business: row.segment ? { segment: row.segment } : undefined,
  });
  if (!made) return 'name_taken';
  await db
    .update(crmCompanies)
    .set({ clientId: made.row.id, updatedAt: new Date() })
    .where(eq(crmCompanies.id, row.id));
  return { clientId: made.row.id, created: true };
}

// --- contacts -------------------------------------------------------------------------

export interface ContactInput {
  name?: string | null;
  email?: string | null;
  phone?: string | null;
  jobTitle?: string | null;
  companyId?: string | null;
}

function contactColumns(input: ContactInput): Partial<typeof crmContacts.$inferInsert> {
  const patch: Partial<typeof crmContacts.$inferInsert> = {};
  if (input.name !== undefined) patch.name = input.name?.trim().slice(0, 120) || null;
  if (input.email !== undefined) patch.email = normalizeEmail(input.email);
  if (input.phone !== undefined) patch.phone = normalizeBrazilianPhone(input.phone);
  if (input.jobTitle !== undefined) patch.jobTitle = input.jobTitle?.trim().slice(0, 80) || null;
  if (input.companyId !== undefined) patch.companyId = input.companyId;
  return patch;
}

/** The live contact an e-mail or a phone already names: phone first (the WhatsApp is the identity here). */
export async function findContact(
  db: Executor,
  input: { email?: string | null; phone?: string | null },
): Promise<ContactRow | null> {
  const phone = normalizeBrazilianPhone(input.phone);
  if (phone) {
    const byPhone = await db.query.crmContacts.findFirst({
      where: and(eq(crmContacts.phone, phone), live(crmContacts)),
    });
    if (byPhone) return byPhone;
  }
  const email = normalizeEmail(input.email);
  if (email) {
    const byEmail = await db.query.crmContacts.findFirst({
      where: and(eq(crmContacts.email, email), live(crmContacts)),
    });
    if (byEmail) return byEmail;
  }
  return null;
}

/**
 * The contact for a person: found by phone, then e-mail; made when neither
 * matches. A found contact gets its gaps filled. Null when there is neither
 * an e-mail nor a phone to find them by again.
 */
export async function findOrCreateContact(
  db: Executor,
  input: ContactInput,
  actorEmployeeId: string | null,
): Promise<{ contact: ContactRow; created: boolean } | null> {
  const columns = contactColumns(input);
  if (!columns.email && !columns.phone) return null;
  for (const key of [
    columns.phone && `crm:contact:phone:${columns.phone}`,
    columns.email && `crm:contact:email:${columns.email}`,
  ]
    .filter((key): key is string => Boolean(key))
    .sort()) {
    await db.execute(sql`select pg_advisory_xact_lock(hashtext(${key}))`);
  }
  const existing = await findContact(db, columns);
  if (existing) {
    const gaps: Partial<typeof crmContacts.$inferInsert> = {};
    for (const key of ['name', 'email', 'phone', 'jobTitle', 'companyId'] as const) {
      if (!existing[key] && columns[key]) gaps[key] = columns[key];
    }
    // A second e-mail (or phone) must not steal another live contact's key.
    if (gaps.email) {
      const taken = await db.query.crmContacts.findFirst({
        where: and(eq(crmContacts.email, gaps.email), live(crmContacts)),
      });
      if (taken) delete gaps.email;
    }
    if (gaps.phone) {
      const taken = await db.query.crmContacts.findFirst({
        where: and(eq(crmContacts.phone, gaps.phone), live(crmContacts)),
      });
      if (taken) delete gaps.phone;
    }
    if (Object.keys(gaps).length === 0) return { contact: existing, created: false };
    const [updated] = await db
      .update(crmContacts)
      .set({ ...gaps, updatedAt: new Date() })
      .where(eq(crmContacts.id, existing.id))
      .returning();
    return { contact: updated ?? existing, created: false };
  }
  const [created] = await db
    .insert(crmContacts)
    .values({ ...columns, createdBy: actorEmployeeId })
    .onConflictDoNothing()
    .returning();
  if (created) return { contact: created, created: true };
  const theirs = await findContact(db, columns);
  return theirs ? { contact: theirs, created: false } : null;
}

/** Ties a contact to a lead; the first contact of a lead is its main one. */
export async function linkContact(
  db: Executor,
  input: { leadId: string; contactId: string; primary?: boolean; actorEmployeeId: string | null },
): Promise<void> {
  const current = await db
    .select({ contactId: leadContacts.contactId, primary: leadContacts.primary })
    .from(leadContacts)
    .where(eq(leadContacts.leadId, input.leadId));
  const already = current.find((row) => row.contactId === input.contactId);
  const hasPrimary = current.some((row) => row.primary);
  const primary = input.primary ?? (!hasPrimary || current.length === 0);
  if (primary) {
    await db
      .update(leadContacts)
      .set({ primary: false })
      .where(and(eq(leadContacts.leadId, input.leadId), eq(leadContacts.primary, true)));
  }
  if (already) {
    if (primary && !already.primary)
      await db
        .update(leadContacts)
        .set({ primary: true })
        .where(
          and(eq(leadContacts.leadId, input.leadId), eq(leadContacts.contactId, input.contactId)),
        );
    return;
  }
  await db
    .insert(leadContacts)
    .values({ leadId: input.leadId, contactId: input.contactId, primary })
    .onConflictDoNothing();
  await db.insert(leadEvents).values({
    leadId: input.leadId,
    kind: 'lead.contact_linked',
    actorEmployeeId: input.actorEmployeeId,
    detail: { contactId: input.contactId, primary },
  });
}

export async function unlinkContact(
  db: Executor,
  input: { leadId: string; contactId: string; actorEmployeeId: string | null },
): Promise<boolean> {
  const removed = await db
    .delete(leadContacts)
    .where(and(eq(leadContacts.leadId, input.leadId), eq(leadContacts.contactId, input.contactId)))
    .returning({ primary: leadContacts.primary });
  if (removed.length === 0) return false;
  if (removed[0]?.primary) {
    const next = await db.query.leadContacts.findFirst({
      where: eq(leadContacts.leadId, input.leadId),
      orderBy: asc(leadContacts.createdAt),
    });
    if (next)
      await db
        .update(leadContacts)
        .set({ primary: true })
        .where(
          and(eq(leadContacts.leadId, input.leadId), eq(leadContacts.contactId, next.contactId)),
        );
  }
  await db.insert(leadEvents).values({
    leadId: input.leadId,
    kind: 'lead.contact_unlinked',
    actorEmployeeId: input.actorEmployeeId,
    detail: { contactId: input.contactId },
  });
  return true;
}

/**
 * The person of an arriving lead, as a contact: found or made from the lead's
 * own name, e-mail and phone, tied as the lead's main contact when it has
 * none, and the lead's company tied to the contact when the contact has none.
 */
export async function attachLeadContact(
  db: Executor,
  lead: {
    id: string;
    name: string | null;
    email: string | null;
    phone: string | null;
    companyId: string | null;
  },
  actorEmployeeId: string | null,
): Promise<ContactRow | null> {
  const found = await findOrCreateContact(
    db,
    { name: lead.name, email: lead.email, phone: lead.phone, companyId: lead.companyId },
    actorEmployeeId,
  );
  if (!found) return null;
  await linkContact(db, { leadId: lead.id, contactId: found.contact.id, actorEmployeeId });
  return found.contact;
}

const contactCounts = {
  leads: sql<number>`(select count(*) from ${leadContacts} lc where lc.contact_id = ${crmContacts.id})::int`,
  openLeads: sql<number>`(select count(*) from ${leadContacts} lc join ${leads} l on l.id = lc.lead_id where lc.contact_id = ${crmContacts.id} and l.won is null)::int`,
};

function contactQuery(db: Executor) {
  return db
    .select({ row: crmContacts, companyName: crmCompanies.name, ...contactCounts })
    .from(crmContacts)
    .leftJoin(crmCompanies, eq(crmCompanies.id, crmContacts.companyId));
}

const toContact = (item: {
  row: ContactRow;
  companyName: string | null;
  leads: number;
  openLeads: number;
}): CrmContact => ({
  id: item.row.id,
  name: item.row.name,
  email: item.row.email,
  phone: item.row.phone,
  jobTitle: item.row.jobTitle,
  companyId: item.row.companyId,
  companyName: item.companyName,
  leads: item.leads,
  openLeads: item.openLeads,
  createdAt: iso(item.row.createdAt),
  updatedAt: iso(item.row.updatedAt),
});

export const CONTACT_LIST_LIMIT = 200;

/** A seller (own scope) sees only the contacts of their leads. */
export async function listContacts(
  db: Executor,
  input: { q?: string; ownerEmployeeId?: string },
): Promise<CrmContact[]> {
  const needle = input.q ? `%${input.q.toLowerCase()}%` : null;
  const digits = input.q?.replace(/\D/g, '') ?? '';
  const scope = input.ownerEmployeeId
    ? sql`exists (select 1 from ${leadContacts} lc join ${leads} l on l.id = lc.lead_id where lc.contact_id = ${crmContacts.id} and l.owner_employee_id = ${input.ownerEmployeeId})`
    : undefined;
  const rows = await contactQuery(db)
    .where(
      and(
        live(crmContacts),
        scope,
        needle
          ? or(
              sql`lower(coalesce(${crmContacts.name}, '')) like ${needle}`,
              sql`coalesce(${crmContacts.email}, '') like ${needle}`,
              digits.length >= 4
                ? sql`coalesce(${crmContacts.phone}, '') like ${`%${digits}%`}`
                : sql`false`,
              sql`lower(coalesce(${crmCompanies.name}, '')) like ${needle}`,
            )
          : undefined,
      ),
    )
    .orderBy(asc(crmContacts.name), desc(crmContacts.createdAt))
    .limit(CONTACT_LIST_LIMIT);
  return rows.map(toContact);
}

export async function contactOf(db: Executor, id: string): Promise<CrmContact | null> {
  const [row] = await contactQuery(db).where(eq(crmContacts.id, id)).limit(1);
  if (!row) return null;
  if (row.row.mergedIntoId) return contactOf(db, row.row.mergedIntoId);
  return toContact(row);
}

/** Whether a seller (own scope) may see a contact: one of their leads has it. */
export async function contactVisibleTo(db: Executor, contactId: string, ownerEmployeeId: string) {
  const [row] = await db
    .select({ one: sql<number>`1` })
    .from(leadContacts)
    .innerJoin(leads, eq(leads.id, leadContacts.leadId))
    .where(and(eq(leadContacts.contactId, contactId), eq(leads.ownerEmployeeId, ownerEmployeeId)))
    .limit(1);
  return Boolean(row);
}

export type ContactUpdateResult =
  | { ok: true; contact: ContactRow }
  | { ok: false; reason: 'not_found' | 'email_taken' | 'phone_taken' | 'no_key' };

export async function updateContact(
  db: Database,
  id: string,
  input: ContactInput,
): Promise<ContactUpdateResult> {
  return db.transaction(async (tx) => {
    const row = await tx.query.crmContacts.findFirst({
      where: and(eq(crmContacts.id, id), live(crmContacts)),
    });
    if (!row) return { ok: false, reason: 'not_found' };
    const patch = contactColumns(input);
    const email = patch.email === undefined ? row.email : patch.email;
    const phone = patch.phone === undefined ? row.phone : patch.phone;
    if (!email && !phone) return { ok: false, reason: 'no_key' };
    if (patch.email && patch.email !== row.email) {
      const clash = await tx.query.crmContacts.findFirst({
        where: and(eq(crmContacts.email, patch.email), live(crmContacts), ne(crmContacts.id, id)),
      });
      if (clash) return { ok: false, reason: 'email_taken' };
    }
    if (patch.phone && patch.phone !== row.phone) {
      const clash = await tx.query.crmContacts.findFirst({
        where: and(eq(crmContacts.phone, patch.phone), live(crmContacts), ne(crmContacts.id, id)),
      });
      if (clash) return { ok: false, reason: 'phone_taken' };
    }
    const [updated] = await tx
      .update(crmContacts)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(crmContacts.id, id))
      .returning();
    return { ok: true, contact: updated ?? row };
  });
}

/** Live contacts that share a phone with another, or an e-mail: cannot happen by the unique keys, so near-duplicates by name + company. */
export async function duplicateContacts(db: Executor): Promise<CrmDuplicatePair<CrmContact>[]> {
  const rows = await db.execute<{ a: string; b: string; by: string }>(sql`
    select x.id as a, y.id as b, 'name' as by
    from ${crmContacts} x
    join ${crmContacts} y on y.id > x.id and y.merged_into_id is null
      and lower(coalesce(y.name, '')) = lower(coalesce(x.name, '')) and coalesce(x.name, '') <> ''
    where x.merged_into_id is null
    limit 100`);
  const pairs: CrmDuplicatePair<CrmContact>[] = [];
  for (const row of rows.rows) {
    const [first, second] = await Promise.all([contactOf(db, row.a), contactOf(db, row.b)]);
    if (first && second) pairs.push({ by: row.by, a: first, b: second });
  }
  return pairs;
}

/** `from` into `into`: the kept contact fills its gaps, its lead links move, `from` is retired. */
export async function mergeContacts(
  db: Database,
  input: { fromId: string; intoId: string; actorEmployeeId: string },
): Promise<MergeResult> {
  if (input.fromId === input.intoId) return { ok: false, reason: 'same' };
  return db.transaction(async (tx) => {
    const [from] = await tx
      .select()
      .from(crmContacts)
      .where(eq(crmContacts.id, input.fromId))
      .for('update');
    const [into] = await tx
      .select()
      .from(crmContacts)
      .where(eq(crmContacts.id, input.intoId))
      .for('update');
    if (!from || !into) return { ok: false, reason: 'not_found' };
    if (from.mergedIntoId || into.mergedIntoId) return { ok: false, reason: 'merged' };
    const now = new Date();
    const gaps: Partial<typeof crmContacts.$inferInsert> = {};
    for (const key of ['name', 'email', 'phone', 'jobTitle', 'companyId'] as const) {
      if (!into[key] && from[key]) gaps[key] = from[key];
    }
    await tx
      .update(crmContacts)
      .set({ mergedIntoId: into.id, updatedAt: now })
      .where(eq(crmContacts.id, from.id));
    if (Object.keys(gaps).length > 0)
      await tx
        .update(crmContacts)
        .set({ ...gaps, updatedAt: now })
        .where(eq(crmContacts.id, into.id));
    const links = await tx.select().from(leadContacts).where(eq(leadContacts.contactId, from.id));
    for (const link of links) {
      await tx
        .delete(leadContacts)
        .where(and(eq(leadContacts.leadId, link.leadId), eq(leadContacts.contactId, from.id)));
      await linkContact(tx, {
        leadId: link.leadId,
        contactId: into.id,
        primary: link.primary || undefined,
        actorEmployeeId: input.actorEmployeeId,
      });
      await tx.insert(leadEvents).values({
        leadId: link.leadId,
        kind: 'lead.contact_merged',
        actorEmployeeId: input.actorEmployeeId,
        detail: { fromContactId: from.id, intoContactId: into.id },
      });
    }
    return { ok: true };
  });
}

// --- what a lead's page and a record's page show -------------------------------------------

export async function contactsOfLead(db: Executor, leadId: string): Promise<LeadContactRef[]> {
  const rows = await db
    .select({
      id: crmContacts.id,
      name: crmContacts.name,
      email: crmContacts.email,
      phone: crmContacts.phone,
      jobTitle: crmContacts.jobTitle,
      primary: leadContacts.primary,
      mergedIntoId: crmContacts.mergedIntoId,
    })
    .from(leadContacts)
    .innerJoin(crmContacts, eq(crmContacts.id, leadContacts.contactId))
    .where(eq(leadContacts.leadId, leadId))
    .orderBy(desc(leadContacts.primary), asc(leadContacts.createdAt));
  return rows.map(({ mergedIntoId: _merged, ...row }) => row);
}

export async function leadsOfContact(
  db: Executor,
  contactId: string,
  ownerEmployeeId?: string,
): Promise<CrmRelatedLead[]> {
  const rows = await db
    .select({
      id: leads.id,
      name: leads.name,
      pipeline: leads.pipeline,
      brand: leads.brand,
      stage: leads.stage,
      won: leads.won,
      valueCents: leads.valueCents,
      ownerName: employees.fullName,
      createdAt: leads.createdAt,
    })
    .from(leadContacts)
    .innerJoin(leads, eq(leads.id, leadContacts.leadId))
    .leftJoin(employees, eq(employees.id, leads.ownerEmployeeId))
    .where(
      and(
        eq(leadContacts.contactId, contactId),
        ownerEmployeeId ? eq(leads.ownerEmployeeId, ownerEmployeeId) : undefined,
      ),
    )
    .orderBy(desc(leads.createdAt))
    .limit(100);
  return rows.map((row) => ({
    ...row,
    pipeline: row.pipeline as LeadPipeline | null,
    createdAt: iso(row.createdAt),
  }));
}

export async function leadsOfCompany(
  db: Executor,
  companyId: string,
  ownerEmployeeId?: string,
): Promise<CrmRelatedLead[]> {
  const rows = await db
    .select({
      id: leads.id,
      name: leads.name,
      pipeline: leads.pipeline,
      brand: leads.brand,
      stage: leads.stage,
      won: leads.won,
      valueCents: leads.valueCents,
      ownerName: employees.fullName,
      createdAt: leads.createdAt,
    })
    .from(leads)
    .leftJoin(employees, eq(employees.id, leads.ownerEmployeeId))
    .where(
      and(
        eq(leads.companyId, companyId),
        ownerEmployeeId ? eq(leads.ownerEmployeeId, ownerEmployeeId) : undefined,
      ),
    )
    .orderBy(desc(leads.createdAt))
    .limit(100);
  return rows.map((row) => ({
    ...row,
    pipeline: row.pipeline as LeadPipeline | null,
    createdAt: iso(row.createdAt),
  }));
}

export async function contactsOfCompany(db: Executor, companyId: string): Promise<CrmContact[]> {
  const rows = await contactQuery(db)
    .where(and(eq(crmContacts.companyId, companyId), live(crmContacts)))
    .orderBy(asc(crmContacts.name));
  return rows.map(toContact);
}
