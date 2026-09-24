import { sql } from 'drizzle-orm';
import {
  bigint,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import { tenants, WINGS_TENANT_ID } from './ads.js';
import { clients } from './clients.js';
import { employees } from './employees.js';

const tenantId = () =>
  uuid('tenant_id')
    .notNull()
    .default(WINGS_TENANT_ID)
    .references(() => tenants.id);

/**
 * The folder model: what every department and every client gets. A node of
 * kind `clients` becomes a "Clientes" folder holding one folder per active
 * client, and the nodes under it are made inside each of those.
 */
export const driveTemplateNodes = pgTable(
  'drive_template_nodes',
  {
    tenantId: tenantId(),
    id: uuid('id').primaryKey().defaultRandom(),
    parentId: uuid('parent_id').references((): AnyPgColumn => driveTemplateNodes.id),
    name: text('name').notNull(),
    /** folder | clients */
    kind: text('kind').notNull().default('folder'),
    department: text('department').notNull(),
    /** A `DriveFolderSlot` for the nodes of a client's tree; copied to its folders. */
    slot: text('slot'),
    position: integer('position').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('drive_template_parent_idx').on(table.parentId)],
);

/**
 * A tree. `department` decides who sees a folder and is inherited by whatever
 * is made inside it. `path` is the names from the root, kept for the
 * breadcrumb and the search: it says nothing about where bytes are stored.
 */
export const driveFolders = pgTable(
  'drive_folders',
  {
    tenantId: tenantId(),
    id: uuid('id').primaryKey().defaultRandom(),
    parentId: uuid('parent_id').references((): AnyPgColumn => driveFolders.id),
    name: text('name').notNull(),
    path: text('path').notNull(),
    department: text('department').notNull(),
    /** Set on a client's folder and on everything inside it. */
    clientId: uuid('client_id').references(() => clients.id),
    /** What the folder is in a client's tree (`DriveFolderSlot`), from its model node. */
    slot: text('slot'),
    /** manual | template | client | client_child */
    origin: text('origin').notNull().default('manual'),
    /** The node of the model this folder was made from, while that node exists. */
    templateNodeId: uuid('template_node_id').references(() => driveTemplateNodes.id, {
      onDelete: 'set null',
    }),
    createdBy: uuid('created_by').references(() => employees.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('drive_folders_parent_idx').on(table.parentId),
    index('drive_folders_department_idx').on(table.department),
    index('drive_folders_client_idx').on(table.clientId),
    // Two folders of one parent never share a name, whatever the case.
    uniqueIndex('drive_folders_sibling_name_idx').on(table.parentId, sql`lower(${table.name})`),
  ],
);

/**
 * A file is a row here only after its bytes were confirmed in storage.
 * `storage_key` is a name the server made and never leaves it. `checksum` is
 * what the storage reports (`md5:` of a direct upload) or what the server
 * computed (`sha256:` of bytes it wrote itself).
 */
export const driveFiles = pgTable(
  'drive_files',
  {
    tenantId: tenantId(),
    id: uuid('id').primaryKey().defaultRandom(),
    folderId: uuid('folder_id')
      .notNull()
      .references(() => driveFolders.id),
    name: text('name').notNull(),
    mimeType: text('mime_type').notNull(),
    byteSize: bigint('byte_size', { mode: 'number' }).notNull(),
    storageKey: text('storage_key').notNull(),
    /** Starts at 1; replacing the file keeps the old one in `drive_file_versions`. */
    version: integer('version').notNull().default(1),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => employees.id),
    clientId: uuid('client_id').references(() => clients.id),
    tags: text('tags').array().notNull().default([]),
    checksum: text('checksum'),
    /** In the trash since. Emptied for good thirty days later. */
    trashedAt: timestamp('trashed_at', { withTimezone: true }),
    trashedBy: uuid('trashed_by').references(() => employees.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('drive_files_folder_idx').on(table.folderId),
    index('drive_files_client_idx').on(table.clientId),
    index('drive_files_trashed_idx').on(table.trashedAt),
  ],
);

/** What a file was before it was replaced. */
export const driveFileVersions = pgTable(
  'drive_file_versions',
  {
    tenantId: tenantId(),
    id: uuid('id').primaryKey().defaultRandom(),
    fileId: uuid('file_id')
      .notNull()
      .references(() => driveFiles.id, { onDelete: 'cascade' }),
    version: integer('version').notNull(),
    mimeType: text('mime_type').notNull(),
    byteSize: bigint('byte_size', { mode: 'number' }).notNull(),
    storageKey: text('storage_key').notNull(),
    checksum: text('checksum'),
    /** Who put the NEXT version on top of this one. */
    replacedBy: uuid('replaced_by').references(() => employees.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('drive_file_versions_idx').on(table.fileId, table.version)],
);

/**
 * An upload somebody was given an address for. It becomes a file only when
 * `complete` finds the bytes in storage with the promised size.
 */
export const driveUploads = pgTable(
  'drive_uploads',
  {
    tenantId: tenantId(),
    id: uuid('id').primaryKey().defaultRandom(),
    folderId: uuid('folder_id')
      .notNull()
      .references(() => driveFolders.id),
    name: text('name').notNull(),
    mimeType: text('mime_type').notNull(),
    byteSize: bigint('byte_size', { mode: 'number' }).notNull(),
    storageKey: text('storage_key').notNull(),
    replaceFileId: uuid('replace_file_id').references(() => driveFiles.id, { onDelete: 'cascade' }),
    requestedBy: uuid('requested_by')
      .notNull()
      .references(() => employees.id),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('drive_uploads_expires_idx').on(table.expiresAt)],
);
