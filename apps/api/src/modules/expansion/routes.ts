import { eq } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { expansionLandingPages } from '../../db/schema/index.js';
import { writeAudit } from '../../lib/audit.js';

const identifierSchema = z
  .string()
  .trim()
  .min(2)
  .max(120)
  .regex(/^[\p{L}\p{N} ._\-/]+$/u, 'identificador inválido');
const body = z.object({
  identifier: identifierSchema,
  brand: z.string().trim().min(2).max(120),
  active: z.boolean().default(true),
});

/**
 * Integrações → Entrada de leads de Expansão: which RD Marketing landing pages
 * belong to client brands. Whoever holds `integrations.manage` edits it; the
 * job reads it on every pass, so a change applies within 5 minutes.
 */
export const expansionRoutes: FastifyPluginAsync = async (app) => {
  const { db } = app.wings;
  const guard = { preHandler: app.requirePermission('integrations.manage') };

  app.get('/expansion/landing-pages', guard, async (_request, reply) => {
    const rows = await db.query.expansionLandingPages.findMany({
      orderBy: (table, { asc }) => [asc(table.brand), asc(table.identifier)],
    });
    return reply.send({
      enabled: app.wings.env.EXPANSION_INTAKE_ENABLED === 'true',
      landingPages: rows.map((row) => ({
        identifier: row.identifier,
        brand: row.brand,
        active: row.active,
      })),
    });
  });

  app.put('/expansion/landing-pages', guard, async (request, reply) => {
    const parsed = body.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_landing_page' });
    const input = parsed.data;
    await db
      .insert(expansionLandingPages)
      .values(input)
      .onConflictDoUpdate({
        target: expansionLandingPages.identifier,
        set: { brand: input.brand, active: input.active },
      });
    await writeAudit(db, {
      actorEmployeeId: request.session.actor.employeeId,
      action: 'expansion.landing_page_saved',
      entity: 'expansion_landing_page',
      entityId: input.identifier,
      metadata: { active: input.active },
    });
    return reply.send({ ok: true });
  });

  app.delete('/expansion/landing-pages/:identifier', guard, async (request, reply) => {
    const params = z.object({ identifier: identifierSchema }).safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: 'invalid_landing_page' });
    const { identifier } = params.data;
    await db.delete(expansionLandingPages).where(eq(expansionLandingPages.identifier, identifier));
    await writeAudit(db, {
      actorEmployeeId: request.session.actor.employeeId,
      action: 'expansion.landing_page_removed',
      entity: 'expansion_landing_page',
      entityId: identifier,
      metadata: {},
    });
    return reply.code(204).send();
  });
};
