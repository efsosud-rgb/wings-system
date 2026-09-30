import {
  WINGS_CLIENT_ID,
  clientCreateSchema,
  clientSlugOf,
  clientRegisterMissing,
  clientUpdateSchema,
  type ClientRelationship,
  type Client,
  type ExpansionEntry,
} from '@wings/shared';
import { and, asc, desc, eq, ne } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { Database } from '../../db/client.js';
import { clientBusiness, clientContacts, clients } from '../../db/schema/index.js';
import { writeAudit } from '../../lib/audit.js';
import { syncDriveFolders } from '../drive/folders.js';
import { createClientRecord } from './create.js';

const idParam = z.object({ id: z.uuid() });

type ClientRow = typeof clients.$inferSelect;
export const toClient = (row: ClientRow): Client => ({
  id: row.id,
  name: row.name,
  slug: row.slug,
  active: row.active,
  expansionArea: Array.isArray(row.expansionArea) ? (row.expansionArea as ExpansionEntry[]) : [],
  number: row.number ?? null,
  relationship: (row.relationship as ClientRelationship | null) ?? null,
});

/**
 * Wings Company first, then the active ones by name, then the inactive; each
 * with what its register lacks against the new register (Wings Company: nothing).
 */
export async function listClients(db: Database): Promise<Client[]> {
  const [rows, contacts, business] = await Promise.all([
    db.select().from(clients).orderBy(desc(clients.active), asc(clients.name)),
    db.select().from(clientContacts).where(eq(clientContacts.role, 'principal')),
    db.select().from(clientBusiness),
  ]);
  const contactOf = new Map(contacts.map((contact) => [contact.clientId, contact]));
  const businessOf = new Map(business.map((row) => [row.clientId, row]));
  return rows
    .map((row) => {
      const address = (row.address ?? {}) as Record<string, string | null>;
      const registerMissing =
        row.id === WINGS_CLIENT_ID
          ? []
          : clientRegisterMissing({
              cnpj: row.cnpj,
              legalName: row.legalName,
              tradeName: row.tradeName,
              cnaeMain: row.cnaeMain,
              openedOn: row.openedOn,
              city: address.city ?? null,
              state: address.state ?? null,
              relationship: row.relationship,
              contact: contactOf.get(row.id) ?? null,
              business: businessOf.get(row.id) ?? null,
            });
      return { ...toClient(row), registerMissing };
    })
    .sort((a, b) => Number(b.id === WINGS_CLIENT_ID) - Number(a.id === WINGS_CLIENT_ID));
}

/** The client by id, only while active: work is not filed under a client that was switched off. */
export async function activeClient(db: Database, id: string): Promise<Client | null> {
  const row = await db.query.clients.findFirst({
    where: and(eq(clients.id, id), eq(clients.active, true)),
  });
  return row ? toClient(row) : null;
}

/**
 * Formatação → Clientes. The register is read by whoever files media under a
 * client and kept by whoever holds `clients.manage`. Wings Company is fixed:
 * other tables default to its id.
 */
export const clientRoutes: FastifyPluginAsync = async (app) => {
  const { db } = app.wings;

  app.get('/clients', { preHandler: app.requireAuth }, async (request, reply) => {
    if (
      !app.can(request, 'clients.manage') &&
      !app.can(request, 'clients.read') &&
      !app.can(request, 'marketing.media.read')
    ) {
      return reply.status(403).send({ error: 'forbidden', message: 'Acesso negado' });
    }
    return reply.send({ clients: await listClients(db) });
  });

  app.post(
    '/clients',
    { preHandler: app.requirePermission('clients.manage') },
    async (request, reply) => {
      const body = clientCreateSchema.safeParse(request.body);
      if (!body.success) {
        return reply.status(400).send({
          error: 'invalid_request',
          message: body.error.issues[0]?.message ?? 'Dados inválidos',
        });
      }
      const { cnpj, contact, relationship, company, business } = body.data;
      if (cnpj) {
        const holder = await db.query.clients.findFirst({
          where: eq(clients.cnpj, cnpj),
          columns: { name: true },
        });
        if (holder) {
          return reply.status(409).send({
            error: 'cnpj_taken',
            message: `Este CNPJ já está no cadastro de ${holder.name}.`,
          });
        }
      }
      const created = await createClientRecord(db, {
        name: body.data.name,
        cnpj,
        contact,
        relationship,
        company,
        business,
      });
      if (!created) {
        return reply
          .status(409)
          .send({ error: 'client_exists', message: 'Já existe um cliente com este nome.' });
      }
      const { row } = created;
      await writeAudit(db, {
        actorEmployeeId: request.session.actor.employeeId,
        action: 'client.created',
        entity: 'client',
        entityId: row.id,
        ip: request.ip,
        metadata: {
          slug: row.slug,
          withCnpj: cnpj !== null,
          withContact: true,
          relationship,
          driveFoldersCreated: created.driveFoldersCreated,
          projectOpened: created.projectOpened,
        },
      });
      return reply.status(201).send({ client: toClient(row) });
    },
  );

  app.patch(
    '/clients/:id',
    { preHandler: app.requirePermission('clients.manage') },
    async (request, reply) => {
      const params = idParam.safeParse(request.params);
      const body = clientUpdateSchema.safeParse(request.body);
      if (!params.success || !body.success) {
        return reply.status(400).send({
          error: 'invalid_request',
          message: (body.success ? undefined : body.error.issues[0]?.message) ?? 'Dados inválidos',
        });
      }
      if (params.data.id === WINGS_CLIENT_ID) {
        return reply.status(409).send({
          error: 'client_fixed',
          message: 'Wings Company é o cliente padrão e não pode ser alterado.',
        });
      }
      if (body.data.number !== undefined) {
        const holder = await db.query.clients.findFirst({
          where: and(eq(clients.number, body.data.number), ne(clients.id, params.data.id)),
        });
        if (holder) {
          return reply.status(409).send({
            error: 'number_taken',
            message: `O número ${body.data.number} já é de ${holder.name}.`,
          });
        }
      }
      const slug = body.data.name === undefined ? undefined : clientSlugOf(body.data.name);
      if (slug !== undefined) {
        const taken = await db.query.clients.findFirst({
          where: and(eq(clients.slug, slug), ne(clients.id, params.data.id)),
        });
        if (taken) {
          return reply
            .status(409)
            .send({ error: 'client_exists', message: 'Já existe um cliente com este nome.' });
        }
      }
      const [row] = await db
        .update(clients)
        .set({
          ...(body.data.name !== undefined ? { name: body.data.name, slug } : {}),
          ...(body.data.active !== undefined ? { active: body.data.active } : {}),
          ...(body.data.number !== undefined ? { number: body.data.number } : {}),
          ...(body.data.relationship !== undefined ? { relationship: body.data.relationship } : {}),
        })
        .where(eq(clients.id, params.data.id))
        .returning();
      if (!row)
        return reply.status(404).send({ error: 'not_found', message: 'Cliente não encontrado.' });
      // A renamed client renames its folders; a reactivated one gets the ones it lacks.
      const folders = await syncDriveFolders(db);
      await writeAudit(db, {
        actorEmployeeId: request.session.actor.employeeId,
        action: 'client.updated',
        entity: 'client',
        entityId: row.id,
        ip: request.ip,
        metadata: {
          slug: row.slug,
          active: row.active,
          number: row.number,
          driveFoldersCreated: folders.foldersCreated,
          driveFoldersRenamed: folders.foldersRenamed,
        },
      });
      return reply.send({ client: toClient(row) });
    },
  );
};
