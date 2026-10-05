import {
  CSV_EXPORT_MAX_ROWS,
  crmBrandCreateSchema,
  crmBrandUpdateSchema,
  crmCompanyInputSchema,
  crmCompanyUpdateSchema,
  crmContactInputSchema,
  crmContactUpdateSchema,
  crmMergeSchema,
  crmSearchQuerySchema,
  csvImportRequestSchema,
  grantedScope,
  isValidCnpj,
  leadActivityCreateSchema,
  leadContactLinkSchema,
  leadDealUpdateSchema,
  leadListQuerySchema,
  type CrmBrand,
} from '@wings/shared';
import { eq } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { employees, leads } from '../../db/schema/index.js';
import { writeAudit } from '../../lib/audit.js';
import { addActivity } from './activities.js';
import {
  companyOf,
  companyToClient,
  contactOf,
  contactVisibleTo,
  contactsOfCompany,
  duplicateCompanies,
  duplicateContacts,
  findOrCreateCompany,
  findOrCreateContact,
  leadsOfCompany,
  leadsOfContact,
  linkContact,
  listCompanies,
  listContacts,
  mergeCompanies,
  mergeContacts,
  unlinkContact,
  updateCompany,
  updateContact,
} from './contacts.js';
import { exportLeads, previewImport, runImport } from './csv.js';
import { brandsOnSale, changeDeal, createBrand, listBrands, setBrandOnSale } from './deal.js';
import { loadLead } from './service.js';

const idParam = z.object({ id: z.uuid() });
const twoIds = z.object({ id: z.uuid(), contactId: z.uuid() });
const invalid = (message?: string) => ({
  error: 'invalid_request',
  message: message ?? 'Dados inválidos',
});
const notFound = (what = 'Lead') => ({ error: 'not_found', message: `${what} não encontrado.` });

const MERGE_MESSAGES = {
  not_found: 'Registro não encontrado.',
  same: 'Escolha dois registros diferentes.',
  merged: 'Um dos registros já foi mesclado.',
} as const;

/**
 * CRM núcleo (05/10/2026): contacts and companies, calls and meetings, the
 * deal's value and brand of interest, the brand list and the CSV door.
 * Reading is `leads.read` in the caller's scope (a seller sees the contacts
 * of their own leads); writing is `leads.write`; merging and the brand list
 * are `crm.manage`; turning a company into a client is `clients.manage`.
 */
export const nucleoRoutes: FastifyPluginAsync = async (app) => {
  const { db } = app.wings;
  type Req = Parameters<typeof app.can>[0];

  const ownScope = (request: Req, permission: 'leads.read' | 'leads.write') =>
    grantedScope(request.session.actor, permission) === 'own'
      ? request.session.actor.employeeId
      : undefined;

  async function visibleLead(request: Req, id: string, permission: 'leads.read' | 'leads.write') {
    const row = await db.query.leads.findFirst({ where: eq(leads.id, id) });
    if (!row) return null;
    const own = ownScope(request, permission);
    return own === undefined || row.ownerEmployeeId === own ? row : null;
  }

  const read = { preHandler: app.requirePermission('leads.read') };
  const write = { preHandler: app.requirePermission('leads.write') };
  const manage = { preHandler: app.requirePermission('crm.manage') };

  // --- contacts ---------------------------------------------------------------------------

  app.get('/crm/contacts', read, async (request, reply) => {
    const query = crmSearchQuerySchema.safeParse(request.query);
    if (!query.success) return reply.status(400).send(invalid());
    const own = ownScope(request, 'leads.read');
    if (query.data.duplicates) {
      if (own !== undefined) return reply.send({ contacts: [], duplicates: [] });
      return reply.send({ contacts: [], duplicates: await duplicateContacts(db) });
    }
    return reply.send({
      contacts: await listContacts(db, { q: query.data.q, ownerEmployeeId: own }),
      duplicates: [],
    });
  });

  app.post('/crm/contacts', write, async (request, reply) => {
    const body = crmContactInputSchema.safeParse(request.body);
    if (!body.success) return reply.status(400).send(invalid(body.error.issues[0]?.message));
    const actor = request.session.actor.employeeId;
    const companyId = await resolveCompany(body.data, actor);
    if (companyId === 'not_found')
      return reply.status(400).send(invalid('Empresa não encontrada.'));
    const found = await db.transaction((tx) =>
      findOrCreateContact(
        tx,
        { ...body.data, companyId: companyId ?? body.data.companyId ?? null },
        actor,
      ),
    );
    if (!found) return reply.status(400).send(invalid('Informe um e-mail ou um telefone válido.'));
    await writeAudit(db, {
      actorEmployeeId: actor,
      action: found.created ? 'crm_contact.created' : 'crm_contact.found',
      entity: 'crm_contact',
      entityId: found.contact.id,
      ip: request.ip,
    });
    return reply.status(found.created ? 201 : 200).send({
      contact: await contactOf(db, found.contact.id),
      created: found.created,
    });
  });

  app.get('/crm/contacts/:id', read, async (request, reply) => {
    const params = idParam.safeParse(request.params);
    if (!params.success) return reply.status(400).send(invalid());
    const own = ownScope(request, 'leads.read');
    const contact = await contactOf(db, params.data.id);
    if (!contact || (own !== undefined && !(await contactVisibleTo(db, contact.id, own))))
      return reply.status(404).send(notFound('Contato'));
    return reply.send({ contact, leads: await leadsOfContact(db, contact.id, own) });
  });

  app.patch('/crm/contacts/:id', write, async (request, reply) => {
    const params = idParam.safeParse(request.params);
    const body = crmContactUpdateSchema.safeParse(request.body);
    if (!params.success || !body.success)
      return reply
        .status(400)
        .send(invalid(body.success ? undefined : body.error.issues[0]?.message));
    const own = ownScope(request, 'leads.write');
    if (own !== undefined && !(await contactVisibleTo(db, params.data.id, own)))
      return reply.status(404).send(notFound('Contato'));
    const actor = request.session.actor.employeeId;
    const companyId = await resolveCompany(body.data, actor);
    if (companyId === 'not_found')
      return reply.status(400).send(invalid('Empresa não encontrada.'));
    const result = await updateContact(db, params.data.id, {
      ...body.data,
      ...(companyId !== undefined ? { companyId } : {}),
    });
    if (!result.ok) {
      const messages = {
        not_found: 'Contato não encontrado.',
        email_taken: 'Já existe um contato com este e-mail. Use "Mesclar" para juntar os dois.',
        phone_taken: 'Já existe um contato com este telefone. Use "Mesclar" para juntar os dois.',
        no_key: 'O contato precisa de um e-mail ou um telefone.',
      } as const;
      return reply
        .status(result.reason === 'not_found' ? 404 : 409)
        .send({ error: result.reason, message: messages[result.reason] });
    }
    await writeAudit(db, {
      actorEmployeeId: actor,
      action: 'crm_contact.updated',
      entity: 'crm_contact',
      entityId: result.contact.id,
      ip: request.ip,
      metadata: { fields: Object.keys(body.data) },
    });
    return reply.send({ contact: await contactOf(db, result.contact.id) });
  });

  app.post('/crm/contacts/merge', manage, async (request, reply) => {
    const body = crmMergeSchema.safeParse(request.body);
    if (!body.success) return reply.status(400).send(invalid(body.error.issues[0]?.message));
    const actor = request.session.actor.employeeId;
    const result = await mergeContacts(db, { ...body.data, actorEmployeeId: actor });
    if (!result.ok)
      return reply
        .status(result.reason === 'not_found' ? 404 : 409)
        .send({ error: result.reason, message: MERGE_MESSAGES[result.reason] });
    await writeAudit(db, {
      actorEmployeeId: actor,
      action: 'crm_contact.merged',
      entity: 'crm_contact',
      entityId: body.data.intoId,
      ip: request.ip,
      metadata: { fromId: body.data.fromId },
    });
    return reply.send({ contact: await contactOf(db, body.data.intoId) });
  });

  /** The company named by id or by name on a contact form: its id, null to detach, undefined when untouched. */
  async function resolveCompany(
    input: { companyId?: string | null; companyName?: string },
    actor: string,
  ): Promise<string | null | undefined | 'not_found'> {
    if (input.companyName) {
      const found = await db.transaction((tx) =>
        findOrCreateCompany(tx, { name: input.companyName! }, actor),
      );
      return found?.company.id ?? 'not_found';
    }
    if (input.companyId === undefined) return undefined;
    if (input.companyId === null) return null;
    return (await companyOf(db, input.companyId)) ? input.companyId : 'not_found';
  }

  // --- the lead's contacts --------------------------------------------------------------------

  app.post('/leads/:id/contacts', write, async (request, reply) => {
    const params = idParam.safeParse(request.params);
    const body = leadContactLinkSchema.safeParse(request.body);
    if (!params.success || !body.success)
      return reply
        .status(400)
        .send(invalid(body.success ? undefined : body.error.issues[0]?.message));
    const row = await visibleLead(request, params.data.id, 'leads.write');
    if (!row) return reply.status(404).send(notFound());
    const actor = request.session.actor.employeeId;
    let contactId = body.data.contactId ?? null;
    if (!contactId && body.data.contact) {
      const companyId = await resolveCompany(body.data.contact, actor);
      if (companyId === 'not_found')
        return reply.status(400).send(invalid('Empresa não encontrada.'));
      const found = await db.transaction((tx) =>
        findOrCreateContact(
          tx,
          { ...body.data.contact, companyId: companyId ?? row.companyId ?? null },
          actor,
        ),
      );
      if (!found)
        return reply.status(400).send(invalid('Informe um e-mail ou um telefone válido.'));
      contactId = found.contact.id;
    }
    if (!contactId) return reply.status(400).send(invalid('Informe o contato.'));
    if (!(await contactOf(db, contactId))) return reply.status(404).send(notFound('Contato'));
    await db.transaction((tx) =>
      linkContact(tx, {
        leadId: row.id,
        contactId: contactId!,
        primary: body.data.primary,
        actorEmployeeId: actor,
      }),
    );
    await writeAudit(db, {
      actorEmployeeId: actor,
      action: 'lead.contact_linked',
      entity: 'lead',
      entityId: row.id,
      ip: request.ip,
      metadata: { contactId },
    });
    return reply.status(201).send(await loadLead(db, row.id));
  });

  app.delete('/leads/:id/contacts/:contactId', write, async (request, reply) => {
    const params = twoIds.safeParse(request.params);
    if (!params.success) return reply.status(400).send(invalid());
    const row = await visibleLead(request, params.data.id, 'leads.write');
    if (!row) return reply.status(404).send(notFound());
    const actor = request.session.actor.employeeId;
    const removed = await db.transaction((tx) =>
      unlinkContact(tx, {
        leadId: row.id,
        contactId: params.data.contactId,
        actorEmployeeId: actor,
      }),
    );
    if (!removed) return reply.status(404).send(notFound('Contato'));
    await writeAudit(db, {
      actorEmployeeId: actor,
      action: 'lead.contact_unlinked',
      entity: 'lead',
      entityId: row.id,
      ip: request.ip,
      metadata: { contactId: params.data.contactId },
    });
    return reply.send(await loadLead(db, row.id));
  });

  // --- companies ----------------------------------------------------------------------------

  app.get('/crm/companies', read, async (request, reply) => {
    const query = crmSearchQuerySchema.safeParse(request.query);
    if (!query.success) return reply.status(400).send(invalid());
    if (query.data.duplicates) {
      if (ownScope(request, 'leads.read') !== undefined)
        return reply.send({ companies: [], duplicates: [] });
      return reply.send({ companies: [], duplicates: await duplicateCompanies(db) });
    }
    return reply.send({ companies: await listCompanies(db, { q: query.data.q }), duplicates: [] });
  });

  app.post('/crm/companies', write, async (request, reply) => {
    const body = crmCompanyInputSchema.safeParse(request.body);
    if (!body.success) return reply.status(400).send(invalid(body.error.issues[0]?.message));
    if (body.data.cnpj && !isValidCnpj(body.data.cnpj))
      return reply.status(400).send(invalid('CNPJ inválido.'));
    const actor = request.session.actor.employeeId;
    const found = await db.transaction((tx) => findOrCreateCompany(tx, body.data, actor));
    if (!found) return reply.status(400).send(invalid('Informe o nome da empresa.'));
    await writeAudit(db, {
      actorEmployeeId: actor,
      action: found.created ? 'crm_company.created' : 'crm_company.found',
      entity: 'crm_company',
      entityId: found.company.id,
      ip: request.ip,
    });
    return reply
      .status(found.created ? 201 : 200)
      .send({ company: await companyOf(db, found.company.id), created: found.created });
  });

  app.get('/crm/companies/:id', read, async (request, reply) => {
    const params = idParam.safeParse(request.params);
    if (!params.success) return reply.status(400).send(invalid());
    const company = await companyOf(db, params.data.id);
    if (!company) return reply.status(404).send(notFound('Empresa'));
    const own = ownScope(request, 'leads.read');
    const [related, contacts] = await Promise.all([
      leadsOfCompany(db, company.id, own),
      contactsOfCompany(db, company.id),
    ]);
    // A seller sees a company through their own leads only.
    if (own !== undefined && related.length === 0)
      return reply.status(404).send(notFound('Empresa'));
    return reply.send({ company, leads: related, contacts });
  });

  app.patch('/crm/companies/:id', write, async (request, reply) => {
    const params = idParam.safeParse(request.params);
    const body = crmCompanyUpdateSchema.safeParse(request.body);
    if (!params.success || !body.success)
      return reply
        .status(400)
        .send(invalid(body.success ? undefined : body.error.issues[0]?.message));
    const own = ownScope(request, 'leads.write');
    if (own !== undefined && (await leadsOfCompany(db, params.data.id, own)).length === 0)
      return reply.status(404).send(notFound('Empresa'));
    const result = await updateCompany(db, params.data.id, body.data);
    if (!result.ok) {
      const messages = {
        not_found: 'Empresa não encontrada.',
        cnpj_taken: 'Já existe uma empresa com este CNPJ. Use "Mesclar" para juntar as duas.',
        name_taken: 'Já existe uma empresa com este nome. Use "Mesclar" para juntar as duas.',
        invalid_cnpj: 'CNPJ inválido.',
      } as const;
      const status =
        result.reason === 'not_found' ? 404 : result.reason === 'invalid_cnpj' ? 400 : 409;
      return reply.status(status).send({ error: result.reason, message: messages[result.reason] });
    }
    await writeAudit(db, {
      actorEmployeeId: request.session.actor.employeeId,
      action: 'crm_company.updated',
      entity: 'crm_company',
      entityId: result.company.id,
      ip: request.ip,
      metadata: { fields: Object.keys(body.data) },
    });
    return reply.send({ company: await companyOf(db, result.company.id) });
  });

  app.post('/crm/companies/merge', manage, async (request, reply) => {
    const body = crmMergeSchema.safeParse(request.body);
    if (!body.success) return reply.status(400).send(invalid(body.error.issues[0]?.message));
    const actor = request.session.actor.employeeId;
    const result = await mergeCompanies(db, { ...body.data, actorEmployeeId: actor });
    if (!result.ok)
      return reply
        .status(result.reason === 'not_found' ? 404 : 409)
        .send({ error: result.reason, message: MERGE_MESSAGES[result.reason] });
    await writeAudit(db, {
      actorEmployeeId: actor,
      action: 'crm_company.merged',
      entity: 'crm_company',
      entityId: body.data.intoId,
      ip: request.ip,
      metadata: { fromId: body.data.fromId },
    });
    return reply.send({ company: await companyOf(db, body.data.intoId) });
  });

  /** "Virar cliente": the company joins the Formatação register (Novo cliente's path). */
  app.post(
    '/crm/companies/:id/client',
    { preHandler: app.requirePermission('clients.manage') },
    async (request, reply) => {
      const params = idParam.safeParse(request.params);
      const body = z
        .object({ relationship: z.enum(['formatacao', 'expansao', 'ambos']).default('formatacao') })
        .safeParse(request.body ?? {});
      if (!params.success || !body.success) return reply.status(400).send(invalid());
      const result = await companyToClient(db, {
        companyId: params.data.id,
        relationship: body.data.relationship,
      });
      if (result === 'not_found') return reply.status(404).send(notFound('Empresa'));
      if (result === 'name_taken')
        return reply.status(409).send({
          error: 'client_exists',
          message:
            'Já existe um cliente com este nome. Ligue a empresa a ele pela ficha do cliente.',
        });
      await writeAudit(db, {
        actorEmployeeId: request.session.actor.employeeId,
        action: result.created ? 'crm_company.became_client' : 'crm_company.client_linked',
        entity: 'crm_company',
        entityId: params.data.id,
        ip: request.ip,
        metadata: { clientId: result.clientId, relationship: body.data.relationship },
      });
      return reply.status(result.created ? 201 : 200).send({
        company: await companyOf(db, params.data.id),
        clientId: result.clientId,
        created: result.created,
      });
    },
  );

  // --- activities: calls and meetings -----------------------------------------------------------

  app.post('/leads/:id/activities', write, async (request, reply) => {
    const params = idParam.safeParse(request.params);
    const body = leadActivityCreateSchema.safeParse(request.body);
    if (!params.success || !body.success)
      return reply
        .status(400)
        .send(invalid(body.success ? undefined : body.error.issues[0]?.message));
    const row = await visibleLead(request, params.data.id, 'leads.write');
    if (!row) return reply.status(404).send(notFound());
    const actor = request.session.actor.employeeId;
    const activity = await addActivity(db, {
      ...body.data,
      leadId: row.id,
      actorEmployeeId: actor,
    });
    await writeAudit(db, {
      actorEmployeeId: actor,
      action: body.data.kind === 'call' ? 'lead.call_logged' : 'lead.meeting_logged',
      entity: 'lead',
      entityId: row.id,
      ip: request.ip,
      metadata: { activityId: activity.id },
    });
    return reply.status(201).send({ activity });
  });

  // --- value, brand of interest, company ---------------------------------------------------------

  app.patch('/leads/:id/deal', write, async (request, reply) => {
    const params = idParam.safeParse(request.params);
    const body = leadDealUpdateSchema.safeParse(request.body);
    if (!params.success || !body.success)
      return reply
        .status(400)
        .send(invalid(body.success ? undefined : body.error.issues[0]?.message));
    const row = await visibleLead(request, params.data.id, 'leads.write');
    if (!row) return reply.status(404).send(notFound());
    if (body.data.brandClientId) {
      const brands = await brandsOnSale(db);
      if (!brands.some((brand: CrmBrand) => brand.clientId === body.data.brandClientId))
        return reply
          .status(400)
          .send(invalid('Esta marca não está na lista de marcas de interesse.'));
    }
    const actor = request.session.actor.employeeId;
    const result = await changeDeal(db, { ...body.data, leadId: row.id, actorEmployeeId: actor });
    if (!result.ok) {
      const messages = {
        not_found: 'Lead não encontrado.',
        brand_not_found: 'Marca não encontrada.',
        company_not_found: 'Empresa não encontrada.',
      } as const;
      return reply
        .status(result.reason === 'not_found' ? 404 : 400)
        .send({ error: result.reason, message: messages[result.reason] });
    }
    if (result.changed.length > 0) {
      await writeAudit(db, {
        actorEmployeeId: actor,
        action: 'lead.deal_updated',
        entity: 'lead',
        entityId: row.id,
        ip: request.ip,
        metadata: { changed: result.changed },
      });
    }
    return reply.send(await loadLead(db, row.id));
  });

  // --- brands of interest (Administração → CRM) --------------------------------------------------

  app.get('/crm/brands', read, async (request, reply) => {
    const all = z.object({ all: z.coerce.boolean().optional() }).safeParse(request.query);
    const everything =
      all.success && all.data.all && grantedScope(request.session.actor, 'crm.manage');
    return reply.send({ brands: everything ? await listBrands(db) : await brandsOnSale(db) });
  });

  app.post('/crm/brands', manage, async (request, reply) => {
    const body = crmBrandCreateSchema.safeParse(request.body);
    if (!body.success) return reply.status(400).send(invalid(body.error.issues[0]?.message));
    const brand = await createBrand(db, body.data);
    if (brand === 'exists')
      return reply.status(409).send({
        error: 'client_exists',
        message: 'Já existe um cliente com este nome. Marque "à venda" nele na lista abaixo.',
      });
    await writeAudit(db, {
      actorEmployeeId: request.session.actor.employeeId,
      action: 'crm_brand.created',
      entity: 'client',
      entityId: brand.clientId,
      ip: request.ip,
    });
    return reply.status(201).send({ brand });
  });

  app.patch('/crm/brands/:id', manage, async (request, reply) => {
    const params = idParam.safeParse(request.params);
    const body = crmBrandUpdateSchema.safeParse(request.body);
    if (!params.success || !body.success) return reply.status(400).send(invalid());
    const brand = await setBrandOnSale(db, params.data.id, body.data.onSale);
    if (!brand) return reply.status(404).send(notFound('Marca'));
    await writeAudit(db, {
      actorEmployeeId: request.session.actor.employeeId,
      action: 'crm_brand.updated',
      entity: 'client',
      entityId: brand.clientId,
      ip: request.ip,
      metadata: { onSale: body.data.onSale },
    });
    return reply.send({ brand });
  });

  // --- CSV: export the filtered list, preview and run an import --------------------------------

  app.get('/leads/export.csv', read, async (request, reply) => {
    const query = leadListQuerySchema.safeParse(request.query);
    if (!query.success) return reply.status(400).send(invalid('Filtro inválido.'));
    const own = ownScope(request, 'leads.read');
    const result = await exportLeads(
      db,
      { ...query.data, ownerEmployeeId: own },
      CSV_EXPORT_MAX_ROWS,
    );
    await writeAudit(db, {
      actorEmployeeId: request.session.actor.employeeId,
      action: 'lead.exported',
      entity: 'lead_list',
      entityId: 'csv',
      ip: request.ip,
      metadata: {
        rows: result.count,
        total: result.total,
        filters: Object.keys(query.data).filter(
          (key) => query.data[key as keyof typeof query.data] !== undefined,
        ),
        scope: own ? 'own' : 'all',
      },
    });
    const stamp = new Date().toISOString().slice(0, 10);
    return reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header('content-disposition', `attachment; filename="funil-${stamp}.csv"`)
      .header('x-rows', String(result.count))
      .header('x-total', String(result.total))
      .send(result.csv);
  });

  app.post('/leads/import/preview', write, async (request, reply) => {
    const body = csvImportRequestSchema
      .omit({ mapping: true })
      .extend({ mapping: csvImportRequestSchema.shape.mapping.optional() })
      .safeParse(request.body);
    if (!body.success) return reply.status(400).send(invalid(body.error.issues[0]?.message));
    return reply.send(await previewImport(db, { csv: body.data.csv, mapping: body.data.mapping }));
  });

  app.post('/leads/import', write, async (request, reply) => {
    const body = csvImportRequestSchema.safeParse(request.body);
    if (!body.success) return reply.status(400).send(invalid(body.error.issues[0]?.message));
    const actor = request.session.actor.employeeId;
    const own = ownScope(request, 'leads.write');
    // A seller's import lands on the seller; a manager may name an owner or leave it empty.
    let owner: string | null | undefined = own ?? body.data.ownerEmployeeId ?? null;
    if (own === undefined && body.data.ownerEmployeeId) {
      const found = await db.query.employees.findFirst({
        where: eq(employees.id, body.data.ownerEmployeeId),
        columns: { id: true, status: true },
      });
      if (!found || found.status !== 'active')
        return reply.status(400).send(invalid('Funcionário inexistente ou inativo.'));
      owner = found.id;
    }
    if (body.data.brandClientId) {
      const brands = await brandsOnSale(db);
      if (!brands.some((brand) => brand.clientId === body.data.brandClientId))
        return reply
          .status(400)
          .send(invalid('Esta marca não está na lista de marcas de interesse.'));
    }
    const report = await runImport(db, {
      csv: body.data.csv,
      mapping: body.data.mapping,
      pipeline: body.data.pipeline,
      brandClientId: body.data.brandClientId,
      ownerEmployeeId: owner,
      actorEmployeeId: actor,
    });
    await writeAudit(db, {
      actorEmployeeId: actor,
      action: 'lead.imported_csv',
      entity: 'lead_import',
      entityId: report.batchId,
      ip: request.ip,
      metadata: {
        rows: report.rows,
        created: report.created,
        matched: report.matched,
        skipped: report.skipped,
        pipeline: body.data.pipeline ?? null,
      },
    });
    return reply.status(201).send(report);
  });
};
