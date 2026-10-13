import type { Actor, WaCall, WaCallStatus, WaRingingSnapshot } from '@wings/shared';
import { and, desc, eq, gt, isNull, sql } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import { leads, waCalls, waContacts } from '../../db/schema/index.js';
import type { Env } from '../../env.js';
import { leadOwnerFilter } from '../leads/access.js';
import { callingOn } from './calling.js';
import { errorText, whatsappConfigOf } from './graph.js';

/** Meta gives 30–60 s to answer; a ringing row older than this is not offered. */
export const RING_MS = 60_000;

type Row = typeof waCalls.$inferSelect;

/** One call as a screen sees it; `viewer` is who is looking (only the caller gets Meta's answer). */
export async function callView(db: Database, row: Row, viewer: string): Promise<WaCall> {
  const contact = await db.query.waContacts.findFirst({
    where: eq(waContacts.id, row.contactId),
  });
  const lead = row.leadId
    ? await db.query.leads.findFirst({ where: eq(leads.id, row.leadId), columns: { name: true } })
    : null;
  return {
    id: row.id,
    direction: row.direction === 'out' ? 'out' : 'in',
    status: row.status as WaCallStatus,
    leadId: row.leadId,
    name: lead?.name ?? contact?.profileName ?? null,
    phone: contact?.phone ?? '',
    answerSdp:
      row.direction === 'out' && row.employeeId === viewer && row.status !== 'completed'
        ? row.remoteSdp
        : null,
    error: errorText(row.errorCode, row.errorTitle),
    startedAt: row.startedAt.toISOString(),
    connectedAt: row.connectedAt?.toISOString() ?? null,
    endedAt: row.endedAt?.toISOString() ?? null,
    durationSeconds: row.durationSeconds,
  };
}

/**
 * The calls ringing for this person: incoming, not yet picked up, inside the ring
 * window, on a deal they can see (no deal: full scope only). The one place this is
 * decided; the poll route and the stream both answer from it.
 */
export async function ringingFor(
  db: Database,
  env: Env,
  fetchImpl: typeof fetch,
  actor: Actor,
  now: Date,
): Promise<WaRingingSnapshot> {
  const on = await callingOn(fetchImpl, whatsappConfigOf(env));
  if (!on) return { calling: false, calls: [] };
  const owner = leadOwnerFilter(actor, 'leads.whatsapp');
  const rows = await db
    .select({ call: waCalls })
    .from(waCalls)
    .leftJoin(leads, eq(leads.id, waCalls.leadId))
    .where(
      and(
        eq(waCalls.direction, 'in'),
        eq(waCalls.status, 'ringing'),
        isNull(waCalls.employeeId),
        gt(waCalls.startedAt, new Date(now.getTime() - RING_MS)),
        owner === undefined ? sql`true` : eq(leads.ownerEmployeeId, owner),
      ),
    )
    .orderBy(desc(waCalls.startedAt))
    .limit(5);
  return {
    calling: true,
    calls: await Promise.all(rows.map((r) => callView(db, r.call, actor.employeeId))),
  };
}
