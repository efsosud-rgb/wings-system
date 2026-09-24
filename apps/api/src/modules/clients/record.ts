import {
  CONSULTANT_AREAS,
  EMPTY_ADDRESS,
  clientCompleteness,
  grantedScope,
  maskCpf,
  type Actor,
  type ClientAddress,
  type ClientBusiness,
  type ClientCompany,
  type ClientContact,
  type ClientContactRole,
  type ClientContract,
  type ClientFranchise,
  type ClientPartner,
  type ClientRecord,
  type ClientSignature,
  type ExpansionEntry,
  type MaritalStatus,
  type PropertyRegime,
  clientBusinessSchema,
  clientCompanySchema,
  clientContactsSchema,
  clientContractsSchema,
  clientFranchiseSchema,
  clientPartnerInputSchema,
  clientSignatureSchema,
} from '@wings/shared';
import { and, asc, desc, eq, inArray, max, sql } from 'drizzle-orm';
import type { z } from 'zod';
import type { Database } from '../../db/client.js';
import {
  clientBusiness,
  clientContacts,
  clientContractConsultants,
  clientContracts,
  clientFranchisePlans,
  clientPartners,
  clientSignatures,
  clientUnitModels,
  clientWitnesses,
  clients,
  driveFolders,
  employees,
  leads,
  sectors,
} from '../../db/schema/index.js';
import { writeAudit } from '../../lib/audit.js';
import type { CpfCrypto } from '../../lib/cpf-crypto.js';
import { toClient } from './routes.js';

/**
 * The client's full record: read with the sensitive fields masked for who may
 * not see them, written block by block, every write on the audit trail by
 * field name (never by value). See `client-record.ts` in @wings/shared.
 */

type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];
type Writer = Database | Tx;

export interface RecordAccess {
  canEdit: boolean;
  canSeeSensitive: boolean;
}

export interface WriteContext {
  actor: Actor;
  ip: string;
  cpfCrypto: CpfCrypto;
  canSeeSensitive: boolean;
}

export type Failure =
  | { error: 'not_found'; status: 404; message: string }
  | { error: 'sensitive_forbidden'; status: 403; message: string }
  | { error: 'conflict'; status: 409; code: string; message: string }
  | { error: 'invalid'; status: 400; message: string };

const notFound: Failure = { error: 'not_found', status: 404, message: 'Cliente não encontrado.' };
const sensitiveForbidden: Failure = {
  error: 'sensitive_forbidden',
  status: 403,
  message: 'CPF, estado civil e regime de bens só podem ser preenchidos por Jurídico, Diretoria ou Admin Master.',
};
const invalid = (message: string): Failure => ({ error: 'invalid', status: 400, message });
const conflict = (code: string, message: string): Failure => ({ error: 'conflict', status: 409, code, message });

const addressOf = (value: unknown): ClientAddress => ({
  ...EMPTY_ADDRESS,
  ...(value && typeof value === 'object' ? (value as Partial<ClientAddress>) : {}),
});

/** The keys whose values differ: what the audit trail records, never the values. */
export function changedKeys(before: Record<string, unknown>, after: Record<string, unknown>): string[] {
  return Object.keys(after).filter(
    (key) => JSON.stringify(before[key] ?? null) !== JSON.stringify(after[key] ?? null),
  );
}

// --- read ------------------------------------------------------------------------

type ClientRow = typeof clients.$inferSelect;

export const companyOf = (row: ClientRow): ClientCompany => ({
  legalName: row.legalName,
  tradeName: row.tradeName,
  cnpj: row.cnpj,
  stateRegistration: row.stateRegistration,
  municipalRegistration: row.municipalRegistration,
  openedOn: row.openedOn,
  legalNature: row.legalNature,
  taxRegime: row.taxRegime as ClientCompany['taxRegime'],
  cnaeMain: row.cnaeMain,
  cnaeSecondary: Array.isArray(row.cnaeSecondary) ? row.cnaeSecondary : [],
  shareCapitalCents: row.shareCapitalCents,
  address: addressOf(row.address),
  phone: row.phone,
  email: row.email,
  website: row.website,
  social: (row.social ?? {}) as ClientCompany['social'],
});

const EMPTY_BUSINESS: ClientBusiness = {
  segment: null,
  description: null,
  operatingYears: null,
  ownUnits: null,
  revenueBand: null,
  averageTicketCents: null,
  employeesCount: null,
  inpiProcess: null,
  inpiClass: null,
  inpiStatus: null,
};

async function consultantOptions(db: Database) {
  const rows = await db
    .select({ id: employees.id, name: employees.fullName, sector: sectors.slug })
    .from(employees)
    .innerJoin(sectors, eq(sectors.id, employees.sectorId))
    .where(and(eq(employees.status, 'active'), inArray(sectors.slug, CONSULTANT_AREAS)))
    .orderBy(asc(employees.fullName));
  const options = Object.fromEntries(CONSULTANT_AREAS.map((area) => [area, [] as { id: string; name: string }[]]));
  for (const row of rows) options[row.sector]?.push({ id: row.id, name: row.name });
  return options as ClientRecord['consultantOptions'];
}

export async function loadRecord(
  db: Database,
  cpfCrypto: CpfCrypto,
  actor: Actor,
  clientId: string,
  access: RecordAccess,
): Promise<ClientRecord | null> {
  const row = await db.query.clients.findFirst({ where: eq(clients.id, clientId) });
  if (!row) return null;

  const [partnerRows, contactRows, businessRow, contractRows, planRow, unitRows, signatureRow, witnessRows, folder] =
    await Promise.all([
      db.select().from(clientPartners).where(eq(clientPartners.clientId, clientId)).orderBy(asc(clientPartners.position)),
      db.select().from(clientContacts).where(eq(clientContacts.clientId, clientId)),
      db.query.clientBusiness.findFirst({ where: eq(clientBusiness.clientId, clientId) }),
      db.select().from(clientContracts).where(eq(clientContracts.clientId, clientId)).orderBy(asc(clientContracts.position)),
      db.query.clientFranchisePlans.findFirst({ where: eq(clientFranchisePlans.clientId, clientId) }),
      db.select().from(clientUnitModels).where(eq(clientUnitModels.clientId, clientId)).orderBy(asc(clientUnitModels.position)),
      db.query.clientSignatures.findFirst({ where: eq(clientSignatures.clientId, clientId) }),
      db.select().from(clientWitnesses).where(eq(clientWitnesses.clientId, clientId)).orderBy(asc(clientWitnesses.position)),
      db.query.driveFolders.findFirst({
        where: and(eq(driveFolders.clientId, clientId), eq(driveFolders.slot, 'enviados')),
      }),
    ]);

  const consultantRows = contractRows.length
    ? await db
        .select()
        .from(clientContractConsultants)
        .where(inArray(clientContractConsultants.contractId, contractRows.map((c) => c.id)))
    : [];

  const masked = (encrypted: string | null) => {
    if (!encrypted || !access.canSeeSensitive) return null;
    try {
      return maskCpf(cpfCrypto.decrypt(encrypted));
    } catch {
      return null;
    }
  };

  const company = companyOf(row);
  const fullPartners = partnerRows.map((p) => ({
    id: p.id,
    position: p.position,
    name: p.name,
    cpfOnFile: p.cpfEncrypted !== null,
    rg: p.rg,
    rgIssuer: p.rgIssuer,
    nationality: p.nationality,
    profession: p.profession,
    maritalStatus: p.maritalStatus as MaritalStatus | null,
    propertyRegime: p.propertyRegime as PropertyRegime | null,
    address: addressOf(p.address),
    email: p.email,
    mobile: p.mobile,
    sharePercent: p.sharePercent === null ? null : Number(p.sharePercent),
    signsForCompany: p.signsForCompany,
    cpfEncrypted: p.cpfEncrypted,
  }));
  const partners: ClientPartner[] = fullPartners.map(({ cpfEncrypted, ...p }) => ({
    ...p,
    cpfMasked: masked(cpfEncrypted),
    maritalStatus: access.canSeeSensitive ? p.maritalStatus : null,
    propertyRegime: access.canSeeSensitive ? p.propertyRegime : null,
    restricted: !access.canSeeSensitive,
  }));

  const contacts: ClientContact[] = contactRows.map((c) => ({
    role: c.role as ClientContactRole,
    name: c.name,
    jobTitle: c.jobTitle,
    email: c.email,
    whatsapp: c.whatsapp,
  }));

  const business: ClientBusiness = businessRow
    ? {
        segment: businessRow.segment,
        description: businessRow.description,
        operatingYears: businessRow.operatingYears,
        ownUnits: businessRow.ownUnits,
        revenueBand: businessRow.revenueBand as ClientBusiness['revenueBand'],
        averageTicketCents: businessRow.averageTicketCents,
        employeesCount: businessRow.employeesCount,
        inpiProcess: businessRow.inpiProcess,
        inpiClass: businessRow.inpiClass,
        inpiStatus: businessRow.inpiStatus as ClientBusiness['inpiStatus'],
      }
    : EMPTY_BUSINESS;

  const contracts: ClientContract[] = contractRows.map((c) => ({
    id: c.id,
    service: c.service,
    number: c.number,
    signedOn: c.signedOn,
    valueCents: c.valueCents,
    paymentMethod: c.paymentMethod,
    installments: c.installments,
    startsOn: c.startsOn,
    termMonths: c.termMonths,
    leadId: c.leadId,
    consultants: Object.fromEntries(
      consultantRows.filter((k) => k.contractId === c.id).map((k) => [k.area, k.employeeId]),
    ) as ClientContract['consultants'],
  }));

  const franchise: ClientFranchise = {
    franchiseFeeCents: planRow?.franchiseFeeCents ?? null,
    royaltiesPercent: planRow?.royaltiesPercent === null || planRow?.royaltiesPercent === undefined ? null : Number(planRow.royaltiesPercent),
    adFundPercent: planRow?.adFundPercent === null || planRow?.adFundPercent === undefined ? null : Number(planRow.adFundPercent),
    initialInvestmentCents: planRow?.initialInvestmentCents ?? null,
    franchiseeProfile: planRow?.franchiseeProfile ?? null,
    unitModels: unitRows.map((u) => ({
      name: u.name,
      description: u.description,
      initialInvestmentCents: u.initialInvestmentCents,
      franchiseFeeCents: u.franchiseFeeCents,
      areaM2: u.areaM2,
    })),
  };

  const signature: ClientSignature = {
    signerPartnerId: signatureRow?.signerPartnerId ?? null,
    signingEmail: signatureRow?.signingEmail ?? null,
    signingMobile: signatureRow?.signingMobile ?? null,
    signatureType: (signatureRow?.signatureType ?? null) as ClientSignature['signatureType'],
    forum: signatureRow?.forum ?? null,
    witnesses: witnessRows.map((w) => ({
      id: w.id,
      name: w.name,
      cpfOnFile: w.cpfEncrypted !== null,
      cpfMasked: masked(w.cpfEncrypted),
      email: w.email,
    })),
  };

  const client = toClient(row);
  const completeness = clientCompleteness({
    company,
    partners: fullPartners,
    contacts,
    business,
    contracts,
    franchise,
    signature,
    expansionArea: client.expansionArea as ExpansionEntry[],
  });

  // Leads are personal data: listed only for who reads every lead.
  const leadOptions =
    grantedScope(actor, 'leads.read') === 'all'
      ? (
          await db
            .select({ id: leads.id, name: leads.name, createdAt: leads.createdAt })
            .from(leads)
            .where(eq(leads.clientId, clientId))
            .orderBy(desc(leads.createdAt))
            .limit(200)
        ).map((lead) => ({
          id: lead.id,
          label: `${lead.name ?? 'Lead sem nome'} — ${lead.createdAt.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' })}`,
        }))
      : null;

  return {
    client,
    company,
    partners,
    contacts,
    business,
    contracts,
    franchise,
    signature,
    completeness,
    documentsFolderId: folder?.id ?? null,
    access,
    consultantOptions: await consultantOptions(db),
    leadOptions,
  };
}

// --- write ------------------------------------------------------------------------

async function clientExists(db: Writer, clientId: string) {
  return (await db.query.clients.findFirst({ where: eq(clients.id, clientId), columns: { id: true } })) !== undefined;
}

const audit = (db: Writer, ctx: WriteContext, clientId: string, action: string, metadata: Record<string, unknown>) =>
  writeAudit(db, {
    actorEmployeeId: ctx.actor.employeeId,
    action,
    entity: 'client',
    entityId: clientId,
    ip: ctx.ip,
    metadata,
  });

type Ok<T = void> = { ok: true; value: T };
type Result<T = void> = Ok<T> | { ok: false; failure: Failure };
const ok = <T>(value: T): Ok<T> => ({ ok: true, value });
const fail = (failure: Failure) => ({ ok: false as const, failure });

export async function saveCompany(
  db: Database,
  ctx: WriteContext,
  clientId: string,
  input: z.output<typeof clientCompanySchema>,
): Promise<Result> {
  return db.transaction(async (tx) => {
    const row = await tx.query.clients.findFirst({ where: eq(clients.id, clientId) });
    if (!row) return fail(notFound);
    if (input.cnpj) {
      const holder = await tx.query.clients.findFirst({
        where: and(eq(clients.cnpj, input.cnpj), sql`${clients.id} <> ${clientId}`),
        columns: { name: true },
      });
      if (holder) return fail(conflict('cnpj_taken', `Este CNPJ já está no cadastro de ${holder.name}.`));
    }
    const fields = changedKeys(companyOf(row), input);
    await tx
      .update(clients)
      .set({ ...input, updatedAt: new Date() })
      .where(eq(clients.id, clientId));
    await audit(tx, ctx, clientId, 'client.company_updated', { fields });
    return ok(undefined);
  });
}

const sensitiveSent = (input: { cpf?: unknown; maritalStatus?: unknown; propertyRegime?: unknown }) =>
  input.cpf !== undefined || input.maritalStatus !== undefined || input.propertyRegime !== undefined;

type PartnerInput = z.output<typeof clientPartnerInputSchema>;

export async function savePartner(
  db: Database,
  ctx: WriteContext,
  clientId: string,
  partnerId: string | null,
  input: PartnerInput,
): Promise<Result<{ id: string }>> {
  if (sensitiveSent(input) && !ctx.canSeeSensitive) return fail(sensitiveForbidden);
  const cpfColumns =
    input.cpf === undefined
      ? {}
      : input.cpf === null
        ? { cpfEncrypted: null, cpfIndex: null }
        : { cpfEncrypted: ctx.cpfCrypto.encrypt(input.cpf), cpfIndex: ctx.cpfCrypto.index(input.cpf) };
  const values = {
    name: input.name,
    rg: input.rg,
    rgIssuer: input.rgIssuer,
    nationality: input.nationality,
    profession: input.profession,
    address: input.address,
    email: input.email,
    mobile: input.mobile,
    sharePercent: input.sharePercent,
    signsForCompany: input.signsForCompany,
    ...(input.maritalStatus !== undefined ? { maritalStatus: input.maritalStatus } : {}),
    ...(input.propertyRegime !== undefined ? { propertyRegime: input.propertyRegime } : {}),
    ...cpfColumns,
  };

  return db.transaction(async (tx) => {
    if (!(await clientExists(tx, clientId))) return fail(notFound);
    if ('cpfIndex' in cpfColumns && cpfColumns.cpfIndex) {
      const twin = await tx.query.clientPartners.findFirst({
        where: and(
          eq(clientPartners.clientId, clientId),
          eq(clientPartners.cpfIndex, cpfColumns.cpfIndex),
          partnerId ? sql`${clientPartners.id} <> ${partnerId}` : sql`true`,
        ),
        columns: { id: true },
      });
      if (twin) return fail(conflict('cpf_taken', 'Este CPF já é de outro sócio deste cliente.'));
    }

    if (partnerId === null) {
      const [last] = await tx
        .select({ position: max(clientPartners.position) })
        .from(clientPartners)
        .where(eq(clientPartners.clientId, clientId));
      const [made] = await tx
        .insert(clientPartners)
        .values({ clientId, position: (last?.position ?? 0) + 1, ...values })
        .returning({ id: clientPartners.id });
      if (!made) throw new Error('partner insert returned nothing');
      await audit(tx, ctx, clientId, 'client.partner_created', {
        partnerId: made.id,
        fields: Object.keys(values).filter((key) => key !== 'cpfIndex'),
      });
      return ok({ id: made.id });
    }

    const before = await tx.query.clientPartners.findFirst({
      where: and(eq(clientPartners.id, partnerId), eq(clientPartners.clientId, clientId)),
    });
    if (!before) return fail({ ...notFound, message: 'Sócio não encontrado.' });
    const fields = changedKeys(
      { ...before, address: addressOf(before.address), sharePercent: before.sharePercent === null ? null : Number(before.sharePercent) },
      values,
    ).filter((key) => key !== 'cpfIndex');
    await tx
      .update(clientPartners)
      .set({ ...values, updatedAt: new Date() })
      .where(eq(clientPartners.id, partnerId));
    await audit(tx, ctx, clientId, 'client.partner_updated', { partnerId, fields });
    return ok({ id: partnerId });
  });
}

export async function deletePartner(db: Database, ctx: WriteContext, clientId: string, partnerId: string): Promise<Result> {
  return db.transaction(async (tx) => {
    const [gone] = await tx
      .delete(clientPartners)
      .where(and(eq(clientPartners.id, partnerId), eq(clientPartners.clientId, clientId)))
      .returning({ id: clientPartners.id });
    if (!gone) return fail({ ...notFound, message: 'Sócio não encontrado.' });
    await audit(tx, ctx, clientId, 'client.partner_deleted', { partnerId });
    return ok(undefined);
  });
}

export async function saveContacts(
  db: Database,
  ctx: WriteContext,
  clientId: string,
  input: z.output<typeof clientContactsSchema>,
): Promise<Result> {
  return db.transaction(async (tx) => {
    if (!(await clientExists(tx, clientId))) return fail(notFound);
    const before = await tx.select().from(clientContacts).where(eq(clientContacts.clientId, clientId));
    await tx.delete(clientContacts).where(eq(clientContacts.clientId, clientId));
    if (input.contacts.length) {
      await tx.insert(clientContacts).values(input.contacts.map((contact) => ({ clientId, ...contact })));
    }
    const changed = [...new Set([...before.map((c) => c.role), ...input.contacts.map((c) => c.role)])].filter(
      (role) => {
        const old = before.find((c) => c.role === role);
        const now = input.contacts.find((c) => c.role === role);
        return changedKeys(old ?? {}, now ?? { name: null }).length > 0 || !old !== !now;
      },
    );
    await audit(tx, ctx, clientId, 'client.contacts_updated', { roles: changed });
    return ok(undefined);
  });
}

export async function saveBusiness(
  db: Database,
  ctx: WriteContext,
  clientId: string,
  input: z.output<typeof clientBusinessSchema>,
): Promise<Result> {
  return db.transaction(async (tx) => {
    if (!(await clientExists(tx, clientId))) return fail(notFound);
    const before = await tx.query.clientBusiness.findFirst({ where: eq(clientBusiness.clientId, clientId) });
    await tx
      .insert(clientBusiness)
      .values({ clientId, ...input })
      .onConflictDoUpdate({ target: clientBusiness.clientId, set: { ...input, updatedAt: new Date() } });
    await audit(tx, ctx, clientId, 'client.business_updated', { fields: changedKeys(before ?? EMPTY_BUSINESS, input) });
    return ok(undefined);
  });
}

export async function saveContracts(
  db: Database,
  ctx: WriteContext,
  clientId: string,
  input: z.output<typeof clientContractsSchema>,
): Promise<Result> {
  return db.transaction(async (tx) => {
    if (!(await clientExists(tx, clientId))) return fail(notFound);
    const existing = await tx.select().from(clientContracts).where(eq(clientContracts.clientId, clientId));
    const existingIds = new Set(existing.map((c) => c.id));
    for (const contract of input.contracts) {
      if (contract.id && !existingIds.has(contract.id)) return fail(invalid('Contrato não encontrado neste cliente.'));
    }
    const assigned = existing.length
      ? await tx
          .select()
          .from(clientContractConsultants)
          .where(inArray(clientContractConsultants.contractId, [...existingIds]))
      : [];

    // A consultant who already was on the contract stays valid; a new one must
    // be an active employee of that very area.
    const wanted = input.contracts.flatMap((contract) =>
      Object.entries(contract.consultants).map(([area, employeeId]) => ({ contractId: contract.id, area, employeeId })),
    );
    const fresh = wanted.filter(
      (item) =>
        !assigned.some((a) => a.contractId === item.contractId && a.area === item.area && a.employeeId === item.employeeId),
    );
    if (fresh.length) {
      const people = await tx
        .select({ id: employees.id, sector: sectors.slug })
        .from(employees)
        .innerJoin(sectors, eq(sectors.id, employees.sectorId))
        .where(and(inArray(employees.id, fresh.map((item) => item.employeeId as string)), eq(employees.status, 'active')));
      for (const item of fresh) {
        if (!people.some((p) => p.id === item.employeeId && p.sector === item.area)) {
          return fail(invalid('O consultor escolhido não é um funcionário ativo desta área.'));
        }
      }
    }

    const knownLeads = new Set(existing.map((c) => c.leadId).filter(Boolean));
    const newLeads = input.contracts.map((c) => c.leadId).filter((id): id is string => !!id && !knownLeads.has(id));
    if (newLeads.length) {
      const found = await tx
        .select({ id: leads.id })
        .from(leads)
        .where(and(inArray(leads.id, newLeads), eq(leads.clientId, clientId)));
      if (found.length !== new Set(newLeads).size) return fail(invalid('O lead de origem não é deste cliente.'));
    }

    const keep = new Set(input.contracts.map((c) => c.id).filter(Boolean));
    const removed = existing.filter((c) => !keep.has(c.id)).map((c) => c.id);
    if (removed.length) await tx.delete(clientContracts).where(inArray(clientContracts.id, removed));

    const fieldsChanged = new Set<string>();
    for (const [position, contract] of input.contracts.entries()) {
      const { id, consultants, ...values } = contract;
      let contractId = id;
      if (contractId) {
        const before = existing.find((c) => c.id === contractId);
        for (const key of changedKeys(before ?? {}, values)) fieldsChanged.add(key);
        await tx
          .update(clientContracts)
          .set({ ...values, position, updatedAt: new Date() })
          .where(eq(clientContracts.id, contractId));
        await tx.delete(clientContractConsultants).where(eq(clientContractConsultants.contractId, contractId));
      } else {
        const [made] = await tx
          .insert(clientContracts)
          .values({ clientId, position, ...values })
          .returning({ id: clientContracts.id });
        contractId = made?.id;
        for (const key of Object.keys(values)) fieldsChanged.add(key);
      }
      const before = assigned.filter((a) => a.contractId === id);
      if (
        JSON.stringify(Object.fromEntries(before.map((a) => [a.area, a.employeeId]))) !==
        JSON.stringify(consultants)
      ) {
        fieldsChanged.add('consultants');
      }
      const rows = Object.entries(consultants).map(([area, employeeId]) => ({
        contractId: contractId as string,
        area,
        employeeId: employeeId as string,
      }));
      if (rows.length) await tx.insert(clientContractConsultants).values(rows);
    }
    await audit(tx, ctx, clientId, 'client.contracts_updated', {
      count: input.contracts.length,
      removed: removed.length,
      fields: [...fieldsChanged],
    });
    return ok(undefined);
  });
}

export async function saveFranchise(
  db: Database,
  ctx: WriteContext,
  clientId: string,
  input: z.output<typeof clientFranchiseSchema>,
): Promise<Result> {
  return db.transaction(async (tx) => {
    if (!(await clientExists(tx, clientId))) return fail(notFound);
    const { unitModels, ...plan } = input;
    const before = await tx.query.clientFranchisePlans.findFirst({ where: eq(clientFranchisePlans.clientId, clientId) });
    const beforeUnits = await tx
      .select()
      .from(clientUnitModels)
      .where(eq(clientUnitModels.clientId, clientId))
      .orderBy(asc(clientUnitModels.position));
    await tx
      .insert(clientFranchisePlans)
      .values({ clientId, ...plan })
      .onConflictDoUpdate({ target: clientFranchisePlans.clientId, set: { ...plan, updatedAt: new Date() } });
    await tx.delete(clientUnitModels).where(eq(clientUnitModels.clientId, clientId));
    if (unitModels.length) {
      await tx.insert(clientUnitModels).values(unitModels.map((unit, position) => ({ clientId, position, ...unit })));
    }
    const fields = changedKeys(
      before
        ? { ...before, royaltiesPercent: before.royaltiesPercent === null ? null : Number(before.royaltiesPercent), adFundPercent: before.adFundPercent === null ? null : Number(before.adFundPercent) }
        : {},
      plan,
    );
    const unitsBefore = beforeUnits.map(({ name, description, initialInvestmentCents, franchiseFeeCents, areaM2 }) => ({
      name,
      description,
      initialInvestmentCents,
      franchiseFeeCents,
      areaM2,
    }));
    if (JSON.stringify(unitsBefore) !== JSON.stringify(unitModels)) fields.push('unitModels');
    await audit(tx, ctx, clientId, 'client.franchise_updated', { fields, unitModels: unitModels.length });
    return ok(undefined);
  });
}

export async function saveSignature(
  db: Database,
  ctx: WriteContext,
  clientId: string,
  input: z.output<typeof clientSignatureSchema>,
): Promise<Result> {
  if (input.witnesses.some((w) => w.cpf !== undefined) && !ctx.canSeeSensitive) return fail(sensitiveForbidden);
  return db.transaction(async (tx) => {
    if (!(await clientExists(tx, clientId))) return fail(notFound);
    const { witnesses, ...values } = input;
    if (values.signerPartnerId) {
      const partner = await tx.query.clientPartners.findFirst({
        where: and(eq(clientPartners.id, values.signerPartnerId), eq(clientPartners.clientId, clientId)),
        columns: { id: true },
      });
      if (!partner) return fail(invalid('Quem assina precisa ser um sócio deste cliente.'));
    }
    const before = await tx.query.clientSignatures.findFirst({ where: eq(clientSignatures.clientId, clientId) });
    const existing = await tx.select().from(clientWitnesses).where(eq(clientWitnesses.clientId, clientId));
    for (const witness of witnesses) {
      if (witness.id && !existing.some((w) => w.id === witness.id)) return fail(invalid('Testemunha não encontrada.'));
    }

    await tx
      .insert(clientSignatures)
      .values({ clientId, ...values })
      .onConflictDoUpdate({ target: clientSignatures.clientId, set: { ...values, updatedAt: new Date() } });

    // Witnesses are replaced; one that keeps its id and sends no CPF keeps the CPF it had.
    const keep = new Set(witnesses.map((w) => w.id).filter(Boolean));
    const removed = existing.filter((w) => !keep.has(w.id)).map((w) => w.id);
    if (removed.length) await tx.delete(clientWitnesses).where(inArray(clientWitnesses.id, removed));
    for (const [position, witness] of witnesses.entries()) {
      const cpf =
        witness.cpf === undefined
          ? {}
          : witness.cpf === null
            ? { cpfEncrypted: null, cpfIndex: null }
            : { cpfEncrypted: ctx.cpfCrypto.encrypt(witness.cpf), cpfIndex: ctx.cpfCrypto.index(witness.cpf) };
      const row = { position, name: witness.name, email: witness.email, ...cpf };
      if (witness.id) await tx.update(clientWitnesses).set(row).where(eq(clientWitnesses.id, witness.id));
      else await tx.insert(clientWitnesses).values({ clientId, ...row });
    }

    await audit(tx, ctx, clientId, 'client.signature_updated', {
      fields: changedKeys(before ?? {}, values),
      witnesses: witnesses.length,
      witnessCpfsWritten: witnesses.filter((w) => w.cpf !== undefined).length,
    });
    return ok(undefined);
  });
}

/** The full CPF of a partner or witness: its own permission, always audited, never in a URL. */
export async function revealCpf(
  db: Database,
  ctx: WriteContext,
  clientId: string,
  kind: 'partner' | 'witness',
  id: string,
): Promise<Result<{ cpf: string }>> {
  const table = kind === 'partner' ? clientPartners : clientWitnesses;
  const [row] = await db
    .select({ cpfEncrypted: table.cpfEncrypted })
    .from(table)
    .where(and(eq(table.id, id), eq(table.clientId, clientId)));
  if (!row?.cpfEncrypted) return fail({ ...notFound, message: 'CPF não encontrado.' });
  let cpf: string;
  try {
    cpf = ctx.cpfCrypto.decrypt(row.cpfEncrypted);
  } catch {
    return fail({ ...notFound, message: 'CPF não encontrado.' });
  }
  await audit(db, ctx, clientId, 'client.cpf_revealed', { kind, id });
  return ok({ cpf });
}

