import { WINGS_CLIENT_ID, type CrmBrand } from '@wings/shared';
import { and, asc, eq, isNull, or, sql } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import { clients, crmCompanies, leadEvents, leads } from '../../db/schema/index.js';
import { createClientRecord } from '../clients/create.js';
import { findOrCreateCompany } from './contacts.js';
import type { Executor } from './crm.js';

/**
 * The deal side of a lead (CRM núcleo): the estimated value, the brand of
 * interest and the company. The brand of interest is an Expansão client whose
 * franchise is on sale (`clients.franchise_on_sale`, kept in Administração →
 * CRM): choosing one files the lead under that client, the same column the
 * landing-page rules fill, so every filter and report keeps working.
 */

// --- brands of interest ---------------------------------------------------------------

export async function listBrands(db: Executor): Promise<CrmBrand[]> {
  const rows = await db
    .select({
      clientId: clients.id,
      name: clients.name,
      onSale: clients.franchiseOnSale,
      openLeads: sql<number>`(select count(*) from ${leads} l where l.client_id = ${clients.id} and l.won is null and l.pipeline = 'expansao')::int`,
    })
    .from(clients)
    .where(
      and(
        eq(clients.active, true),
        sql`${clients.id} <> ${WINGS_CLIENT_ID}`,
        or(
          eq(clients.franchiseOnSale, true),
          eq(clients.relationship, 'expansao'),
          eq(clients.relationship, 'ambos'),
        ),
      ),
    )
    .orderBy(asc(clients.name));
  return rows.map((row) => ({ ...row, onSale: row.onSale === true }));
}

/** The brand list a seller picks from: only the ones on sale. */
export async function brandsOnSale(db: Executor): Promise<CrmBrand[]> {
  return (await listBrands(db)).filter((brand) => brand.onSale);
}

/** Registers a brand as an Expansão client with its franchise on sale (Novo cliente's path). */
export async function createBrand(
  db: Database,
  input: { name: string },
): Promise<CrmBrand | 'exists'> {
  const made = await createClientRecord(db, { name: input.name, relationship: 'expansao' });
  if (!made) return 'exists';
  await db
    .update(clients)
    .set({ franchiseOnSale: true, updatedAt: new Date() })
    .where(eq(clients.id, made.row.id));
  return { clientId: made.row.id, name: made.row.name, onSale: true, openLeads: 0 };
}

export async function setBrandOnSale(
  db: Database,
  clientId: string,
  onSale: boolean,
): Promise<CrmBrand | null> {
  const [row] = await db
    .update(clients)
    .set({ franchiseOnSale: onSale, updatedAt: new Date() })
    .where(and(eq(clients.id, clientId), sql`${clients.id} <> ${WINGS_CLIENT_ID}`))
    .returning({ id: clients.id, name: clients.name });
  if (!row) return null;
  return (await listBrands(db)).find((brand) => brand.clientId === row.id) ?? null;
}

// --- the lead's deal fields ---------------------------------------------------------------

export interface DealChange {
  leadId: string;
  valueCents?: number | null;
  /** `AAAA-MM-DD`, validated by the route; null clears the forecast. */
  expectedCloseAt?: string | null;
  /** A client id from the brand list; null clears the brand (the lead goes back to Wings Company, unmapped). */
  brandClientId?: string | null;
  companyId?: string | null;
  companyName?: string;
  name?: string;
  actorEmployeeId: string | null;
}

export type DealChangeResult =
  | { ok: true; changed: string[] }
  | { ok: false; reason: 'not_found' | 'brand_not_found' | 'company_not_found' };

export async function changeDeal(db: Database, change: DealChange): Promise<DealChangeResult> {
  return db.transaction(async (tx) => {
    const [lead] = await tx.select().from(leads).where(eq(leads.id, change.leadId)).for('update');
    if (!lead) return { ok: false, reason: 'not_found' };
    const now = new Date();
    const patch: Partial<typeof leads.$inferInsert> = { updatedAt: now };
    const changed: string[] = [];
    const events: { kind: string; detail: Record<string, unknown> }[] = [];

    if (change.name !== undefined && change.name !== lead.name) {
      patch.name = change.name;
      changed.push('name');
      // The old and new names stay in the event: a person's name is personal
      // data, but the timeline of the deal is where the team is meant to see it.
      events.push({ kind: 'lead.renamed', detail: { from: lead.name, to: change.name } });
    }

    if (change.valueCents !== undefined && change.valueCents !== lead.valueCents) {
      patch.valueCents = change.valueCents;
      changed.push('value');
      events.push({
        kind: 'lead.value_changed',
        detail: { from: lead.valueCents, to: change.valueCents },
      });
    }

    if (change.expectedCloseAt !== undefined && change.expectedCloseAt !== lead.expectedCloseAt) {
      patch.expectedCloseAt = change.expectedCloseAt;
      changed.push('expected_close');
      events.push({
        kind: 'lead.expected_close_changed',
        detail: { from: lead.expectedCloseAt, to: change.expectedCloseAt },
      });
    }

    if (change.brandClientId !== undefined) {
      if (change.brandClientId === null) {
        if (lead.clientId !== WINGS_CLIENT_ID || lead.brand) {
          patch.clientId = WINGS_CLIENT_ID;
          patch.clientMapped = false;
          patch.brand = null;
          changed.push('brand');
          events.push({ kind: 'lead.brand_changed', detail: { from: lead.clientId, to: null } });
        }
      } else if (change.brandClientId !== lead.clientId) {
        const brand = await tx.query.clients.findFirst({
          where: and(eq(clients.id, change.brandClientId), eq(clients.active, true)),
          columns: { id: true, name: true },
        });
        if (!brand) return { ok: false, reason: 'brand_not_found' };
        patch.clientId = brand.id;
        patch.clientMapped = true;
        patch.brand = brand.name;
        changed.push('brand');
        events.push({ kind: 'lead.brand_changed', detail: { from: lead.clientId, to: brand.id } });
      }
    }

    let companyId: string | null | undefined;
    if (change.companyName) {
      const found = await findOrCreateCompany(
        tx,
        { name: change.companyName },
        change.actorEmployeeId,
      );
      companyId = found?.company.id ?? null;
    } else if (change.companyId !== undefined) {
      if (change.companyId !== null) {
        const company = await tx.query.crmCompanies.findFirst({
          where: and(eq(crmCompanies.id, change.companyId), isNull(crmCompanies.mergedIntoId)),
          columns: { id: true },
        });
        if (!company) return { ok: false, reason: 'company_not_found' };
      }
      companyId = change.companyId;
    }
    if (companyId !== undefined && companyId !== lead.companyId) {
      patch.companyId = companyId;
      changed.push('company');
      events.push({
        kind: 'lead.company_changed',
        detail: { from: lead.companyId, to: companyId },
      });
    }

    if (changed.length === 0) return { ok: true, changed };
    await tx.update(leads).set(patch).where(eq(leads.id, lead.id));
    for (const event of events) {
      await tx.insert(leadEvents).values({
        leadId: lead.id,
        kind: event.kind,
        actorEmployeeId: change.actorEmployeeId,
        detail: event.detail,
      });
    }
    return { ok: true, changed };
  });
}
