import {
  firstDirectMessage,
  grantedScope,
  IG_PRIVATE_REPLY_BLOCK_LABELS,
  privateReplyChangeDenial,
  instagramAttachSchema,
  instagramDiscardSchema,
  instagramDoNotContactSchema,
  instagramLeadSchema,
  instagramPasteSchema,
  instagramProspectingSettingsSchema,
  instagramProspectListQuery,
  instagramTransferSchema,
  normalizeInstagram,
  WINGS_CLIENT_ID,
  type Actor,
  type InstagramStatus,
} from '@wings/shared';
import { eq } from 'drizzle-orm';
import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import { z } from 'zod';
import { clients, employees } from '../../db/schema/index.js';
import { writeAudit } from '../../lib/audit.js';
import { createOpenRouterLlm, type AgentLlm } from '../agent/llm.js';
import { confirmPaste, pastesToday, previewPaste, readPaste, type Refusal } from './paste.js';
import {
  attachToLead,
  createLead,
  discard,
  doNotContact,
  instagramOwners,
  instagramOptOut,
  instagramProspectInReach,
  listInstagramProspects,
  type InstagramFound,
  listPasteBatches,
  markApproached,
  markWhatsAppAsked,
  promote,
  transfer,
} from './prospects.js';
import { loadInstagramSettings, saveInstagramSettings } from './settings.js';
import { instagramMessagingOf } from '../instagram/graph.js';
import { requestPrivateReply } from '../instagram/private-reply.js';

/**
 * Prospecção Instagram, parte 2 (docs/prospeccao/instagram.md §1.2, §9) and the queue of parte 1
 * (§1.4, "Comentários da Wings"). Every route needs `prospecting.instagram_paste`; pasting and
 * working a prospect also need `leads.write`, so Diretoria reads and changes nothing. With the
 * paste off (PROSPECT_AI_INSTAGRAM_PASTE_ENABLED) its routes answer 503; parte 1 has its own
 * switches (INSTAGRAM_WEBHOOK_ENABLED, INSTAGRAM_AUTO_REPLY_ENABLED). The only thing that reaches
 * Instagram from here is the click "Enviar resposta privada", through the gates of §5.3.
 */

const idParams = z.object({ id: z.uuid() });

export const instagramProspectingRoutes: FastifyPluginAsync = async (app) => {
  const { db, env } = app.wings;
  const now = () => app.wings.now?.() ?? new Date();
  const read = { preHandler: app.requirePermission('prospecting.instagram_paste') };
  const write = {
    preHandler: [
      app.requirePermission('prospecting.instagram_paste'),
      app.requirePermission('leads.write'),
    ],
  };
  const configure = { preHandler: app.requirePermission('prospect_ai.configure') };
  const llm: AgentLlm | null =
    app.wings.agentLlm ??
    (env.OPENROUTER_API_KEY ? createOpenRouterLlm({ apiKey: env.OPENROUTER_API_KEY }) : null);
  const aiEnabled = env.PROSPECT_AI_CLASSIFIER_ENABLED && llm !== null;

  const off = (reply: FastifyReply) =>
    reply.status(503).send({
      error: 'instagram_colagem_desligada',
      message:
        'A Prospecção Instagram está desligada: espera o OK do Jurídico e a política de privacidade.',
    });
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

  /** Wings' own @, from the Wings client record: its comments are never prospects. */
  const wingsUsername = async () => {
    const wings = await db.query.clients.findFirst({ where: eq(clients.id, WINGS_CLIENT_ID) });
    const handle = (wings?.social as Record<string, string> | undefined)?.instagram;
    return handle ? normalizeInstagram(handle) : null;
  };

  app.get('/prospect-ai/instagram/status', read, async (request) => {
    const status: InstagramStatus = {
      enabled: env.PROSPECT_AI_INSTAGRAM_PASTE_ENABLED,
      webhookEnabled: env.INSTAGRAM_WEBHOOK_ENABLED === 'true',
      replyEnabled: instagramMessagingOf(env) !== null,
      aiEnabled,
      settings: await loadInstagramSettings(db),
      pastesToday: await pastesToday(db, request.session.actor.employeeId, now()),
    };
    return status;
  });

  app.post('/prospect-ai/instagram/pastes/preview', write, async (request, reply) => {
    if (!env.PROSPECT_AI_INSTAGRAM_PASTE_ENABLED) return off(reply);
    const body = instagramPasteSchema.safeParse(request.body);
    if (!body.success) return invalid(reply, body.error);
    const parsed = readPaste(body.data, await loadInstagramSettings(db), await wingsUsername());
    if ('ok' in parsed) return refused(reply, parsed);
    return previewPaste(db, request.session.actor, parsed, { aiEnabled, now: now() });
  });

  app.post('/prospect-ai/instagram/pastes', write, async (request, reply) => {
    if (!env.PROSPECT_AI_INSTAGRAM_PASTE_ENABLED) return off(reply);
    const body = instagramPasteSchema.safeParse(request.body);
    if (!body.success) return invalid(reply, body.error);
    const settings = await loadInstagramSettings(db);
    const parsed = readPaste(body.data, settings, await wingsUsername());
    if ('ok' in parsed) return refused(reply, parsed);
    const result = await confirmPaste(db, request.session.actor, parsed, {
      settings,
      llm,
      aiEnabled,
      dailyUsd: env.PROSPECT_AI_DAILY_USD,
      now: now(),
    });
    if ('ok' in result) return refused(reply, result);
    return result;
  });

  app.post('/prospect-ai/instagram/pastes/attach', write, async (request, reply) => {
    if (!env.PROSPECT_AI_INSTAGRAM_PASTE_ENABLED) return off(reply);
    const body = instagramAttachSchema.safeParse(request.body);
    if (!body.success) return invalid(reply, body.error);
    const result = await attachToLead(db, request.session.actor, body.data, now());
    if (!result.ok) return refused(reply, result);
    return result;
  });

  app.get('/prospect-ai/instagram/pastes', read, async (request, reply) => {
    if (!env.PROSPECT_AI_INSTAGRAM_PASTE_ENABLED) return off(reply);
    return { batches: await listPasteBatches(db, request.session.actor) };
  });

  app.get('/prospect-ai/instagram/prospects', read, async (request, reply) => {
    const query = instagramProspectListQuery.safeParse(request.query);
    if (!query.success) return invalid(reply, query.error);
    // Parte 1 (the webhook's comments) does not wait for the paste's switch.
    if (query.data.parte !== '1' && !env.PROSPECT_AI_INSTAGRAM_PASTE_ENABLED) return off(reply);
    return { prospects: await listInstagramProspects(db, request.session.actor, query.data) };
  });

  app.get('/prospect-ai/instagram/owners', read, async (request, reply) => {
    if (!env.PROSPECT_AI_INSTAGRAM_PASTE_ENABLED) return off(reply);
    return { owners: await instagramOwners(db) };
  });

  /**
   * "Copiar mensagem" (§8.2): the text with the seller's first name; null while no policy link.
   * The "não me contate" is checked here, at the moment the text is prepared (409 and closed).
   */
  app.get('/prospect-ai/instagram/prospects/:id/message', write, async (request, reply) => {
    if (!env.PROSPECT_AI_INSTAGRAM_PASTE_ENABLED) return off(reply);
    const params = idParams.safeParse(request.params);
    if (!params.success) return notFound(reply);
    const found = await instagramProspectInReach(db, request.session.actor, params.data.id);
    if (!found) return notFound(reply);
    const blocked = await instagramOptOut(db, request.session.actor, found, now());
    if (blocked) return refused(reply, blocked);
    const me = await db.query.employees.findFirst({
      where: eq(employees.id, request.session.actor.employeeId),
    });
    const message = firstDirectMessage(
      await loadInstagramSettings(db),
      me?.fullName ?? '',
      found.postOwner,
    );
    return {
      message,
      reason: message ? null : 'A política de privacidade ainda não tem link em Ajustes.',
    };
  });

  /** One action on one prospect: 404 out of reach, the service's refusal, or the prospect. */
  const action = (
    path: string,
    schema: z.ZodType | null,
    run: (found: InstagramFound, body: unknown, actor: Actor) => Promise<{ ok: true } | Refusal>,
  ) =>
    app.post(`/prospect-ai/instagram/prospects/:id/${path}`, write, async (request, reply) => {
      const params = idParams.safeParse(request.params);
      if (!params.success) return notFound(reply);
      const body = schema ? schema.safeParse(request.body ?? {}) : null;
      if (body && !body.success) return invalid(reply, body.error);
      const found = await instagramProspectInReach(db, request.session.actor, params.data.id);
      if (!found) return notFound(reply);
      if (found.row.source === 'instagram_colagem' && !env.PROSPECT_AI_INSTAGRAM_PASTE_ENABLED)
        return off(reply);
      const result = await run(found, body?.data, request.session.actor);
      if (!result.ok) return refused(reply, result);
      return result;
    });

  action('approached', null, async (found, _body, actor) =>
    markApproached(db, actor, found, await loadInstagramSettings(db), now()),
  );
  action('promote', null, (found, _body, actor) => promote(db, actor, found, now()));
  action('discard', instagramDiscardSchema, (found, body, actor) =>
    discard(db, actor, found, (body as z.infer<typeof instagramDiscardSchema>).reason, now()),
  );
  action('do-not-contact', instagramDoNotContactSchema, (found, body, actor) =>
    doNotContact(
      db,
      actor,
      found,
      (body as z.infer<typeof instagramDoNotContactSchema>).reason || null,
      now(),
    ),
  );
  action('lead', instagramLeadSchema, (found, body, actor) =>
    createLead(db, actor, found, body as z.infer<typeof instagramLeadSchema>, now()),
  );
  action('transfer', instagramTransferSchema, async (found, body, actor) =>
    transfer(
      db,
      actor,
      found,
      (body as z.infer<typeof instagramTransferSchema>).ownerEmployeeId,
      await loadInstagramSettings(db),
      now(),
    ),
  );

  action('whatsapp-asked', null, (found, _body, actor) =>
    markWhatsAppAsked(db, actor, found, now()),
  );

  /**
   * "Enviar resposta privada" (§5.2): the opportunity's owner or a manager, on a comment of
   * parte 1 still in "Quer comprar". The gates and the one call are `requestPrivateReply`'s.
   */
  action('private-reply', null, async (found, _body, actor) => {
    if (found.row.source === 'instagram_colagem')
      return {
        ok: false,
        status: 409,
        error: 'fora_da_fila',
        message: 'A resposta privada é só para comentários nos posts e anúncios da Wings.',
      };
    const result = await requestPrivateReply(
      {
        db,
        fetch: app.wings.instagramFetch ?? fetch,
        config: instagramMessagingOf(env),
        settings: await loadInstagramSettings(db),
        now: now(),
      },
      found.row.id,
      'clique',
      actor.employeeId,
    );
    if (result.ok) return { ok: true, status: result.status };
    const message =
      result.block === 'ja_tratado'
        ? 'Este comentário já teve a sua resposta privada.'
        : result.block === 'fora_da_fila'
          ? 'Só um prospect em "Quer comprar" recebe a resposta privada.'
          : IG_PRIVATE_REPLY_BLOCK_LABELS[result.block];
    return {
      ok: false,
      status: result.block === 'limite_hora' ? 429 : 409,
      error: result.block,
      message,
    };
  });

  app.put('/prospect-ai/instagram/settings', configure, async (request, reply) => {
    const body = instagramProspectingSettingsSchema.safeParse(request.body);
    if (!body.success) return invalid(reply, body.error);
    const before = await loadInstagramSettings(db);
    const denied = privateReplyChangeDenial(
      before.privateReply,
      body.data.privateReply,
      grantedScope(request.session.actor, 'prospect_ai.instagram_auto_reply') !== null,
      before.messages.linkPolitica !== body.data.messages.linkPolitica,
    );
    if (denied) return reply.status(403).send({ error: 'forbidden', message: denied });
    await saveInstagramSettings(db, body.data, request.session.actor.employeeId, now());
    await writeAudit(db, {
      actorEmployeeId: request.session.actor.employeeId,
      action: 'prospect_ai.instagram_settings_changed',
      entity: 'prospect_ai_settings',
      metadata: { before, after: body.data },
    });
    return { settings: body.data };
  });
};
