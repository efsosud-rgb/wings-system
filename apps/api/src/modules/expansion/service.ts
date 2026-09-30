import { normalizeBrazilianPhone, normalizeEmail } from '@wings/shared';
import { and, asc, eq, gte, isNull, or } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import {
  clients,
  expansionIntakeLedger,
  leadEvents,
  leadSourceRules,
  leads,
} from '../../db/schema/index.js';
import {
  runExpansionIntake,
  type IntakeResult,
  type Ledger,
  type LandingPageRule,
  type Target,
} from './intake.js';
import { RdCrm, RdMarketing, type Conversion, type RdMarketingCredentials } from './rd.js';

export function dbLedger(db: Database): Ledger {
  return {
    async has(key) {
      const row = await db.query.expansionIntakeLedger.findFirst({
        where: eq(expansionIntakeLedger.conversionKey, key),
        columns: { id: true },
      });
      return Boolean(row);
    },
    async record(entry) {
      await db
        .insert(expansionIntakeLedger)
        .values({
          conversionKey: entry.key,
          target: entry.target,
          outcome: entry.outcome,
          rdDealId: entry.dealId,
        })
        .onConflictDoNothing();
    },
  };
}

/**
 * The brands' landing pages: the source rules of funnel Expansão. The brand
 * is the rule's own name for it (what RD's campaigns are named after), else
 * the client's.
 */
export async function activeRules(db: Database): Promise<LandingPageRule[]> {
  const rows = await db
    .select({
      identifier: leadSourceRules.pattern,
      brand: leadSourceRules.brand,
      clientName: clients.name,
    })
    .from(leadSourceRules)
    .leftJoin(clients, eq(clients.id, leadSourceRules.clientId))
    .where(
      and(
        eq(leadSourceRules.kind, 'landing_page'),
        eq(leadSourceRules.pipeline, 'expansao'),
        eq(leadSourceRules.active, true),
      ),
    )
    .orderBy(asc(leadSourceRules.pattern));
  return rows.flatMap((row) => {
    const brand = row.brand ?? row.clientName;
    return brand ? [{ identifier: row.identifier, brand }] : [];
  });
}

/**
 * The lead of the Funil this conversion is, gets the RD deal the intake just
 * made (CRM phase 1). Only a lead with no deal yet, in the same funnel (or
 * none said), that arrived in the 30 days before the conversion. When more
 * than one fits, the one with both the phone and the e-mail wins; still more
 * than one, nothing is linked (no guess) and the RD import sorts it out.
 */
export async function recordDealOnLead(
  db: Database,
  event: { conversion: Conversion; dealId: string; target: Target; brand: string | null },
): Promise<boolean> {
  const phone = normalizeBrazilianPhone(event.conversion.phone);
  const email = normalizeEmail(event.conversion.email);
  const byContact = [
    phone ? eq(leads.phone, phone) : null,
    email ? eq(leads.email, email) : null,
  ].filter((condition) => condition !== null);
  if (byContact.length === 0) return false;
  const since = new Date(event.conversion.occurredAt.getTime() - 30 * 86_400_000);
  const candidates = await db
    .select()
    .from(leads)
    .where(
      and(
        or(...byContact),
        isNull(leads.rdDealId),
        or(isNull(leads.pipeline), eq(leads.pipeline, event.target)),
        gte(leads.createdAt, since),
      ),
    )
    .limit(10);
  const both = candidates.filter(
    (lead) => phone && email && lead.phone === phone && lead.email === email,
  );
  const lead = candidates.length === 1 ? candidates[0] : both.length === 1 ? both[0] : undefined;
  if (!lead) return false;
  await db
    .update(leads)
    .set({
      rdDealId: event.dealId,
      pipeline: lead.pipeline ?? event.target,
      brand: lead.brand ?? event.brand,
      updatedAt: new Date(),
    })
    .where(eq(leads.id, lead.id));
  await db.insert(leadEvents).values({
    leadId: lead.id,
    kind: 'rd.deal_created',
    detail: { rdDealId: event.dealId, pipeline: event.target },
  });
  return true;
}

export interface IntakeCredentials {
  rdCrmToken: string;
  rdMarketing: RdMarketingCredentials;
  expansionOwnerId?: string | null;
}

/** One pass over the last `lookbackHours` of conversions. */
export async function runIntakeOnce(
  db: Database,
  credentials: IntakeCredentials,
  options: { lookbackHours: number; dryRun?: boolean; fetchImpl?: typeof fetch; now?: Date },
): Promise<IntakeResult> {
  const now = options.now ?? new Date();
  return runExpansionIntake({
    marketing: new RdMarketing(credentials.rdMarketing, options.fetchImpl),
    crm: new RdCrm(credentials.rdCrmToken, options.fetchImpl),
    ledger: dbLedger(db),
    rules: await activeRules(db),
    expansionOwnerId: credentials.expansionOwnerId ?? null,
    since: new Date(now.getTime() - options.lookbackHours * 3_600_000),
    dryRun: options.dryRun ?? false,
    now: () => now,
    onDealCreated: (event) => recordDealOnLead(db, event),
  });
}
