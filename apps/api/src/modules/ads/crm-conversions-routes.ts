import { conversionMappingInputSchema } from '@wings/shared';
import type { FastifyPluginAsync } from 'fastify';
import { writeAudit } from '../../lib/audit.js';
import { conversionsPanel, saveMapping } from './crm-conversions-status.js';

/**
 * Closing the loop's panel (docs/ads/fechar-ciclo.md). Reading needs `ads.read`;
 * choosing which stage becomes which event changes what the platforms learn,
 * so it needs `ads.approve` and is audited. The switches and tokens are
 * environment variables, Eric's: no route turns anything on.
 */
export const crmConversionsRoutes: FastifyPluginAsync = async (app) => {
  const { db, env } = app.wings;

  app.get(
    '/ads/conversions',
    { preHandler: app.requirePermission('ads.read') },
    async (_request, reply) =>
      reply.send(await conversionsPanel(db, env, app.wings.now?.() ?? new Date())),
  );

  app.put(
    '/ads/conversions/mappings',
    { preHandler: app.requirePermission('ads.approve') },
    async (request, reply) => {
      const body = conversionMappingInputSchema.safeParse(request.body);
      if (!body.success) {
        return reply.status(400).send({
          error: 'invalid_request',
          message: body.error.issues[0]?.message ?? 'Dados inválidos',
        });
      }
      const actor = request.session.actor.employeeId;
      const mapping = await saveMapping(db, body.data, actor);
      if (!mapping) {
        return reply
          .status(404)
          .send({ error: 'stage_not_found', message: 'Etapa não encontrada.' });
      }
      await writeAudit(db, {
        actorEmployeeId: actor,
        action: 'ad_conversion.mapping_saved',
        entity: 'ad_conversion_stage_event',
        entityId: mapping.id,
        ip: request.ip,
        metadata: {
          stageId: mapping.stageId,
          platform: mapping.platform,
          eventName: mapping.eventName,
          googleConversionActionId: mapping.googleConversionActionId,
          active: mapping.active,
        },
      });
      return reply.send({ mapping });
    },
  );
};
