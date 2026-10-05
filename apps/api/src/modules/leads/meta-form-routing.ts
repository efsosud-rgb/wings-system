import type { LeadPipeline } from '@wings/shared';
import { and, eq } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import { crmNotifications, employees, metaLeadForms, roles } from '../../db/schema/index.js';
import { brandKey } from './brands.js';
import { listBrands } from './deal.js';

// --- a form without a rule -------------------------------------------------------------------

export interface FormClassification {
  pipeline: LeadPipeline;
  brand: string | null;
  clientId: string | null;
  /** True when nothing said which funnel: the lead went to Formatação and someone should look. */
  guessed: boolean;
}

/**
 * The funnel of a form nobody wrote a rule for, from the form's own name:
 * "formatação" → Formatação; a registered Expansão brand's name → Expansão
 * with that brand; anything else → Formatação, flagged as a guess.
 */
export async function classifyUnruledForm(
  db: Database,
  formId: string | null,
): Promise<FormClassification> {
  const form = formId
    ? await db.query.metaLeadForms.findFirst({ where: eq(metaLeadForms.formId, formId) })
    : null;
  return classifyFormName(db, form?.name ?? null);
}

/** Same reading for a form whose name arrives with the lead (TikTok has no form catalogue here). */
export async function classifyFormName(
  db: Database,
  formName: string | null,
): Promise<FormClassification> {
  const key = brandKey(formName ?? '');
  if (key) {
    if (/\bformata/.test(key))
      return { pipeline: 'formatacao', brand: null, clientId: null, guessed: false };
    const brands = await listBrands(db);
    const match = brands
      .map((brand) => ({ brand, key: brandKey(brand.name) }))
      .filter((item) => item.key && ` ${key} `.includes(` ${item.key} `))
      .sort((a, b) => b.key.length - a.key.length)[0];
    if (match)
      return {
        pipeline: 'expansao',
        brand: match.brand.name,
        clientId: match.brand.clientId,
        guessed: false,
      };
  }
  return { pipeline: 'formatacao', brand: null, clientId: null, guessed: true };
}

/** One notice per form (not per lead) to Diretoria: a form with no rule and no telling name. */
export async function noticeUnclassifiedForm(
  db: Database,
  formId: string | null,
  platform: 'meta' | 'tiktok' = 'meta',
): Promise<void> {
  const board = await db
    .select({ id: employees.id })
    .from(employees)
    .innerJoin(roles, eq(roles.id, employees.roleId))
    .where(and(eq(roles.key, 'diretoria'), eq(employees.status, 'active')));
  if (board.length === 0) return;
  await db
    .insert(crmNotifications)
    .values(
      board.map((person) => ({
        recipientEmployeeId: person.id,
        kind: 'automation',
        message:
          platform === 'tiktok'
            ? 'Um formulário da TikTok sem regra trouxe lead: ele entrou em Formatação. Crie a regra do formulário (Landing pages) para mandar ao funil certo.'
            : 'Um formulário do Meta sem regra trouxe lead: ele entrou em Formatação. Crie a regra do formulário (Landing pages) para mandar ao funil certo.',
        dedupeKey: `${platform}_form_unclassified:${formId ?? 'desconhecido'}:${person.id}`,
      })),
    )
    .onConflictDoNothing();
}
