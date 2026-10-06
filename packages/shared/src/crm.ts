import { z } from 'zod';
import { driveUploadRequestSchema } from './drive.js';
import { LEAD_NAME_MAX, LEAD_PIPELINES, type LeadPipeline, type LeadSource } from './leads.js';

/**
 * CRM Vendas — the Funil as the team's place of work (plano
 * /root/relatorios/plano-crm-sofia-2026-10-05.md, Fase 1). Wings System is
 * the official CRM; RD Station CRM receives a copy during the transition.
 *
 * Stages are configurable per funnel (`crm_stages`): the default set is
 * whatever RD CRM has today, learned from the deals the import and the hourly
 * follow-up read, never invented here. Every stage or outcome change is a
 * `lead_stage_history` row (append-only); every owner change, note and task is
 * on the lead's timeline. Personal data lives only in `leads`.
 */

// --- stages ---------------------------------------------------------------------

export interface CrmStage {
  id: string;
  pipeline: LeadPipeline;
  name: string;
  /** 1-based position inside the funnel. */
  position: number;
  /** A retired stage keeps its leads and its history but takes no new ones. */
  active: boolean;
  /** The RD CRM stage this one mirrors, when known (for the copy to RD). */
  rdStageId: string | null;
  /** Sofia's pre-qualification entry stage (Fase 4); false until Sofia is ready. */
  sofiaEntry: boolean;
  /** Chance (0–100) a deal in this stage closes; weights the column's value. Configurable. */
  probability: number;
  /** Open leads in the stage, when the caller asked for counts. */
  openCount?: number;
}

export const CRM_STAGE_NAME_MAX = 60;

export const crmStageCreateSchema = z.object({
  pipeline: z.enum(LEAD_PIPELINES),
  name: z.string().trim().min(2, 'Informe o nome da etapa').max(CRM_STAGE_NAME_MAX),
  /** Insert here (1-based); omitted puts it last. */
  position: z.number().int().min(1).optional(),
});
export type CrmStageCreateInput = z.infer<typeof crmStageCreateSchema>;

export const crmStageUpdateSchema = z
  .object({
    name: z.string().trim().min(2, 'Informe o nome da etapa').max(CRM_STAGE_NAME_MAX).optional(),
    active: z.boolean().optional(),
    probability: z.number().int().min(0).max(100).optional(),
  })
  .refine(
    (value) =>
      value.name !== undefined || value.active !== undefined || value.probability !== undefined,
    { message: 'Nada para alterar.' },
  );
export type CrmStageUpdateInput = z.infer<typeof crmStageUpdateSchema>;

/** The whole order of a funnel's stages, every active stage once. */
export const crmStageOrderSchema = z.object({
  pipeline: z.enum(LEAD_PIPELINES),
  ids: z.array(z.uuid()).min(1).max(50),
});
export type CrmStageOrderInput = z.infer<typeof crmStageOrderSchema>;

// --- the lead's work ----------------------------------------------------------------

/** Who or what moved the lead: a person in the Wings System, RD CRM (mirror), the importer or Sofia. */
export const LEAD_CHANGE_SOURCES = ['wings', 'rd', 'import', 'sofia'] as const;
export type LeadChangeSource = (typeof LEAD_CHANGE_SOURCES)[number];

export interface LeadStageHistoryEntry {
  id: string;
  at: string;
  fromStage: string | null;
  toStage: string | null;
  /** The outcome after the change: true won, false lost, null open. */
  won: boolean | null;
  lostReason: string | null;
  source: LeadChangeSource;
  actorName: string | null;
}

export const LEAD_LOST_REASON_MAX = 200;

/**
 * One request, several things a seller does on a lead: move it, close it,
 * reopen it, hand it to someone else, fix its funnel. The API checks each part
 * against the caller's permissions (`leads.write` own/all for stage and
 * outcome; `leads.assign` for the owner).
 */
export const leadUpdateSchema = z
  .object({
    stageId: z.uuid().optional(),
    pipeline: z.enum(LEAD_PIPELINES).optional(),
    /** An employee id, or null to leave the lead with no owner. */
    ownerEmployeeId: z.uuid().nullable().optional(),
    /** true = won, false = lost (with `lostReason`), null = reopen. */
    won: z.boolean().nullable().optional(),
    lostReason: z.string().trim().max(LEAD_LOST_REASON_MAX).optional(),
  })
  .refine(
    (value) =>
      value.stageId !== undefined ||
      value.pipeline !== undefined ||
      value.ownerEmployeeId !== undefined ||
      value.won !== undefined,
    { message: 'Nada para alterar.' },
  )
  .refine((value) => value.won !== false || (value.lostReason?.length ?? 0) >= 2, {
    message: 'Informe o motivo da perda.',
  });
export type LeadUpdateInput = z.infer<typeof leadUpdateSchema>;

// --- notes -----------------------------------------------------------------------------

export const LEAD_NOTE_MAX = 4000;

export interface LeadNote {
  id: string;
  at: string;
  authorName: string | null;
  body: string;
}

export const leadNoteCreateSchema = z.object({
  body: z.string().trim().min(1, 'Escreva a anotação').max(LEAD_NOTE_MAX),
});
export type LeadNoteCreateInput = z.infer<typeof leadNoteCreateSchema>;

// --- tasks -----------------------------------------------------------------------------

export const LEAD_TASK_KINDS = ['first_contact', 'follow_up', 'call', 'meeting', 'other'] as const;
export type LeadTaskKind = (typeof LEAD_TASK_KINDS)[number];
export const LEAD_TASK_KIND_LABELS: Record<LeadTaskKind, string> = {
  first_contact: 'Primeiro contato',
  follow_up: 'Follow-up',
  call: 'Ligação',
  meeting: 'Reunião',
  other: 'Outra',
};

export const LEAD_TASK_TITLE_MAX = 160;

export interface LeadTask {
  id: string;
  leadId: string;
  /** For the task list: who the lead is (as the list already shows it). */
  leadName: string | null;
  leadCompanyName: string | null;
  kind: LeadTaskKind;
  title: string;
  dueAt: string;
  assigneeEmployeeId: string | null;
  assigneeName: string | null;
  /** Made by the system (the first-contact SLA), not by a person. */
  auto: boolean;
  createdAt: string;
  doneAt: string | null;
  doneByName: string | null;
}

export const leadTaskCreateSchema = z.object({
  kind: z.enum(LEAD_TASK_KINDS).default('follow_up'),
  title: z.string().trim().min(2, 'Informe a tarefa').max(LEAD_TASK_TITLE_MAX),
  dueAt: z.iso.datetime({ offset: true }),
  /** Defaults to the lead's owner, else the caller. */
  assigneeEmployeeId: z.uuid().optional(),
});
export type LeadTaskCreateInput = z.infer<typeof leadTaskCreateSchema>;

export const leadTaskUpdateSchema = z
  .object({
    done: z.boolean().optional(),
    dueAt: z.iso.datetime({ offset: true }).optional(),
    title: z.string().trim().min(2).max(LEAD_TASK_TITLE_MAX).optional(),
  })
  .refine(
    (value) => value.done !== undefined || value.dueAt !== undefined || value.title !== undefined,
    { message: 'Nada para alterar.' },
  );
export type LeadTaskUpdateInput = z.infer<typeof leadTaskUpdateSchema>;

export const taskListQuerySchema = z.object({
  /** `open` (default), `overdue`, `done` or `all`. */
  status: z.enum(['open', 'overdue', 'done', 'all']).default('open'),
  /** Only with a scope wider than own: every seller's tasks. */
  everyone: z.coerce.boolean().optional(),
  /** With `everyone`: one seller's tasks. */
  assignee: z
    .uuid()
    .optional()
    .or(z.literal('').transform(() => undefined)),
  kind: z
    .enum(LEAD_TASK_KINDS)
    .optional()
    .or(z.literal('').transform(() => undefined)),
});
export type TaskListQuery = z.infer<typeof taskListQuerySchema>;

/** When a task is late: its due time has passed and it is not done. */
export const isTaskOverdue = (task: Pick<LeadTask, 'dueAt' | 'doneAt'>, now = Date.now()) =>
  task.doneAt === null && new Date(task.dueAt).getTime() < now;

// --- distribution -------------------------------------------------------------------

/**
 * The rotation of a funnel: the sellers who take new leads in turn. A new lead
 * with a funnel and no owner goes to the member who waited longest
 * (round-robin); a paused member keeps their leads and takes no new one.
 */
export interface DistributionMember {
  employeeId: string;
  name: string;
  active: boolean;
  lastAssignedAt: string | null;
  /** Open leads the member owns, for the manager to see the load. */
  openLeads: number;
}

export interface Distribution {
  pipeline: LeadPipeline;
  members: DistributionMember[];
}

export const distributionUpdateSchema = z.object({
  pipeline: z.enum(LEAD_PIPELINES),
  members: z
    .array(z.object({ employeeId: z.uuid(), active: z.boolean() }))
    .max(50)
    .refine((list) => new Set(list.map((item) => item.employeeId)).size === list.length, {
      message: 'Um vendedor aparece duas vezes.',
    }),
});
export type DistributionUpdateInput = z.infer<typeof distributionUpdateSchema>;

/** An employee who may own leads (the owner dropdown and the rotation). */
export interface Seller {
  id: string;
  name: string;
  role: string;
  active: boolean;
}

// --- kanban ---------------------------------------------------------------------------

export const BOARD_CARDS_PER_STAGE = 30;

/** A compact card: the deal, who it is with, its value, its owner, its clock and where it came from. */
export interface BoardCard {
  id: string;
  name: string | null;
  companyName: string | null;
  contactName: string | null;
  email: string | null;
  phone: string | null;
  valueCents: number | null;
  /** The day the seller expects to close, `AAAA-MM-DD`; null while nobody said. */
  expectedCloseAt: string | null;
  brand: string | null;
  clientName: string;
  ownerEmployeeId: string | null;
  ownerName: string | null;
  stageChangedAt: string | null;
  /** The next open task, when there is one. */
  nextTask: { title: string; dueAt: string } | null;
  source: LeadSource;
  won: boolean | null;
  createdAt: string;
}

export interface BoardColumn {
  /** Null for the leads of the funnel that have no stage yet. */
  stage: CrmStage | null;
  total: number;
  /** Sum of the deals' values in the column, cents. */
  valueCents: number;
  /** The sum weighted by the stage's probability, cents. */
  weightedCents: number;
  cards: BoardCard[];
}

export interface Board {
  pipeline: LeadPipeline;
  columns: BoardColumn[];
  total: number;
  valueCents: number;
  weightedCents: number;
}

/** One column's next page of cards. */
export const boardColumnQuerySchema = z.object({
  pipeline: z.enum(LEAD_PIPELINES),
  /** A stage id, or `none` for the leads without a stage. */
  stageId: z.uuid().or(z.literal('none')),
  offset: z.coerce.number().int().min(0).max(5000).default(0),
});

// --- business hours (the first-contact SLA) ----------------------------------------

/** Wings' working hours (Eric, 05/10/2026): Monday to Friday, 9h–18h, São Paulo. Holidays come later. */
export const BUSINESS_HOURS = { start: 9, end: 18, timeZone: 'America/Sao_Paulo' } as const;

interface LocalParts {
  weekday: number;
  hour: number;
  minute: number;
  offsetMinutes: number;
}

/** The São Paulo wall clock of an instant, and the zone offset at that instant. */
function localParts(date: Date): LocalParts {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: BUSINESS_HOURS.timeZone,
    hourCycle: 'h23',
    weekday: 'short',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(date);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
  const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(get('weekday'));
  const asUtc = Date.UTC(
    Number(get('year')),
    Number(get('month')) - 1,
    Number(get('day')),
    Number(get('hour')),
    Number(get('minute')),
    Number(get('second')),
  );
  return {
    weekday,
    hour: Number(get('hour')),
    minute: Number(get('minute')),
    offsetMinutes: Math.round((asUtc - date.getTime()) / 60_000),
  };
}

const isWorkday = (weekday: number) => weekday >= 1 && weekday <= 5;

/** The next instant inside working hours, `from` itself when it already is. */
export function nextBusinessInstant(from: Date): Date {
  let cursor = new Date(from.getTime());
  cursor.setUTCSeconds(0, 0);
  for (let guard = 0; guard < 14; guard++) {
    const local = localParts(cursor);
    const minutesOfDay = local.hour * 60 + local.minute;
    if (
      isWorkday(local.weekday) &&
      minutesOfDay >= BUSINESS_HOURS.start * 60 &&
      minutesOfDay < BUSINESS_HOURS.end * 60
    ) {
      return cursor;
    }
    // Jump to the next 9h (today if before 9h, else tomorrow), in local time.
    const toStart =
      isWorkday(local.weekday) && minutesOfDay < BUSINESS_HOURS.start * 60
        ? BUSINESS_HOURS.start * 60 - minutesOfDay
        : 24 * 60 - minutesOfDay + BUSINESS_HOURS.start * 60;
    cursor = new Date(cursor.getTime() + toStart * 60_000);
    // A DST change between the two instants shifts the wall clock: re-align to 9h exactly.
    const after = localParts(cursor);
    const drift = after.hour * 60 + after.minute - BUSINESS_HOURS.start * 60;
    if (drift !== 0) cursor = new Date(cursor.getTime() - drift * 60_000);
  }
  return cursor;
}

/**
 * `from` plus `hours` of working time (Mon–Fri, 9h–18h São Paulo). Time
 * outside those hours does not count: a lead that arrives Friday 17h30 with
 * a 1-hour SLA is due Monday 9h30.
 */
export function addBusinessHours(from: Date, hours: number): Date {
  let remaining = Math.max(0, hours) * 60;
  let cursor = nextBusinessInstant(from);
  for (let guard = 0; guard < 400 && remaining > 0; guard++) {
    const local = localParts(cursor);
    const untilClose = BUSINESS_HOURS.end * 60 - (local.hour * 60 + local.minute);
    if (remaining <= untilClose) return new Date(cursor.getTime() + remaining * 60_000);
    remaining -= untilClose;
    cursor = nextBusinessInstant(new Date(cursor.getTime() + untilClose * 60_000));
  }
  return cursor;
}

// --- contacts and companies (CRM núcleo) ----------------------------------------------

/**
 * A lead is a deal; the person and the company it is with are records of
 * their own, found again by e-mail, phone or CNPJ so a second arrival or an
 * import never makes a twin. A won deal turns the company into a client of
 * the Formatação register with one click.
 */

export const CRM_COMPANY_NAME_MAX = 120;
export const CRM_CONTACT_NAME_MAX = 120;

/** Accent- and case-blind, no punctuation, single spaces: how a company is found again by name. */
export function companyKey(name: string): string {
  return name
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/\b(ltda|me|epp|eireli|s\.?a\.?|sa)\b\.?/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

export interface CrmCompany {
  id: string;
  name: string;
  cnpj: string | null;
  phone: string | null;
  email: string | null;
  website: string | null;
  city: string | null;
  state: string | null;
  segment: string | null;
  /** The Formatação client this company became, when it did. */
  clientId: string | null;
  clientName: string | null;
  contacts: number;
  leads: number;
  openLeads: number;
  createdAt: string;
  updatedAt: string;
}

export interface CrmContact {
  id: string;
  name: string | null;
  email: string | null;
  phone: string | null;
  jobTitle: string | null;
  companyId: string | null;
  companyName: string | null;
  leads: number;
  openLeads: number;
  createdAt: string;
  updatedAt: string;
}

/** A contact as the lead's page shows it. */
export interface LeadContactRef {
  id: string;
  name: string | null;
  email: string | null;
  phone: string | null;
  jobTitle: string | null;
  primary: boolean;
}

/** A lead as a contact's or a company's page lists it. */
export interface CrmRelatedLead {
  id: string;
  name: string | null;
  pipeline: LeadPipeline | null;
  brand: string | null;
  stage: string | null;
  won: boolean | null;
  ownerName: string | null;
  valueCents: number | null;
  createdAt: string;
}

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .or(z.literal('').transform(() => undefined));

export const crmCompanyInputSchema = z.object({
  name: z.string().trim().min(2, 'Informe o nome da empresa').max(CRM_COMPANY_NAME_MAX),
  cnpj: optionalText(20),
  phone: optionalText(30),
  email: optionalText(200),
  website: optionalText(200),
  city: optionalText(120),
  state: optionalText(2),
  segment: optionalText(80),
});
export type CrmCompanyInput = z.infer<typeof crmCompanyInputSchema>;

export const crmCompanyUpdateSchema = crmCompanyInputSchema.partial().extend({
  name: z.string().trim().min(2).max(CRM_COMPANY_NAME_MAX).optional(),
});
export type CrmCompanyUpdateInput = z.infer<typeof crmCompanyUpdateSchema>;

export const crmContactInputSchema = z
  .object({
    name: optionalText(CRM_CONTACT_NAME_MAX),
    email: optionalText(200),
    phone: optionalText(30),
    jobTitle: optionalText(80),
    /** A company id, a new company's name, or null for none. */
    companyId: z.uuid().nullable().optional(),
    companyName: optionalText(CRM_COMPANY_NAME_MAX),
  })
  .refine((value) => value.email || value.phone, { message: 'Informe um e-mail ou um telefone.' });
export type CrmContactInput = z.infer<typeof crmContactInputSchema>;

export const crmContactUpdateSchema = z.object({
  name: optionalText(CRM_CONTACT_NAME_MAX),
  email: optionalText(200),
  phone: optionalText(30),
  jobTitle: optionalText(80),
  companyId: z.uuid().nullable().optional(),
  companyName: optionalText(CRM_COMPANY_NAME_MAX),
});
export type CrmContactUpdateInput = z.infer<typeof crmContactUpdateSchema>;

/** Merge `fromId` into `intoId`: links move, gaps of the kept row are filled, the other is retired. */
export const crmMergeSchema = z
  .object({ fromId: z.uuid(), intoId: z.uuid() })
  .refine((value) => value.fromId !== value.intoId, {
    message: 'Escolha dois registros diferentes.',
  });
export type CrmMergeInput = z.infer<typeof crmMergeSchema>;

export const crmSearchQuerySchema = z.object({
  q: z
    .string()
    .trim()
    .max(120)
    .optional()
    .or(z.literal('').transform(() => undefined)),
  /** Pairs that share a phone, an e-mail (contacts) or a name (companies). */
  duplicates: z.coerce.boolean().optional(),
});

/** Which contacts a lead has: add one (by id or by data), set the main one, take one off. */
export const leadContactLinkSchema = z.object({
  contactId: z.uuid().optional(),
  contact: crmContactInputSchema.optional(),
  primary: z.boolean().optional(),
});

/** A duplicate pair the server found, for the merge screen. */
export interface CrmDuplicatePair<T> {
  /** phone | email | name */
  by: string;
  a: T;
  b: T;
}

// --- activities: calls and meetings ------------------------------------------------------

export const LEAD_ACTIVITY_KINDS = ['call', 'meeting'] as const;
export type LeadActivityKind = (typeof LEAD_ACTIVITY_KINDS)[number];
export const LEAD_ACTIVITY_KIND_LABELS: Record<LeadActivityKind, string> = {
  call: 'Ligação',
  meeting: 'Reunião',
};

export const LEAD_CALL_OUTCOMES = [
  'answered',
  'no_answer',
  'busy',
  'voicemail',
  'wrong_number',
  'callback',
] as const;
export type LeadCallOutcome = (typeof LEAD_CALL_OUTCOMES)[number];
export const LEAD_CALL_OUTCOME_LABELS: Record<LeadCallOutcome, string> = {
  answered: 'Atendeu',
  no_answer: 'Não atendeu',
  busy: 'Ocupado',
  voicemail: 'Caixa postal',
  wrong_number: 'Número errado',
  callback: 'Pediu retorno',
};

export const LEAD_ACTIVITY_NOTE_MAX = 2000;

export interface LeadActivity {
  id: string;
  kind: LeadActivityKind;
  at: string;
  outcome: LeadCallOutcome | null;
  durationSeconds: number | null;
  participants: string | null;
  meetUrl: string | null;
  note: string | null;
  actorName: string | null;
  createdAt: string;
}

const meetUrl = z
  .string()
  .trim()
  .max(300)
  .refine(
    (value) =>
      /^https:\/\/(meet\.google\.com|[\w.-]+\.zoom\.us|teams\.microsoft\.com)\//.test(value),
    {
      message: 'Informe o link completo do Meet (https://meet.google.com/…).',
    },
  );

export const leadActivityCreateSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('call'),
    at: z.iso.datetime({ offset: true }).optional(),
    outcome: z.enum(LEAD_CALL_OUTCOMES),
    durationSeconds: z.number().int().min(0).max(86_400).optional(),
    note: optionalText(LEAD_ACTIVITY_NOTE_MAX),
  }),
  z.object({
    kind: z.literal('meeting'),
    at: z.iso.datetime({ offset: true }),
    participants: optionalText(500),
    meetUrl: meetUrl.optional().or(z.literal('').transform(() => undefined)),
    note: optionalText(LEAD_ACTIVITY_NOTE_MAX),
  }),
]);
export type LeadActivityCreateInput = z.infer<typeof leadActivityCreateSchema>;

// --- value and brand of interest -----------------------------------------------------

export const LEAD_VALUE_MAX_CENTS = 100_000_000_00;

/**
 * A calendar date as the API carries it: `AAAA-MM-DD`, and one that exists
 * (no 31 de fevereiro). The forecast has no time and no time zone: the day
 * the seller typed is the day everyone reads.
 */
const ISO_DATE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
export const isoDateSchema = z
  .string()
  .regex(ISO_DATE, 'Data inválida.')
  .refine((text) => {
    const [year, month, day] = text.split('-').map(Number) as [number, number, number];
    const date = new Date(Date.UTC(year, month - 1, day));
    return date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
  }, 'Data inválida.');

/** Today's date as `AAAA-MM-DD` in the person's own time zone (the forecast is a plain calendar day). */
export const localIsoDate = (now = new Date()): string =>
  `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

/**
 * An open deal whose forecast day is already behind us is "vencida": the
 * forecast was missed, not the deal. A won or lost deal is never overdue,
 * whatever its forecast said.
 */
export const isCloseForecastOverdue = (
  lead: { expectedCloseAt: string | null; won: boolean | null },
  today = localIsoDate(),
): boolean => lead.won === null && lead.expectedCloseAt !== null && lead.expectedCloseAt < today;

/**
 * The lead's deal fields a seller edits on its page: the estimated value, the
 * expected close date, the brand of interest (an Expansão brand from
 * Administração → CRM; it files the lead under that client) and the company.
 */
export const leadDealUpdateSchema = z
  .object({
    /** The deal's name (the person or the company), as the seller edits it in the head of the page. */
    name: z.string().trim().min(2, 'Informe o nome').max(LEAD_NAME_MAX).optional(),
    valueCents: z.number().int().min(0).max(LEAD_VALUE_MAX_CENTS).nullable().optional(),
    /** The day the seller expects to close, `AAAA-MM-DD`; null clears the forecast. */
    expectedCloseAt: isoDateSchema.nullable().optional(),
    /** A client id from the brand list, or null to clear the brand. */
    brandClientId: z.uuid().nullable().optional(),
    /** A company id, or null to detach; `companyName` makes (or finds) one by name. */
    companyId: z.uuid().nullable().optional(),
    companyName: optionalText(CRM_COMPANY_NAME_MAX),
  })
  .refine(
    (value) =>
      value.name !== undefined ||
      value.valueCents !== undefined ||
      value.expectedCloseAt !== undefined ||
      value.brandClientId !== undefined ||
      value.companyId !== undefined ||
      value.companyName !== undefined,
    { message: 'Nada para alterar.' },
  );
export type LeadDealUpdateInput = z.infer<typeof leadDealUpdateSchema>;

/**
 * A Drive file attached to a deal (ficha do cliente). The Drive keeps the
 * bytes and decides who opens it; this is the link, read with `leads.read` in
 * the caller's scope. Opening or downloading goes through `/drive/files/:id/link`.
 */
export interface LeadFile {
  id: string;
  fileId: string;
  name: string;
  mimeType: string;
  byteSize: number;
  version: number;
  addedByName: string | null;
  createdAt: string;
}

/** `POST /leads/:id/files/uploads`: the folder is the deal's own, chosen by the server. */
export const leadFileUploadSchema = driveUploadRequestSchema.omit({
  folderId: true,
  replaceFileId: true,
});
export type LeadFileUploadInput = z.output<typeof leadFileUploadSchema>;

/**
 * The deal's AI summary (Etapa 4), kept on the lead with the date it was
 * made. Built only from the timeline and the form answers: no phone, e-mail
 * or document ever goes to the model (`docs/crm/ficha-do-cliente.md`).
 */
export interface LeadAiSummary {
  text: string;
  generatedAt: string;
  model: string;
  basedOn: { events: number; answers: number };
}

/** An Expansão brand a lead may be interested in: a client with its franchise on sale. */
export interface CrmBrand {
  clientId: string;
  name: string;
  onSale: boolean;
  openLeads: number;
}

export const crmBrandCreateSchema = z.object({
  name: z.string().trim().min(2, 'Informe o nome da marca').max(80),
});

export const crmBrandUpdateSchema = z.object({ onSale: z.boolean() });

// --- CSV import and export ------------------------------------------------------------

export const CSV_IMPORT_MAX_BYTES = 2_000_000;
export const CSV_IMPORT_MAX_ROWS = 5_000;
export const CSV_EXPORT_MAX_ROWS = 10_000;

/** The lead fields a CSV column may feed. */
export const CSV_IMPORT_FIELDS = [
  'name',
  'email',
  'phone',
  'company',
  'cnpj',
  'city',
  'brand',
  'pipeline',
  'stage',
  'value',
  'owner',
  'note',
] as const;
export type CsvImportField = (typeof CSV_IMPORT_FIELDS)[number];
export const CSV_IMPORT_FIELD_LABELS: Record<CsvImportField, string> = {
  name: 'Nome',
  email: 'E-mail',
  phone: 'Telefone',
  company: 'Empresa',
  cnpj: 'CNPJ',
  city: 'Cidade',
  brand: 'Marca de interesse',
  pipeline: 'Funil',
  stage: 'Etapa',
  value: 'Valor estimado',
  owner: 'Dono (e-mail do vendedor)',
  note: 'Anotação',
};

/** Header names (accent- and case-blind) that map to each field on their own. */
export const CSV_HEADER_ALIASES: Record<CsvImportField, string[]> = {
  name: ['nome', 'name', 'lead', 'contato', 'nome completo'],
  email: ['email', 'e-mail', 'e mail'],
  phone: ['telefone', 'celular', 'whatsapp', 'phone', 'fone', 'tel'],
  company: ['empresa', 'company', 'organizacao', 'razao social', 'nome fantasia'],
  cnpj: ['cnpj'],
  city: ['cidade', 'city', 'municipio'],
  brand: ['marca', 'marca de interesse', 'franquia', 'brand', 'cliente'],
  pipeline: ['funil', 'pipeline'],
  stage: ['etapa', 'stage', 'estagio', 'fase'],
  value: ['valor', 'valor estimado', 'value', 'ticket'],
  owner: ['dono', 'vendedor', 'responsavel', 'owner', 'usuario'],
  note: ['anotacao', 'observacao', 'observacoes', 'nota', 'notes', 'comentario'],
};

export const csvImportMappingSchema = z.record(z.string().max(200), z.enum(CSV_IMPORT_FIELDS));

export const csvImportRequestSchema = z.object({
  /** The file's text, UTF-8. */
  csv: z.string().min(1, 'Envie um arquivo CSV.').max(CSV_IMPORT_MAX_BYTES),
  /** Column header -> field. Headers left out are ignored. */
  mapping: csvImportMappingSchema,
  pipeline: z.enum(LEAD_PIPELINES).optional(),
  /** Default brand (a client id) for rows without one. */
  brandClientId: z.uuid().optional(),
  /** Default owner; a seller's own imports always land on them. */
  ownerEmployeeId: z.uuid().optional(),
});
export type CsvImportRequest = z.infer<typeof csvImportRequestSchema>;

export interface CsvPreviewRow {
  line: number;
  values: Record<CsvImportField, string>;
  /** Empty when the row would import. */
  errors: string[];
  /** The lead the row would join (same e-mail or phone), when there is one. */
  matchesLeadId: string | null;
}

export interface CsvImportPreview {
  headers: string[];
  /** The mapping the server guessed from the headers (the caller may change it). */
  suggestedMapping: Record<string, CsvImportField>;
  rows: number;
  valid: number;
  invalid: number;
  /** Rows that would join a lead the system already has. */
  existing: number;
  /** Rows that repeat another row of the same file (same e-mail or phone). */
  repeated: number;
  sample: CsvPreviewRow[];
}

export interface CsvImportReport {
  batchId: string;
  rows: number;
  created: number;
  matched: number;
  skipped: number;
  errors: { line: number; message: string }[];
}

// --- saved views (the tabs of Negociações) ------------------------------------------------

export const CRM_VIEW_NAME_MAX = 40;

/** A person's saved filter set on a funnel: a tab next to "Todas" and "Minhas". */
export interface CrmSavedView {
  id: string;
  pipeline: LeadPipeline;
  name: string;
  /** The list query's fields, as the screen keeps them. */
  filters: Record<string, string>;
  createdAt: string;
}

export const crmSavedViewCreateSchema = z.object({
  pipeline: z.enum(LEAD_PIPELINES),
  name: z.string().trim().min(2, 'Dê um nome à visão').max(CRM_VIEW_NAME_MAX),
  filters: z.record(z.string().max(40), z.string().max(200)),
});
export type CrmSavedViewCreateInput = z.infer<typeof crmSavedViewCreateSchema>;

/** The two letters a card shows for the owner: "Thais Lima" -> "TL". */
export function initialsOf(name: string | null | undefined): string {
  const parts = (name ?? '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '—';
  const first = parts[0]![0] ?? '';
  const last = parts.length > 1 ? (parts[parts.length - 1]![0] ?? '') : '';
  return `${first}${last}`.toUpperCase();
}

/** The badge a source gets on a card: short label and a tone the CSS knows. */
export const LEAD_SOURCE_BADGES: Record<LeadSource, { label: string; tone: string }> = {
  meta_lead_ads: { label: 'Meta', tone: 'meta' },
  tiktok_lead_ads: { label: 'TikTok', tone: 'tiktok' },
  rd_station: { label: 'RD', tone: 'rd' },
  rd_crm: { label: 'RD', tone: 'rd' },
  site_form: { label: 'Site', tone: 'site' },
  whatsapp_link: { label: 'WhatsApp', tone: 'whatsapp' },
  manual: { label: 'Manual', tone: 'manual' },
  csv_import: { label: 'Planilha', tone: 'manual' },
};

/** Google shows when the attribution says so, whatever the door was. */
export const sourceBadgeOf = (
  source: LeadSource,
  adPlatform?: string | null,
): { label: string; tone: string } =>
  adPlatform === 'google' ? { label: 'Google', tone: 'google' } : LEAD_SOURCE_BADGES[source];
