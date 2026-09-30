import { normalizeSourcePattern } from '@wings/shared';
import type { Conversion, CrmContact, CrmMap, NewDeal, RdCrm, RdMarketing } from './rd.js';

/**
 * Every new RD Marketing conversion that has no deal in RD CRM gets one, in
 * the right funnel:
 *
 *  - a client brand's landing page (the configurable list) → funnel
 *    "Expansão", stage "Novo Contato", the brand named on the deal;
 *  - the Wings site form (`wings-company-form-site`) → funnel "Formatação",
 *    stage "Sem contato".
 *
 * Anything else is left alone, and so are existing flows and the RD Station
 * Marketing integration: this only ever creates a deal, and only when the
 * contact has none open and none made after the conversion. Nothing personal
 * leaves this file except into RD itself; the result is counts.
 */

/** The task each new Expansão deal gets, for its owner, due the day it is created. */
export const FIRST_CONTACT_TASK = 'Fazer primeiro contato';

/**
 * A conversion this young is left for the next pass: RD's own flows create
 * the deal within minutes, and this job is only the safety net behind them.
 */
export const SETTLING_MS = 15 * 60_000;

export const FORM_SITE_IDENTIFIER = 'wings-company-form-site';

export interface LandingPageRule {
  identifier: string;
  brand: string;
}

export type Target = 'expansao' | 'formatacao';

const TARGETS: Record<Target, { pipeline: string; stage: string }> = {
  expansao: { pipeline: 'Expansão', stage: 'Novo Contato' },
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
  /** Too recent: RD's flows may still be creating the deal. */
  settling: number;
  existingDeal: number;
  noContactData: number;
  failed: number;
  /** Expansão deals whose first-contact task RD refused (the deal itself was made). */
  taskFailed: number;
  /** Deals created that RD read back without a contact or a source. */
  unverified: number;
  /** Would create (dry run) or created, per funnel and brand. */
  created: Record<string, number>;
  /** RD CRM ids of the deals this run made (empty on a dry run). */
  createdDealIds: string[];
  /** Would create (dry run) or created, per conversion identifier. */
  createdByIdentifier: Record<string, number>;
  /** Created deals that RD read back without a contact and that got one tied afterwards. */
  linked: number;
  /** RD ids of created deals still without a contact after every way was tried. */
  orphanDealIds: string[];
  /** Statuses of the linking attempts, per way ("strategy:status"). */
  linkAttempts: Record<string, number>;
}

/** The deal is "covered" when the contact has one open, or one RD made after this conversion. */
async function covered(
  crm: RdCrm,
  conversion: Conversion,
): Promise<{ covered: boolean; contact: CrmContact | null }> {
  const contact = await crm.findContact(conversion.email, conversion.phone);
  if (!contact) return { covered: false, contact: null };
  if (contact.deals.some((deal) => deal.win === null)) return { covered: true, contact };
  const after = conversion.occurredAt.getTime() - 10 * 60_000;
  for (const deal of contact.deals) {
    const createdAt = await crm.dealCreatedAt(deal.id);
    if (createdAt && createdAt.getTime() >= after) return { covered: true, contact };
  }
  return { covered: false, contact };
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
  stageName?: string,
): NewDeal | null {
  const spec = TARGETS[target];
  const stageId = map.pipelines.get(spec.pipeline)?.stages.get(stageName ?? spec.stage);
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
  now?: () => Date;
  /**
   * A recovery pass: only these identifiers are handled (the rest are counted
   * as ignored), and these identifiers are Formatação forms that land in the
   * given stage instead of the site form's "Sem contato".
   */
  recovery?: { only: string[]; formatacaoIdentifiers: string[]; formatacaoStage: string };
  /** Called after each contact, so a long pass can show how far it is. */
  onProgress?: (done: number, total: number) => void;
  /**
   * Called after RD made a deal, so the Funil's lead (when there is one) knows
   * its deal. A failure here never undoes nor repeats the deal.
   */
  onDealCreated?: (event: {
    conversion: Conversion;
    dealId: string;
    target: Target;
    brand: string | null;
  }) => Promise<unknown>;
}): Promise<IntakeResult> {
  const { marketing, crm, ledger, dryRun } = input;
  const brandOf = new Map(
    input.rules.map((rule) => [normalizeSourcePattern(rule.identifier), rule.brand]),
  );
  const result: IntakeResult = {
    contacts: 0,
    conversions: 0,
    ignored: {},
    alreadyDecided: 0,
    settling: 0,
    existingDeal: 0,
    noContactData: 0,
    failed: 0,
    taskFailed: 0,
    unverified: 0,
    created: {},
    createdDealIds: [],
    createdByIdentifier: {},
    linked: 0,
    orphanDealIds: [],
    linkAttempts: {},
  };
  const uuids = await marketing.contactsConvertedSince(input.since);
  result.contacts = uuids.length;
  let map: CrmMap | null = null;
  // Contacts that got a deal in this very run: a second conversion of theirs is covered.
  const handled = new Set<string>();

  let done = 0;
  for (const uuid of uuids) {
    input.onProgress?.(done, uuids.length);
    done += 1;
    const conversions = (await marketing.conversionsOf(uuid, input.since)).sort(
      (a, b) => a.occurredAt.getTime() - b.occurredAt.getTime(),
    );
    for (const conversion of conversions) {
      result.conversions += 1;
      const recovery = input.recovery;
      const brand = brandOf.get(normalizeSourcePattern(conversion.identifier)) ?? null;
      const outOfScope = recovery ? !recovery.only.includes(conversion.identifier) : false;
      const isFormatacao = recovery
        ? recovery.formatacaoIdentifiers.includes(conversion.identifier)
        : conversion.identifier === FORM_SITE_IDENTIFIER;
      const target: Target | null = outOfScope
        ? null
        : isFormatacao
          ? 'formatacao'
          : brand
            ? 'expansao'
            : null;
      if (!target) {
        result.ignored[conversion.identifier] = (result.ignored[conversion.identifier] ?? 0) + 1;
        continue;
      }
      if (input.now && input.now().getTime() - conversion.occurredAt.getTime() < SETTLING_MS) {
        result.settling += 1;
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
          result.createdByIdentifier[conversion.identifier] =
            (result.createdByIdentifier[conversion.identifier] ?? 0) + 1;
          handled.add(uuid);
          continue;
        }
        map ??= await crm.map();
        const deal = dealFor(
          conversion,
          target,
          brand,
          map,
          input.expansionOwnerId ?? null,
          target === 'formatacao' ? input.recovery?.formatacaoStage : undefined,
        );
        if (!deal) throw new Error('funnel or stage not found in RD CRM');
        const dealId = await crm.createDeal(deal);
        handled.add(uuid);
        result.created[label] = (result.created[label] ?? 0) + 1;
        result.createdDealIds.push(dealId);
        result.createdByIdentifier[conversion.identifier] =
          (result.createdByIdentifier[conversion.identifier] ?? 0) + 1;
        await ledger.record({ key, target, outcome: 'created', dealId });
        await input.onDealCreated?.({ conversion, dealId, target, brand }).catch(() => undefined);
        if (target === 'expansao' && input.expansionOwnerId) {
          try {
            await crm.createTask({
              dealId,
              userId: input.expansionOwnerId,
              subject: FIRST_CONTACT_TASK,
              dueDay: input.now?.() ?? new Date(),
            });
          } catch {
            result.taskFailed += 1;
          }
        }
        let back = await crm.checkDeal(dealId).catch(() => null);
        if (back && !back.hasContact) {
          // A deal without a contact is no use to anyone: tie the person to it.
          const tie = await crm.linkContact(
            dealId,
            { name: conversion.name, email: conversion.email, phone: conversion.phone },
            known.contact,
          );
          for (const attempt of tie.attempts) {
            const key = `${attempt.strategy}:${attempt.status}`;
            result.linkAttempts[key] = (result.linkAttempts[key] ?? 0) + 1;
          }
          if (tie.linked) result.linked += 1;
          else result.orphanDealIds.push(dealId);
          back = await crm.checkDeal(dealId).catch(() => null);
        }
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
