import {
  normalizeBrazilianPhone,
  normalizeEmail,
  pipelineOfRdFunnel,
  WINGS_CLIENT_ID,
  type LeadPipeline,
} from '@wings/shared';
import { and, asc, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import {
  auditLog,
  clients,
  employees,
  leadEnrichmentLedger,
  leadEvents,
  leads,
  rdUserMap,
  leadStageHistory,
} from '../../db/schema/index.js';
import { rdCrmGetter } from '../ads/funnel-sync.js';
import { shapeOf } from '../media/kairogen-adapter.js';
import { brandKey } from './brands.js';
import { ensureStage } from './crm.js';
import { upsertLead, type LeadRow } from './service.js';

/**
 * CRM phase 1 (docs/crm/fase1-complemento-funil.md §2.3): RD Station CRM's
 * Expansão and Formatação deals become leads of the Funil, with brand, funnel,
 * stage and owner, so the Funil shows the work the team does in RD. RD stays
 * the tool of record: this only reads RD (GET), and the stage columns of a
 * lead are a mirror. Personal data (the contact's name, e-mail, phone) goes
 * into `leads` and nowhere else; the result and every log are counts, ids and
 * labels.
 *
 * Formats are read tolerantly and their shapes logged (`shapeOf`: keys and
 * numbers, never strings). Seen live on 2026-09-30 (staging simulation): the
 * users list (`id`, `name`, `email`, `active`, `hidden`), the deal list with
 * `contacts` (`emails[].email`, `phones[].phone`) and `deal_custom_fields`
 * (`custom_field.label`, `value`), and `deal_stage_histories` as
 * `{deal_stage_id, start_date, end_date}[]`.
 */

export interface RdStage {
  id: string;
  name: string;
}
export interface RdPipelineRow {
  id?: string;
  name: string;
  deal_stages: RdStage[];
}
export interface RdUserRow {
  id?: string;
  _id?: string;
  name?: string;
  email?: string;
  active?: boolean;
  hidden?: boolean;
}
export interface RdDealRow {
  id?: string;
  _id?: string;
  name?: string;
  win: boolean | null;
  hold?: boolean | null;
  created_at: string;
  closed_at?: string | null;
  deal_stage?: { id?: string; _id?: string } | null;
  user?: { id?: string; _id?: string } | null;
  deal_source?: { name?: string } | null;
  campaign?: { name?: string } | null;
  deal_lost_reason?: { name?: string } | null;
  /** The deal list carries its contacts (seen live 2026-09-30); older answers may not. */
  contacts?: RdContactRow[];
  deal_custom_fields?: {
    value?: unknown;
    custom_field?: { label?: string } | null;
  }[];
}
export interface RdContactRow {
  id?: string;
  _id?: string;
  name?: string;
  emails?: { email?: string }[];
  phones?: { phone?: string }[];
}
export type RdDealDetail = { deal_stage_histories?: unknown } & Record<string, unknown>;

/** What the importer asks of RD CRM: reads only. */
export interface RdCrmReader {
  pipelines(): Promise<RdPipelineRow[]>;
  users(): Promise<RdUserRow[]>;
  /** Every deal, or those created in [since, until] when given. */
  deals(period?: { since: Date; until: Date }): Promise<RdDealRow[]>;
  dealContacts(dealId: string): Promise<RdContactRow[]>;
  deal(dealId: string): Promise<RdDealDetail>;
}

const idOf = (row: { id?: string; _id?: string } | null | undefined) => row?.id ?? row?._id ?? null;
const ymd = (date: Date) => date.toISOString().slice(0, 10);

/** ~85 calls a minute at most: RD CRM's limit is per minute and shared with the intake jobs. */
export const RD_IMPORT_MIN_INTERVAL_MS = 700;

export function rdCrmReader(
  token: string,
  fetchImpl: typeof fetch = fetch,
  minIntervalMs = RD_IMPORT_MIN_INTERVAL_MS,
): RdCrmReader {
  const get = rdCrmGetter(token, fetchImpl, { minIntervalMs });
  return {
    pipelines: () => get<RdPipelineRow[]>('/deal_pipelines', {}),
    async users() {
      const body = await get<RdUserRow[] | { users?: RdUserRow[] }>('/users', {});
      return Array.isArray(body) ? body : (body.users ?? []);
    },
    async deals(period) {
      const deals: RdDealRow[] = [];
      let next: string | null = null;
      do {
        const params: Record<string, string> = { limit: '200' };
        if (period) {
          params.created_at_period = 'true';
          params.start_date = `${ymd(period.since)}T00:00:00`;
          params.end_date = `${ymd(period.until)}T23:59:59`;
        }
        if (next) params.next_page = next;
        const page: { deals?: RdDealRow[]; has_more?: boolean; next_page?: string } = await get(
          '/deals',
          params,
        );
        deals.push(...(page.deals ?? []));
        next = page.has_more && page.next_page ? page.next_page : null;
      } while (next);
      return deals;
    },
    async dealContacts(dealId) {
      const body = await get<{ contacts?: RdContactRow[] }>(`/deals/${dealId}/contacts`, {});
      return body.contacts ?? [];
    },
    deal: (dealId) => get<RdDealDetail>(`/deals/${dealId}`, {}),
  };
}

// --- pure helpers ----------------------------------------------------------------

export interface StagePlace {
  pipelineName: string;
  pipeline: LeadPipeline | null;
  stage: string;
  order: number;
  /** Id of the first stage of the pipeline. */
  firstStageId: string | null;
  /**
   * An RD archive funnel of the pipeline ("Negócios perdidos - Expansão",
   * "Vendidos | Expansão🏆"): its stages are filing labels, not steps of the
   * work, so they never become a Wings stage (`stageRowOf`).
   */
  archive: boolean;
}

const plainName = (name: string) =>
  name
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .trim()
    .toLowerCase();

/** The RD funnel is the pipeline's own ("Expansão", "Formatação"), not one of its archives. */
export function isArchiveFunnel(name: string, pipeline: LeadPipeline | null): boolean {
  return pipeline !== null && plainName(name) !== pipeline;
}

export function stagePlaces(pipelines: readonly RdPipelineRow[]): Map<string, StagePlace> {
  const places = new Map<string, StagePlace>();
  for (const pipeline of pipelines) {
    const first = pipeline.deal_stages[0]?.id ?? null;
    pipeline.deal_stages.forEach((stage, index) => {
      places.set(stage.id, {
        pipelineName: pipeline.name,
        pipeline: pipelineOfRdFunnel(pipeline.name),
        stage: stage.name,
        order: index + 1,
        firstStageId: first,
        archive: isArchiveFunnel(pipeline.name, pipelineOfRdFunnel(pipeline.name)),
      });
    });
  }
  return places;
}

/**
 * The Wings stage a deal sits in: the pipeline's own funnel learns its stages
 * (`ensureStage`); an archive funnel gives none (Eric, 05/10: never a column
 * from "Vendidos" or "Negócios perdidos"; the deal is won or lost instead).
 */
async function stageRowOf(db: Database, place: StagePlace, rdStageId: string | null) {
  if (!place.pipeline || place.archive) return null;
  return ensureStage(db, {
    pipeline: place.pipeline,
    name: place.stage,
    position: place.order,
    rdStageId,
  });
}

/** The stage label a lead keeps: RD's, except from an archive funnel, which has none. */
const stageLabelOf = (place: StagePlace) => (place.archive ? null : place.stage);

/**
 * The outcome in the funnel of origin. An archive funnel files the deal (Eric,
 * 05/10): "Vendidos…" is won and "Negócios perdidos…" is lost, whatever the
 * deal's own flag says; its stage label becomes the reason when RD gives none.
 */
export function rdOutcomeOf(
  deal: Pick<RdDealRow, 'win' | 'closed_at' | 'deal_lost_reason'>,
  place: Pick<StagePlace, 'archive' | 'pipelineName' | 'stage'>,
): { won: boolean | null; closedAt: Date | null; lostReason: string | null } {
  const filed = place.archive ? plainName(place.pipelineName) : '';
  const won = /^vendid/.test(filed) ? true : /^negocios perdidos/.test(filed) ? false : deal.win;
  const reason = deal.deal_lost_reason?.name ?? (place.archive ? place.stage : null);
  return {
    won,
    closedAt: dateOf(deal.closed_at),
    lostReason: won === false ? (reason?.slice(0, 200) ?? null) : null,
  };
}

/**
 * Who keeps the RD owner (Eric, 05/10: only Eric, Thais and Fernando, named by
 * their RD user ids in CRM_RD_OWNER_USER_IDS). Anyone else's deal comes in with
 * no owner: no rotation, no first-contact task, no alert. Unset keeps every
 * linked owner, as before.
 */
export function rdOwnerAllowlist(value: string | undefined): ReadonlySet<string> | null {
  const ids = (value ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);
  return ids.length > 0 ? new Set(ids) : null;
}

const ownerOf = (
  owners: ReadonlyMap<string, string | null>,
  allowed: ReadonlySet<string> | null | undefined,
  rdOwnerId: string | null,
) => (rdOwnerId && (!allowed || allowed.has(rdOwnerId)) ? (owners.get(rdOwnerId) ?? null) : null);

const EXPANSION_CAMPAIGN = /^LP(?:\/LE)?\s+(.+?)\s+-\s+Fluxo Expans[aã]o/i;

/** The brand of an Expansão deal: the "Nome da Marca" field, else the "LP/LE <marca> - Fluxo Expansão" campaign. */
export function brandOfDeal(deal: RdDealRow): string | null {
  for (const field of deal.deal_custom_fields ?? []) {
    if (!/^nome da marca$/i.test(field.custom_field?.label?.trim() ?? '')) continue;
    const value = typeof field.value === 'string' ? field.value.trim() : '';
    if (value) return value.slice(0, 120);
  }
  const campaign = deal.campaign?.name?.match(EXPANSION_CAMPAIGN)?.[1]?.trim();
  return campaign ? campaign.slice(0, 120) : null;
}

export interface StageTimes {
  /** When the deal first entered a stage after the pipeline's first one. */
  firstContactAt: Date | null;
  /** When the deal entered the stage it is in now. */
  stageChangedAt: Date | null;
}

const dateOf = (value: unknown): Date | null => {
  if (typeof value !== 'string' || !value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
};

/**
 * Reads `deal_stage_histories` tolerantly: each entry names a stage (by
 * `deal_stage_id`, `stage_id` or a nested `deal_stage`) and when the deal
 * entered it (`start_date`, `started_at` or `created_at`). An entry that says
 * neither is skipped; nothing is guessed.
 */
export function stageTimesOf(
  histories: unknown,
  input: { currentStageId: string | null; firstStageId: string | null },
): StageTimes {
  const entries: { stageId: string; start: Date }[] = [];
  for (const raw of Array.isArray(histories) ? histories : []) {
    if (!raw || typeof raw !== 'object') continue;
    const entry = raw as Record<string, unknown>;
    const nested = entry.deal_stage as { id?: string; _id?: string } | undefined;
    const stageId =
      (typeof entry.deal_stage_id === 'string' && entry.deal_stage_id) ||
      (typeof entry.stage_id === 'string' && entry.stage_id) ||
      idOf(nested);
    const start = dateOf(entry.start_date) ?? dateOf(entry.started_at) ?? dateOf(entry.created_at);
    if (stageId && start) entries.push({ stageId, start });
  }
  entries.sort((a, b) => a.start.getTime() - b.start.getTime());
  const firstContact = entries.find((entry) => entry.stageId !== input.firstStageId);
  const current = [...entries].reverse().find((entry) => entry.stageId === input.currentStageId);
  return { firstContactAt: firstContact?.start ?? null, stageChangedAt: current?.start ?? null };
}

// --- import ------------------------------------------------------------------------

export interface RdImportResult {
  applied: boolean;
  dealsListed: number;
  /** In Expansão/Formatação and inside the window (or open). */
  inScope: Record<LeadPipeline, number>;
  /** Of `inScope`, deals filed in an archive funnel (no Wings stage is created for them). */
  inArchive: number;
  /** What the archive funnels became in the funnel of origin. */
  archiveOutcome: { won: number; lost: number };
  /** Deals of RD funnels with no Wings pipeline (Parcerias, Estruturação, Lista de espera…), per funnel. */
  outOfScope: Record<string, number>;
  created: number;
  /** Joined to a lead that already existed (same deal, phone or e-mail). */
  merged: number;
  /** A person with more than one deal: the lead keeps the open or the latest. */
  otherDealOfSamePerson: number;
  noContactData: number;
  testDeals: number;
  owners: { mapped: number; unmapped: number };
  /** Expansão deals per brand as RD names it; "(sem marca)" when neither field nor campaign says. */
  brands: Record<string, number>;
  /** Brands RD names that no client matches (their leads stay under Wings, unmapped). */
  unmatchedBrands: string[];
  histories: { read: number; failed: number; withFirstContact: number };
  rdUsers: { listed: number; linkedByEmail: number; linkedByName: number };
  failed: number;
}

export interface RdImportOptions {
  apply: boolean;
  /** Deals created on or after this day come in; open ones come in whatever their age. */
  since: Date;
  /** Only deals created in the window (incremental run); open older ones are not listed. */
  window?: { since: Date; until: Date };
  /** Read `deal_stage_histories` (one call per deal). */
  histories: boolean;
  /** Only deals the Funil does not have yet (incremental run). */
  onlyMissing?: boolean;
  /** RD users whose deals keep their owner (`rdOwnerAllowlist`); null or absent keeps every linked one. */
  ownerRdUserIds?: ReadonlySet<string> | null;
  /**
   * The run's batch id (required with `apply`): new leads carry it in
   * `import_batch_id`, and a lead that already existed gets a `rd.import_batch`
   * event with what it was before (ids and labels, never personal data), so
   * `undoRdImportBatch` can take this run back alone.
   */
  batchId?: string;
  log?: (facts: Record<string, unknown>) => void;
  onProgress?: (done: number, total: number) => void;
}

interface Contact {
  id: string | null;
  name: string | null;
  email: string | null;
  phone: string | null;
}

function contactOf(rows: readonly RdContactRow[]): Contact {
  const first = rows[0];
  if (!first) return { id: null, name: null, email: null, phone: null };
  const email = first.emails?.map((row) => normalizeEmail(row.email)).find(Boolean) ?? null;
  const phone =
    first.phones?.map((row) => normalizeBrazilianPhone(row.phone)).find(Boolean) ?? null;
  return { id: idOf(first), name: first.name?.trim() || null, email, phone };
}

/** RD users -> `rd_user_map`, linked to an employee by e-mail, else by the same full name; never unlinks. */
async function syncRdUsers(db: Database, rows: readonly RdUserRow[], apply: boolean) {
  const staff = await db
    .select({ id: employees.id, email: employees.email, fullName: employees.fullName })
    .from(employees);
  const byEmail = new Map(staff.map((employee) => [employee.email.toLowerCase(), employee.id]));
  const byName = new Map<string, string | null>();
  for (const employee of staff) {
    const key = brandKey(employee.fullName);
    byName.set(key, byName.has(key) ? null : employee.id); // two with the same name: no guess
  }
  const counts = { listed: rows.length, linkedByEmail: 0, linkedByName: 0 };
  for (const row of rows) {
    const rdUserId = idOf(row);
    if (!rdUserId) continue;
    const existing = await db.query.rdUserMap.findFirst({
      where: eq(rdUserMap.rdUserId, rdUserId),
    });
    let employeeId = existing?.employeeId ?? null;
    // Someone who left the company is never linked by a guess (their deals stay "dono inativo").
    if (!employeeId && !existing?.departedAt) {
      const viaEmail = row.email ? byEmail.get(row.email.toLowerCase()) : undefined;
      const viaName = row.name ? byName.get(brandKey(row.name)) : undefined;
      employeeId = viaEmail ?? viaName ?? null;
      if (viaEmail) counts.linkedByEmail += 1;
      else if (viaName) counts.linkedByName += 1;
    }
    if (!apply) continue;
    const values = {
      rdName: (row.name ?? '').trim() || '(sem nome)',
      rdActive: row.active !== false && row.hidden !== true,
      employeeId,
      updatedAt: new Date(),
    };
    await db
      .insert(rdUserMap)
      .values({ rdUserId, ...values })
      .onConflictDoUpdate({ target: rdUserMap.rdUserId, set: values });
  }
  return counts;
}

/** A lead keeps its deal unless the new one is open and the kept one is not, or the kept one is closed. */
const replacesDeal = (lead: LeadRow, incomingWin: boolean | null) =>
  lead.rdDealId === null || lead.won !== null || incomingWin === null;

/** The columns an import may change on an existing lead: ids, labels and dates, nothing personal. */
const SNAPSHOT_KEYS = [
  'rdDealId',
  'rdContactId',
  'rdOwnerId',
  'rdPipeline',
  'pipeline',
  'brand',
  'stage',
  'stageOrder',
  'stageChangedAt',
  'firstContactAt',
  'won',
  'closedAt',
  'lostReason',
  'rdSyncedAt',
  'ownerEmployeeId',
  'clientId',
  'clientMapped',
] as const satisfies readonly (keyof LeadRow)[];

/** What the lead was before the run; a column the run's upsert just filled was empty, and is left to `filled`. */
function snapshotOf(lead: LeadRow, filled: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(
    SNAPSHOT_KEYS.filter((key) => !filled.includes(key)).map((key) => {
      const value = lead[key];
      return [key, value instanceof Date ? value.toISOString() : value];
    }),
  );
}

export async function importRdDeals(
  db: Database,
  rd: RdCrmReader,
  options: RdImportOptions,
): Promise<RdImportResult> {
  const result: RdImportResult = {
    applied: options.apply,
    dealsListed: 0,
    inScope: { expansao: 0, formatacao: 0 },
    inArchive: 0,
    archiveOutcome: { won: 0, lost: 0 },
    outOfScope: {},
    created: 0,
    merged: 0,
    otherDealOfSamePerson: 0,
    noContactData: 0,
    testDeals: 0,
    owners: { mapped: 0, unmapped: 0 },
    brands: {},
    unmatchedBrands: [],
    histories: { read: 0, failed: 0, withFirstContact: 0 },
    rdUsers: { listed: 0, linkedByEmail: 0, linkedByName: 0 },
    failed: 0,
  };

  if (options.apply && !options.batchId) throw new Error('an applied RD import needs a batch id');
  const [pipelines, users, deals] = await Promise.all([
    rd.pipelines(),
    rd.users(),
    rd.deals(options.window),
  ]);
  options.log?.({ step: 'rd_import.users', shape: shapeOf(users[0] ?? null) });
  result.rdUsers = await syncRdUsers(db, users, options.apply);
  const owners = new Map(
    (
      await db
        .select({ rdUserId: rdUserMap.rdUserId, employeeId: rdUserMap.employeeId })
        .from(rdUserMap)
    ).map((row) => [row.rdUserId, row.employeeId]),
  );
  const places = stagePlaces(pipelines);
  const brandClients = new Map(
    (await db.select({ id: clients.id, name: clients.name }).from(clients))
      .filter((client) => client.id !== WINGS_CLIENT_ID)
      .map((client) => [brandKey(client.name), client.id]),
  );

  result.dealsListed = deals.length;
  for (const deal of deals) {
    const place = places.get(idOf(deal.deal_stage) ?? '');
    if (place && !place.pipeline)
      result.outOfScope[place.pipelineName] = (result.outOfScope[place.pipelineName] ?? 0) + 1;
  }
  const scoped = deals
    .map((deal) => ({ deal, id: idOf(deal), place: places.get(idOf(deal.deal_stage) ?? '') }))
    .filter(
      (
        row,
      ): row is { deal: RdDealRow; id: string; place: StagePlace & { pipeline: LeadPipeline } } =>
        Boolean(row.id && row.place?.pipeline) &&
        (row.deal.win === null ||
          new Date(row.deal.created_at).getTime() >= options.since.getTime()),
    )
    .sort((a, b) => new Date(a.deal.created_at).getTime() - new Date(b.deal.created_at).getTime());
  if (scoped[0]) options.log?.({ step: 'rd_import.deal', shape: shapeOf(scoped[0].deal) });

  let done = 0;
  let historyShapeLogged = false;
  const unmatched = new Set<string>();
  // A simulation writes nothing, so it remembers who it has already counted.
  const seenInRun = new Set<string>();
  for (const { deal, id, place } of scoped) {
    options.onProgress?.(done, scoped.length);
    done += 1;
    result.inScope[place.pipeline] += 1;
    if (place.archive) result.inArchive += 1;
    const already = await db.query.leads.findFirst({
      where: eq(leads.rdDealId, id),
      columns: { id: true },
    });
    if (options.onlyMissing && already) continue;

    const brand = place.pipeline === 'expansao' ? brandOfDeal(deal) : null;
    if (place.pipeline === 'expansao') {
      const label = brand ?? '(sem marca)';
      result.brands[label] = (result.brands[label] ?? 0) + 1;
    }
    const brandClientId = brand ? (brandClients.get(brandKey(brand)) ?? null) : null;
    if (brand && !brandClientId) unmatched.add(brand);
    const rdOwnerId = idOf(deal.user);
    const ownerEmployeeId = ownerOf(owners, options.ownerRdUserIds, rdOwnerId);
    const outcome = rdOutcomeOf(deal, place);
    if (place.archive) result.archiveOutcome[outcome.won ? 'won' : 'lost'] += 1;
    if (ownerEmployeeId) result.owners.mapped += 1;
    else result.owners.unmapped += 1;
    if (/\bteste\b/i.test(`${deal.name ?? ''} ${deal.deal_lost_reason?.name ?? ''}`))
      result.testDeals += 1;

    try {
      const contact = contactOf(
        Array.isArray(deal.contacts) ? deal.contacts : await rd.dealContacts(id),
      );
      if (!contact.email && !contact.phone) result.noContactData += 1;

      let times: StageTimes = { firstContactAt: null, stageChangedAt: null };
      if (options.histories) {
        try {
          const detail = await rd.deal(id);
          if (!historyShapeLogged) {
            options.log?.({
              step: 'rd_import.deal_stage_histories',
              shape: shapeOf(detail.deal_stage_histories ?? null),
            });
            historyShapeLogged = true;
          }
          times = stageTimesOf(detail.deal_stage_histories, {
            currentStageId: idOf(deal.deal_stage),
            firstStageId: place.firstStageId,
          });
          result.histories.read += 1;
          if (times.firstContactAt) result.histories.withFirstContact += 1;
        } catch {
          result.histories.failed += 1;
        }
      }

      if (!options.apply) {
        const seen =
          (contact.phone && seenInRun.has(contact.phone)) ||
          (contact.email && seenInRun.has(contact.email));
        if (contact.phone) seenInRun.add(contact.phone);
        if (contact.email) seenInRun.add(contact.email);
        if (already || seen) result.merged += 1;
        else {
          const phoneMatch = contact.phone
            ? await db.query.leads.findFirst({
                where: eq(leads.phone, contact.phone),
                columns: { id: true },
              })
            : undefined;
          const emailMatch =
            !phoneMatch && contact.email
              ? await db.query.leads.findFirst({
                  where: eq(leads.email, contact.email),
                  columns: { id: true },
                })
              : undefined;
          if (phoneMatch || emailMatch) result.merged += 1;
          else result.created += 1;
        }
        continue;
      }

      const mapped = place.pipeline === 'formatacao' || brandClientId !== null;
      const upserted = await upsertLead(db, {
        source: 'rd_crm',
        name: contact.name,
        email: contact.email,
        phone: contact.phone,
        clientId: brandClientId ?? WINGS_CLIENT_ID,
        clientMapped: mapped,
        pipeline: place.pipeline,
        brand,
        externalId: id,
        arrivedAt: dateOf(deal.created_at),
        consentSource: 'rd_crm',
        skipResearch: true,
        importBatchId: options.batchId ?? null,
        event: {
          kind: 'lead.imported.rd_crm',
          detail: { rdDealId: id, pipeline: place.pipeline, batchId: options.batchId ?? null },
        },
      });
      if (upserted.created) result.created += 1;
      else result.merged += 1;

      const lead = upserted.lead;
      // A lead from before this run: remember what it was, once per run, so the run can be undone.
      if (!upserted.created && lead.importBatchId !== options.batchId) {
        const recorded = await db.query.leadEvents.findFirst({
          where: and(
            eq(leadEvents.leadId, lead.id),
            eq(leadEvents.kind, 'rd.import_batch'),
            sql`${leadEvents.detail}->>'batchId' = ${options.batchId ?? ''}`,
          ),
          columns: { id: true },
        });
        if (!recorded) {
          await db.insert(leadEvents).values({
            leadId: lead.id,
            kind: 'rd.import_batch',
            detail: {
              batchId: options.batchId ?? null,
              filled: upserted.filled,
              before: snapshotOf(lead, upserted.filled),
            },
          });
        }
      }
      if (lead.rdDealId !== id && !replacesDeal(lead, outcome.won)) {
        result.otherDealOfSamePerson += 1;
        await db.insert(leadEvents).values({
          leadId: lead.id,
          kind: 'rd.other_deal',
          detail: {
            rdDealId: id,
            pipeline: place.pipeline,
            win: deal.win,
            batchId: options.batchId ?? null,
          },
        });
        continue;
      }
      if (lead.rdDealId && lead.rdDealId !== id) result.otherDealOfSamePerson += 1;
      // A lead already run from the Wings System (it was born here, or a person
      // moved it) keeps what it has: RD only fills what is still empty.
      const wingsRun = lead.managedBy === 'wings' && !upserted.created;
      const stageRow = await stageRowOf(db, place, idOf(deal.deal_stage));
      const keepStage = wingsRun && lead.stageId !== null;
      const keepOutcome = wingsRun && lead.won !== null;
      await db
        .update(leads)
        .set({
          // The import decides which of a person's deals the lead follows; a Wings-run lead keeps its own.
          rdDealId: wingsRun ? (lead.rdDealId ?? id) : id,
          rdContactId: contact.id,
          rdOwnerId,
          rdPipeline: place.pipelineName,
          pipeline: lead.pipeline ?? place.pipeline,
          brand: brand ?? lead.brand,
          ...(keepStage
            ? {}
            : {
                stage: stageLabelOf(place),
                stageOrder: place.archive ? null : place.order,
                stageId: stageRow?.id ?? null,
                stageChangedAt:
                  times.stageChangedAt ??
                  (lead.rdDealId === id && lead.stage === stageLabelOf(place)
                    ? lead.stageChangedAt
                    : null),
              }),
          ...(wingsRun ? {} : { managedBy: 'rd' }),
          firstContactAt:
            times.firstContactAt ?? (lead.rdDealId === id ? lead.firstContactAt : null),
          ...(keepOutcome ? {} : outcome),
          rdSyncedAt: new Date(),
          ...(ownerEmployeeId && !(wingsRun && lead.ownerEmployeeId) ? { ownerEmployeeId } : {}),
          ...(brandClientId && !lead.clientMapped
            ? { clientId: brandClientId, clientMapped: true }
            : {}),
          updatedAt: new Date(),
        })
        .where(eq(leads.id, lead.id));
    } catch (error) {
      // The message names an RD path and a status only (rdCrmGetter).
      result.failed += 1;
      options.log?.({
        step: 'rd_import.deal_failed',
        rdDealId: id,
        error: error instanceof Error ? error.message.slice(0, 120) : 'unknown',
      });
    }
  }
  result.unmatchedBrands = [...unmatched].sort();
  return result;
}

/**
 * The hourly follow-up inside the ingestion cycle: the stage, outcome and
 * owner of every lead that has an RD deal, from the deals the cycle already
 * read (no extra call). A stage that changed loses its `stage_changed_at`
 * until the deal's history is read again (never "now", which would be a guess).
 */
export async function followRdStages(
  db: Database,
  input: {
    deals: readonly RdDealRow[];
    pipelines: readonly RdPipelineRow[];
    ownerRdUserIds?: ReadonlySet<string> | null;
  },
): Promise<{ updated: number; stageChanged: number }> {
  const places = stagePlaces(input.pipelines);
  const owners = new Map(
    (
      await db
        .select({ rdUserId: rdUserMap.rdUserId, employeeId: rdUserMap.employeeId })
        .from(rdUserMap)
    ).map((row) => [row.rdUserId, row.employeeId]),
  );
  let updated = 0;
  let stageChanged = 0;
  for (const deal of input.deals) {
    const id = idOf(deal);
    const place = places.get(idOf(deal.deal_stage) ?? '');
    if (!id || !place) continue;
    const lead = await db.query.leads.findFirst({ where: eq(leads.rdDealId, id) });
    if (!lead) continue;
    const rdOwnerId = idOf(deal.user);
    // Run from the Wings System: RD is a copy; it fills only what is still empty here.
    const wingsRun = lead.managedBy === 'wings';
    const keepStage = wingsRun && lead.stageId !== null;
    const keepOutcome = wingsRun && lead.won !== null;
    const label = stageLabelOf(place);
    const changed = !keepStage && (lead.stage !== label || lead.rdPipeline !== place.pipelineName);
    const ownerEmployeeId = ownerOf(owners, input.ownerRdUserIds, rdOwnerId);
    const stageRow = await stageRowOf(db, place, idOf(deal.deal_stage));
    const outcome = rdOutcomeOf(deal, place);
    const outcomeChanged = !keepOutcome && lead.won !== outcome.won;
    if (changed || outcomeChanged) {
      await db.insert(leadStageHistory).values({
        leadId: lead.id,
        fromStageId: lead.stageId,
        toStageId: stageRow?.id ?? null,
        fromStage: lead.stage,
        toStage: keepStage ? lead.stage : label,
        won: keepOutcome ? lead.won : outcome.won,
        lostReason: keepOutcome ? lead.lostReason : outcome.lostReason,
        source: 'rd',
      });
    }
    await db
      .update(leads)
      .set({
        rdPipeline: place.pipelineName,
        pipeline: lead.pipeline ?? place.pipeline,
        ...(keepStage
          ? {}
          : {
              stage: label,
              stageOrder: place.archive ? null : place.order,
              stageId: place.archive ? null : (stageRow?.id ?? lead.stageId),
              ...(changed ? { stageChangedAt: null } : {}),
            }),
        ...(keepOutcome ? {} : outcome),
        rdOwnerId,
        ...(ownerEmployeeId && !(wingsRun && lead.ownerEmployeeId) ? { ownerEmployeeId } : {}),
        rdSyncedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(leads.id, lead.id));
    updated += 1;
    if (changed) stageChanged += 1;
  }
  return { updated, stageChanged };
}

/** Open leads whose stage time is unknown: their history is read again, a few per run, oldest first. */
export async function refreshStageTimes(
  db: Database,
  rd: RdCrmReader,
  input: { pipelines: readonly RdPipelineRow[]; limit: number },
): Promise<{ read: number; failed: number }> {
  const byName = new Map<string, { stageId: string; place: StagePlace }>();
  for (const [stageId, place] of stagePlaces(input.pipelines)) {
    byName.set(`${place.pipelineName}|${place.stage}`, { stageId, place });
  }
  const rows = await db
    .select({
      id: leads.id,
      rdDealId: leads.rdDealId,
      rdPipeline: leads.rdPipeline,
      stage: leads.stage,
      firstContactAt: leads.firstContactAt,
    })
    .from(leads)
    .where(and(isNotNull(leads.rdDealId), isNull(leads.stageChangedAt), isNull(leads.won)))
    .orderBy(asc(leads.updatedAt))
    .limit(input.limit);
  let read = 0;
  let failed = 0;
  for (const row of rows) {
    if (!row.rdDealId) continue;
    const known = byName.get(`${row.rdPipeline}|${row.stage}`);
    try {
      const detail = await rd.deal(row.rdDealId);
      const times = stageTimesOf(detail.deal_stage_histories, {
        currentStageId: known?.stageId ?? null,
        firstStageId: known?.place.firstStageId ?? null,
      });
      await db
        .update(leads)
        .set({
          stageChangedAt: times.stageChangedAt,
          firstContactAt: row.firstContactAt ?? times.firstContactAt,
          updatedAt: new Date(),
        })
        .where(eq(leads.id, row.id));
      read += 1;
    } catch {
      failed += 1;
    }
  }
  return { read, failed };
}

// --- undo ---------------------------------------------------------------------------

const DATE_KEYS = new Set(['stageChangedAt', 'firstContactAt', 'closedAt', 'rdSyncedAt']);

export interface UndoResult {
  applied: boolean;
  batchId: string;
  /** Leads this run created: removed with their timeline. */
  created: number;
  /** Leads from before the run: put back as they were (filled gaps emptied again). */
  restored: number;
}

/**
 * Takes one RD import run back: the leads it created go (with their timeline
 * and any research ledger rows), and the leads that existed before get their
 * columns back from the run's `rd.import_batch` event, with the gaps the run
 * filled emptied again. Simulates unless `apply`. `rd_user_map` rows the run
 * added stay (a list of our own RD users, nothing about leads).
 */
export async function undoRdImportBatch(
  db: Database,
  input: { batchId: string; apply: boolean; actorEmployeeId?: string | null },
): Promise<UndoResult> {
  const created = await db
    .select({ id: leads.id })
    .from(leads)
    .where(eq(leads.importBatchId, input.batchId));
  const touched = await db
    .select({ id: leadEvents.id, leadId: leadEvents.leadId, detail: leadEvents.detail })
    .from(leadEvents)
    .where(
      and(
        eq(leadEvents.kind, 'rd.import_batch'),
        sql`${leadEvents.detail}->>'batchId' = ${input.batchId}`,
      ),
    );
  const createdIds = created.map((row) => row.id);
  const createdSet = new Set(createdIds);
  const restore = touched.filter((row) => !createdSet.has(row.leadId));
  const result: UndoResult = {
    applied: input.apply,
    batchId: input.batchId,
    created: createdIds.length,
    restored: restore.length,
  };
  if (!input.apply) return result;

  await db.transaction(async (tx) => {
    for (let index = 0; index < createdIds.length; index += 500) {
      const chunk = createdIds.slice(index, index + 500);
      await tx.delete(leadEvents).where(inArray(leadEvents.leadId, chunk));
      await tx.delete(leadEnrichmentLedger).where(inArray(leadEnrichmentLedger.leadId, chunk));
      await tx.delete(leads).where(inArray(leads.id, chunk));
    }
    for (const row of restore) {
      const detail = row.detail as { before?: Record<string, unknown>; filled?: string[] };
      const patch: Record<string, unknown> = {};
      for (const key of detail.filled ?? []) patch[key] = null;
      if ((detail.filled ?? []).includes('clientId')) {
        patch.clientId = WINGS_CLIENT_ID;
        patch.clientMapped = false;
      }
      for (const [key, value] of Object.entries(detail.before ?? {})) {
        patch[key] = DATE_KEYS.has(key) && typeof value === 'string' ? new Date(value) : value;
      }
      await tx
        .update(leads)
        .set({ ...(patch as Partial<LeadRow>), updatedAt: new Date() })
        .where(eq(leads.id, row.leadId));
      await tx.insert(leadEvents).values({
        leadId: row.leadId,
        kind: 'rd.import_batch_undone',
        detail: { batchId: input.batchId },
      });
    }
    await tx.insert(auditLog).values({
      actorEmployeeId: input.actorEmployeeId ?? null,
      action: 'leads.import_rd_undone',
      entity: 'lead_import_batch',
      entityId: input.batchId,
      metadata: { created: result.created, restored: result.restored },
    });
  });
  return result;
}
