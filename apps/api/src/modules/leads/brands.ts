import { LANDING_PAGE_BASE_URL, normalizeSourcePattern, WINGS_CLIENT_ID } from '@wings/shared';
import { and, eq, isNull } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import { clientProjects, clients, leadSourceRules } from '../../db/schema/index.js';
import { writeAudit } from '../../lib/audit.js';
import { createClientRecord } from '../clients/create.js';

/**
 * The brands Wings sells franchises for, registered as clients and tied to
 * their landing-page rules (CRM phase 1). Names are matched loosely — no
 * accents, no case, no "do/dos/da/das/de/e" — so "Casal dos Churros" (RD) and
 * "Casal do Churros" (the register) are one brand; a rule is also tied by its
 * identifier's slug (`lp-calcadao-do-frango` → "calcadao frango").
 */

/** Eric's list of 30/09/2026. */
export const EXPANSION_BRANDS = [
  'Casal do Churros',
  'Açaí da Fila',
  'Calçadão do Frango',
  'Mister Russo',
  'Grupo Forte Fênix',
  'Rio Açaí Gourmet',
  'Ginteco',
  'Família K',
];

/**
 * Brands whose landing pages were read live on 2026-09-30 at
 * franquia.wingscompany.com.br/<slug>: the RD form's `conversion_identifier`
 * is the slug. Wash Club's page is a draft in RD (404): client only, its rule
 * is made by CRM Vendas → Landing pages when the page is published.
 */
export const EXPANSION_BRANDS_2026_09_30: { name: string; identifiers: string[] }[] = [
  { name: 'Cenoritas', identifiers: ['cenoritas'] },
  { name: 'Malkuth', identifiers: ['malkuth'] },
  { name: 'Amarjon', identifiers: ['amarjon'] },
  { name: 'Iguari', identifiers: ['iguari'] },
  { name: 'Wash Club', identifiers: [] },
];

const STOPWORDS = new Set(['do', 'dos', 'da', 'das', 'de', 'e']);

export function brandKey(name: string): string {
  return name
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter((word) => word && !STOPWORDS.has(word))
    .join(' ');
}

/** The brand an identifier names: `lp-`, `le-` and `lista-de-espera-` prefixes off. */
export function identifierKey(identifier: string): string {
  return brandKey(identifier.replace(/^(lp|le|lista-de-espera)-/i, ''));
}

export interface BrandLink {
  identifier: string;
  ruleBrand: string | null;
  client: { number: number | null; name: string } | null;
  /** created (a new rule for a page given), linked (by this run), already (before it), none (no client matches) */
  state: 'created' | 'linked' | 'already' | 'none';
  by: 'brand' | 'identifier' | null;
}

export interface BrandReport {
  applied: boolean;
  /** Names registered by this run (or that would be). */
  created: string[];
  /** Names that already had a client, with the client's own name. */
  existing: { wanted: string; client: string }[];
  links: BrandLink[];
}

/**
 * Registers the brands missing from the register and ties each Expansão rule
 * without a client to the one its brand or identifier names. Without
 * `apply`, nothing is written and the report says what would be. Rules that
 * already point at a client are left as they are.
 */
export async function registerBrands(
  db: Database,
  input: {
    names: readonly string[];
    /** Landing pages to make rules for (Expansão), per brand name, when there is none yet. */
    pages?: readonly { name: string; identifiers: readonly string[] }[];
    apply: boolean;
    actorEmployeeId?: string | null;
  },
): Promise<BrandReport> {
  const report: BrandReport = { applied: input.apply, created: [], existing: [], links: [] };
  const known = (await db.select().from(clients)).filter((client) => client.id !== WINGS_CLIENT_ID);
  const byKey = new Map(known.map((client) => [brandKey(client.name), client]));

  for (const name of input.names) {
    const found = byKey.get(brandKey(name));
    if (found) {
      report.existing.push({ wanted: name, client: found.name });
      continue;
    }
    report.created.push(name);
    if (!input.apply) {
      byKey.set(brandKey(name), { id: '', name, number: null } as (typeof known)[number]);
      continue;
    }
    // A brand Wings sells franchises for: Expansão, so no Formatação project opens (Eric, 30/09).
    const made = await createClientRecord(db, { name, relationship: 'expansao' });
    if (!made) throw new Error(`client "${name}" could not be created`);
    byKey.set(brandKey(name), made.row);
    await writeAudit(db, {
      actorEmployeeId: input.actorEmployeeId ?? null,
      action: 'client.created',
      entity: 'client',
      entityId: made.row.id,
      metadata: {
        slug: made.row.slug,
        via: 'crm-brands',
        driveFoldersCreated: made.driveFoldersCreated,
      },
    });
  }

  // Rules for the pages given, pointing at the brand's client (kept as they are when one exists).
  const createdPatterns = new Set<string>();
  for (const brand of input.pages ?? []) {
    const client = byKey.get(brandKey(brand.name));
    for (const identifier of brand.identifiers) {
      const pattern = normalizeSourcePattern(identifier);
      const exists = await db.query.leadSourceRules.findFirst({
        where: and(eq(leadSourceRules.kind, 'landing_page'), eq(leadSourceRules.pattern, pattern)),
        columns: { id: true },
      });
      if (exists) continue;
      createdPatterns.add(pattern);
      report.links.push({
        identifier: pattern,
        ruleBrand: brand.name,
        client: client ? { number: client.number, name: client.name } : null,
        state: 'created',
        by: null,
      });
      if (!input.apply) continue;
      const [rule] = await db
        .insert(leadSourceRules)
        .values({
          kind: 'landing_page',
          pattern,
          pipeline: 'expansao',
          brand: brand.name,
          clientId: client?.id || null,
          url: `${LANDING_PAGE_BASE_URL}/${pattern}`,
          createdBy: input.actorEmployeeId ?? null,
        })
        .returning({ id: leadSourceRules.id });
      await writeAudit(db, {
        actorEmployeeId: input.actorEmployeeId ?? null,
        action: 'lead_source_rule.created',
        entity: 'lead_source_rule',
        entityId: rule?.id ?? pattern,
        metadata: {
          kind: 'landing_page',
          pipeline: 'expansao',
          clientId: client?.id ?? null,
          via: 'crm-brands',
        },
      });
    }
  }

  const rules = await db
    .select()
    .from(leadSourceRules)
    .where(and(eq(leadSourceRules.kind, 'landing_page'), eq(leadSourceRules.pipeline, 'expansao')));
  const byId = new Map([...byKey.values()].map((client) => [client.id, client]));
  for (const rule of rules.sort((a, b) => a.pattern.localeCompare(b.pattern))) {
    if (createdPatterns.has(rule.pattern)) continue;
    if (rule.clientId) {
      const client = byId.get(rule.clientId);
      report.links.push({
        identifier: rule.pattern,
        ruleBrand: rule.brand,
        client: client
          ? { number: client.number, name: client.name }
          : { number: null, name: '(outro cliente)' },
        state: 'already',
        by: null,
      });
      continue;
    }
    const viaBrand = rule.brand ? byKey.get(brandKey(rule.brand)) : undefined;
    const client = viaBrand ?? byKey.get(identifierKey(rule.pattern));
    if (!client) {
      report.links.push({
        identifier: rule.pattern,
        ruleBrand: rule.brand,
        client: null,
        state: 'none',
        by: null,
      });
      continue;
    }
    if (input.apply) {
      await db
        .update(leadSourceRules)
        .set({ clientId: client.id })
        .where(eq(leadSourceRules.id, rule.id));
      await writeAudit(db, {
        actorEmployeeId: input.actorEmployeeId ?? null,
        action: 'lead_source_rule.linked',
        entity: 'lead_source_rule',
        entityId: rule.id,
        metadata: { clientId: client.id, by: viaBrand ? 'brand' : 'identifier', via: 'crm-brands' },
      });
    }
    report.links.push({
      identifier: rule.pattern,
      ruleBrand: rule.brand,
      client: { number: client.number, name: client.name },
      state: 'linked',
      by: viaBrand ? 'brand' : 'identifier',
    });
  }
  return report;
}

export function formatBrandReport(report: BrandReport): string {
  const verb = report.applied ? '' : 'seria ';
  return [
    report.applied ? 'APLICADO' : 'SIMULAÇÃO (nada foi gravado; rode com --apply para valer)',
    `clientes ${report.applied ? 'cadastrados' : 'a cadastrar'}: ${report.created.length}`,
    ...report.created.map((name) => `  + ${name}`),
    `já no cadastro: ${report.existing.length}`,
    ...report.existing.map((item) => `  = ${item.wanted} → ${item.client}`),
    `regras de LP do funil Expansão: ${report.links.length}`,
    ...report.links.map((link) => {
      const client = link.client
        ? `${link.client.number ?? '—'}. ${link.client.name}`
        : 'sem cliente';
      const how =
        link.state === 'created'
          ? `${verb}criada, ligada ao cliente`
          : link.state === 'already'
            ? 'já ligada'
            : link.state === 'none'
              ? 'NENHUM cliente casa'
              : `${verb}ligada pel${link.by === 'brand' ? 'a marca' : 'o identificador'}`;
      return `  ${link.identifier} (${link.ruleBrand ?? '—'}) → ${client} [${how}]`;
    }),
  ].join('\n');
}

export interface LegacyBrandMove {
  wanted: string;
  client: { number: number | null; name: string } | null;
  relationshipBefore: string | null;
  relationshipAfter: string | null;
  /** hidden (by this run, or would be), already (before it), none (no project) */
  project: 'hidden' | 'already' | 'none';
}

/**
 * B5 (Eric, 01/10): the 8 brands of the first `crm-brands` run are Expansão
 * clients. Their relationship becomes Expansão ("ambos" is kept, it already
 * includes it) and their projects leave the Projetos board, hidden, never
 * deleted. Without `apply`, nothing is written and the report says what would be.
 */
export async function moveLegacyBrandsToExpansion(
  db: Database,
  input: { apply: boolean; actorEmployeeId?: string | null },
): Promise<{ applied: boolean; moves: LegacyBrandMove[] }> {
  const known = (await db.select().from(clients)).filter((client) => client.id !== WINGS_CLIENT_ID);
  const byKey = new Map(known.map((client) => [brandKey(client.name), client]));
  const moves: LegacyBrandMove[] = [];
  for (const wanted of EXPANSION_BRANDS) {
    const client = byKey.get(brandKey(wanted));
    if (!client) {
      moves.push({
        wanted,
        client: null,
        relationshipBefore: null,
        relationshipAfter: null,
        project: 'none',
      });
      continue;
    }
    const before = client.relationship;
    const after = before === 'ambos' ? 'ambos' : 'expansao';
    const project = await db.query.clientProjects.findFirst({
      where: eq(clientProjects.clientId, client.id),
      columns: { id: true, hiddenAt: true },
    });
    moves.push({
      wanted,
      client: { number: client.number, name: client.name },
      relationshipBefore: before,
      relationshipAfter: after,
      project: !project ? 'none' : project.hiddenAt ? 'already' : 'hidden',
    });
    if (!input.apply) continue;
    if (before !== after) {
      await db.update(clients).set({ relationship: after }).where(eq(clients.id, client.id));
      await writeAudit(db, {
        actorEmployeeId: input.actorEmployeeId ?? null,
        action: 'client.relationship_changed',
        entity: 'client',
        entityId: client.id,
        metadata: { from: before, to: after, via: 'crm-brands --expansion-legacy' },
      });
    }
    if (project && !project.hiddenAt) {
      await db
        .update(clientProjects)
        .set({ hiddenAt: new Date() })
        .where(and(eq(clientProjects.id, project.id), isNull(clientProjects.hiddenAt)));
      await writeAudit(db, {
        actorEmployeeId: input.actorEmployeeId ?? null,
        action: 'project.hidden',
        entity: 'client_project',
        entityId: project.id,
        metadata: { clientId: client.id, via: 'crm-brands --expansion-legacy' },
      });
    }
  }
  return { applied: input.apply, moves };
}

export function formatLegacyMoveReport(report: {
  applied: boolean;
  moves: LegacyBrandMove[];
}): string {
  const verb = report.applied ? '' : 'seria ';
  return [
    report.applied ? 'APLICADO' : 'SIMULAÇÃO (nada foi gravado; rode com --apply para valer)',
    `marcas antigas: ${report.moves.length}`,
    ...report.moves.map((move) => {
      if (!move.client) return `  ${move.wanted} → NENHUM cliente casa`;
      const relation =
        move.relationshipBefore === move.relationshipAfter
          ? `relação ${move.relationshipAfter} (já)`
          : `relação ${move.relationshipBefore ?? '—'} → ${move.relationshipAfter} (${verb}alterada)`;
      const project =
        move.project === 'none'
          ? 'sem projeto'
          : move.project === 'already'
            ? 'projeto já oculto'
            : `projeto ${verb}oculto`;
      return `  ${move.client.number ?? '—'}. ${move.client.name}: ${relation}; ${project}`;
    }),
  ].join('\n');
}
