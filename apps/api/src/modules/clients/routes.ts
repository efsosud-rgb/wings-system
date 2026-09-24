import {
  WINGS_CLIENT_ID,
  clientCreateSchema,
  clientSlugOf,
  clientUpdateSchema,
  type Client,
  type ExpansionEntry,
} from '@wings/shared';
import { and, asc, desc, eq, ne, sql } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { Database } from '../../db/client.js';
import { clients } from '../../db/schema/index.js';
import { writeAudit } from '../../lib/audit.js';
import { syncDriveFolders } from '../drive/folders.js';
import { openProjectForClient } from '../projects/service.js';

const idParam = z.object({ id: z.uuid() });

type ClientRow = typeof clients.$inferSelect;
export const toClient = (row: ClientRow): Client => ({
  id: row.id,
  name: row.name,
  slug: row.slug,
  active: row.active,
  expansionArea: Array.isArray(row.expansionArea) ? (row.expansionArea as ExpansionEntry[]) : [],
  number: row.number ?? null,
});

/** Wings Company first, then the active ones by name, then the inactive. */
export async function listClients(db: Database): Promise<Client[]> {
  const rows = await db.select().from(clients).orderBy(desc(clients.active), asc(clients.name));
  return rows
    .map(toClient)
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
 * Administração → Clientes. The register is read by whoever files media under a
 * client and kept by whoever holds `clients.manage`. Wings Company is fixed:
 * other tables default to its id.
 */
export const clientRoutes: FastifyPluginAsync = async (app) => {
  const { db } = app.wings;

  app.get('/clients', { preHandler: app.requireAuth }, async (request, reply) => {
    if (!app.can(request, 'clients.manage') && !app.can(request, 'marketing.media.read')) {
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
      // The next number, under a lock so two registrations never take the same one.
      const row = await db.transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(7301, 2)`);
        const [last] = await tx
          .select({ number: sql<number | null>`max(${clients.number})` })
          .from(clients);
        const [made] = await tx
          .insert(clients)
          .values({
            name: body.data.name,
            slug: clientSlugOf(body.data.name),
            number: (last?.number ?? 0) + 1,
          })
          .onConflictDoNothing()
          .returning();
        // The client's project opens with the client: Em Andamento, at 01.
        if (made) await openProjectForClient(tx, made.id);
        return made;
      });
      if (!row) {
        return reply
          .status(409)
          .send({ error: 'client_exists', message: 'Já existe um cliente com este nome.' });
      }
      // A new client gets its tree under Clientes/<NN. Nome>, at once.
      const folders = await syncDriveFolders(db);
      await writeAudit(db, {
        actorEmployeeId: request.session.actor.employeeId,
        action: 'client.created',
        entity: 'client',
        entityId: row.id,
        ip: request.ip,
        metadata: { slug: row.slug, driveFoldersCreated: folders.foldersCreated, projectOpened: true },
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
