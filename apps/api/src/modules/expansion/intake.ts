import type { Conversion, CrmMap, NewDeal, RdCrm, RdMarketing } from './rd.js';

/**
 * Every new RD Marketing conversion that has no deal in RD CRM gets one, in
 * the right funnel:
 *
 *  - a client brand's landing page (the configurable list) → funnel
 *    "Expansão", stage "Tentando contato", the brand named on the deal;
 *  - the Wings site form (`wings-company-form-site`) → funnel "Formatação",
 *    stage "Sem contato".
 *
 * Anything else is left alone, and so are existing flows and the RD Station
 * Marketing integration: this only ever creates a deal, and only when the
 * contact has none open and none made after the conversion. Nothing personal
 * leaves this file except into RD itself; the result is counts.
 */

export const FORM_SITE_IDENTIFIER = 'wings-company-form-site';

export interface LandingPageRule {
  identifier: string;
  brand: string;
}

export type Target = 'expansao' | 'formatacao';

const TARGETS: Record<Target, { pipeline: string; stage: string }> = {
  expansao: { pipeline: 'Expansão', stage: 'Tentando contato' },
  formatacao: { pipeline: 'Formatação', stage: 'Sem contato' },
};

export interface Ledger {
  /** Conversions already decided (a deal made, or one found). */
  has(key: string): Promise<boolean>;
  record(entry: {
    key: string;
    target: Target;
    outcome: Outcome;
    dealId: string | null;
  }): Promise<void>;
}

export type Outcome = 'created' | 'existing_deal' | 'no_contact_data' | 'failed';

export const conversionKey = (conversion: Conversion) =>
  `${conversion.contactUuid}|${conversion.identifier}|${conversion.occurredAt.toISOString()}`;

export function memoryLedger(): Ledger & { entries: Map<string, Outcome> } {
  const entries = new Map<string, Outcome>();
  return {
    entries,
    has: async (key) => entries.has(key),
    record: async (entry) => void entries.set(entry.key, entry.outcome),
  };
}

export interface IntakeResult {
  contacts: number;
  conversions: number;
  /** Conversions per identifier that no rule routes (counts of an identifier, not of people). */
  ignored: Record<string, number>;
  alreadyDecided: number;
  existingDeal: number;
  noContactData: number;
  failed: number;
  /** Deals created that RD read back without a contact or a source. */
  unverified: number;
  /** Would create (dry run) or created, per funnel and brand. */
  created: Record<string, number>;
}

/** The deal is "covered" when the contact has one open, or one RD made after this conversion. */
async function covered(
  crm: RdCrm,
  conversion: Conversion,
): Promise<{ covered: boolean; contactId: string | null }> {
  const contact = await crm.findContact(conversion.email, conversion.phone);
  if (!contact) return { covered: false, contactId: null };
  if (contact.deals.some((deal) => deal.win === null))
    return { covered: true, contactId: contact.id };
  const after = conversion.occurredAt.getTime() - 10 * 60_000;
  for (const deal of contact.deals) {
    const createdAt = await crm.dealCreatedAt(deal.id);
    if (createdAt && createdAt.getTime() >= after) return { covered: true, contactId: contact.id };
  }
  return { covered: false, contactId: contact.id };
}

function describeUtms(conversion: Conversion): string {
  const { utms, page } = conversion;
  const parts = [
    utms?.source && `source=${utms.source}`,
    utms?.medium && `medium=${utms.medium}`,
    utms?.campaign && `campaign=${utms.campaign}`,
    utms?.content && `content=${utms.content}`,
    page && `página=${page}`,
    `conversão=${conversion.identifier}`,
  ].filter(Boolean);
  return `UTM · ${parts.join(' · ')}`;
}

/** "Referência | <the LP's host>" when RD has it (the brands' existing deals use it), else "Contato pelo Site". */
export function sourceIdFor(conversion: Conversion, target: Target, map: CrmMap): string | null {
  const host = conversion.page?.split('/')[0]?.replace(/^www\./, '');
  const named = target === 'expansao' && host ? map.sources.get(`Referência | ${host}`) : undefined;
  return named ?? map.sources.get('Contato pelo Site') ?? null;
}

export function campaignNameFor(
  target: Target,
  brand: string | null,
  map: CrmMap,
): string | undefined {
  return target === 'expansao'
    ? [`LP/LE ${brand} - Fluxo Expansão`, `LP ${brand} - Fluxo Expansão`].find((candidate) =>
        map.campaigns.has(candidate),
      )
    : 'SITE WINGS // FORMATAÇÃO';
}

function dealFor(
  conversion: Conversion,
  target: Target,
  brand: string | null,
  map: CrmMap,
  ownerId: string | null,
): NewDeal | null {
  const spec = TARGETS[target];
  const stageId = map.pipelines.get(spec.pipeline)?.stages.get(spec.stage);
  if (!stageId) return null;
  const customFields: { id: string; value: string }[] = [];
  const brandField = map.customFields.get('Nome da Marca');
  if (brand && brandField) customFields.push({ id: brandField, value: brand });
  const obsField = map.customFields.get('OBS');
  if (obsField) customFields.push({ id: obsField, value: describeUtms(conversion) });
  const name = conversion.name ?? conversion.email ?? 'Lead';
  const campaignName =
    target === 'expansao'
      ? [`LP/LE ${brand} - Fluxo Expansão`, `LP ${brand} - Fluxo Expansão`].find((candidate) =>
          map.campaigns.has(candidate),
        )
      : 'SITE WINGS // FORMATAÇÃO';
  return {
    name: brand ? `${name} - ${brand}` : name,
    stageId,
    contact: { name, email: conversion.email, phone: conversion.phone },
    sourceId: sourceIdFor(conversion, target, map),
    ownerId: target === 'expansao' ? ownerId : null,
    campaignId: (campaignName && map.campaigns.get(campaignName)) || null,
    customFields,
  };
}

export async function runExpansionIntake(input: {
  marketing: RdMarketing;
  crm: RdCrm;
  ledger: Ledger;
  rules: LandingPageRule[];
  /** RD CRM user who owns the Expansão deals this run creates. */
  expansionOwnerId?: string | null;
  since: Date;
  dryRun: boolean;
}): Promise<IntakeResult> {
  const { marketing, crm, ledger, dryRun } = input;
  const brandOf = new Map(input.rules.map((rule) => [rule.identifier, rule.brand]));
  const result: IntakeResult = {
    contacts: 0,
    conversions: 0,
    ignored: {},
    alreadyDecided: 0,
    existingDeal: 0,
    noContactData: 0,
    failed: 0,
    unverified: 0,
    created: {},
  };
  const uuids = await marketing.contactsConvertedSince(input.since);
  result.contacts = uuids.length;
  let map: CrmMap | null = null;
  // Contacts that got a deal in this very run: a second conversion of theirs is covered.
  const handled = new Set<string>();

  for (const uuid of uuids) {
    const conversions = (await marketing.conversionsOf(uuid, input.since)).sort(
      (a, b) => a.occurredAt.getTime() - b.occurredAt.getTime(),
    );
    for (const conversion of conversions) {
      result.conversions += 1;
      const brand = brandOf.get(conversion.identifier) ?? null;
      const target: Target | null = brand
        ? 'expansao'
        : conversion.identifier === FORM_SITE_IDENTIFIER
          ? 'formatacao'
          : null;
      if (!target) {
        result.ignored[conversion.identifier] = (result.ignored[conversion.identifier] ?? 0) + 1;
        continue;
      }
      const key = conversionKey(conversion);
      if (await ledger.has(key)) {
        result.alreadyDecided += 1;
        continue;
      }
      if (!conversion.email && !conversion.phone) {
        result.noContactData += 1;
        await ledger.record({ key, target, outcome: 'no_contact_data', dealId: null });
        continue;
      }
      try {
        const known = await covered(crm, conversion);
        if (known.covered || handled.has(uuid)) {
          result.existingDeal += 1;
          if (!dryRun) await ledger.record({ key, target, outcome: 'existing_deal', dealId: null });
          continue;
        }
        const label = `${target}${brand ? `:${brand}` : ''}`;
        if (dryRun) {
          result.created[label] = (result.created[label] ?? 0) + 1;
          handled.add(uuid);
          continue;
        }
        map ??= await crm.map();
        const deal = dealFor(conversion, target, brand, map, input.expansionOwnerId ?? null);
        if (!deal) throw new Error('funnel or stage not found in RD CRM');
        const dealId = await crm.createDeal(deal);
        handled.add(uuid);
        result.created[label] = (result.created[label] ?? 0) + 1;
        await ledger.record({ key, target, outcome: 'created', dealId });
        const back = await crm.checkDeal(dealId).catch(() => null);
        if (!back || !back.hasContact || !back.hasSource) result.unverified += 1;
      } catch {
        // The error names a path and a status only; the next run checks the
        // contact again before creating anything, so a lost answer is safe.
        result.failed += 1;
      }
    }
  }
  return result;
}
