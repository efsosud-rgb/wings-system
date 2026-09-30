import { asc, eq } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { employees, rdUserMap } from '../../db/schema/index.js';
import { writeAudit } from '../../lib/audit.js';

/**
 * Administração → Usuários do RD CRM: which employee each RD CRM user is, so
 * the owner of a deal read from RD shows as one of ours (CRM phase 1). The
 * list is filled by the RD import (`leads-import-rd`); here a person only
 * links or unlinks. Whoever holds `integrations.manage` edits it.
 */
export const rdUserRoutes: FastifyPluginAsync = async (app) => {
  const { db } = app.wings;
  const guard = { preHandler: app.requirePermission('integrations.manage') };

  app.get('/leads/rd-users', guard, async (_request, reply) => {
    const rows = await db
      .select({
        rdUserId: rdUserMap.rdUserId,
        rdName: rdUserMap.rdName,
        rdActive: rdUserMap.rdActive,
        employeeId: rdUserMap.employeeId,
        employeeName: employees.fullName,
      })
      .from(rdUserMap)
      .leftJoin(employees, eq(employees.id, rdUserMap.employeeId))
      .orderBy(asc(rdUserMap.rdName));
    return reply.send({ users: rows });
  });

  app.put('/leads/rd-users/:rdUserId', guard, async (request, reply) => {
    const params = z.object({ rdUserId: z.string().trim().min(1).max(64) }).safeParse(request.params);
    const body = z.object({ employeeId: z.uuid().nullable() }).safeParse(request.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: 'invalid_rd_user' });
    const { employeeId } = body.data;
    if (employeeId) {
      const employee = await db.query.employees.findFirst({
        where: eq(employees.id, employeeId),
        columns: { id: true },
      });
      if (!employee) return reply.code(400).send({ error: 'unknown_employee' });
    }
    const actor = request.session.actor.employeeId;
    const [row] = await db
      .update(rdUserMap)
      .set({ employeeId, updatedBy: actor, updatedAt: new Date() })
      .where(eq(rdUserMap.rdUserId, params.data.rdUserId))
      .returning({ rdUserId: rdUserMap.rdUserId });
    if (!row) return reply.code(404).send({ error: 'unknown_rd_user' });
    await writeAudit(db, {
      actorEmployeeId: actor,
      action: 'rd_user_map.saved',
      entity: 'rd_user_map',
      entityId: row.rdUserId,
      ip: request.ip,
      metadata: { employeeId },
    });
    return reply.send({ ok: true });
  });
};
