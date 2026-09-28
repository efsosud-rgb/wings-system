import {
  PERMISSIONS,
  ROLES,
  ROLE_PERMISSIONS,
  SECTORS,
  WINGS_CLIENT_ID,
  WINGS_CLIENT_NAME,
  WINGS_CLIENT_SLUG,
  type PermissionKey,
  type RoleKey,
  type SectorSlug,
} from '@wings/shared';
import { eq } from 'drizzle-orm';
import { createDb, type Database } from './client.js';
import { seedDriveTemplate, syncDriveFolders } from '../modules/drive/folders.js';
import { loadDotEnv } from './load-env.js';
import {
  clients,
  expansionLandingPages,
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
/** Landing pages of client brands known on 2026-09-28; more are added in Integrações. */
const EXPANSION_LANDING_PAGES = [
  { identifier: 'lp-calcadao-do-frango', brand: 'Calçadão do Frango' },
  { identifier: 'casal-do-churros', brand: 'Casal dos Churros' },
  { identifier: 'lp-mister-russo', brand: 'Mister Russo' },
];

export async function seed(db: Database): Promise<void> {
  // Insert-only: a person may deactivate or rename one later and the next deploy must not undo it.
  for (const page of EXPANSION_LANDING_PAGES) {
    await db.insert(expansionLandingPages).values(page).onConflictDoNothing();
  }

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
