import { LANDING_PAGE_BASE_URL, normalizeSourcePattern, WINGS_CLIENT_ID } from '@wings/shared';
import { and, eq, inArray, isNull } from 'drizzle-orm';
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
 * is the slug. Wash Club's page was a draft in RD (404) then: client only. It
 * is published since; its `wash-club` rule comes from the seed (audit of 01/10).
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

/**
 * T6 (Eric, 01/10): each brand's Instagram (shown on its pages) and its own
 * WhatsApp as a contact on the record only. Expansão links and pages always
 * open the Wings WhatsApp, never these numbers. A brand without WhatsApp gets
 * the reason, shown with "—".
 */
export const BRAND_CONTACTS_2026_10_01: {
  name: string;
  instagram: string;
  whatsapp: string | null;
  whatsappNote: string | null;
}[] = [
  {
    name: 'Cenoritas',
    instagram: '@cenoritas.gourmet',
    whatsapp: '21972055989',
    whatsappNote: null,
  },
  { name: 'Amarjon', instagram: '@amarjonbiojoias', whatsapp: '32988339012', whatsappNote: null },
  {
    name: 'Iguari',
    instagram: '@iguaripasseioshopping',
    whatsapp: null,
    whatsappNote: 'a marca não tem WhatsApp próprio (Eric, 01/10/2026)',
  },
];

export interface BrandContactChange {
  wanted: string;
  client: { number: number | null; name: string } | null;
  /** The record fields that change (or would): instagram, whatsapp, whatsappNote. */
  fields: string[];
}

/**
 * Writes `BRAND_CONTACTS_2026_10_01` into the brands' records. Without
 * `apply` nothing is written; running it again changes nothing. Each change
 * is audited as `client.company_updated`, field names only.
 */
export async function applyBrandContacts(
  db: Database,
  input: { apply: boolean; actorEmployeeId?: string | null },
): Promise<{ applied: boolean; changes: BrandContactChange[] }> {
  const known = (await db.select().from(clients)).filter((client) => client.id !== WINGS_CLIENT_ID);
  const byKey = new Map(known.map((client) => [brandKey(client.name), client]));
  const changes: BrandContactChange[] = [];
  for (const wanted of BRAND_CONTACTS_2026_10_01) {
    const client = byKey.get(brandKey(wanted.name));
    if (!client) {
      changes.push({ wanted: wanted.name, client: null, fields: [] });
      continue;
    }
    const social = { ...(client.social ?? {}), instagram: wanted.instagram };
    const fields = [
      client.social?.instagram !== wanted.instagram && 'instagram',
      client.whatsapp !== wanted.whatsapp && 'whatsapp',
      client.whatsappNote !== wanted.whatsappNote && 'whatsappNote',
    ].filter((field): field is string => Boolean(field));
    changes.push({
      wanted: wanted.name,
      client: { number: client.number, name: client.name },
      fields,
    });
    if (!input.apply || fields.length === 0) continue;
    await db
      .update(clients)
      .set({
        social,
        whatsapp: wanted.whatsapp,
        whatsappNote: wanted.whatsappNote,
        updatedAt: new Date(),
      })
      .where(eq(clients.id, client.id));
    await writeAudit(db, {
      actorEmployeeId: input.actorEmployeeId ?? null,
      action: 'client.company_updated',
      entity: 'client',
      entityId: client.id,
      metadata: { fields, via: 'crm-brands --contacts' },
    });
  }
  return { applied: input.apply, changes };
}

export function formatBrandContactsReport(report: {
  applied: boolean;
  changes: BrandContactChange[];
}): string {
  return [
    report.applied ? 'APLICADO' : 'SIMULAÇÃO (nada foi gravado; rode com --apply para valer)',
    ...report.changes.map((change) =>
      !change.client
        ? `  ${change.wanted} → NENHUM cliente casa`
        : `  ${change.client.name}: ${change.fields.length ? change.fields.join(', ') : 'nada a mudar'}`,
    ),
  ].join('\n');
}

/**
 * Eric, 02/10/2026: the only franchises on sale, as named in the register
 * ("Amarjon Biojóias" is Amarjon, "Dr. Coluna" Dr Coluna, "Pensou; Lavou"
 * Pensou Lavou). Every other Expansão brand is off sale.
 */
export const ON_SALE_2026_10_02 = [
  'Wash Club',
  'Casal do Churros',
  'Mister Russo',
  'Dr Coluna',
  'Calçadão do Frango',
  'Super Dogão da Nana',
  'Só Crianças',
  'Amarjon',
  'Grupo Meu AP',
  'Rio Açaí Gourmet',
  'Lion Eletropostos',
  'Sarantopoulos',
  'Iguari',
  'Malkuth',
  'Cenoritas',
  'Lion Hair',
  'Ginteco',
  'A Cabana da Barra',
  'Pecan',
  'Açaí da Fila',
  'Grupo Forte Fênix',
  'Pensou Lavou',
];

export const RD_UNPUBLISHED_ON = '2026-10-02';

/**
 * The 67 pages Eric switched off in RD on 02/10/2026, by identifier. `parceiro`
 * stands for two pages (franquia.cervejariaodin and franquia.circustrattoria)
 * and `socio` for two more (franquia.reidogadocarnes and franquia.fullhousecomidadefesta).
 */
export const RD_UNPUBLISHED_2026_10_02 = [
  'capi-hair',
  'lista-de-espera-florir-cafe',
  'lista-de-espera-bazar-das-flores',
  'conytos-lista-de-espera',
  'conytos',
  'lista-de-espera-grippa',
  'lista-de-espera-verano',
  'pizzaria-das-palmeiras',
  'lista-de-espera-nork',
  'lista-de-espera-mister-gulla',
  'lista-de-espera-sorvetes-da-ilha',
  'lista-de-espera-fm-kitchens',
  'lista-de-espera-caval_barber_shop',
  'donabonitex',
  'lista-de-espera-sushi-de-feira',
  'lista-de-espera-colab-space',
  'lista-de-espera-mundo-dos-hots',
  'lista-de-espera-na-chapa-muriae',
  'lista-de-espera-familia-k',
  'le-uni',
  'valhalla',
  'lista-de-espera-melhor-parada',
  'lp-grippa-head-spa',
  'le-fabrica-de-salgados-mongagua',
  'pizzaria-verano',
  'le-byker',
  'lista-de-espera-nossa-esmalteria',
  'lista-de-espera-renata-salgados',
  'lista-de-espera-parro-pizzaria',
  'le-cookie-craft',
  'le-food-forest',
  'lista-de-espera-petina',
  'sushi-de-feira',
  'lista-de-espera-gustavo-eyewear',
  'lp-mundo-dos-hots',
  'food-forest',
  'dimos',
  'salinas',
  'raptor',
  'flowmultas',
  'le-manet-pizzas',
  'lp-manet-pizzas',
  'casa-da-dona',
  'fabricadesalgadosmongagua',
  'flowmultaslicenciados',
  'familia-k',
  'felipe-nilo',
  'lp-mister-gulla',
  'melhor-parada',
  'lp-na-chapa',
  'nork',
  'nossa-esmalteria',
  'lp-sorvetes-da-ilha',
  'uni',
  'renata-salgados',
  'cookie-craft',
  'florir',
  'parro-pizzaria',
  'bistrogro',
  'teste-bot',
  'lista-de-espera_espaco-felipe-nilo',
  'politica-de-privacidade-valhalla',
  'politica-de-privacidade-dona-bonitex',
  'parceiro',
  'socio',
];

export interface OnSaleReport {
  applied: boolean;
  brands: BrandReport;
  /** Clients whose on-sale mark changes (or would). */
  marks: { name: string; from: boolean | null; to: boolean }[];
  /** Rules marked as switched off in RD (or that would be). */
  unpublished: string[];
  /** Identifiers with no landing-page rule: nothing to mark (pages with no form, or never mapped). */
  noRule: string[];
}

/**
 * Applies Eric's decision of 02/10: registers the on-sale brands that have no
 * record yet (name only), marks every Expansão client on or off sale, and
 * dates the rules of the pages switched off in RD. Those rules stay active,
 * so late conversions and old leads of the pages keep their brand and funnel.
 * Nothing is deleted. Without `apply`, nothing is written. Safe to run again.
 */
export async function applyOnSale20261002(
  db: Database,
  input: { apply: boolean; actorEmployeeId?: string | null },
): Promise<OnSaleReport> {
  const brands = await registerBrands(db, { names: ON_SALE_2026_10_02, apply: input.apply });
  const onSale = new Set(ON_SALE_2026_10_02.map(brandKey));
  const marks: OnSaleReport['marks'] = [];
  const known = (await db.select().from(clients)).filter((client) => client.id !== WINGS_CLIENT_ID);
  for (const client of known) {
    const wanted = onSale.has(brandKey(client.name))
      ? true
      : client.relationship === 'expansao' || client.relationship === 'ambos'
        ? false
        : null;
    if (wanted === null || client.franchiseOnSale === wanted) continue;
    marks.push({ name: client.name, from: client.franchiseOnSale, to: wanted });
    if (!input.apply) continue;
    await db
      .update(clients)
      .set({ franchiseOnSale: wanted, updatedAt: new Date() })
      .where(eq(clients.id, client.id));
    await writeAudit(db, {
      actorEmployeeId: input.actorEmployeeId ?? null,
      action: 'client.franchise_on_sale_changed',
      entity: 'client',
      entityId: client.id,
      metadata: { from: client.franchiseOnSale, to: wanted, via: 'crm-brands --on-sale' },
    });
  }
  // Brands still to be registered by this run are on sale too.
  if (!input.apply) {
    for (const name of brands.created) marks.push({ name, from: null, to: true });
  }

  const rules = await db
    .select({
      id: leadSourceRules.id,
      pattern: leadSourceRules.pattern,
      rdUnpublishedOn: leadSourceRules.rdUnpublishedOn,
    })
    .from(leadSourceRules)
    .where(
      and(
        eq(leadSourceRules.kind, 'landing_page'),
        inArray(leadSourceRules.pattern, RD_UNPUBLISHED_2026_10_02.map(normalizeSourcePattern)),
      ),
    );
  const ruled = new Set(rules.map((rule) => rule.pattern));
  const unpublished: string[] = [];
  for (const rule of rules) {
    if (rule.rdUnpublishedOn) continue;
    unpublished.push(rule.pattern);
    if (!input.apply) continue;
    await db
      .update(leadSourceRules)
      .set({ rdUnpublishedOn: RD_UNPUBLISHED_ON })
      .where(eq(leadSourceRules.id, rule.id));
    await writeAudit(db, {
      actorEmployeeId: input.actorEmployeeId ?? null,
      action: 'lead_source_rule.rd_unpublished',
      entity: 'lead_source_rule',
      entityId: rule.id,
      metadata: { on: RD_UNPUBLISHED_ON, via: 'crm-brands --on-sale' },
    });
  }
  return {
    applied: input.apply,
    brands,
    marks,
    unpublished: unpublished.sort(),
    noRule: RD_UNPUBLISHED_2026_10_02.filter(
      (identifier) => !ruled.has(normalizeSourcePattern(identifier)),
    ),
  };
}

export function formatOnSaleReport(report: OnSaleReport): string {
  const verb = report.applied ? '' : 'seria ';
  const label = (value: boolean | null) =>
    value === null ? 'sem marcação' : value ? 'em comercialização' : 'fora de comercialização';
  return [
    report.applied ? 'APLICADO' : 'SIMULAÇÃO (nada foi gravado; rode com --apply para valer)',
    `marcas a cadastrar: ${report.brands.created.length}`,
    ...report.brands.created.map((name) => `  + ${name}`),
    `marcações ${verb}alteradas: ${report.marks.length}`,
    ...report.marks.map((mark) => `  ${mark.name}: ${label(mark.from)} → ${label(mark.to)}`),
    `regras ${verb}marcadas "desativada no RD em ${RD_UNPUBLISHED_ON}" (seguem ativas): ${report.unpublished.length}`,
    ...report.unpublished.map((pattern) => `  ${pattern}`),
    `páginas desativadas sem regra (nada a marcar): ${report.noRule.length}`,
    ...report.noRule.map((identifier) => `  ${identifier}`),
  ].join('\n');
}
