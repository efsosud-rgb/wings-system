import type { Conversion, CrmContact } from './rd.js';

/**
 * A read-only audit of the RD conversions: for each conversion identifier in
 * the window, how many became a deal in RD CRM (and in which funnel/stage) and
 * how many leaked. Only GETs; the answer holds counts, identifiers, funnel and
 * stage names and campaign names, never a name, e-mail or phone (people are
 * numbered 1, 2, 3 within the answer).
 */

export interface AuditMarketing {
  contactsConvertedSince(since: Date): Promise<string[]>;
  conversionsOf(uuid: string, since: Date): Promise<Conversion[]>;
}

export interface AuditCrm {
  findContact(email: string | null, phone: string | null): Promise<CrmContact | null>;
  dealPlacement(
    dealId: string,
  ): Promise<{ createdAt: Date | null; pipeline: string; stage: string }>;
}

export interface PageAudit {
  identifier: string;
  conversions: number;
  people: number;
  withDeal: number;
  leaked: number;
  first: string;
  last: string;
  /** "Funil / Etapa" -> conversions whose contact has a deal there. */
  funnels: Record<string, number>;
}

export interface TodayRow {
  identifier: string;
  /** HH:MM in São Paulo. */
  hour: string;
  ads: 'google' | 'meta' | null;
  eventType: string | null;
  utmSource: string | null;
  utmCampaign: string | null;
  /** 1, 2, 3...: the same number is the same person. */
  person: number;
  /** "Funil / Etapa" of a deal created at or after the conversion; null when there is none. */
  deal: string | null;
}

export interface AuditResult {
  days: number;
  since: string;
  contacts: number;
  pages: PageAudit[];
  today: { day: string; conversions: number; people: number; rows: TodayRow[] };
}

const SP_OFFSET_MS = 3 * 3_600_000; // Brazil has no DST since 2019.
const spDay = (at: Date) => new Date(at.getTime() - SP_OFFSET_MS).toISOString().slice(0, 10);

export async function auditConversions(input: {
  marketing: AuditMarketing;
  crm: AuditCrm;
  days: number;
  now?: Date;
}): Promise<AuditResult> {
  const now = input.now ?? new Date();
  const since = new Date(now.getTime() - input.days * 86_400_000);
  const day = spDay(now);
  const dayStart = new Date(Date.parse(`${day}T00:00:00Z`) + SP_OFFSET_MS);

  const uuids = await input.marketing.contactsConvertedSince(since);
  const pages = new Map<string, Omit<PageAudit, 'people'> & { people: Set<string> }>();
  const placements = new Map<string, Awaited<ReturnType<AuditCrm['dealPlacement']>>>();
  const personNumber = new Map<string, number>();
  const today: TodayRow[] = [];

  for (const uuid of uuids) {
    const conversions = await input.marketing.conversionsOf(uuid, since);
    if (conversions.length === 0) continue;

    // One CRM lookup per contact, by the first conversion's e-mail/phone.
    const first = conversions[0]!;
    const contact = await input.crm.findContact(first.email, first.phone);
    const deals = [];
    for (const ref of contact?.deals ?? []) {
      if (!placements.has(ref.id)) placements.set(ref.id, await input.crm.dealPlacement(ref.id));
      deals.push(placements.get(ref.id)!);
    }

    const personKey = first.email ?? first.phone?.replace(/\D/g, '') ?? uuid;
    if (!personNumber.has(personKey)) personNumber.set(personKey, personNumber.size + 1);

    for (const conversion of conversions) {
      // Covered like the job does: a deal made from an hour before the conversion on.
      const fresh = deals.find(
        (deal) => deal.createdAt && deal.createdAt.getTime() >= conversion.occurredAt.getTime() - 3_600_000,
      );
      const placed = fresh ?? deals[0];
      const where = placed ? `${placed.pipeline} / ${placed.stage}` : null;

      let page = pages.get(conversion.identifier);
      if (!page) {
        page = {
          identifier: conversion.identifier,
          conversions: 0,
          people: new Set(),
          withDeal: 0,
          leaked: 0,
          first: conversion.occurredAt.toISOString(),
          last: conversion.occurredAt.toISOString(),
          funnels: {},
        };
        pages.set(conversion.identifier, page);
      }
      page.conversions += 1;
      page.people.add(uuid);
      const iso = conversion.occurredAt.toISOString();
      if (iso < page.first) page.first = iso;
      if (iso > page.last) page.last = iso;
      if (where) {
        page.withDeal += 1;
        page.funnels[where] = (page.funnels[where] ?? 0) + 1;
      } else {
        page.leaked += 1;
      }

      if (conversion.occurredAt >= dayStart) {
        today.push({
          identifier: conversion.identifier,
          hour: new Date(conversion.occurredAt.getTime() - SP_OFFSET_MS).toISOString().slice(11, 16),
          ads: conversion.ads,
          eventType: conversion.eventType,
          utmSource: conversion.utms?.source ?? null,
          utmCampaign: conversion.utms?.campaign ?? null,
          person: personNumber.get(personKey)!,
          deal: fresh ? `${fresh.pipeline} / ${fresh.stage}` : null,
        });
      }
    }
  }

  return {
    days: input.days,
    since: since.toISOString(),
    contacts: uuids.length,
    pages: [...pages.values()]
      .map(({ people, ...rest }) => ({ ...rest, people: people.size }))
      .sort((a, b) => b.conversions - a.conversions),
    today: {
      day,
      conversions: today.length,
      people: new Set(today.map((row) => row.person)).size,
      rows: today.sort((a, b) => a.hour.localeCompare(b.hour)),
    },
  };
}
