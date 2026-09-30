import { normalizeSourcePattern } from '@wings/shared';
import { and, eq } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { clients, leadSourceRules } from '../../db/schema/index.js';
import { writeAudit } from '../../lib/audit.js';
import { auditConversions, type AuditResult } from './audit.js';
import { RdCrm, RdMarketing } from './rd.js';
import { activeRules } from './service.js';

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

  // The brands' pages are the source rules of funnel Expansão (one list since CRM phase 1).
  const expansionPage = (pattern: string) =>
    and(
      eq(leadSourceRules.kind, 'landing_page'),
      eq(leadSourceRules.pattern, pattern),
      eq(leadSourceRules.pipeline, 'expansao'),
    );

  app.get('/expansion/landing-pages', guard, async (_request, reply) => {
    const rows = await db
      .select({
        identifier: leadSourceRules.pattern,
        brand: leadSourceRules.brand,
        clientName: clients.name,
        active: leadSourceRules.active,
      })
      .from(leadSourceRules)
      .leftJoin(clients, eq(clients.id, leadSourceRules.clientId))
      .where(
        and(eq(leadSourceRules.kind, 'landing_page'), eq(leadSourceRules.pipeline, 'expansao')),
      );
    const landingPages = rows
      .map((row) => ({
        identifier: row.identifier,
        brand: row.brand ?? row.clientName ?? '',
        active: row.active,
      }))
      .sort(
        (a, b) =>
          a.brand.localeCompare(b.brand, 'pt-BR') || a.identifier.localeCompare(b.identifier),
      );
    return reply.send({ enabled: app.wings.env.EXPANSION_INTAKE_ENABLED === 'true', landingPages });
  });

  // Read-only audit of RD conversions -> RD CRM deals. Walking RD takes minutes
  // (its limit is per minute), so the first GET starts the run and answers 202;
  // the next ones answer the result. One run at a time, kept in memory only.
  let audit:
    | { state: 'running'; startedAt: string; days: number }
    | { state: 'done'; finishedAt: string; result: AuditResult; registered: string[] }
    | { state: 'failed'; finishedAt: string; error: string }
    | null = null;

  app.get('/expansion/landing-audit', guard, async (request, reply) => {
    const query = z
      .object({
        days: z.coerce.number().int().min(1).max(120).default(90),
        refresh: z.enum(['1']).optional(),
      })
      .safeParse(request.query);
    if (!query.success) return reply.code(400).send({ error: 'invalid_query' });
    const { days, refresh } = query.data;
    const env = app.wings.env;
    if (
      !env.RD_CRM_API_TOKEN ||
      !env.RD_MKT_CLIENT_ID ||
      !env.RD_MKT_CLIENT_SECRET ||
      !env.RD_MKT_REFRESH_TOKEN
    ) {
      return reply.code(503).send({ error: 'rd_not_configured' });
    }
    if (audit?.state === 'running') return reply.code(202).send(audit);
    const fresh = audit?.state === 'done' && audit.result.days === days && !refresh;
    if (fresh) return reply.send(audit);

    audit = { state: 'running', startedAt: new Date().toISOString(), days };
    await writeAudit(db, {
      actorEmployeeId: request.session.actor.employeeId,
      action: 'expansion.landing_audit_started',
      entity: 'expansion_landing_audit',
      entityId: 'rd',
      metadata: { days },
    });
    const credentials = {
      clientId: env.RD_MKT_CLIENT_ID,
      clientSecret: env.RD_MKT_CLIENT_SECRET,
      refreshToken: env.RD_MKT_REFRESH_TOKEN,
    };
    const crmToken = env.RD_CRM_API_TOKEN;
    void (async () => {
      try {
        const result = await auditConversions({
          marketing: new RdMarketing(credentials, app.wings.rdFetch),
          crm: new RdCrm(crmToken, app.wings.rdFetch),
          days,
        });
        const registered = (await activeRules(db)).map((rule) => rule.identifier);
        audit = { state: 'done', finishedAt: new Date().toISOString(), result, registered };
      } catch (error) {
        // The message names a path and a status only (rd.ts), never a body.
        audit = {
          state: 'failed',
          finishedAt: new Date().toISOString(),
          error: error instanceof Error ? error.message.slice(0, 200) : 'unknown',
        };
      }
    })();
    return reply.code(202).send(audit);
  });

  app.put('/expansion/landing-pages', guard, async (request, reply) => {
    const parsed = body.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_landing_page' });
    const input = { ...parsed.data, identifier: normalizeSourcePattern(parsed.data.identifier) };
    const existing = await db.query.leadSourceRules.findFirst({
      where: and(
        eq(leadSourceRules.kind, 'landing_page'),
        eq(leadSourceRules.pattern, input.identifier),
      ),
    });
    if (existing && existing.pipeline !== null && existing.pipeline !== 'expansao') {
      return reply.code(409).send({ error: 'landing_page_in_other_pipeline' });
    }
    if (existing) {
      await db
        .update(leadSourceRules)
        .set({ brand: input.brand, active: input.active, pipeline: 'expansao' })
        .where(eq(leadSourceRules.id, existing.id));
    } else {
      await db.insert(leadSourceRules).values({
        kind: 'landing_page',
        pattern: input.identifier,
        pipeline: 'expansao',
        brand: input.brand,
        active: input.active,
        createdBy: request.session.actor.employeeId,
      });
    }
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
    const identifier = normalizeSourcePattern(params.data.identifier);
    await db.delete(leadSourceRules).where(expansionPage(identifier));
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
