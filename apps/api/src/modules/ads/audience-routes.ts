import { audienceProfileSchema, reachSchema, type AudienceProfile } from '@wings/shared';
import { eq } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { employees, marketingAudienceProfiles, WINGS_TENANT_ID } from '../../db/schema/index.js';
import { writeAudit } from '../../lib/audit.js';

/**
 * The tenant's standing audience — ideal customer profile and reach — that the
 * campaign builder starts from. One row per tenant; saving replaces it.
 *
 * Wings System is single-tenant today, so the tenant is the constant every ads
 * table already defaults to. Nothing routes by tenant yet.
 */
export const audienceRoutes: FastifyPluginAsync = async (app) => {
  const { db } = app.wings;

  app.get(
    '/ads/audience-profile',
    { preHandler: app.requirePermission('ads.read') },
    async (_request, reply) => {
      const [row] = await db
        .select({
          idealCustomerProfile: marketingAudienceProfiles.idealCustomerProfile,
          reach: marketingAudienceProfiles.reach,
          updatedAt: marketingAudienceProfiles.updatedAt,
          updatedByName: employees.fullName,
        })
        .from(marketingAudienceProfiles)
        .leftJoin(employees, eq(employees.id, marketingAudienceProfiles.updatedBy))
        .where(eq(marketingAudienceProfiles.tenantId, WINGS_TENANT_ID));

      const profile: AudienceProfile | null = row
        ? {
            idealCustomerProfile: row.idealCustomerProfile,
            // Parsed on the way out: a reach saved before the map existed has no
            // customLocations, and the schema's default fills that in.
            reach: reachSchema.parse(row.reach),
            updatedAt: row.updatedAt.toISOString(),
            updatedByName: row.updatedByName,
          }
        : null;
      return reply.send({ profile });
    },
  );

  app.put(
    '/ads/audience-profile',
    { preHandler: app.requirePermission('ads.request') },
    async (request, reply) => {
      const parsed = audienceProfileSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          error: 'invalid_request',
          message: parsed.error.issues[0]?.message ?? 'Dados inválidos',
        });
      }

      const now = new Date();
      const values = {
        idealCustomerProfile: parsed.data.idealCustomerProfile,
        reach: parsed.data.reach,
        updatedBy: request.session.actor.employeeId,
        updatedAt: now,
      };
      await db
        .insert(marketingAudienceProfiles)
        .values({ tenantId: WINGS_TENANT_ID, ...values })
        .onConflictDoUpdate({ target: marketingAudienceProfiles.tenantId, set: values });

      await writeAudit(db, {
        actorEmployeeId: request.session.actor.employeeId,
        action: 'ads.audience_profile_updated',
        entity: 'marketing_audience_profile',
        entityId: WINGS_TENANT_ID,
        metadata: {
          states: parsed.data.reach.states.length,
          cities: parsed.data.reach.cities.length,
        },
      });
      return reply.send({ ok: true, updatedAt: now.toISOString() });
    },
  );
};
