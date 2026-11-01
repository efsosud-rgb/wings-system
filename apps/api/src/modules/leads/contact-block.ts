import {
  CONTACT_CHANNEL_LABELS,
  CONTACT_OPT_OUT_ORIGIN_LABELS,
  normalizeContactKey,
  WHATSAPP_OPT_IN_MISSING_TEXT,
  whatsappOptInMissing,
  type ContactBlock,
  type ContactChannel,
  type ContactKeyKind,
  type ContactOptOutEntry,
  type ContactOptOutOrigin,
  type LeadContactOptOuts,
} from '@wings/shared';
import { and, eq, inArray, isNotNull, isNull, or, sql, type SQL } from 'drizzle-orm';
import { WINGS_TENANT_ID } from '../../db/schema/ads.js';
import { contactOptOuts, leadEvents, leads, prospects, waContacts } from '../../db/schema/index.js';
import type { Executor } from './crm.js';

/**
 * The one "não me contate" check (docs/crm/nao-me-contate.md, Eric 29/10). Every path where Wings
 * starts a contact asks `contactBlock` first. It reads, and only reads: the register
 * (`contact_opt_outs`, the channel asked or `all`), the WhatsApp SAIR (`wa_contacts.opt_out_at`),
 * a prospect marked `nao_contatar` (every channel, by place_id or by the lead it became) and, for
 * WhatsApp, the Prospecção opt-in rule (`whatsappOptInMissing`) unchanged.
 */

/** What is known of the person: any of these, a lead's own keys are added to them. */
export interface ContactKeys {
  tenantId?: string;
  leadId?: string | null;
  phone?: string | null;
  email?: string | null;
  instagramUser?: string | null;
  placeId?: string | null;
  cnpj?: string | null;
}

const OPEN: ContactBlock = { blocked: false, reason: null, origin: null };

type LeadKeys = {
  phone: string | null;
  email: string | null;
  instagram: string | null;
  companyCnpj: string | null;
  googlePlaceId: string | null;
  source: string;
  legalBasis: string | null;
  consentSource: string | null;
};

async function leadOf(db: Executor, tenantId: string, leadId: string | null | undefined) {
  if (!leadId) return null;
  const [lead] = await db
    .select({
      phone: leads.phone,
      email: leads.email,
      instagram: leads.instagram,
      companyCnpj: leads.companyCnpj,
      googlePlaceId: leads.googlePlaceId,
      source: leads.source,
      legalBasis: leads.legalBasis,
      consentSource: leads.consentSource,
    })
    .from(leads)
    .where(and(eq(leads.id, leadId), eq(leads.tenantId, tenantId)));
  return (lead ?? null) as LeadKeys | null;
}

/** Every key, by kind, in its stored form (a phone canonical, as `wa_contacts.phone` keeps it). */
function normalisedKeys(keys: ContactKeys, lead: LeadKeys | null) {
  const of = (kind: ContactKeyKind, ...raws: (string | null | undefined)[]) => [
    ...new Set(raws.map((raw) => normalizeContactKey(kind, raw)).filter((v): v is string => !!v)),
  ];
  return {
    lead: keys.leadId ? [keys.leadId] : [],
    phone: of('phone', keys.phone, lead?.phone),
    email: of('email', keys.email, lead?.email),
    instagram_user: of('instagram_user', keys.instagramUser, lead?.instagram),
    place_id: of('place_id', keys.placeId, lead?.googlePlaceId),
    cnpj: of('cnpj', keys.cnpj, lead?.companyCnpj),
  } satisfies Record<ContactKeyKind, string[]>;
}

function registerMatch(keys: ReturnType<typeof normalisedKeys>): SQL | undefined {
  return or(
    ...Object.entries(keys)
      .filter(([, values]) => values.length > 0)
      .map(([kind, values]) =>
        and(eq(contactOptOuts.keyKind, kind), inArray(contactOptOuts.keyValue, values)),
      ),
  );
}

/**
 * Entries one event made, left out of a check: the origin, and the moment the event arrived (the
 * database's clock, as `contact_opt_outs.created_at`). A register row of that origin from before
 * `since` still counts; the older sources of that origin (`wa_contacts.opt_out_at`, rewritten by
 * every SAIR) never do.
 */
export interface OwnOptOut {
  origin: ContactOptOutOrigin;
  since: Date;
}

const isOwn = (entry: ContactOptOutEntry, own: OwnOptOut | undefined) =>
  !!own &&
  entry.origin === own.origin &&
  (entry.id === null || entry.since >= own.since.toISOString());

/** Every active "não me contate" that reaches these keys, oldest first, one per channel and origin. */
async function entriesOf(
  db: Executor,
  tenantId: string,
  keys: ReturnType<typeof normalisedKeys>,
  own?: OwnOptOut,
) {
  const match = registerMatch(keys);
  // One read at a time: a transaction's connection takes one query at a time (side by side, pg warns
  // and pg 9 refuses), and a caller inside a transaction must read through it, never through the pool
  // (a second connection held while the first waits is how the pool runs dry).
  const register = match
    ? await db
        .select()
        .from(contactOptOuts)
        .where(and(eq(contactOptOuts.tenantId, tenantId), isNull(contactOptOuts.revokedAt), match))
    : [];
  const waOptOuts = keys.phone.length
    ? await db
        .select({ since: waContacts.optOutAt })
        .from(waContacts)
        .where(
          and(
            eq(waContacts.tenantId, tenantId),
            inArray(waContacts.phone, keys.phone),
            isNotNull(waContacts.optOutAt),
          ),
        )
    : [];
  const prospectRows =
    keys.place_id.length || keys.lead.length
      ? await db
          .select({ reason: prospects.reason, since: prospects.updatedAt })
          .from(prospects)
          .where(
            and(
              eq(prospects.tenantId, tenantId),
              eq(prospects.status, 'nao_contatar'),
              or(
                keys.place_id.length ? inArray(prospects.placeId, keys.place_id) : undefined,
                keys.lead.length ? inArray(prospects.leadId, keys.lead) : undefined,
              ),
            ),
          )
      : [];
  const all: ContactOptOutEntry[] = [
    ...register.map((row) => ({
      id: row.id,
      channel: row.channel as ContactChannel,
      origin: row.origin as ContactOptOutOrigin,
      reason: row.reason,
      since: row.createdAt.toISOString(),
    })),
    ...waOptOuts.map((row) => ({
      id: null,
      channel: 'whatsapp' as const,
      origin: 'whatsapp_palavra' as const,
      reason: null,
      since: row.since!.toISOString(),
    })),
    ...prospectRows.map((row) => ({
      id: null,
      channel: 'all' as const,
      origin: 'prospeccao' as const,
      reason: row.reason,
      since: row.since.toISOString(),
    })),
  ]
    // Left out before one per channel and origin is kept: an older row of the same origin stays.
    .filter((entry) => !isOwn(entry, own))
    .sort((a, b) => a.since.localeCompare(b.since));
  const seen = new Set<string>();
  return all.filter((entry) => {
    const key = `${entry.channel}:${entry.origin}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

const blockOf = (entry: ContactOptOutEntry): ContactBlock => ({
  blocked: true,
  reason: `Pediu para não ser contatado (${CONTACT_CHANNEL_LABELS[entry.channel]}; ${
    CONTACT_OPT_OUT_ORIGIN_LABELS[entry.origin]
  }).`,
  origin: entry.origin,
});

function decide(
  entries: ContactOptOutEntry[],
  lead: LeadKeys | null,
  channels: ContactChannel[],
): ContactBlock {
  const hit = entries.find((e) => e.channel === 'all' || channels.includes(e.channel));
  if (hit) return blockOf(hit);
  if (channels.includes('whatsapp') && lead && whatsappOptInMissing(lead))
    return { blocked: true, reason: WHATSAPP_OPT_IN_MISSING_TEXT, origin: 'prospeccao' };
  return OPEN;
}

/**
 * Whether Wings may start a contact on this channel (or any of these), and why not. `except` leaves
 * out what one event made: Sofia asks it without the SAIR she is about to confirm, and only that
 * one (an older SAIR, by any key of the person, still blocks).
 */
export async function contactBlock(
  db: Executor,
  channel: ContactChannel | ContactChannel[],
  keys: ContactKeys,
  except?: OwnOptOut,
): Promise<ContactBlock> {
  const tenantId = keys.tenantId ?? WINGS_TENANT_ID;
  const lead = await leadOf(db, tenantId, keys.leadId);
  const entries = await entriesOf(db, tenantId, normalisedKeys(keys, lead), except);
  return decide(entries, lead, [channel].flat());
}

/** A lead's badge: every active entry, and per channel whether a contact may start. */
export async function leadContactOptOuts(
  db: Executor,
  leadId: string,
  tenantId = WINGS_TENANT_ID,
): Promise<LeadContactOptOuts> {
  const lead = await leadOf(db, tenantId, leadId);
  const entries = await entriesOf(db, tenantId, normalisedKeys({ leadId }, lead));
  return {
    entries,
    blocks: {
      whatsapp: decide(entries, lead, ['whatsapp']),
      phone: decide(entries, lead, ['phone']),
      email: decide(entries, lead, ['email']),
      instagram: decide(entries, lead, ['instagram']),
    },
  };
}

/**
 * Records a "não me contate" on these channels for every key given (a lead's own keys included).
 * Idempotent: an active row for the same channel and key stays as it is. Returns the rows added.
 */
export async function recordContactOptOut(
  db: Executor,
  input: ContactKeys & {
    channels: ContactChannel[];
    origin: ContactOptOutOrigin;
    reason: string | null;
    createdBy: string | null;
  },
): Promise<number> {
  const tenantId = input.tenantId ?? WINGS_TENANT_ID;
  const lead = await leadOf(db, tenantId, input.leadId);
  const keys = normalisedKeys(input, lead);
  const channels: ContactChannel[] = input.channels.includes('all')
    ? ['all']
    : [...new Set(input.channels)];
  const rows = channels.flatMap((channel) =>
    Object.entries(keys).flatMap(([keyKind, values]) =>
      values.map((keyValue) => ({
        tenantId,
        channel,
        keyKind,
        keyValue,
        origin: input.origin,
        reason: input.reason,
        createdBy: input.createdBy,
      })),
    ),
  );
  if (rows.length === 0) return 0;
  const added = await db
    .insert(contactOptOuts)
    .values(rows)
    .onConflictDoNothing()
    .returning({ id: contactOptOuts.id });
  return added.length;
}

/** Revokes every active row of this channel that reaches the lead. Returns how many. */
export async function revokeContactOptOuts(
  db: Executor,
  input: { leadId: string; channel: ContactChannel; reason: string; by: string; at: Date },
  tenantId = WINGS_TENANT_ID,
): Promise<number> {
  const lead = await leadOf(db, tenantId, input.leadId);
  const match = registerMatch(normalisedKeys({ leadId: input.leadId }, lead));
  const revoked = await db
    .update(contactOptOuts)
    .set({ revokedAt: input.at, revokedBy: input.by, revokedReason: input.reason })
    .where(
      and(
        eq(contactOptOuts.tenantId, tenantId),
        eq(contactOptOuts.channel, input.channel),
        isNull(contactOptOuts.revokedAt),
        match ?? sql`false`,
      ),
    )
    .returning({ id: contactOptOuts.id });
  return revoked.length;
}

/** A contact that did not start, on the lead's timeline: the channel, the path, the origin; never a text. */
export async function noteContactBlocked(
  db: Executor,
  leadId: string,
  detail: { channel: ContactChannel; path: string; origin: ContactOptOutOrigin | null },
  actorEmployeeId: string | null = null,
) {
  await db
    .insert(leadEvents)
    .values({ leadId, kind: 'lead.contact_blocked', actorEmployeeId, detail });
}

/**
 * For a list of search results at once: the oldest active "não me contate" reaching each place_id,
 * phone or Instagram @ (the register and the WhatsApp SAIR), keyed `place_id:<id>`,
 * `phone:<canonical>` and `instagram_user:<@>`. With `channels`, only the entries that block one
 * of them (or `all`) count, so another channel's older entry never hides the one asked.
 */
export async function optOutsAmong(
  db: Executor,
  given: {
    placeIds: string[];
    phones: string[];
    instagramUsers?: string[];
    channels?: ContactChannel[];
  },
  tenantId = WINGS_TENANT_ID,
): Promise<Map<string, ContactOptOutEntry>> {
  const phones = [
    ...new Set(given.phones.map((p) => normalizeContactKey('phone', p)).filter((p) => p !== null)),
  ];
  const keys = {
    lead: [],
    phone: phones,
    email: [],
    instagram_user: (given.instagramUsers ?? [])
      .map((u) => normalizeContactKey('instagram_user', u))
      .filter((u) => u !== null),
    place_id: given.placeIds,
    cnpj: [],
  };
  const found = new Map<string, ContactOptOutEntry>();
  const match = registerMatch(keys);
  if (!match) return found;
  const [register, waOptOuts] = await Promise.all([
    db
      .select()
      .from(contactOptOuts)
      .where(and(eq(contactOptOuts.tenantId, tenantId), isNull(contactOptOuts.revokedAt), match)),
    phones.length
      ? db
          .select({ phone: waContacts.phone, since: waContacts.optOutAt })
          .from(waContacts)
          .where(
            and(
              eq(waContacts.tenantId, tenantId),
              inArray(waContacts.phone, phones),
              isNotNull(waContacts.optOutAt),
            ),
          )
      : [],
  ]);
  const all = [
    ...register.map((row) => ({
      key: `${row.keyKind}:${row.keyValue}`,
      entry: {
        id: row.id,
        channel: row.channel as ContactChannel,
        origin: row.origin as ContactOptOutOrigin,
        reason: row.reason,
        since: row.createdAt.toISOString(),
      },
    })),
    ...waOptOuts.map((row) => ({
      key: `phone:${row.phone}`,
      entry: {
        id: null,
        channel: 'whatsapp' as const,
        origin: 'whatsapp_palavra' as const,
        reason: null,
        since: row.since!.toISOString(),
      },
    })),
  ]
    .filter(
      ({ entry }) =>
        !given.channels || entry.channel === 'all' || given.channels.includes(entry.channel),
    )
    .sort((a, b) => a.entry.since.localeCompare(b.entry.since));
  for (const { key, entry } of all) if (!found.has(key)) found.set(key, entry);
  return found;
}
