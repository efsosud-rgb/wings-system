import type { AdIdentifierKind } from '@wings/shared';
import { leadAdIdentifiers } from '../../db/schema/index.js';
import type { Executor } from './crm.js';

/**
 * The ad identifiers an arrival brings, kept on the lead with the door and the
 * moment (docs/ads/fechar-ciclo.md): Meta's lead id of an instant form, the
 * click ids, and Meta's browser ids. A value out of the platform's shape is
 * dropped without a word: these are never logged, not even when refused.
 */

export interface AdIdentifier {
  kind: AdIdentifierKind;
  value: string;
}

const CLICK_ID = /^[\w\-.~]{4,500}$/;
const SHAPES: Record<AdIdentifierKind, RegExp> = {
  meta_lead_id: /^\d{5,25}$/,
  fbclid: CLICK_ID,
  gclid: CLICK_ID,
  gbraid: CLICK_ID,
  wbraid: CLICK_ID,
  fbc: /^fb\.\d\.\d{10,13}\.[\w\-.~]{4,500}$/,
  fbp: /^fb\.\d\.\d{10,13}\.\d{1,30}$/,
};

export interface IdentifierSource {
  source: string;
  externalId?: string | null;
  attribution?: {
    gclid?: string | null;
    fbclid?: string | null;
    gbraid?: string | null;
    wbraid?: string | null;
  } | null;
  /** The pixel's `_fbc` / `_fbp`, when a site form sent them. */
  metaBrowserIds?: { fbc?: string | null; fbp?: string | null } | null;
}

export function adIdentifiersOf(arrival: IdentifierSource): AdIdentifier[] {
  const found: [AdIdentifierKind, string | null | undefined][] = [
    // Meta's leadgen id is the lead's external id at that door, and only there.
    ['meta_lead_id', arrival.source === 'meta_lead_ads' ? arrival.externalId : null],
    ['fbclid', arrival.attribution?.fbclid],
    ['gclid', arrival.attribution?.gclid],
    ['gbraid', arrival.attribution?.gbraid],
    ['wbraid', arrival.attribution?.wbraid],
    ['fbc', arrival.metaBrowserIds?.fbc],
    ['fbp', arrival.metaBrowserIds?.fbp],
  ];
  const kept: AdIdentifier[] = [];
  for (const [kind, raw] of found) {
    const value = raw?.trim();
    if (value && SHAPES[kind].test(value)) kept.push({ kind, value });
  }
  return kept;
}

/** Idempotent: the same value on the same lead is kept once, with its first door and moment. */
export async function recordAdIdentifiers(
  ex: Executor,
  leadId: string,
  identifiers: AdIdentifier[],
  source: string,
  capturedAt: Date,
): Promise<void> {
  if (identifiers.length === 0) return;
  await ex
    .insert(leadAdIdentifiers)
    .values(identifiers.map((id) => ({ leadId, ...id, source, capturedAt })))
    .onConflictDoNothing();
}
