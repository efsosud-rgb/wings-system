import {
  PERMISSIONS,
  ROLES,
  ROLE_PERMISSIONS,
  SECTORS,
  WINGS_CLIENT_ID,
  WINGS_CLIENT_NAME,
  WINGS_CLIENT_SLUG,
  normalizeSourcePattern,
  type PermissionKey,
  type RoleKey,
  type SectorSlug,
} from '@wings/shared';
import { eq } from 'drizzle-orm';
import { createDb, type Database } from './client.js';
import { seedDriveTemplate, syncDriveFolders } from '../modules/drive/folders.js';
import { brandKey } from '../modules/leads/brands.js';
import { loadDotEnv } from './load-env.js';
import {
  clients,
  leadSourceRules,
  permissions,
  rolePermissions,
  roles,
  sectors,
  workSchedules,
} from './schema/index.js';

/**
 * Seeds reference data: sectors, roles, the permission matrix and the standard
 * work schedule. Idempotent — safe to re-run after every deploy.
 */
/** Landing pages of client brands known on 2026-09-28 (the last six confirmed by Eric the same day); more are added in Integrações. */
const EXPANSION_LANDING_PAGES = [
  { identifier: 'lp-calcadao-do-frango', brand: 'Calçadão do Frango' },
  { identifier: 'casal-do-churros', brand: 'Casal dos Churros' },
  { identifier: 'lp-mister-russo', brand: 'Mister Russo' },
  { identifier: 'calcadao-do-frango', brand: 'Calçadão do Frango' },
  { identifier: 'acai-da-fila', brand: 'Açaí da Fila' },
  { identifier: 'grupo-forte-fenix', brand: 'Grupo Forte Fênix' },
  { identifier: 'rio-acai-gourmet', brand: 'Rio Açaí Gourmet' },
  { identifier: 'ginteco', brand: 'Ginteco' },
  // RD pages without a rule, found by the landing-page audit of 2026-10-01
  // (docs/analise/landing-pages-auditoria-2026-10-01.md): Mister Russo's form
  // uses the slug, while `lp-mister-russo` is only its WhatsApp balloon. They
  // make no RD deal until Eric decides: RD's own automation may already make one.
  { identifier: 'mister-russo', brand: 'Mister Russo', rdDealIntake: false },
  { identifier: 'familia-k', brand: 'Família K', rdDealIntake: false },
  // Família K's waiting list too (Eric, 01/10), so production starts with it off.
  { identifier: 'lista-de-espera-familia-k', brand: 'Família K', rdDealIntake: false },
  { identifier: 'wash-club', brand: 'Wash Club', rdDealIntake: false },
  // Four new pages of the audit v2 (docs/analise/landing-pages-auditoria-2026-10-01-v2.md)
  // and `lionhairoficial`, also Lion Hair (Eric, 01/10). Held from RD deals like the three above.
  { identifier: 'so-criancas', brand: 'Só Crianças', rdDealIntake: false },
  { identifier: 'lion-hair', brand: 'Lion Hair', rdDealIntake: false },
  { identifier: 'lionhairoficial', brand: 'Lion Hair', rdDealIntake: false },
  { identifier: 'super-dogao-da-nana', brand: 'Super Dogão da Nana', rdDealIntake: false },
  { identifier: 'sarantopoulos', brand: 'Sarantopoulos', rdDealIntake: false },
  // Every other page published in RD on 2026-10-02 (Eric's list of 100, each
  // read live): the brand from the page's name and text, a `le-` or
  // `lista-de-espera-` page under its main page's brand. Held from RD deals
  // like the ones above. The identifier is the slug, also on a brand's own
  // domain (franquia.<marca>.com.br). `le-cookie-cup` is Cookie Craft's (its
  // text says so; Eric, 02/10).
  { identifier: 'parceiro', brand: 'Cervejaria Odin', rdDealIntake: false },
  { identifier: 'conytos', brand: 'Conytos', rdDealIntake: false },
  { identifier: 'conytos-lista-de-espera', brand: 'Conytos', rdDealIntake: false },
  { identifier: 'franquias', brand: 'Valhalla Burguer', rdDealIntake: false },
  { identifier: 'valhalla', brand: 'Valhalla Burguer', rdDealIntake: false },
  { identifier: 'amarjon-le', brand: 'Amarjon', rdDealIntake: false },
  { identifier: 'capi-hair', brand: 'Capi Hair Plus', rdDealIntake: false },
  { identifier: 'casa-da-dona', brand: 'Casa da Dona', rdDealIntake: false },
  { identifier: 'cenoritasgg', brand: 'Cenoritas', rdDealIntake: false },
  { identifier: 'cookie-craft', brand: 'Cookie Craft', rdDealIntake: false },
  { identifier: 'le-cookie-craft', brand: 'Cookie Craft', rdDealIntake: false },
  { identifier: 'le-cookie-cup', brand: 'Cookie Craft', rdDealIntake: false },
  { identifier: 'dimos', brand: 'Dimos', rdDealIntake: false },
  { identifier: 'donabonitex', brand: 'Dona Bonitex', rdDealIntake: false },
  { identifier: 'dr-coluna', brand: 'Dr Coluna', rdDealIntake: false },
  { identifier: 'le-dr-coluna', brand: 'Dr Coluna', rdDealIntake: false },
  {
    identifier: 'fabricadesalgadosmongagua',
    brand: 'Fábrica de Salgados Mongaguá',
    rdDealIntake: false,
  },
  {
    identifier: 'le-fabrica-de-salgados-mongagua',
    brand: 'Fábrica de Salgados Mongaguá',
    rdDealIntake: false,
  },
  { identifier: 'felipe-nilo', brand: 'Felipe Nilo', rdDealIntake: false },
  // These two are on lp.wingscompany.com.br, but they are a brand's franchise
  // pages (candidates' list, "Franquia BistrOgro"), not Wings' own.
  { identifier: 'lista-de-espera_espaco-felipe-nilo', brand: 'Felipe Nilo', rdDealIntake: false },
  { identifier: 'bistrogro', brand: 'BistrOgro', rdDealIntake: false },
  { identifier: 'florir', brand: 'Florir Café', rdDealIntake: false },
  { identifier: 'lista-de-espera-florir-cafe', brand: 'Florir Café', rdDealIntake: false },
  { identifier: 'flowmultas', brand: 'Flow Multas', rdDealIntake: false },
  { identifier: 'flowmultaslicenciados', brand: 'Flow Multas', rdDealIntake: false },
  { identifier: 'food-forest', brand: 'Food Forest', rdDealIntake: false },
  { identifier: 'le-food-forest', brand: 'Food Forest', rdDealIntake: false },
  { identifier: 'grupo-forte-fenix2', brand: 'Grupo Forte Fênix', rdDealIntake: false },
  { identifier: 'grupo-meu-ap', brand: 'Grupo Meu AP', rdDealIntake: false },
  { identifier: 'iguarigourmet', brand: 'Iguari', rdDealIntake: false },
  { identifier: 'le-byker', brand: 'Byker', rdDealIntake: false },
  { identifier: 'le-manet-pizzas', brand: 'Manet Pizzas', rdDealIntake: false },
  { identifier: 'lp-manet-pizzas', brand: 'Manet Pizzas', rdDealIntake: false },
  { identifier: 'uni', brand: 'Uni', rdDealIntake: false },
  { identifier: 'le-uni', brand: 'Uni', rdDealIntake: false },
  { identifier: 'lista-de-espera-acai-da-fila', brand: 'Açaí da Fila', rdDealIntake: false },
  {
    identifier: 'lista-de-espera-bazar-das-flores',
    brand: 'Bazar das Flores',
    rdDealIntake: false,
  },
  {
    identifier: 'lista-de-espera-calcadao-do-frango',
    brand: 'Calçadão do Frango',
    rdDealIntake: false,
  },
  {
    identifier: 'lista-de-espera-caval_barber_shop',
    brand: 'Caval Barber Shop',
    rdDealIntake: false,
  },
  { identifier: 'lista-de-espera-colab-space', brand: 'Colab Space', rdDealIntake: false },
  { identifier: 'lista-de-espera-fm-kitchens', brand: 'FM Kitchens', rdDealIntake: false },
  { identifier: 'lista-de-espera-ginteco', brand: 'Ginteco', rdDealIntake: false },
  { identifier: 'lp-grippa-head-spa', brand: 'Grippa Head Spa', rdDealIntake: false },
  { identifier: 'lista-de-espera-grippa', brand: 'Grippa Head Spa', rdDealIntake: false },
  { identifier: 'lista-de-espera-gustavo-eyewear', brand: 'Gustavo Eyewear', rdDealIntake: false },
  { identifier: 'melhor-parada', brand: 'Melhor Parada', rdDealIntake: false },
  { identifier: 'lista-de-espera-melhor-parada', brand: 'Melhor Parada', rdDealIntake: false },
  { identifier: 'lp-mister-gulla', brand: 'Mister Gulla Express', rdDealIntake: false },
  {
    identifier: 'lista-de-espera-mister-gulla',
    brand: 'Mister Gulla Express',
    rdDealIntake: false,
  },
  { identifier: 'lp-mundo-dos-hots', brand: 'Mundo dos Hots', rdDealIntake: false },
  { identifier: 'lista-de-espera-mundo-dos-hots', brand: 'Mundo dos Hots', rdDealIntake: false },
  { identifier: 'lp-na-chapa', brand: 'Na Chapa', rdDealIntake: false },
  { identifier: 'lista-de-espera-na-chapa-muriae', brand: 'Na Chapa', rdDealIntake: false },
  { identifier: 'nork', brand: 'Nork', rdDealIntake: false },
  { identifier: 'lista-de-espera-nork', brand: 'Nork', rdDealIntake: false },
  { identifier: 'nossa-esmalteria', brand: 'Nossa Esmalteria', rdDealIntake: false },
  {
    identifier: 'lista-de-espera-nossa-esmalteria',
    brand: 'Nossa Esmalteria',
    rdDealIntake: false,
  },
  { identifier: 'parro-pizzaria', brand: 'Parrô Pizzaria', rdDealIntake: false },
  { identifier: 'lista-de-espera-parro-pizzaria', brand: 'Parrô Pizzaria', rdDealIntake: false },
  { identifier: 'lista-de-espera-petina', brand: 'Petina Soluções', rdDealIntake: false },
  { identifier: 'renata-salgados', brand: 'Renata Salgados', rdDealIntake: false },
  { identifier: 'lista-de-espera-renata-salgados', brand: 'Renata Salgados', rdDealIntake: false },
  { identifier: 'lp-sorvetes-da-ilha', brand: 'Sorvetes da Ilha', rdDealIntake: false },
  {
    identifier: 'lista-de-espera-sorvetes-da-ilha',
    brand: 'Sorvetes da Ilha',
    rdDealIntake: false,
  },
  { identifier: 'sushi-de-feira', brand: 'Sushi de Feira', rdDealIntake: false },
  { identifier: 'lista-de-espera-sushi-de-feira', brand: 'Sushi de Feira', rdDealIntake: false },
  { identifier: 'pizzaria-verano', brand: 'Verano Pizzaria', rdDealIntake: false },
  { identifier: 'lista-de-espera-verano', brand: 'Verano Pizzaria', rdDealIntake: false },
  { identifier: 'lp-so-criancas', brand: 'Só Crianças', rdDealIntake: false },
  { identifier: 'malkutbistrocafeteria', brand: 'Malkuth', rdDealIntake: false },
  // Its RD page title still says Só Crianças (copied); the text is Pecan's.
  { identifier: 'pecan', brand: 'Pecan', rdDealIntake: false },
  { identifier: 'pensoulavou', brand: 'Pensou Lavou', rdDealIntake: false },
  { identifier: 'pizzaria-das-palmeiras', brand: 'Pizzaria das Palmeiras', rdDealIntake: false },
  { identifier: 'raptor', brand: 'Raptor', rdDealIntake: false },
  { identifier: 'salinas', brand: 'Salinas', rdDealIntake: false },
];

/** The Formatação forms (the Formatação net's list), Wings Company's own; a Wings page may be Expansão's. */
const FORMATACAO_LANDING_PAGES = [
  'wings-company-form-site',
  'lp-formatacao-whatsapp',
  'Formulário Simplificado. -02',
  // Wings' own pages at lp.wingscompany.com.br (Eric's list of 02/10), held from RD deals.
  { identifier: 'expansao-de-franquias', rdDealIntake: false },
  { identifier: 'formatar-franquia', rdDealIntake: false },
  // Its public is franchise candidates: Expansão, with no brand (Eric, 02/10).
  { identifier: 'hub-de-franquias', rdDealIntake: false, pipeline: 'expansao' as const },
  { identifier: 'lp-servicos-todos', rdDealIntake: false },
  { identifier: 'plano-de-negocios', rdDealIntake: false },
];

/** Meta Lead Ads instant forms → funnel. Ids given by Eric (05/10/2026); none invented. */
const META_LEAD_FORMS: { formId: string; pipeline: 'formatacao' | 'expansao' }[] = [
  { formId: '1538007113903398', pipeline: 'formatacao' },
];

export async function seed(db: Database): Promise<void> {
  // Sectors: parents first, then children, so parent_id can be resolved.
  const slugs = Object.keys(SECTORS) as SectorSlug[];
  const ordered = [
    ...slugs.filter((slug) => SECTORS[slug].parent === null),
    ...slugs.filter((slug) => SECTORS[slug].parent !== null),
  ];

  for (const slug of ordered) {
    const definition = SECTORS[slug];
    const parentId = definition.parent
      ? ((await db.query.sectors.findFirst({ where: eq(sectors.slug, definition.parent) }))?.id ??
        null)
      : null;

    await db
      .insert(sectors)
      .values({ slug, name: definition.name, parentId })
      .onConflictDoUpdate({
        target: sectors.slug,
        set: { name: definition.name, parentId },
      });
  }

  for (const [key, definition] of Object.entries(ROLES) as [RoleKey, (typeof ROLES)[RoleKey]][]) {
    await db
      .insert(roles)
      .values({
        key,
        name: definition.name,
        rank: definition.rank,
        tracksTime: definition.tracksTime,
      })
      .onConflictDoUpdate({
        target: roles.key,
        set: { name: definition.name, rank: definition.rank, tracksTime: definition.tracksTime },
      });
  }

  for (const [key, description] of Object.entries(PERMISSIONS) as [PermissionKey, string][]) {
    await db
      .insert(permissions)
      .values({ key, description })
      .onConflictDoUpdate({ target: permissions.key, set: { description } });
  }

  // The matrix in @wings/shared is the source of truth; the table mirrors it
  // so that reports and the audit trail can join on permissions.
  for (const [roleKey, grants] of Object.entries(ROLE_PERMISSIONS) as [
    RoleKey,
    (typeof ROLE_PERMISSIONS)[RoleKey],
  ][]) {
    const role = await db.query.roles.findFirst({ where: eq(roles.key, roleKey) });
    if (!role) throw new Error(`role ${roleKey} missing after seeding`);

    for (const [permissionKey, scope] of Object.entries(grants) as [
      PermissionKey,
      'own' | 'sector' | 'all',
    ][]) {
      await db
        .insert(rolePermissions)
        .values({ roleId: role.id, permissionKey, scope })
        .onConflictDoUpdate({
          target: [rolePermissions.roleId, rolePermissions.permissionKey],
          set: { scope },
        });
    }
  }

  // Standard company schedule: 09:00–18:00, Monday–Friday, 30 minutes tolerance.
  const existingDefault = await db.query.workSchedules.findFirst({
    where: eq(workSchedules.isDefault, true),
  });
  if (!existingDefault) {
    await db.insert(workSchedules).values({
      name: 'Padrão Wings',
      startTime: '09:00:00',
      endTime: '18:00:00',
      breakMinutes: 60,
      toleranceMinutes: 30,
      weekdays: [1, 2, 3, 4, 5],
      timezone: 'America/Sao_Paulo',
      isDefault: true,
    });
  }

  // The first client is Wings itself. The migration already inserts it (other
  // tables default to its id); this keeps the row right in a database that lost it.
  await db
    .insert(clients)
    .values({ id: WINGS_CLIENT_ID, name: WINGS_CLIENT_NAME, slug: WINGS_CLIENT_SLUG })
    .onConflictDoNothing();

  // Source rules for the known landing pages (CRM phase 1: one list for the
  // client, the brand and the funnel). Insert-only: a person may deactivate,
  // re-point or rename one later and the next deploy must not undo it. A new
  // rule is tied to its brand's client when the register already has one.
  const clientByBrand = new Map(
    (await db.select({ id: clients.id, name: clients.name }).from(clients)).map((client) => [
      brandKey(client.name),
      client.id,
    ]),
  );
  for (const page of EXPANSION_LANDING_PAGES) {
    await db
      .insert(leadSourceRules)
      .values({
        kind: 'landing_page',
        pattern: normalizeSourcePattern(page.identifier),
        pipeline: 'expansao',
        brand: page.brand,
        clientId: clientByBrand.get(brandKey(page.brand)) ?? null,
        rdDealIntake: 'rdDealIntake' in page ? page.rdDealIntake : true,
      })
      .onConflictDoNothing();
  }
  for (const page of FORMATACAO_LANDING_PAGES) {
    const {
      identifier,
      rdDealIntake = true,
      pipeline = 'formatacao',
    }: {
      identifier: string;
      rdDealIntake?: boolean;
      pipeline?: 'formatacao' | 'expansao';
    } = typeof page === 'string' ? { identifier: page } : page;
    await db
      .insert(leadSourceRules)
      .values({
        kind: 'landing_page',
        pattern: normalizeSourcePattern(identifier),
        clientId: WINGS_CLIENT_ID,
        pipeline,
        rdDealIntake,
      })
      .onConflictDoNothing();
  }

  // Meta Lead Ads forms (Eric, 05/10/2026): the Formatação instant form of the
  // Wings page. Insert-only, like the pages above; the Expansão forms are
  // added in CRM Vendas → Landing pages as each brand gets one.
  for (const form of META_LEAD_FORMS) {
    await db
      .insert(leadSourceRules)
      .values({
        kind: 'meta_form',
        pattern: form.formId,
        clientId: WINGS_CLIENT_ID,
        pipeline: form.pipeline,
        rdDealIntake: false,
      })
      .onConflictDoNothing();
  }

  // The Drive's folder model (written once, then it belongs to whoever edits it)
  // and the folders it asks for. Both only ever add.
  await seedDriveTemplate(db);
  await syncDriveFolders(db);
}

async function main() {
  loadDotEnv();
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is not set');

  const { db, pool } = createDb(databaseUrl);
  await seed(db);
  await pool.end();
  console.warn('seed complete');
}

if (process.argv[1]?.endsWith('seed.ts') || process.argv[1]?.endsWith('seed.js')) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}
