import {
  CSV_HEADER_ALIASES,
  CSV_IMPORT_FIELDS,
  CSV_IMPORT_MAX_ROWS,
  csvHeaderKey,
  isValidCnpj,
  LEAD_OUTCOME_LABELS,
  LEAD_PIPELINE_LABELS,
  LEAD_SOURCE_LABELS,
  normalizeBrazilianPhone,
  normalizeEmail,
  parseCsv,
  pipelineOfRdFunnel,
  toCsv,
  WINGS_CLIENT_ID,
  type CsvImportField,
  type CsvImportPreview,
  type CsvImportReport,
  type CsvPreviewRow,
  type LeadListItem,
  type LeadPipeline,
} from '@wings/shared';
import { asc, eq, or } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import type { Database } from '../../db/client.js';
import { employees, leads } from '../../db/schema/index.js';
import { addNote, changeLead, ensureStage, type Executor } from './crm.js';
import { brandsOnSale } from './deal.js';
import { upsertLead, type LeadListFilter, listLeads } from './service.js';

/**
 * The Funil's spreadsheet door (CRM núcleo). Import: the file is parsed, each
 * column mapped to a field (guessed from the header, changed by the person),
 * every row checked and shown before anything is written; the write goes
 * through `upsertLead`, so a person the system already has joins their lead
 * instead of making a twin, and the whole run carries one `import_batch_id`.
 * Export: the list as filtered, in the caller's scope, as a `;` CSV Excel
 * opens. The audit entry of either carries counts, never a row.
 */

// --- mapping ----------------------------------------------------------------------------

const aliasIndex = new Map<string, CsvImportField>();
for (const field of CSV_IMPORT_FIELDS) {
  for (const alias of CSV_HEADER_ALIASES[field]) aliasIndex.set(csvHeaderKey(alias), field);
}

/** Header -> field, by the aliases; a header nothing matches is left out. */
export function suggestMapping(headers: readonly string[]): Record<string, CsvImportField> {
  const mapping: Record<string, CsvImportField> = {};
  const used = new Set<CsvImportField>();
  for (const header of headers) {
    const field = aliasIndex.get(csvHeaderKey(header));
    if (field && !used.has(field)) {
      mapping[header] = field;
      used.add(field);
    }
  }
  return mapping;
}

// --- rows -------------------------------------------------------------------------------

export interface ParsedRow {
  line: number;
  values: Record<CsvImportField, string>;
  errors: string[];
  /** The key another row of the file already used (phone first, else e-mail). */
  repeatOf: number | null;
}

/** Brazilian money as typed: "R$ 1.234,56", "1234.56", "1234" -> cents. */
export function parseMoneyCents(text: string): number | null {
  const raw = text.replace(/[R$\s]/g, '');
  if (!raw) return null;
  const normalized =
    raw.includes(',') && raw.lastIndexOf(',') > raw.lastIndexOf('.')
      ? raw.replace(/\./g, '').replace(',', '.')
      : raw.replace(/,/g, '');
  const value = Number(normalized);
  if (!Number.isFinite(value) || value < 0) return null;
  return Math.round(value * 100);
}

export function pipelineOfText(text: string): LeadPipeline | null {
  return pipelineOfRdFunnel(text);
}

export function parseRows(
  text: string,
  mapping: Record<string, CsvImportField>,
): { headers: string[]; rows: ParsedRow[]; truncated: boolean } {
  const table = parseCsv(text);
  const headers = (table[0] ?? []).map((header) => header.trim());
  const columns = new Map<number, CsvImportField>();
  headers.forEach((header, index) => {
    const field = mapping[header];
    if (field) columns.set(index, field);
  });
  const body = table.slice(1);
  const truncated = body.length > CSV_IMPORT_MAX_ROWS;
  const seen = new Map<string, number>();
  const rows: ParsedRow[] = body.slice(0, CSV_IMPORT_MAX_ROWS).map((cells, index) => {
    const line = index + 2;
    const values = Object.fromEntries(CSV_IMPORT_FIELDS.map((field) => [field, ''])) as Record<
      CsvImportField,
      string
    >;
    for (const [column, field] of columns) values[field] = (cells[column] ?? '').trim();
    const errors: string[] = [];
    const email = normalizeEmail(values.email);
    const phone = normalizeBrazilianPhone(values.phone);
    if (values.email && !email) errors.push('E-mail inválido');
    if (values.phone && !phone) errors.push('Telefone inválido (use DDD + número)');
    if (!email && !phone) errors.push('Sem e-mail nem telefone válido');
    if (values.cnpj && !isValidCnpj(values.cnpj)) errors.push('CNPJ inválido');
    if (values.value && parseMoneyCents(values.value) === null) errors.push('Valor inválido');
    if (values.pipeline && !pipelineOfText(values.pipeline))
      errors.push('Funil desconhecido (use Expansão ou Formatação)');
    if (values.owner && !normalizeEmail(values.owner))
      errors.push('Dono: informe o e-mail do vendedor');
    // A row repeats another when either key was already used in the file.
    const keys = [phone ? `p:${phone}` : null, email ? `e:${email}` : null].filter(
      (key): key is string => key !== null,
    );
    let repeatOf: number | null = null;
    for (const key of keys) {
      const first = seen.get(key);
      if (first !== undefined && repeatOf === null) repeatOf = first;
    }
    if (repeatOf === null) for (const key of keys) seen.set(key, line);
    return { line, values, errors, repeatOf };
  });
  return { headers, rows, truncated };
}

// --- preview ------------------------------------------------------------------------------

export const PREVIEW_SAMPLE = 20;

export async function previewImport(
  db: Executor,
  input: { csv: string; mapping?: Record<string, CsvImportField> },
): Promise<CsvImportPreview> {
  const table = parseCsv(input.csv);
  const headers = (table[0] ?? []).map((header) => header.trim());
  const suggestedMapping = suggestMapping(headers);
  const mapping =
    input.mapping && Object.keys(input.mapping).length > 0 ? input.mapping : suggestedMapping;
  const { rows } = parseRows(input.csv, mapping);
  const sample: CsvPreviewRow[] = [];
  let existing = 0;
  for (const row of rows) {
    let matchesLeadId: string | null = null;
    if (row.errors.length === 0 && row.repeatOf === null) {
      const found = await existingLeadOf(db, row.values);
      if (found) {
        existing++;
        matchesLeadId = found;
      }
    }
    if (sample.length < PREVIEW_SAMPLE)
      sample.push({ line: row.line, values: row.values, errors: row.errors, matchesLeadId });
  }
  const invalid = rows.filter((row) => row.errors.length > 0).length;
  const repeated = rows.filter((row) => row.errors.length === 0 && row.repeatOf !== null).length;
  return {
    headers,
    suggestedMapping,
    rows: rows.length,
    valid: rows.length - invalid - repeated,
    invalid,
    existing,
    repeated,
    sample,
  };
}

async function existingLeadOf(db: Executor, values: Record<CsvImportField, string>) {
  const phone = normalizeBrazilianPhone(values.phone);
  const email = normalizeEmail(values.email);
  const conditions = [
    phone ? eq(leads.phone, phone) : undefined,
    email ? eq(leads.email, email) : undefined,
  ].filter((condition): condition is NonNullable<typeof condition> => Boolean(condition));
  if (conditions.length === 0) return null;
  const row = await db.query.leads.findFirst({
    where: conditions.length === 1 ? conditions[0] : or(...conditions),
    orderBy: asc(leads.createdAt),
    columns: { id: true },
  });
  return row?.id ?? null;
}

// --- import ---------------------------------------------------------------------------------

export interface ImportInput {
  csv: string;
  mapping: Record<string, CsvImportField>;
  pipeline?: LeadPipeline;
  brandClientId?: string;
  ownerEmployeeId?: string | null;
  actorEmployeeId: string;
}

export async function runImport(db: Database, input: ImportInput): Promise<CsvImportReport> {
  const { rows, truncated } = parseRows(input.csv, input.mapping);
  const batchId = randomUUID();
  const report: CsvImportReport = {
    batchId,
    rows: rows.length,
    created: 0,
    matched: 0,
    skipped: 0,
    errors: [],
  };
  if (truncated)
    report.errors.push({
      line: CSV_IMPORT_MAX_ROWS + 2,
      message: `Só as primeiras ${CSV_IMPORT_MAX_ROWS} linhas foram lidas.`,
    });

  const brands = await brandsOnSale(db);
  const brandByKey = new Map(brands.map((brand) => [csvHeaderKey(brand.name), brand]));
  const defaultBrand = input.brandClientId
    ? brands.find((brand) => brand.clientId === input.brandClientId)
    : undefined;
  const sellers = await db
    .select({ id: employees.id, email: employees.email })
    .from(employees)
    .where(eq(employees.status, 'active'));
  const sellerByEmail = new Map(sellers.map((seller) => [seller.email.toLowerCase(), seller.id]));
  const stageCache = new Map<string, { id: string; name: string; position: number }>();

  for (const row of rows) {
    if (row.errors.length > 0) {
      report.skipped++;
      report.errors.push({ line: row.line, message: row.errors.join('; ') });
      continue;
    }
    if (row.repeatOf !== null) {
      report.skipped++;
      report.errors.push({
        line: row.line,
        message: `Repete a linha ${row.repeatOf} (mesmo telefone ou e-mail).`,
      });
      continue;
    }
    const values = row.values;
    const pipeline = pipelineOfText(values.pipeline) ?? input.pipeline ?? null;
    const brand = values.brand ? brandByKey.get(csvHeaderKey(values.brand)) : undefined;
    if (values.brand && !brand) {
      report.skipped++;
      report.errors.push({
        line: row.line,
        message: `Marca "${values.brand.slice(0, 40)}" não está na lista de marcas de interesse.`,
      });
      continue;
    }
    const chosenBrand = brand ?? defaultBrand;
    let owner: string | null = input.ownerEmployeeId ?? null;
    if (values.owner) {
      const found = sellerByEmail.get(values.owner.toLowerCase());
      if (!found) {
        report.skipped++;
        report.errors.push({
          line: row.line,
          message: 'Dono não encontrado entre os funcionários ativos.',
        });
        continue;
      }
      owner = found;
    }
    const result = await upsertLead(db, {
      source: 'csv_import',
      name: values.name || null,
      email: values.email || null,
      phone: values.phone || null,
      clientId: chosenBrand?.clientId ?? WINGS_CLIENT_ID,
      clientMapped: Boolean(chosenBrand),
      brand: chosenBrand?.name ?? null,
      pipeline,
      city: values.city || null,
      company: values.company
        ? { name: values.company, cnpj: values.cnpj || null, city: values.city || null }
        : null,
      valueCents: values.value ? parseMoneyCents(values.value) : null,
      ownerEmployeeId: owner,
      legalBasis: 'legitimate_interest',
      consentedAt: new Date(),
      consentSource: 'csv_import',
      consentText: 'Planilha importada no Wings System',
      importBatchId: batchId,
      skipResearch: true,
      distribute: false,
      event: {
        kind: 'lead.imported.csv',
        actorEmployeeId: input.actorEmployeeId,
        detail: { batchId, line: row.line },
      },
    });
    if (result.created) report.created++;
    else report.matched++;
    // A stage named in the file: found (or made) in the funnel's list, set only on a lead that has none.
    if (result.created && values.stage && pipeline) {
      const key = `${pipeline}|${values.stage.toLowerCase()}`;
      let stage = stageCache.get(key);
      if (!stage) {
        stage = await ensureStage(db, { pipeline, name: values.stage });
        stageCache.set(key, stage);
      }
      await changeLead(db, {
        leadId: result.lead.id,
        stageId: stage.id,
        source: 'import',
        actorEmployeeId: input.actorEmployeeId,
      });
    }
    if (values.note) {
      await addNote(db, {
        leadId: result.lead.id,
        body: values.note.slice(0, 4000),
        authorEmployeeId: input.actorEmployeeId,
      });
    }
  }
  return report;
}

// --- export -----------------------------------------------------------------------------

export const EXPORT_HEADERS = [
  'Nome',
  'Telefone',
  'E-mail',
  'Empresa',
  'Cidade',
  'Funil',
  'Marca / cliente',
  'Etapa',
  'Situação',
  'Valor estimado (R$)',
  'Dono',
  'Origem',
  'Chegou em',
  'Na etapa desde',
] as const;

const money = (cents: number | null) =>
  cents === null ? '' : (cents / 100).toFixed(2).replace('.', ',');
const when = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }) : '';

export function leadsToCsv(items: readonly LeadListItem[]): string {
  const rows = items.map((lead) => [
    lead.name ?? '',
    lead.phone ?? '',
    lead.email ?? '',
    lead.companyName ?? '',
    lead.city ?? '',
    lead.pipeline ? LEAD_PIPELINE_LABELS[lead.pipeline] : '',
    lead.clientMapped ? lead.clientName : (lead.brand ?? ''),
    lead.stage ?? '',
    LEAD_OUTCOME_LABELS[lead.won === true ? 'won' : lead.won === false ? 'lost' : 'open'],
    money(lead.valueCents),
    lead.ownerName ?? '',
    LEAD_SOURCE_LABELS[lead.source],
    when(lead.createdAt),
    when(lead.stageChangedAt),
  ]);
  return `﻿${toCsv([EXPORT_HEADERS as unknown as string[], ...rows])}`;
}

export async function exportLeads(db: Database, filter: LeadListFilter, limit: number) {
  const listed = await listLeads(db, filter, limit);
  return { csv: leadsToCsv(listed.leads), count: listed.leads.length, total: listed.total };
}
