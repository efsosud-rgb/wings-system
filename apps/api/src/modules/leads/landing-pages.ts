import {
  clientSlugOf,
  LANDING_PAGE_BASE_URL,
  landingPageCreateSchema,
  landingPageKeysOf,
  normalizeSourcePattern,
  type LandingPageItem,
  type LeadPipeline,
} from '@wings/shared';
import { and, eq, isNotNull, sql } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { Database } from '../../db/client.js';
import { clients, expansionIntakeLedger, leadSourceRules, leads } from '../../db/schema/index.js';
import { writeAudit } from '../../lib/audit.js';

/**
 * CRM Vendas → Landing pages (Eric's list of 30/09, items 2–4). A landing
 * page is a source rule of kind `landing_page`: it says which client and
 * funnel a conversion on it belongs to. Here the team lists them per client
 * and funnel, sees how each one performs (only numbers with a source), makes a
 * new one (slug, rule and UTM links), archives one (it stops mapping
 * conversions; history stays) and deletes for good only one that never had a
 * lead nor a conversion.
 *
 * The page itself still lives in RD Station until the landing-page agent
 * phase: making one here reserves the address and the rule.
 */

const VISITS_REASON =
  'Sem fonte de visitas por página: o GA4 ainda não está conectado (falta o consentimento) e a leitura do RD feita pelo sistema não traz visitas.';
const CONVERSIONS_SOURCE =
  'RD Marketing, conversões vistas pela entrada automática (expansion-intake / formatacao-intake)';

/** Conversions per identifier the intake jobs saw, and since when they have been looking. */
async function conversionsByIdentifier(db: Database) {
  const identifier = sql<string>`lower(split_part(${expansionIntakeLedger.conversionKey}, '|', 2))`;
  const [rows, first] = await Promise.all([
    db
      .select({ identifier, count: sql<number>`count(*)::int` })
      .from(expansionIntakeLedger)
      .groupBy(identifier),
    db
      .select({ at: sql<string | null>`min(${expansionIntakeLedger.decidedAt})` })
      .from(expansionIntakeLedger),
  ]);
  return {
    counts: new Map(rows.map((row) => [normalizeSourcePattern(row.identifier), row.count])),
    since: first[0]?.at ? new Date(first[0].at).toISOString() : null,
  };
}

/** Leads of the Funil per page: the page each one arrived by, matched the way the rules match. */
async function leadsByPattern(db: Database, patterns: readonly string[]) {
  const rows = await db
    .select({ page: leads.landingPage, count: sql<number>`count(*)::int` })
    .from(leads)
    .where(isNotNull(leads.landingPage))
    .groupBy(leads.landingPage);
  const wanted = new Set(patterns);
  const counts = new Map<string, number>();
  for (const row of rows) {
    const keys = new Set([
      ...landingPageKeysOf({ url: row.page }),
      ...landingPageKeysOf({ identifier: row.page }),
    ]);
    for (const key of keys) {
      if (wanted.has(key)) counts.set(key, (counts.get(key) ?? 0) + row.count);
    }
  }
  return counts;
}

export async function listLandingPages(db: Database): Promise<LandingPageItem[]> {
  const rows = await db
    .select({
      id: leadSourceRules.id,
      pattern: leadSourceRules.pattern,
      url: leadSourceRules.url,
      clientId: leadSourceRules.clientId,
      clientName: clients.name,
      brand: leadSourceRules.brand,
      pipeline: leadSourceRules.pipeline,
      active: leadSourceRules.active,
      archivedAt: leadSourceRules.archivedAt,
      createdAt: leadSourceRules.createdAt,
    })
    .from(leadSourceRules)
    .leftJoin(clients, eq(clients.id, leadSourceRules.clientId))
    .where(eq(leadSourceRules.kind, 'landing_page'));
  const [conversions, leadCounts] = await Promise.all([
    conversionsByIdentifier(db),
    leadsByPattern(
      db,
      rows.map((row) => row.pattern),
    ),
  ]);
  return rows
    .map((row) => {
      const pipeline = (row.pipeline as LeadPipeline | null) ?? null;
      const seen = pipeline !== null;
      const count = conversions.counts.get(row.pattern) ?? 0;
      return {
        id: row.id,
        pattern: row.pattern,
        url: row.url,
        clientId: row.clientId,
        clientName: row.clientName,
        brand: row.brand,
        pipeline,
        active: row.active,
        archivedAt: row.archivedAt?.toISOString() ?? null,
        createdAt: row.createdAt.toISOString(),
        leads: leadCounts.get(row.pattern) ?? 0,
        performance: {
          visits: null,
          visitsSource: null,
          visitsReason: VISITS_REASON,
          conversions: seen && conversions.since ? count : null,
          conversionsSource: seen && conversions.since ? CONVERSIONS_SOURCE : null,
          conversionsSince: seen ? conversions.since : null,
          conversionsReason: !seen
            ? 'Página sem funil: a entrada automática não acompanha as conversões dela.'
            : conversions.since
              ? null
              : 'A entrada automática ainda não registrou nenhuma conversão.',
          rate: null,
        },
      } satisfies LandingPageItem;
    })
    .sort(
      (a, b) =>
        Number(b.active) - Number(a.active) ||
        (a.clientName ?? a.brand ?? '').localeCompare(b.clientName ?? b.brand ?? '', 'pt-BR') ||
        a.pattern.localeCompare(b.pattern),
    );
}

/** The client's slug, or it with -2, -3… when a landing page already has it. */
async function freeSlug(db: Database, wanted: string): Promise<string> {
  const taken = new Set(
    (
      await db
        .select({ pattern: leadSourceRules.pattern })
        .from(leadSourceRules)
        .where(eq(leadSourceRules.kind, 'landing_page'))
    ).map((row) => row.pattern),
  );
  if (!taken.has(wanted)) return wanted;
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${wanted}-${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
}

export const landingPageRoutes: FastifyPluginAsync = async (app) => {
  const { db } = app.wings;
  const read = { preHandler: app.requirePermission('leads.read') };
  const manage = { preHandler: app.requirePermission('clients.manage') };
  const idParam = z.object({ id: z.uuid() });

  app.get('/crm/landing-pages', read, async (_request, reply) =>
    reply.send({ pages: await listLandingPages(db), baseUrl: LANDING_PAGE_BASE_URL }),
  );

  app.post('/crm/landing-pages', manage, async (request, reply) => {
    const body = landingPageCreateSchema.safeParse(request.body);
    if (!body.success) {
      return reply.status(400).send({
        error: 'invalid_request',
        message: body.error.issues[0]?.message ?? 'Dados inválidos',
      });
    }
    const client = await db.query.clients.findFirst({
      where: and(eq(clients.id, body.data.clientId), eq(clients.active, true)),
    });
    if (!client)
      return reply
        .status(400)
        .send({ error: 'invalid_request', message: 'Cliente inativo ou inexistente.' });
    const slug = await freeSlug(db, body.data.slug ?? clientSlugOf(client.name));
    const actor = request.session.actor.employeeId;
    const [row] = await db
      .insert(leadSourceRules)
      .values({
        kind: 'landing_page',
        pattern: slug,
        clientId: client.id,
        pipeline: body.data.pipeline,
        url: `${LANDING_PAGE_BASE_URL}/${slug}`,
        createdBy: actor,
      })
      .returning();
    if (!row)
      return reply.status(409).send({ error: 'slug_taken', message: 'Este endereço já existe.' });
    await writeAudit(db, {
      actorEmployeeId: actor,
      action: 'landing_page.created',
      entity: 'lead_source_rule',
      entityId: row.id,
      ip: request.ip,
      metadata: { clientId: client.id, pipeline: row.pipeline, slug },
    });
    const page = (await listLandingPages(db)).find((candidate) => candidate.id === row.id);
    return reply.status(201).send({ page });
  });

  for (const [path, archive] of [
    ['archive', true],
    ['restore', false],
  ] as const) {
    app.post(`/crm/landing-pages/:id/${path}`, manage, async (request, reply) => {
      const params = idParam.safeParse(request.params);
      if (!params.success) return reply.status(400).send({ error: 'invalid_request' });
      const actor = request.session.actor.employeeId;
      const [row] = await db
        .update(leadSourceRules)
        .set(
          archive
            ? { active: false, archivedAt: new Date(), archivedBy: actor }
            : { active: true, archivedAt: null, archivedBy: null },
        )
        .where(
          and(eq(leadSourceRules.id, params.data.id), eq(leadSourceRules.kind, 'landing_page')),
        )
        .returning({ id: leadSourceRules.id, pattern: leadSourceRules.pattern });
      if (!row) return reply.status(404).send({ error: 'not_found' });
      await writeAudit(db, {
        actorEmployeeId: actor,
        action: archive ? 'landing_page.archived' : 'landing_page.restored',
        entity: 'lead_source_rule',
        entityId: row.id,
        ip: request.ip,
        metadata: { slug: row.pattern },
      });
      return reply.send({ ok: true });
    });
  }

  // For good, only a page that never brought a lead nor a conversion; the
  // caller types the slug back as confirmation.
  app.delete('/crm/landing-pages/:id', manage, async (request, reply) => {
    const params = idParam.safeParse(request.params);
    const body = z.object({ confirm: z.string() }).safeParse(request.query);
    if (!params.success || !body.success)
      return reply.status(400).send({ error: 'invalid_request' });
    const page = (await listLandingPages(db)).find((candidate) => candidate.id === params.data.id);
    if (!page) return reply.status(404).send({ error: 'not_found' });
    if (body.data.confirm !== page.pattern) {
      return reply.status(400).send({
        error: 'confirm_mismatch',
        message: 'Digite o endereço da página para confirmar.',
      });
    }
    if (page.leads > 0 || (page.performance.conversions ?? 0) > 0) {
      return reply.status(409).send({
        error: 'page_has_history',
        message: 'Esta página já trouxe leads ou conversões: arquive em vez de excluir.',
      });
    }
    await db.delete(leadSourceRules).where(eq(leadSourceRules.id, page.id));
    await writeAudit(db, {
      actorEmployeeId: request.session.actor.employeeId,
      action: 'landing_page.deleted',
      entity: 'lead_source_rule',
      entityId: page.id,
      ip: request.ip,
      metadata: { slug: page.pattern, clientId: page.clientId, pipeline: page.pipeline },
    });
    return reply.code(204).send();
  });
};
