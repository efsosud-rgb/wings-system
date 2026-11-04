import {
  PROSPECT_APPROACH_DAILY_MAX,
  PROSPECT_ENRICHMENT_SOURCE,
  PROSPECT_PARSE_DAILY_MAX,
  PROSPECT_STATUSES,
  instagramDiscoverySchema,
  instagramFindSchema,
  prospectApproachSchema,
  prospectBatchSchema,
  prospectClaimSchema,
  prospectEnrichSchema,
  prospectingIcpSchema,
  prospectingQuotaSchema,
  prospectingRetentionSchema,
  prospectLeadSchema,
  prospectParseSchema,
  prospectSearchSchema,
  prospectUpdateSchema,
  type Actor,
  type InstagramFindItem,
  type InstagramFindResponse,
  type ProspectBatchResponse,
  type ProspectEnrichment,
  type ProspectEnrichResponse,
  type ProspectPlaceResponse,
  type ProspectSearchResponse,
} from '@wings/shared';
import { and, eq, notInArray } from 'drizzle-orm';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { prospects } from '../../db/schema/index.js';
import { writeAudit } from '../../lib/audit.js';
import { createOpenRouterLlm, LlmError, type AgentLlm } from '../agent/llm.js';
import { leadInScope } from '../leads/access.js';
import { aiCallsToday, APPROACH_AUDIT_ACTION, suggestApproach } from './approach.js';
import { discoverInstagram, type DiscoveryHold } from './instagram-discovery.js';
import {
  finderKeyOf,
  findInstagram,
  issueFinderTicket,
  readFinderTicket,
  type FinderDeps,
} from './instagram-finder.js';
import {
  createBusinessDiscoveryClient,
  issueTicket,
  ticketKeyOf,
  type BusinessDiscoveryClient,
} from './instagram-graph.js';
import { exportProspects, prospectingMetrics, searchHistory } from './insights.js';
import { createPlacesClient, PlacesError, type PlacesClient } from './places-client.js';
import { reserveCalls, usageOf } from './quota.js';
import {
  assembleSearch,
  claimBatch,
  claimProspect,
  convertProspect,
  isProspectingManager,
  listProspects,
  PARSE_AUDIT_ACTION,
  parseProspectQuery,
  prospectingOwners,
  prospectInReach,
  searchGoogle,
  toProspect,
  updateProspect,
  type Refusal,
} from './service.js';
import { loadProspectingSettings, saveProspectingPart } from './settings.js';
import { readCompanySite } from './site-reader.js';
import { createWebSearch, type WebSearchClient } from './web-search.js';

/**
 * CRM Vendas → Prospecção (docs/crm/prospeccao.md). Every route needs
 * `prospecting.use`: a seller (own) works their own prospects, a manager (all)
 * sees every one and transfers. Google is called only here, with the key on
 * the server, each call reserved in the quota first; its answer goes to the
 * screen and nowhere else. Logs carry Google's error code and status only.
 */

const idParams = z.object({ id: z.uuid() });
const leadParams = z.object({ leadId: z.uuid() });
const listQuery = z.object({
  status: z.enum(PROSPECT_STATUSES).optional(),
  owner: z.uuid().optional(),
});

const GOOGLE_MESSAGES: Partial<Record<PlacesError['code'], string>> = {
  key_invalid: 'O Google recusou a chave da prospecção. Avise o administrador.',
  quota_exceeded: 'O Google recusou por limite de uso. Tente de novo mais tarde.',
};

export const prospectingRoutes: FastifyPluginAsync = async (app) => {
  const { db, env } = app.wings;
  const now = () => app.wings.now?.() ?? new Date();
  const use = { preHandler: app.requirePermission('prospecting.use') };
  const configure = { preHandler: app.requirePermission('prospecting.configure') };
  const quota = { preHandler: app.requirePermission('prospecting.quota') };
  const exporting = { preHandler: app.requirePermission('prospecting.export') };
  // Criar lead also needs leads.write, as POST /leads: Diretoria reads every deal but creates none.
  const createLead = {
    preHandler: [app.requirePermission('prospecting.use'), app.requirePermission('leads.write')],
  };

  /** Null while the key is missing: the routes that call Google then answer 503. */
  const places: PlacesClient | null = env.GOOGLE_PLACES_API_KEY
    ? createPlacesClient({ apiKey: env.GOOGLE_PLACES_API_KEY, fetchImpl: app.wings.placesFetch })
    : null;
  /** Null while off or unconfigured: the discovery route then answers 503 (§6, a Meta switch). */
  const discovery: BusinessDiscoveryClient | null =
    env.INSTAGRAM_BUSINESS_DISCOVERY_ENABLED === 'true' &&
    env.INSTAGRAM_DISCOVERY_ACCOUNT_ID &&
    env.INSTAGRAM_DISCOVERY_TOKEN
      ? createBusinessDiscoveryClient({
          accountId: env.INSTAGRAM_DISCOVERY_ACCOUNT_ID,
          token: env.INSTAGRAM_DISCOVERY_TOKEN,
          fetchImpl: app.wings.instagramDiscoveryFetch,
          log: (facts) => app.log.info({ module: 'instagram-discovery', ...facts }, 'discovery'),
        })
      : null;
  const ticketKey = ticketKeyOf(env.SESSION_SECRET);
  const finderKey = finderKeyOf(env.SESSION_SECRET);
  /** Null while `BRAVE_SEARCH_API_KEY` is missing: the finder's last path then says so. */
  const webSearch: WebSearchClient | null = env.BRAVE_SEARCH_API_KEY
    ? createWebSearch({
        apiKey: env.BRAVE_SEARCH_API_KEY,
        fetchImpl: app.wings.webSearchFetch,
        log: (facts) => app.log.info(facts, 'web search'),
      })
    : null;
  // shortcut: one hold per API process; with replicas each learns Meta's limit on its own call.
  const hold: DiscoveryHold = { until: null, reason: null };
  const finderDeps = (employeeId: string, at: Date): FinderDeps => ({
    db,
    now: at,
    employeeId,
    siteTransport: app.wings.siteTransport,
    discovery: discovery ? { db, client: discovery, ticketKey, hold, now: at } : null,
    search: webSearch,
  });
  const llm: AgentLlm | null =
    app.wings.agentLlm ??
    (env.OPENROUTER_API_KEY ? createOpenRouterLlm({ apiKey: env.OPENROUTER_API_KEY }) : null);

  const notConfigured = (reply: FastifyReply) =>
    reply
      .status(503)
      .send({ error: 'places_not_configured', message: 'Chave do Google não configurada.' });
  const notFound = (reply: FastifyReply) =>
    reply.status(404).send({ error: 'not_found', message: 'Prospect não encontrado.' });
  const invalid = (reply: FastifyReply, error: z.ZodError) =>
    reply.status(400).send({
      error: 'invalid',
      message: error.issues[0]?.message ?? 'Pedido inválido.',
      path: error.issues[0]?.path.join('.'),
    });
  const refused = (reply: FastifyReply, outcome: Refusal) =>
    reply.status(outcome.status).send({ error: outcome.error, message: outcome.message });
  const overQuota = (reply: FastifyReply, message: string) =>
    reply.status(429).send({ error: 'prospecting_quota', message });
  /** Google failed: its code and status in the log, never its text, the key or the URL. */
  const googleFailed = (request: FastifyRequest, reply: FastifyReply, error: unknown) => {
    if (!(error instanceof PlacesError)) throw error;
    request.log.warn({ code: error.code, status: error.status }, 'prospecting: Google call failed');
    return reply.status(502).send({
      error: `places_${error.code}`,
      message:
        GOOGLE_MESSAGES[error.code] ?? 'O Google não respondeu agora. Tente de novo em instantes.',
    });
  };

  /** One ficha (Place Details): reserved, called once, never stored. */
  async function placeAnswer(
    request: FastifyRequest,
    reply: FastifyReply,
    client: PlacesClient,
    placeId: string,
    onNotFound?: () => Promise<void>,
  ) {
    const at = now();
    const employeeId = request.session.actor.employeeId;
    const reserved = await reserveCalls(db, {
      employeeId,
      kind: 'details',
      count: 1,
      queryText: null,
      locations: [],
      now: at,
    });
    if (!reserved.ok) return overQuota(reply, reserved.message);
    let place: Awaited<ReturnType<PlacesClient['details']>>;
    try {
      place = await client.details(placeId);
    } catch (error) {
      return googleFailed(request, reply, error);
    }
    if (!place) await onNotFound?.();
    const usage = await usageOf(db, employeeId, at);
    // Google's ficha lives on the screen only: no browser or proxy cache keeps it.
    return reply.header('Cache-Control', 'no-store').send(
      (place
        ? { found: true, place, usage }
        : {
            found: false,
            message: 'Não encontrado no Google.',
            usage,
          }) satisfies ProspectPlaceResponse,
    );
  }

  // --- state of the screen ----------------------------------------------------------------

  app.get('/prospecting/status', use, async (_request, reply) =>
    reply.send({
      configured: places !== null,
      aiConfigured: llm !== null,
      instagramDiscovery: discovery !== null,
    }),
  );

  app.get('/prospecting/usage', use, async (request, reply) =>
    reply.send(await usageOf(db, request.session.actor.employeeId, now())),
  );

  app.get('/prospecting/owners', use, async (request, reply) => {
    const owners = await prospectingOwners(db);
    // A seller transfers nothing: only their own name.
    const actor = request.session.actor;
    return reply.send(
      isProspectingManager(actor) ? owners : owners.filter((o) => o.id === actor.employeeId),
    );
  });

  app.get('/prospecting/history', use, async (request, reply) =>
    reply.send(await searchHistory(db, request.session.actor)),
  );

  app.get('/prospecting/metrics', use, async (request, reply) =>
    reply.send(await prospectingMetrics(db, request.session.actor, now())),
  );

  // --- settings ---------------------------------------------------------------------------

  app.get('/prospecting/settings', use, async (_request, reply) =>
    reply.send(await loadProspectingSettings(db)),
  );

  app.put('/prospecting/settings/icp', configure, async (request, reply) => {
    const body = prospectingIcpSchema.safeParse(request.body);
    if (!body.success) return invalid(reply, body.error);
    const before = await loadProspectingSettings(db);
    const actor = request.session.actor.employeeId;
    await saveProspectingPart(db, 'icp', body.data, actor, now());
    await writeAudit(db, {
      actorEmployeeId: actor,
      action: 'prospecting.icp_changed',
      entity: 'prospecting_settings',
      ip: request.ip,
      metadata: {
        changed: Object.keys(body.data.weights).filter(
          (key) =>
            before.icp.weights[key as keyof typeof before.icp.weights] !==
            body.data.weights[key as keyof typeof body.data.weights],
        ),
        weights: body.data.weights,
        excludedCount: body.data.excludedNames.length,
        excludedCountBefore: before.icp.excludedNames.length,
      },
    });
    return reply.send(await loadProspectingSettings(db));
  });

  app.put('/prospecting/settings/quota', quota, async (request, reply) => {
    const body = prospectingQuotaSchema.safeParse(request.body);
    if (!body.success) return invalid(reply, body.error);
    const before = await loadProspectingSettings(db);
    const actor = request.session.actor.employeeId;
    await saveProspectingPart(db, 'quota', body.data, actor, now());
    await writeAudit(db, {
      actorEmployeeId: actor,
      action: 'prospecting.quota_changed',
      entity: 'prospecting_settings',
      ip: request.ip,
      metadata: { from: before.quota, to: body.data },
    });
    return reply.send(await loadProspectingSettings(db));
  });

  // Prazos de reserva e de retenção: the same gate as the ICP (the module's rules), audited as the quota.
  app.put('/prospecting/settings/retention', configure, async (request, reply) => {
    const body = prospectingRetentionSchema.safeParse(request.body);
    if (!body.success) return invalid(reply, body.error);
    const before = await loadProspectingSettings(db);
    const actor = request.session.actor.employeeId;
    await saveProspectingPart(db, 'retention', body.data, actor, now());
    await writeAudit(db, {
      actorEmployeeId: actor,
      action: 'prospecting.retention_changed',
      entity: 'prospecting_settings',
      ip: request.ip,
      metadata: { from: before.retention, to: body.data },
    });
    return reply.send(await loadProspectingSettings(db));
  });

  // --- Instagram numbers of the companies found (parte 3, docs/prospeccao/instagram.md §6) ----

  app.post('/prospecting/instagram/discovery', use, async (request, reply) => {
    if (!discovery)
      return reply.status(503).send({
        error: 'instagram_discovery_off',
        message: 'A consulta ao Instagram (Meta) está desligada neste ambiente.',
      });
    const body = instagramDiscoverySchema.safeParse(request.body);
    if (!body.success) return invalid(reply, body.error);
    const answer = await discoverInstagram(
      { db, client: discovery, ticketKey, hold, now: now() },
      request.session.actor.employeeId,
      body.data,
    );
    // Meta's numbers live on the screen and in our cache: no browser or proxy keeps them.
    return reply.header('Cache-Control', 'no-store').send(answer);
  });

  /**
   * t086: the Instagram of the companies of a search that have none yet, five at a time, called by
   * the screen right after the search. Each ticket was signed on that search for this seller; one
   * that is wrong or expired refuses the whole request before anything is read or asked.
   */
  app.post('/prospecting/instagram/find', use, async (request, reply) => {
    const body = instagramFindSchema.safeParse(request.body);
    if (!body.success) return invalid(reply, body.error);
    const actor = request.session.actor;
    const at = now();
    const companies = body.data.items.map(({ ticket }) =>
      readFinderTicket(finderKey, actor.employeeId, ticket, at),
    );
    if (companies.some((company) => company === null))
      return reply.status(400).send({
        error: 'find_ticket_invalid',
        message: 'Esta busca expirou ou não é sua. Busque de novo.',
      });
    const deps = finderDeps(actor.employeeId, at);
    const items = await Promise.all(
      companies.map(async (company): Promise<InstagramFindItem> => {
        const outcome = await findInstagram(deps, company!);
        return {
          placeId: company!.placeId,
          instagram: outcome.instagram && {
            ...outcome.instagram,
            ticket: issueTicket(ticketKey, actor.employeeId, outcome.instagram.username, at),
          },
          miss: outcome.miss,
        };
      }),
    );
    await writeAudit(db, {
      actorEmployeeId: actor.employeeId,
      action: 'prospect.instagram_find',
      entity: 'prospect',
      ip: request.ip,
      metadata: { companies: items.length, found: items.filter((item) => item.instagram).length },
    });
    return reply
      .header('Cache-Control', 'no-store')
      .send({ items } satisfies InstagramFindResponse);
  });

  // --- the AI and the search -------------------------------------------------------------

  app.post('/prospecting/parse', use, async (request, reply) => {
    if (!llm)
      return reply
        .status(503)
        .send({ error: 'ai_unavailable', message: 'A IA não está configurada neste ambiente.' });
    const body = prospectParseSchema.safeParse(request.body);
    if (!body.success) return invalid(reply, body.error);
    const actor = request.session.actor;
    if (
      (await aiCallsToday(db, actor.employeeId, PARSE_AUDIT_ACTION, now())) >=
      PROSPECT_PARSE_DAILY_MAX
    )
      return reply.status(429).send({
        error: 'parse_quota',
        message: `Você já usou a IA da busca ${PROSPECT_PARSE_DAILY_MAX} vezes hoje. Use o formulário.`,
      });
    // Counted before the call, and never the text: a call that failed may have cost too.
    await writeAudit(db, {
      actorEmployeeId: actor.employeeId,
      action: PARSE_AUDIT_ACTION,
      entity: 'prospect_query',
      ip: request.ip,
    });
    let query: Awaited<ReturnType<typeof parseProspectQuery>>;
    try {
      query = await parseProspectQuery(llm, body.data.text);
    } catch (error) {
      if (!(error instanceof LlmError)) throw error;
      return reply.status(502).send({
        error: 'ai_failed',
        message: 'A IA não respondeu agora. Tente de novo em instantes.',
      });
    }
    if (!query)
      return reply.status(502).send({
        error: 'ai_failed',
        message: 'A IA não entendeu o pedido. Preencha o formulário.',
      });
    return reply.send(query);
  });

  app.post('/prospecting/search', use, async (request, reply) => {
    if (!places) return notConfigured(reply);
    const body = prospectSearchSchema.safeParse(request.body);
    if (!body.success) return invalid(reply, body.error);
    // A place twice is one call: never billed twice.
    const input = { ...body.data, places: [...new Set(body.data.places)] };
    const calls = input.places.length;
    if (calls > 1 && input.confirmCalls !== calls)
      return reply.status(400).send({
        error: 'confirm_calls',
        calls,
        message: `Confirme as ${calls} chamadas antes da varredura.`,
      });
    const actor = request.session.actor;
    const at = now();
    const reserved = await reserveCalls(db, {
      employeeId: actor.employeeId,
      kind: 'search',
      count: calls,
      queryText: input.segment,
      locations: input.places,
      now: at,
    });
    if (!reserved.ok) return overQuota(reply, reserved.message);
    let answer: Awaited<ReturnType<typeof searchGoogle>>;
    try {
      answer = await searchGoogle(places, input);
    } catch (error) {
      return googleFailed(request, reply, error);
    }
    for (const { error } of answer.failed)
      request.log.warn(
        { code: error.code, status: error.status },
        'prospecting: one place of a sweep failed',
      );
    const settings = await loadProspectingSettings(db);
    let assembled: Awaited<ReturnType<typeof assembleSearch>>;
    try {
      assembled = await assembleSearch(
        db,
        actor,
        answer,
        input,
        settings.icp,
        (username) => issueTicket(ticketKey, actor.employeeId, username, at),
        (place) => issueFinderTicket(finderKey, actor.employeeId, place, at),
        at,
      );
    } catch (error) {
      // A failed query's message carries its parameters (Google's phones): only the code is kept.
      request.log.error(
        { code: (error as { cause?: { code?: string } }).cause?.code },
        'prospecting: joining the results failed',
      );
      return reply.status(500).send({
        error: 'search_failed',
        message: 'Não foi possível cruzar os resultados agora. Tente de novo.',
      });
    }
    const { items, hidden } = assembled;
    return reply.send({
      items,
      nextPageToken: answer.nextPageToken,
      page: input.page,
      callsSpent: calls,
      hidden,
      failedPlaces: answer.failed.map(({ place, error }) => ({ place, code: error.code })),
      usage: await usageOf(db, actor.employeeId, at),
    } satisfies ProspectSearchResponse);
  });

  // --- prospects (our data) ----------------------------------------------------------------

  app.get('/prospecting/prospects', use, async (request, reply) => {
    const query = listQuery.safeParse(request.query ?? {});
    if (!query.success) return invalid(reply, query.error);
    return reply.send(await listProspects(db, request.session.actor, query.data));
  });

  /** A reservation or discard that changed something leaves its audit entry (ids and statuses). */
  const auditClaim = async (
    request: FastifyRequest,
    actor: Actor,
    action: 'reserve' | 'discard',
    outcome: Extract<Awaited<ReturnType<typeof claimProspect>>, { ok: true }>,
    batch = false,
  ) => {
    if (!outcome.created && outcome.previousStatus === outcome.prospect.status) return;
    await writeAudit(db, {
      actorEmployeeId: actor.employeeId,
      action: action === 'reserve' ? 'prospect.reserved' : 'prospect.discarded',
      entity: 'prospect',
      entityId: outcome.prospect.id,
      ip: request.ip,
      metadata: {
        status: outcome.prospect.status,
        previousStatus: outcome.previousStatus,
        ...(batch ? { batch: true } : {}),
      },
    });
  };

  app.post('/prospecting/prospects', use, async (request, reply) => {
    const body = prospectClaimSchema.safeParse(request.body);
    if (!body.success) return invalid(reply, body.error);
    const actor = request.session.actor;
    const outcome = await claimProspect(db, actor, body.data, now());
    if (!outcome.ok) return refused(reply, outcome);
    await auditClaim(request, actor, body.data.action, outcome);
    return reply.status(outcome.created ? 201 : 200).send(outcome.prospect);
  });

  /** Reservar em lote, after the seller reviewed the ticked results: each one on its own. */
  app.post('/prospecting/prospects/batch', use, async (request, reply) => {
    const body = prospectBatchSchema.safeParse(request.body);
    if (!body.success) return invalid(reply, body.error);
    const actor = request.session.actor;
    const outcomes = await claimBatch(db, actor, body.data.placeIds, now());
    const results: ProspectBatchResponse['results'] = [];
    for (const { placeId, outcome } of outcomes) {
      if (outcome.ok) {
        await auditClaim(request, actor, 'reserve', outcome, true);
        results.push({ placeId, ok: true, prospect: outcome.prospect });
      } else results.push({ placeId, ok: false, error: outcome.error, message: outcome.message });
    }
    const reserved = results.filter((result) => result.ok).length;
    return reply.send({
      results,
      reserved,
      refused: results.length - reserved,
    } satisfies ProspectBatchResponse);
  });

  app.get('/prospecting/prospects/export.csv', exporting, async (request, reply) => {
    const query = listQuery.safeParse(request.query ?? {});
    if (!query.success) return invalid(reply, query.error);
    const actor = request.session.actor;
    const result = await exportProspects(db, actor, query.data);
    await writeAudit(db, {
      actorEmployeeId: actor.employeeId,
      action: 'prospecting.exported',
      entity: 'prospect_list',
      entityId: 'csv',
      ip: request.ip,
      metadata: {
        rows: result.count,
        filters: Object.keys(query.data).filter(
          (key) => query.data[key as keyof typeof query.data] !== undefined,
        ),
      },
    });
    const stamp = now().toISOString().slice(0, 10);
    return reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header('content-disposition', `attachment; filename="prospects-${stamp}.csv"`)
      .header('cache-control', 'no-store')
      .header('x-rows', String(result.count))
      .send(result.csv);
  });

  app.patch('/prospecting/prospects/:id', use, async (request, reply) => {
    const params = idParams.safeParse(request.params);
    if (!params.success) return notFound(reply);
    const body = prospectUpdateSchema.safeParse(request.body);
    if (!body.success) return invalid(reply, body.error);
    const actor = request.session.actor;
    const found = await prospectInReach(db, actor, params.data.id);
    if (!found) return notFound(reply);
    const outcome = await updateProspect(db, actor, found.row, body.data, now());
    if (!outcome.ok) return refused(reply, outcome);
    const { prospect, previous } = outcome;
    if (prospect.status !== previous.status)
      await writeAudit(db, {
        actorEmployeeId: actor.employeeId,
        action: 'prospect.status_changed',
        entity: 'prospect',
        entityId: prospect.id,
        ip: request.ip,
        metadata: { from: previous.status, to: prospect.status },
      });
    if (prospect.ownerEmployeeId !== previous.ownerEmployeeId)
      await writeAudit(db, {
        actorEmployeeId: actor.employeeId,
        action: 'prospect.transferred',
        entity: 'prospect',
        entityId: prospect.id,
        targetEmployeeId: prospect.ownerEmployeeId ?? undefined,
        ip: request.ip,
        metadata: {
          from: previous.ownerEmployeeId,
          to: prospect.ownerEmployeeId,
          status: prospect.status,
        },
      });
    return reply.send(prospect);
  });

  /** Abrir ficha: the live details of a saved prospect (1 ficha of the month). */
  app.get('/prospecting/prospects/:id/place', use, async (request, reply) => {
    if (!places) return notConfigured(reply);
    const params = idParams.safeParse(request.params);
    if (!params.success) return notFound(reply);
    const actor = request.session.actor;
    const found = await prospectInReach(db, actor, params.data.id);
    if (!found) return notFound(reply);
    const { row } = found;
    return placeAnswer(request, reply, places, row.placeId, async () => {
      // A converted prospect and a "do not contact" keep their status, checked in SQL (not on the
      // row read before Google answered): the lead, or the company's refusal, is what matters.
      const [changed] = await db
        .update(prospects)
        .set({ status: 'nao_encontrado', updatedAt: now() })
        .where(
          and(
            eq(prospects.id, row.id),
            notInArray(prospects.status, ['virou_lead', 'nao_contatar']),
          ),
        )
        .returning({ id: prospects.id });
      if (!changed) return;
      await writeAudit(db, {
        actorEmployeeId: actor.employeeId,
        action: 'prospect.not_found',
        entity: 'prospect',
        entityId: row.id,
        ip: request.ip,
        metadata: { previousStatus: row.status },
      });
    });
  });

  /** The lead card's "Dados do Google (ao vivo)", loaded on a click (1 ficha). */
  app.get('/prospecting/leads/:leadId/place', use, async (request, reply) => {
    if (!places) return notConfigured(reply);
    const params = leadParams.safeParse(request.params);
    if (!params.success) return notFound(reply);
    const lead = await leadInScope(db, request.session.actor, params.data.leadId, 'leads.read');
    if (!lead?.googlePlaceId)
      return reply
        .status(404)
        .send({ error: 'not_found', message: 'Esta negociação não veio da prospecção.' });
    return placeAnswer(request, reply, places, lead.googlePlaceId);
  });

  app.post('/prospecting/prospects/:id/enrich', use, async (request, reply) => {
    const params = idParams.safeParse(request.params);
    if (!params.success) return notFound(reply);
    const body = prospectEnrichSchema.safeParse(request.body);
    if (!body.success) return invalid(reply, body.error);
    const actor = request.session.actor;
    const found = await prospectInReach(db, actor, params.data.id);
    if (!found) return notFound(reply);
    const reading = await readCompanySite(body.data.website, {
      transport: app.wings.siteTransport,
    });
    const at = now();
    // t086: with the search's ticket, the click also tries Meta and the web when the site had no link.
    const company = body.data.findTicket
      ? readFinderTicket(finderKey, actor.employeeId, body.data.findTicket, at)
      : null;
    const tried =
      company && company.placeId === found.row.placeId
        ? await findInstagram(
            finderDeps(actor.employeeId, at),
            { ...company, website: body.data.website },
            { reading },
          )
        : null;
    const enrichment: ProspectEnrichment = {
      ...(found.row.enrichment as ProspectEnrichment),
      ...Object.fromEntries(
        Object.entries(reading.found).map(([key, value]) => [
          key,
          { value, source: PROSPECT_ENRICHMENT_SOURCE, at: at.toISOString() },
        ]),
      ),
      ...(!reading.found.instagram && tried?.instagram
        ? {
            instagram: {
              value: `https://www.instagram.com/${tried.instagram.username}/`,
              source: tried.instagram.source,
              at: at.toISOString(),
            },
          }
        : {}),
    };
    const [updated] = await db
      .update(prospects)
      .set({ enrichment, updatedAt: at })
      .where(eq(prospects.id, found.row.id))
      .returning();
    await writeAudit(db, {
      actorEmployeeId: actor.employeeId,
      action: 'prospect.enriched',
      entity: 'prospect',
      entityId: found.row.id,
      ip: request.ip,
      metadata: {
        found: [
          ...new Set([...Object.keys(reading.found), ...(tried?.instagram ? ['instagram'] : [])]),
        ],
        pagesRead: reading.pagesRead,
      },
    });
    return reply.send({
      prospect: toProspect(updated!, found.ownerName, actor),
      pagesRead: reading.pagesRead,
      skipped: reading.skipped,
      ...(tried && !tried.instagram ? { instagramReasons: tried.miss?.reasons ?? [] } : {}),
    } satisfies ProspectEnrichResponse);
  });

  /** Sugerir abordagem: the AI drafts the first contact from our data only; nothing is sent. */
  app.post('/prospecting/prospects/:id/approach', use, async (request, reply) => {
    if (!llm)
      return reply
        .status(503)
        .send({ error: 'ai_unavailable', message: 'A IA não está configurada neste ambiente.' });
    const params = idParams.safeParse(request.params);
    if (!params.success) return notFound(reply);
    const body = prospectApproachSchema.safeParse(request.body);
    if (!body.success) return invalid(reply, body.error);
    const actor = request.session.actor;
    const found = await prospectInReach(db, actor, params.data.id);
    if (!found) return notFound(reply);
    if (found.row.status === 'nao_contatar')
      return reply.status(409).send({
        error: 'prospect_do_not_contact',
        message: 'A empresa pediu para não ser contatada.',
      });
    const at = now();
    if (
      (await aiCallsToday(db, actor.employeeId, APPROACH_AUDIT_ACTION, at)) >=
      PROSPECT_APPROACH_DAILY_MAX
    )
      return reply.status(429).send({
        error: 'approach_quota',
        message: `Você já pediu ${PROSPECT_APPROACH_DAILY_MAX} sugestões hoje. Amanhã tem mais.`,
      });
    // Counted before the call: a call that failed may have cost too.
    await writeAudit(db, {
      actorEmployeeId: actor.employeeId,
      action: APPROACH_AUDIT_ACTION,
      entity: 'prospect',
      entityId: found.row.id,
      ip: request.ip,
      metadata: { channel: body.data.channel },
    });
    let approach: Awaited<ReturnType<typeof suggestApproach>>;
    try {
      approach = await suggestApproach(llm, found.row, body.data);
    } catch (error) {
      if (!(error instanceof LlmError)) throw error;
      return reply.status(502).send({
        error: 'ai_failed',
        message: 'A IA não respondeu agora. Tente de novo em instantes.',
      });
    }
    if (!approach)
      return reply.status(502).send({
        error: 'ai_failed',
        message: 'A IA não conseguiu sugerir agora. Tente de novo.',
      });
    return reply.send(approach);
  });

  app.post('/prospecting/prospects/:id/lead', createLead, async (request, reply) => {
    const params = idParams.safeParse(request.params);
    if (!params.success) return notFound(reply);
    const body = prospectLeadSchema.safeParse(request.body);
    if (!body.success) return invalid(reply, body.error);
    const actor = request.session.actor;
    const found = await prospectInReach(db, actor, params.data.id);
    if (!found) return notFound(reply);
    const outcome = await convertProspect(db, actor, found.row, body.data, now());
    if (!outcome.ok) return refused(reply, outcome);
    await writeAudit(db, {
      actorEmployeeId: actor.employeeId,
      action: 'prospect.converted',
      entity: 'prospect',
      entityId: found.row.id,
      ip: request.ip,
      metadata: {
        leadId: outcome.leadId,
        created: outcome.created,
        followUp: Boolean(body.data.followUpAt),
      },
    });
    return reply.status(outcome.created ? 201 : 200).send({ leadId: outcome.leadId });
  });
};
