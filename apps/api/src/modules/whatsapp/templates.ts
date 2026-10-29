import {
  templateParamCount,
  waTemplateFields,
  type WaManagedTemplate,
  type WaTemplateEdit,
} from '@wings/shared';
import type { Database } from '../../db/client.js';
import { eq } from 'drizzle-orm';
import { waNumberTemplates, waTemplates } from '../../db/schema/index.js';
import {
  errorText,
  listWhatsAppTemplates,
  TEMPLATE_LIST_MAX,
  type WhatsAppConfig,
} from './graph.js';
import { asksCallPermission, templateBody } from './template-send.js';

/**
 * The template list as Meta has it, kept in `wa_templates` (every status, with
 * Meta's reason for a refusal), and the components a template is written with
 * on the Modelos screen. The fields of each {{n}} stay ours: a sync never
 * touches them.
 */

/** Reads Meta's list into the table. The reason in Portuguese when it could not. */
export async function syncTemplates(
  db: Database,
  fetchImpl: typeof fetch,
  config: WhatsAppConfig & { wabaId: string },
  at: Date,
): Promise<string | null> {
  const listed = await listWhatsAppTemplates(fetchImpl, config);
  if (!listed.ok) return errorText(listed.code, listed.title);
  const names = new Set(listed.data.map((t) => `${t.name}|${t.language}`));
  for (const t of listed.data) {
    if (!t.name || !t.language || !t.status) continue;
    const row = {
      metaId: t.id ?? null,
      category: t.category ?? null,
      status: t.status,
      rejectedReason: reasonOf(t.rejected_reason),
      components: (t.components ?? []) as object[],
      syncedAt: at,
    };
    await db
      .insert(waTemplates)
      .values({ ...row, name: t.name, language: t.language })
      .onConflictDoUpdate({
        target: [waTemplates.tenantId, waTemplates.name, waTemplates.language],
        set: row,
      });
  }
  // Deleted at Meta: gone here too, unless the list hit the page limit (then it may be cut short).
  if (listed.data.length < TEMPLATE_LIST_MAX)
    for (const stored of await db
      .select({ id: waTemplates.id, name: waTemplates.name, language: waTemplates.language })
      .from(waTemplates))
      if (!names.has(`${stored.name}|${stored.language}`))
        await db.delete(waTemplates).where(eq(waTemplates.id, stored.id));
  return null;
}

/**
 * A work number's own templates (its WABA's), read into `wa_number_templates`: the same reading
 * as the official list, kept per number, never mixed with the official one.
 */
export async function syncNumberTemplates(
  db: Database,
  fetchImpl: typeof fetch,
  numberId: string,
  config: WhatsAppConfig & { wabaId: string },
  at: Date,
): Promise<string | null> {
  const listed = await listWhatsAppTemplates(fetchImpl, config);
  if (!listed.ok) return errorText(listed.code, listed.title);
  const names = new Set(listed.data.map((t) => `${t.name}|${t.language}`));
  for (const t of listed.data) {
    if (!t.name || !t.language || !t.status) continue;
    const row = {
      metaId: t.id ?? null,
      category: t.category ?? null,
      status: t.status,
      rejectedReason: reasonOf(t.rejected_reason),
      components: (t.components ?? []) as object[],
      syncedAt: at,
    };
    await db
      .insert(waNumberTemplates)
      .values({ ...row, numberId, name: t.name, language: t.language })
      .onConflictDoUpdate({
        target: [waNumberTemplates.numberId, waNumberTemplates.name, waNumberTemplates.language],
        set: row,
      });
  }
  if (listed.data.length < TEMPLATE_LIST_MAX)
    for (const stored of await db
      .select({
        id: waNumberTemplates.id,
        name: waNumberTemplates.name,
        language: waNumberTemplates.language,
      })
      .from(waNumberTemplates)
      .where(eq(waNumberTemplates.numberId, numberId)))
      if (!names.has(`${stored.name}|${stored.language}`))
        await db.delete(waNumberTemplates).where(eq(waNumberTemplates.id, stored.id));
  return null;
}

/** Meta says NONE when nothing was refused. */
export const reasonOf = (reason: string | null | undefined) =>
  reason && reason !== 'NONE' ? reason : null;

interface Component {
  type?: string;
  format?: string;
  text?: string;
  buttons?: { type?: string; text?: string }[];
}

const listOf = (components: unknown): Component[] =>
  Array.isArray(components)
    ? (components as Component[]).filter((c) => c && typeof c === 'object')
    : [];

/**
 * The components sent to Meta. An edit keeps the header as Meta has it (the art
 * of the `_arte` versions is uploaded only when the template is created).
 */
export function componentsFor(draft: WaTemplateEdit, keep: unknown = []): object[] {
  const header = listOf(keep).find((c) => c.type === 'HEADER');
  // The form edits only the quick replies: a link or phone button stays as Meta has it.
  const kept = (listOf(keep).find((c) => c.type === 'BUTTONS')?.buttons ?? []).filter(
    (b) => b.type !== 'QUICK_REPLY',
  );
  const buttons = [...draft.buttons.map((text) => ({ type: 'QUICK_REPLY', text })), ...kept];
  return [
    ...(header ? [header] : []),
    {
      type: 'BODY',
      text: draft.body,
      ...(draft.examples.length > 0 ? { example: { body_text: [draft.examples] } } : {}),
    },
    ...(draft.footer ? [{ type: 'FOOTER', text: draft.footer }] : []),
    ...(buttons.length > 0 ? [{ type: 'BUTTONS', buttons }] : []),
    // shortcut: Meta's call-permission template component as documented, not yet sent to Meta for real.
    ...(draft.callPermission ? [{ type: 'call_permission_request' }] : []),
  ];
}

/** A row of the table as the Modelos screen shows it. */
export function managedOf(row: typeof waTemplates.$inferSelect): WaManagedTemplate {
  const components = listOf(row.components);
  const body = templateBody(row.components);
  const paramCount = templateParamCount(body);
  return {
    id: row.id,
    name: row.name,
    language: row.language,
    category: row.category,
    status: row.status,
    rejectedReason: row.rejectedReason,
    body,
    footer: components.find((c) => c.type === 'FOOTER')?.text ?? null,
    buttons: (components.find((c) => c.type === 'BUTTONS')?.buttons ?? [])
      .filter((b) => b.type === 'QUICK_REPLY' && b.text)
      .map((b) => b.text!),
    header: components.find((c) => c.type === 'HEADER')?.format ?? null,
    callPermission: asksCallPermission(row),
    paramCount,
    fields: row.fields?.length === paramCount ? row.fields : waTemplateFields(row.name, paramCount),
    syncedAt: row.syncedAt.toISOString(),
  };
}
