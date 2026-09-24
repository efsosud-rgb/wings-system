import { z } from 'zod';
import type { RoleKey } from './rbac/roles.js';

/**
 * The Drive: folders and files of the whole company, by department and client.
 *
 * Three rules shape the contract. A file's bytes never pass through the API:
 * the browser sends them to storage with a short pre-signed address, and the
 * file only exists here once the server has confirmed it arrived. No storage
 * key or volume path is ever part of an answer: files are named by id, and
 * opened through an address that lasts minutes. And what a person sees is
 * decided by the server, from the department of each folder.
 */

// ---------------------------------------------------------------------------
// Departments and who sees them
// ---------------------------------------------------------------------------

export const DRIVE_DEPARTMENTS = {
  formatacao: 'Formatação (geral)',
  marketing: 'Marketing',
  juridico: 'Jurídico',
  financeiro: 'Financeiro',
  producao: 'Produção',
  processos: 'Processos',
  logistica: 'Logística',
  ti: 'TI',
  rh_dp: 'RH-DP',
  projetos: 'Projetos',
  comercial: 'Comercial',
  /** The client tree's own folders: `Clientes`, each client, Documentos Enviados, Reuniões, Entrega. */
  clientes: 'Clientes',
  /** 01 Boas Vindas, 02 Imersão, 03 Desenvolvimento Estratégico: every Formatação area reads them. */
  imersao: 'Imersão (01–03)',
} as const;
export type DriveDepartment = keyof typeof DRIVE_DEPARTMENTS;
export const DRIVE_DEPARTMENT_KEYS = Object.keys(DRIVE_DEPARTMENTS) as DriveDepartment[];

/**
 * The departments a role works in: it sees them and, with `drive.write`,
 * writes in them. A role with `drive.read` at scope `all` (Admin Master,
 * Diretoria) is not listed: it sees every folder. `formatacao` and
 * `producao` belong to nobody in particular, so only those two see them.
 */
export const DRIVE_ROLE_DEPARTMENTS: Partial<Record<RoleKey, readonly DriveDepartment[]>> = {
  marketing: ['marketing'],
  rh_dp: ['rh_dp'],
  gerente_comercial: ['comercial'],
  vendedor_expansao: ['comercial'],
  vendedor_formatacao: ['comercial'],
  formatacao_juridico: ['juridico'],
  formatacao_financeiro: ['financeiro'],
  // There is no Contábil folder in the model: accounting works inside Financeiro.
  formatacao_contabil_tributario: ['financeiro'],
  // Processos e Projetos runs the client: 01–03 and 05, plus the client's own folders.
  formatacao_processos_projetos: ['processos', 'projetos', 'imersao', 'clientes'],
  formatacao_logistica: ['logistica'],
  formatacao_ti: ['ti'],
};

/**
 * Departments a role only READS: listed, searched and opened, never written.
 * Decision of 2026-09-24: 01 Boas Vindas, 02 Imersão and 03 Desenvolvimento
 * Estratégico are the base every Formatação consultant (and their agents)
 * works from, so every Formatação area reads them; Processos e Projetos
 * writes them.
 */
export const DRIVE_ROLE_READ_ONLY_DEPARTMENTS: Partial<Record<RoleKey, readonly DriveDepartment[]>> = {
  marketing: ['imersao'],
  rh_dp: ['imersao'],
  formatacao_juridico: ['imersao'],
  formatacao_financeiro: ['imersao'],
  formatacao_contabil_tributario: ['imersao'],
  formatacao_logistica: ['imersao'],
  formatacao_ti: ['imersao'],
};

/**
 * Roles that read EVERY folder of every client (the whole `Clientes/<NN. Nome>`
 * tree, whatever its department), besides the `all` roles. Reading only:
 * writing still follows `DRIVE_ROLE_DEPARTMENTS`.
 */
export const DRIVE_CLIENT_VIEW_ROLES: readonly RoleKey[] = ['formatacao_processos_projetos'];

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------

export const DRIVE_NAME_MAX = 120;
export const DRIVE_MAX_TAGS = 12;
export const DRIVE_TRASH_DAYS = 30;
export const DEFAULT_DRIVE_MAX_FILE_BYTES = 2 * 1024 * 1024 * 1024;

/** A folder or file name: no separators, no control characters, not "." or "..". */
export const driveNameSchema = z
  .string()
  .trim()
  .min(1, 'Informe um nome')
  .max(DRIVE_NAME_MAX, `No máximo ${DRIVE_NAME_MAX} caracteres`)
  .refine((name) => !/[\\/\p{Cc}]/u.test(name), 'O nome não pode ter barras')
  .refine((name) => name !== '.' && name !== '..', 'Nome inválido');

const tagsSchema = z
  .array(z.string().trim().min(1).max(40))
  .max(DRIVE_MAX_TAGS)
  .transform((tags) => [...new Set(tags.map((tag) => tag.toLowerCase()))]);

// ---------------------------------------------------------------------------
// Folders and files
// ---------------------------------------------------------------------------

/** How a folder came to be: by hand, from the model, or for a client under a model node. */
export type DriveFolderOrigin = 'manual' | 'template' | 'client' | 'client_child';

/**
 * What a folder of a client IS, independent of its name: the import from
 * Google Drive and the Client Portal find folders by slot, never by name, so
 * renaming "04 Financeiro" in the model breaks neither. Set on model nodes
 * and copied to the folders made from them.
 */
export const DRIVE_CLIENT_STAGES = [
  { slot: '01', name: '01 Boas Vindas', department: 'imersao' },
  { slot: '02', name: '02 Imersão', department: 'imersao' },
  { slot: '03', name: '03 Desenvolvimento Estratégico', department: 'imersao' },
  { slot: '04', name: '04 Financeiro', department: 'financeiro' },
  { slot: '05', name: '05 Operacional', department: 'projetos' },
  { slot: '06', name: '06 Jurídico', department: 'juridico' },
  { slot: '07', name: '07 Comercial', department: 'comercial' },
  { slot: '08', name: '08 Marketing', department: 'marketing' },
] as const satisfies readonly { slot: string; name: string; department: DriveDepartment }[];

export type DriveStageSlot = (typeof DRIVE_CLIENT_STAGES)[number]['slot'];

export const DRIVE_FOLDER_SLOTS = [
  ...DRIVE_CLIENT_STAGES.map((stage) => stage.slot),
  'midia',
  'enviados',
  'reunioes',
  'entrega',
  ...DRIVE_CLIENT_STAGES.map((stage) => `entrega_${stage.slot}` as const),
] as const;
export type DriveFolderSlot = (typeof DRIVE_FOLDER_SLOTS)[number];

/** `NN. Nome`: two digits up to 99, then as many as it takes. */
export function clientFolderName(number: number | null, name: string): string {
  const clean =
    name
      .replace(/[\\/\p{Cc}]/gu, '-')
      .trim()
      .slice(0, 110) || 'Cliente';
  return number === null ? clean : `${String(number).padStart(2, '0')}. ${clean}`;
}

export interface DriveFolder {
  id: string;
  parentId: string | null;
  name: string;
  /** Names from the root, for the breadcrumb: `/Formatação/Marketing`. Never a storage path. */
  path: string;
  department: DriveDepartment;
  clientId: string | null;
  origin: DriveFolderOrigin;
  /**
   * False for a folder shown only so the tree can be walked down to one the
   * person works in: its files are not listed and nothing can be put in it.
   */
  accessible: boolean;
  canWrite: boolean;
  /** Folders of the model and of clients are kept by the system: no rename, move or delete. */
  managed: boolean;
  /** What the folder is inside a client's tree, or null. */
  slot: DriveFolderSlot | null;
}

export interface DriveFile {
  id: string;
  folderId: string;
  /** For search results and the trash, where the folder is not on screen. */
  folderPath: string;
  name: string;
  mimeType: string;
  byteSize: number;
  version: number;
  ownerName: string | null;
  clientId: string | null;
  clientName: string | null;
  tags: string[];
  createdAt: string;
  updatedAt: string;
  trashedAt: string | null;
  /** When the trash empties this file for good. */
  purgeAt: string | null;
  canWrite: boolean;
}

export interface DriveFileVersion {
  version: number;
  byteSize: number;
  mimeType: string;
  createdAt: string;
  replacedByName: string | null;
}

export type DrivePreviewKind = 'image' | 'video' | 'pdf' | null;
export function drivePreviewKind(mimeType: string): DrivePreviewKind {
  if (/^image\/(png|jpeg|webp|gif|avif)$/.test(mimeType)) return 'image';
  if (/^video\/(mp4|webm)$/.test(mimeType)) return 'video';
  return mimeType === 'application/pdf' ? 'pdf' : null;
}

export const driveFolderCreateSchema = z.object({
  parentId: z.uuid(),
  name: driveNameSchema,
});
export const driveFolderUpdateSchema = z
  .object({ name: driveNameSchema.optional(), parentId: z.uuid().optional() })
  .refine((body) => body.name !== undefined || body.parentId !== undefined, 'Nada a alterar');

export const driveFileUpdateSchema = z
  .object({
    name: driveNameSchema.optional(),
    folderId: z.uuid().optional(),
    tags: tagsSchema.optional(),
  })
  .refine(
    (body) => body.name !== undefined || body.folderId !== undefined || body.tags !== undefined,
    'Nada a alterar',
  );

// ---------------------------------------------------------------------------
// Uploads
// ---------------------------------------------------------------------------

export const driveUploadRequestSchema = z.object({
  folderId: z.uuid(),
  name: driveNameSchema,
  mimeType: z
    .string()
    .trim()
    .max(120)
    .regex(/^[\w.+-]+\/[\w.+-]+$/)
    .default('application/octet-stream'),
  byteSize: z.number().int().positive(),
  /** Set to put a new version on top of an existing file instead of adding one. */
  replaceFileId: z.uuid().optional(),
});
export type DriveUploadRequest = z.output<typeof driveUploadRequestSchema>;

/** Where the browser sends the bytes. Good for a few minutes, for this one file and size. */
export interface DriveUploadTicket {
  uploadId: string;
  method: 'PUT';
  url: string;
  headers: Record<string, string>;
  expiresAt: string;
}

export interface DriveLink {
  url: string;
  expiresAt: string;
}

export const DRIVE_REFUSALS = {
  not_found: 'Pasta ou arquivo não encontrado.',
  forbidden: 'Você não tem acesso a esta pasta.',
  name_taken: 'Já existe um item com este nome nesta pasta.',
  managed_folder: 'Esta pasta faz parte do modelo de pastas e é mantida pelo sistema.',
  folder_not_empty: 'A pasta ainda tem arquivos ou subpastas.',
  into_itself: 'Uma pasta não pode ser movida para dentro dela mesma.',
  too_large: 'O arquivo passa do limite de tamanho.',
  upload_incomplete: 'O arquivo não chegou inteiro ao armazenamento. Envie de novo.',
  upload_expired: 'O envio expirou. Envie de novo.',
  storage_unavailable: 'O armazenamento de arquivos não está configurado neste ambiente.',
} as const;
export type DriveRefusal = keyof typeof DRIVE_REFUSALS;

// ---------------------------------------------------------------------------
// The folder model (Administração → Drive → Modelo de pastas)
// ---------------------------------------------------------------------------

/**
 * `folder`: one folder. `clients`: a "Clientes" folder that gets one folder per
 * active client; the nodes under it are created inside EACH client's folder.
 */
export const DRIVE_TEMPLATE_KINDS = ['folder', 'clients'] as const;
export type DriveTemplateKind = (typeof DRIVE_TEMPLATE_KINDS)[number];

export interface DriveTemplateNode {
  id: string;
  parentId: string | null;
  name: string;
  kind: DriveTemplateKind;
  department: DriveDepartment;
  position: number;
  slot: DriveFolderSlot | null;
}

export const driveTemplateNodeCreateSchema = z.object({
  parentId: z.uuid().nullable(),
  name: driveNameSchema,
  kind: z.enum(DRIVE_TEMPLATE_KINDS).default('folder'),
  /** Defaults to the parent's. Required at the root. */
  department: z.enum(DRIVE_DEPARTMENT_KEYS).optional(),
});
export const driveTemplateNodeUpdateSchema = z
  .object({
    name: driveNameSchema.optional(),
    department: z.enum(DRIVE_DEPARTMENT_KEYS).optional(),
  })
  .refine((body) => body.name !== undefined || body.department !== undefined, 'Nada a alterar');

export interface DriveSyncResult {
  foldersCreated: number;
  foldersRenamed: number;
  clients: number;
}

/** The name of the folder the media library lives in, under Marketing and under each of its clients. */
export const DRIVE_MEDIA_FOLDER = 'Mídia';
export const DRIVE_CLIENTS_FOLDER = 'Clientes';

/** One node of the seed, nested. `clients: true` makes a per-client container. */
export interface DriveTemplateSeed {
  name: string;
  department: DriveDepartment;
  clients?: boolean;
  slot?: DriveFolderSlot;
  children?: DriveTemplateSeed[];
}

const plain = (name: string, department: DriveDepartment, children: DriveTemplateSeed[] = []): DriveTemplateSeed => ({
  name,
  department,
  children,
});

/**
 * One client's tree (decision of 2026-09-24): the eight stages, what the client
 * sends, the meetings, and `Entrega`, the finished material the Client Portal
 * shows, mirroring the eight stages. The media library of a client is
 * `08 Marketing/Mídia`.
 */
export const DRIVE_CLIENT_TREE: DriveTemplateSeed[] = [
  ...DRIVE_CLIENT_STAGES.map(
    (stage): DriveTemplateSeed => ({
      name: stage.name,
      department: stage.department,
      slot: stage.slot,
      children:
        stage.slot === '08'
          ? [{ name: DRIVE_MEDIA_FOLDER, department: 'marketing', slot: 'midia' }]
          : [],
    }),
  ),
  { name: 'Documentos Enviados', department: 'clientes', slot: 'enviados' },
  { name: 'Reuniões', department: 'clientes', slot: 'reunioes' },
  {
    name: 'Entrega',
    department: 'clientes',
    slot: 'entrega',
    children: DRIVE_CLIENT_STAGES.map(
      (stage): DriveTemplateSeed => ({
        name: stage.name,
        department: stage.department,
        slot: `entrega_${stage.slot}`,
      }),
    ),
  },
];

export const DRIVE_CLIENTS_ROOT: DriveTemplateSeed = {
  name: DRIVE_CLIENTS_FOLDER,
  department: 'clientes',
  clients: true,
  children: DRIVE_CLIENT_TREE,
};

export const DRIVE_TEMPLATE_SEED: DriveTemplateSeed[] = [
  {
    name: 'Formatação',
    department: 'formatacao',
    children: [
      // Wings' own media library. A client's is Clientes/<NN. Nome>/08 Marketing/Mídia.
      plain('Marketing', 'marketing', [plain(DRIVE_MEDIA_FOLDER, 'marketing')]),
      plain('Jurídico', 'juridico'),
      plain('Financeiro', 'financeiro'),
      plain('Produção', 'producao'),
      plain('Processos', 'processos'),
      plain('Logística', 'logistica'),
      plain('TI', 'ti'),
      plain('RH-DP', 'rh_dp'),
      plain('Projetos', 'projetos'),
    ],
  },
  {
    name: 'Comercial',
    department: 'comercial',
    children: [plain('Propostas Comerciais', 'comercial')],
  },
  {
    name: 'RH-DP',
    department: 'rh_dp',
    children: [plain('Documentos', 'rh_dp'), plain('Contratos', 'rh_dp')],
  },
  DRIVE_CLIENTS_ROOT,
];

//   GET    /drive/tree                         -> { folders: DriveFolder[] }                 drive.read
//   GET    /drive/folders/:id                  -> { folder, files: DriveFile[] }             drive.read
//   POST   /drive/folders                      -> { folder }                                 drive.write
//   PATCH  /drive/folders/:id  { name?, parentId? } -> { folder }                            drive.write
//   DELETE /drive/folders/:id  (empty, manual only)                                          drive.write
//   GET    /drive/search?q=&clientId=&tag=     -> { files }                                  drive.read
//   GET    /drive/trash                        -> { files }                                  drive.read
//   POST   /drive/uploads                      -> { ticket: DriveUploadTicket }              drive.write
//   POST   /drive/uploads/:id/complete         -> { file }                                   drive.write
//   PATCH  /drive/files/:id  { name?, folderId?, tags? } -> { file }                         drive.write
//   POST   /drive/files/:id/trash | /restore   -> { file }                                   drive.write
//   DELETE /drive/files/:id  (from the trash, for good)                                      drive.manage
//   GET    /drive/files/:id/link?disposition=inline|attachment&version= -> DriveLink        drive.read
//   GET    /drive/files/:id/versions           -> { versions }                               drive.read
//   GET    /drive/template                     -> { nodes }                                  drive.manage
//   POST   /drive/template | PATCH/DELETE /drive/template/:id                                drive.manage
//   POST   /drive/sync                         -> DriveSyncResult                            drive.manage
