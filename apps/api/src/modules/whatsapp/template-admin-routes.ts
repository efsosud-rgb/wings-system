import {
  templateParamCount,
  waTemplateCreateSchema,
  waTemplateEditSchema,
  waTemplateFieldsSchema,
  type WaManagedTemplates,
} from '@wings/shared';
import { and, asc, eq } from 'drizzle-orm';
import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import { z } from 'zod';
import { waTemplates } from '../../db/schema/index.js';
import { writeAudit } from '../../lib/audit.js';
import {
  createWhatsAppTemplate,
  editWhatsAppTemplate,
  errorText,
  whatsappConfigOf,
} from './graph.js';
import { templateBody } from './template-send.js';
import { componentsFor, managedOf, syncTemplates } from './templates.js';

/**
 * CRM Vendas → WhatsApp → Modelos (Eric, 26/10; docs/whatsapp/modelos.md):
 * write a template and send it to Meta's review, edit the words of one
 * (back to review), and say what fills each {{n}} with its fallback (ours
 * only, Meta sees nothing). Admin Master and Diretoria
 * (`whatsapp_templates.manage`). Nothing here sends a message to anyone.
 */

const idParams = z.object({ id: z.uuid() });
/** Meta lets these be edited; PENDING waits for its answer. */
const EDITABLE = new Set(['APPROVED', 'REJECTED', 'PAUSED']);

const invalid = (reply: FastifyReply, error: z.ZodError) =>
  reply
    .status(400)
    .send({ error: 'invalid_request', message: error.issues[0]?.message ?? 'Dados inválidos.' });

export const whatsappTemplateAdminRoutes: FastifyPluginAsync = async (app) => {
  const { db, env } = app.wings;
  const now = () => app.wings.now?.() ?? new Date();
  const fetchImpl = () => app.wings.whatsappFetch ?? fetch;
  const manage = { preHandler: app.requirePermission('whatsapp_templates.manage') };
  const configWithWaba = () => {
    const config = whatsappConfigOf(env);
    return config?.wabaId ? { ...config, wabaId: config.wabaId } : null;
  };
  const off = (reply: FastifyReply) =>
    reply.status(503).send({
      error: 'whatsapp_off',
      message: 'O WhatsApp do sistema não está configurado (token, número ou conta).',
    });
  const metaRefused = (reply: FastifyReply, code: number | null, title: string | null) =>
    reply.status(502).send({
      error: 'meta_refused',
      message: `A Meta recusou: ${errorText(code, title) ?? 'sem motivo'}${title ? ` (${title})` : ''}`,
    });

  app.get('/whatsapp/templates/manage', manage, async (_request, reply) => {
    const config = configWithWaba();
    const syncError = config
      ? await syncTemplates(db, fetchImpl(), config, now())
      : 'O WhatsApp do sistema não está configurado: a lista é a da última leitura.';
    const rows = await db
      .select()
      .from(waTemplates)
      .orderBy(asc(waTemplates.name), asc(waTemplates.language));
    const answer: WaManagedTemplates = {
      templates: rows.map(managedOf),
      syncError,
      configured: config !== null,
    };
    return reply.send(answer);
  });

  app.post('/whatsapp/templates/manage', manage, async (request, reply) => {
    const body = waTemplateCreateSchema.safeParse(request.body);
    if (!body.success) return invalid(reply, body.error);
    const config = configWithWaba();
    if (!config) return off(reply);
    const draft = body.data;
    const [taken] = await db
      .select({ id: waTemplates.id })
      .from(waTemplates)
      .where(and(eq(waTemplates.name, draft.name), eq(waTemplates.language, draft.language)));
    if (taken)
      return reply.status(409).send({
        error: 'template_exists',
        message: 'Já existe um modelo com esse nome e idioma. Edite o que existe ou mude o nome.',
      });
    const components = componentsFor(draft);
    const created = await createWhatsAppTemplate(fetchImpl(), config, {
      name: draft.name,
      language: draft.language,
      category: draft.category,
      components,
    });
    if (!created.ok) return metaRefused(reply, created.code, created.title);
    const [row] = await db
      .insert(waTemplates)
      .values({
        metaId: created.data.id ?? null,
        name: draft.name,
        language: draft.language,
        category: created.data.category ?? draft.category,
        status: created.data.status ?? 'PENDING',
        components,
        fields: draft.fields,
        syncedAt: now(),
      })
      .returning();
    await writeAudit(db, {
      actorEmployeeId: request.session.actor.employeeId,
      action: 'whatsapp_template.created',
      entity: 'wa_templates',
      entityId: row!.id,
      ip: request.ip,
      metadata: { name: draft.name, language: draft.language, category: draft.category },
    });
    return reply.status(201).send({ template: managedOf(row!) });
  });

  app.put('/whatsapp/templates/manage/:id', manage, async (request, reply) => {
    const params = idParams.safeParse(request.params);
    if (!params.success) return reply.status(404).send({ error: 'not_found' });
    const body = waTemplateEditSchema.safeParse(request.body);
    if (!body.success) return invalid(reply, body.error);
    const config = configWithWaba();
    if (!config) return off(reply);
    const [current] = await db.select().from(waTemplates).where(eq(waTemplates.id, params.data.id));
    if (!current?.metaId)
      return reply.status(404).send({ error: 'not_found', message: 'Modelo não encontrado.' });
    if (!EDITABLE.has(current.status))
      return reply.status(409).send({
        error: 'template_pending',
        message: 'A Meta ainda está analisando este modelo: espere a resposta para editar.',
      });
    const components = componentsFor(body.data, current.components);
    const edited = await editWhatsAppTemplate(fetchImpl(), config, current.metaId, components);
    if (!edited.ok) return metaRefused(reply, edited.code, edited.title);
    const [row] = await db
      .update(waTemplates)
      .set({
        components,
        fields: body.data.fields,
        status: 'PENDING',
        rejectedReason: null,
        syncedAt: now(),
      })
      .where(eq(waTemplates.id, current.id))
      .returning();
    await writeAudit(db, {
      actorEmployeeId: request.session.actor.employeeId,
      action: 'whatsapp_template.edited',
      entity: 'wa_templates',
      entityId: current.id,
      ip: request.ip,
      metadata: { name: current.name, language: current.language, previousStatus: current.status },
    });
    return reply.send({ template: managedOf(row!) });
  });

  app.put('/whatsapp/templates/manage/:id/fields', manage, async (request, reply) => {
    const params = idParams.safeParse(request.params);
    if (!params.success) return reply.status(404).send({ error: 'not_found' });
    const body = waTemplateFieldsSchema.safeParse(request.body);
    if (!body.success) return invalid(reply, body.error);
    const [current] = await db.select().from(waTemplates).where(eq(waTemplates.id, params.data.id));
    if (!current)
      return reply.status(404).send({ error: 'not_found', message: 'Modelo não encontrado.' });
    if (body.data.fields.length !== templateParamCount(templateBody(current.components)))
      return reply.status(422).send({
        error: 'fields_count',
        message: 'Diga o que preenche cada campo {{n}} do texto, nem mais nem menos.',
      });
    const [row] = await db
      .update(waTemplates)
      .set({ fields: body.data.fields })
      .where(eq(waTemplates.id, current.id))
      .returning();
    await writeAudit(db, {
      actorEmployeeId: request.session.actor.employeeId,
      action: 'whatsapp_template.fields_changed',
      entity: 'wa_templates',
      entityId: current.id,
      ip: request.ip,
      metadata: { name: current.name, language: current.language },
    });
    return reply.send({ template: managedOf(row!) });
  });
};
