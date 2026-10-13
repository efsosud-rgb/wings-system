import {
  normalizeBrazilianPhone,
  normalizeEmail,
  SUSPECT_CAPITAL_DDDS,
  type LeadSuspectReason,
} from '@wings/shared';
import { and, between, eq, isNull } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import { leadEvents, leads } from '../../db/schema/index.js';

/**
 * The robot that filled Grupo Forte Fênix's page in October 2026 (orchestrator,
 * 13/10): made-up people, sent in bursts. A lead with the robot's e-mail and a
 * capital's DDD that also came in a burst or by direct traffic is marked
 * suspect, and its page shows why. Nothing here closes, loses or deletes a
 * lead: the seller confirms, or clears the mark. Migration 0088 applied the
 * same rule once to the leads already in the database.
 */

/** "4 envios em até 3 minutos na mesma página". */
export const SUSPECT_BURST_COUNT = 4;
export const SUSPECT_BURST_WINDOW_MS = 3 * 60_000;

const ROBOT_EMAIL = /^[a-z]+\.[a-z]+(\d{10})@gmail\.com$/;

/** nome.sobrenome + 10 digits @gmail.com, the digits not being the phone's. */
export function hasRobotEmail(email: string | null, phone: string | null): boolean {
  const digits = ROBOT_EMAIL.exec(normalizeEmail(email) ?? '')?.[1];
  if (!digits) return false;
  return !(normalizeBrazilianPhone(phone) ?? '').includes(digits);
}

export function hasCapitalDdd(phone: string | null): boolean {
  const ddd = /^55(\d{2})\d{8,9}$/.exec(normalizeBrazilianPhone(phone) ?? '')?.[1];
  return ddd !== undefined && (SUSPECT_CAPITAL_DDDS as readonly string[]).includes(ddd);
}

type TrafficColumns = Pick<
  typeof leads.$inferSelect,
  | 'utmSource'
  | 'utmMedium'
  | 'utmCampaign'
  | 'utmContent'
  | 'utmTerm'
  | 'gclid'
  | 'fbclid'
  | 'gbraid'
  | 'wbraid'
  | 'referrer'
  | 'adPlatform'
  | 'adCampaignExternalId'
  | 'adExternalId'
  | 'campaignId'
>;

/** What RD calls "Tráfego Direto": no UTM, no ad click, no referring page, no ad. */
export function isDirectTraffic(lead: TrafficColumns): boolean {
  return [
    lead.utmSource,
    lead.utmMedium,
    lead.utmCampaign,
    lead.utmContent,
    lead.utmTerm,
    lead.gclid,
    lead.fbclid,
    lead.gbraid,
    lead.wbraid,
    lead.referrer,
    lead.adPlatform,
    lead.adCampaignExternalId,
    lead.adExternalId,
    lead.campaignId,
  ].every((value) => !value);
}

/**
 * Whether `at` falls in some window of 3 minutes holding at least 4 arrivals
 * (`times` are the page's arrivals around it, `at` among them).
 */
export function inBurst(at: number, times: readonly number[]): boolean {
  const sorted = [...times].sort((a, b) => a - b);
  return sorted.some(
    (start) =>
      start <= at &&
      at - start <= SUSPECT_BURST_WINDOW_MS &&
      sorted.filter((time) => time >= start && time - start <= SUSPECT_BURST_WINDOW_MS).length >=
        SUSPECT_BURST_COUNT,
  );
}

/** The reasons to mark, or null when the lead is not the robot's. */
export function suspectReasonsOf(
  lead: TrafficColumns & { email: string | null; phone: string | null },
  burst: boolean,
): LeadSuspectReason[] | null {
  if (!hasRobotEmail(lead.email, lead.phone) || !hasCapitalDdd(lead.phone)) return null;
  const direct = isDirectTraffic(lead);
  if (!burst && !direct) return null;
  return [
    'robot_email',
    'capital_ddd',
    ...(burst ? (['burst'] as const) : []),
    ...(direct ? (['direct_traffic'] as const) : []),
  ];
}

/**
 * Checks a lead that just arrived and the page's arrivals around it: the
 * fourth of a burst also marks the three before it. A lead already marked, or
 * cleared by a person, is left alone. Answers how many were marked.
 */
export async function markSuspectsAround(
  db: Database,
  leadId: string,
  now = new Date(),
): Promise<number> {
  const lead = await db.query.leads.findFirst({ where: eq(leads.id, leadId) });
  if (!lead || !hasRobotEmail(lead.email, lead.phone)) return 0;
  const at = lead.enteredAt.getTime();
  const nearby = await db
    .select()
    .from(leads)
    .where(
      and(
        lead.landingPage
          ? eq(leads.landingPage, lead.landingPage)
          : and(isNull(leads.landingPage), eq(leads.source, lead.source)),
        between(
          leads.enteredAt,
          new Date(at - SUSPECT_BURST_WINDOW_MS),
          new Date(at + SUSPECT_BURST_WINDOW_MS),
        ),
      ),
    );
  const times = nearby.map((row) => row.enteredAt.getTime());
  let marked = 0;
  for (const row of nearby) {
    if (row.suspectAt || row.suspectClearedAt) continue;
    const reasons = suspectReasonsOf(row, inBurst(row.enteredAt.getTime(), times));
    if (!reasons) continue;
    const updated = await db
      .update(leads)
      .set({ suspectReasons: reasons, suspectAt: now })
      .where(and(eq(leads.id, row.id), isNull(leads.suspectAt), isNull(leads.suspectClearedAt)))
      .returning({ id: leads.id });
    if (updated.length === 0) continue;
    await db
      .insert(leadEvents)
      .values({ leadId: row.id, kind: 'lead.suspect_marked', detail: { reasons } });
    marked += 1;
  }
  return marked;
}
