import { createHash } from 'node:crypto';
import {
  LEAD_FORM_QUALIFIER_META_KEY,
  LEAD_FORM_QUESTIONS,
  leadFormFingerprint,
  WINGS_CLIENT_ID,
  type LeadForm,
} from '@wings/shared';
import { and, eq, isNotNull } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import { adLeadForms, leadSourceRules, metaLeadForms } from '../../db/schema/index.js';
import type { MetaLeadFormSpec } from './platform/types.js';

/**
 * Wings' standard lead form on Meta: the translation from the shared
 * definition to the Graph API's shape, the reuse of a form already created
 * (same questions, policy and thank-you on the same Page), and what must
 * exist the moment the form does, so its leads land in the right funnel:
 * the `meta_lead_forms` row the periodic read polls, and the
 * `lead_source_rules` row that names the funnel.
 */

/** sha-256 of the shared fingerprint: what `ad_lead_forms` is looked up by. */
export function leadFormHash(form: LeadForm): string {
  return createHash('sha256').update(leadFormFingerprint(form)).digest('hex');
}

/** A slug for Meta's custom-question keys: ascii, lower case, underscores. */
const keyOf = (text: string, index: number) => {
  const slug = text
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);
  return slug || `opcao_${index + 1}`;
};

/**
 * The form as Meta takes it. The multiple-choice question goes first (when
 * on), keyed `qualificacao` so the intake never reads its answer as a field;
 * the five contact questions follow with the keys `lead-fields.ts` maps.
 */
export function metaLeadFormSpecOf(input: {
  form: LeadForm;
  pageId: string;
  name: string;
}): MetaLeadFormSpec {
  const { form } = input;
  const questions: MetaLeadFormSpec['questions'] = [];
  if (form.qualifier) {
    questions.push({
      type: 'CUSTOM',
      key: LEAD_FORM_QUALIFIER_META_KEY,
      label: form.qualifier.question,
      options: form.qualifier.options.map((option, index) => ({
        value: option,
        key: keyOf(option, index),
      })),
    });
  }
  for (const question of LEAD_FORM_QUESTIONS) {
    questions.push(
      question.metaType === 'CUSTOM'
        ? { type: 'CUSTOM', key: question.metaKey, label: question.label }
        : { type: question.metaType, key: question.metaKey },
    );
  }
  return {
    pageId: input.pageId,
    name: input.name,
    questions,
    privacyPolicy: { url: form.privacyPolicyUrl, linkText: 'Política de Privacidade' },
    thankYou: {
      title: form.thankYou.title,
      body: form.thankYou.body,
      buttonText: form.thankYou.buttonText,
      buttonUrl: form.thankYou.buttonUrl,
    },
    locale: 'pt_BR',
  };
}

/** A Meta form this system already created on the Page with the same definition, newest first. */
export async function reusableLeadForm(
  db: Database,
  input: { pageId: string; form: LeadForm },
): Promise<{ externalId: string; name: string } | null> {
  const rows = await db
    .select({
      externalId: adLeadForms.externalId,
      name: adLeadForms.name,
      createdAt: adLeadForms.createdAt,
    })
    .from(adLeadForms)
    .where(
      and(
        eq(adLeadForms.platform, 'meta'),
        eq(adLeadForms.pageId, input.pageId),
        eq(adLeadForms.fingerprint, leadFormHash(input.form)),
        isNotNull(adLeadForms.externalId),
      ),
    );
  const newest = rows.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
  return newest?.externalId ? { externalId: newest.externalId, name: newest.name } : null;
}

/**
 * What exists the moment a form exists on Meta: our record of it (for reuse
 * and the trail), the `meta_lead_forms` row the periodic read polls, and the
 * funnel rule on the form's id. Idempotent: a form registered twice (a reuse)
 * changes nothing that is already there, and a rule someone wrote by hand for
 * this form id is kept as it is.
 */
export async function registerLeadFormIntake(
  db: Database,
  input: {
    pageId: string;
    pageName?: string | null;
    formExternalId: string;
    name: string;
    form: LeadForm;
    executionId: string | null;
    createdBy: string | null;
  },
): Promise<{ ruleCreated: boolean }> {
  await db.insert(adLeadForms).values({
    platform: 'meta',
    pageId: input.pageId,
    fingerprint: leadFormHash(input.form),
    // The funnel is the rule's, not the form's: kept out of the spec so a
    // reuse with another funnel finds the same form.
    spec: { ...input.form, funnel: undefined },
    name: input.name,
    externalId: input.formExternalId,
    executionId: input.executionId,
    createdBy: input.createdBy,
  });

  await db
    .insert(metaLeadForms)
    .values({
      formId: input.formExternalId,
      pageId: input.pageId,
      pageName: input.pageName ?? null,
      name: input.name,
      status: 'ACTIVE',
    })
    .onConflictDoNothing();

  const inserted = await db
    .insert(leadSourceRules)
    .values({
      kind: 'meta_form',
      pattern: input.formExternalId,
      // A rule names a client or a brand; Wings' own funnels are Wings Company's.
      clientId: input.form.funnel.clientId ?? (input.form.funnel.brand ? null : WINGS_CLIENT_ID),
      pipeline: input.form.funnel.pipeline,
      brand: input.form.funnel.brand,
      // A lead-ad form's deals are the CRM's own; RD gets a copy through the
      // lead intake's own rule, never a second deal from here.
      rdDealIntake: false,
      createdBy: input.createdBy,
    })
    .onConflictDoNothing()
    .returning({ id: leadSourceRules.id });
  return { ruleCreated: inserted.length > 0 };
}
