import { z } from 'zod';
import { LEAD_FIELD_LABELS, type LeadFieldKey } from '../lead-fields.js';
import { LEAD_PIPELINES } from '../leads.js';

/**
 * Wings' standard lead form, the one every lead campaign asks (Eric,
 * 2026-10-06): five required contact questions, an optional multiple-choice
 * question before them (off by default), the privacy policy and the thank-you
 * screen. One definition for the Meta instant form and for the site page
 * (`/lp/<slug>`), so answers land in the same lead fields on both.
 *
 * The question texts are the labels of `lead-fields.ts`, and the test asserts
 * that each one maps back to its field through `leadFieldOfQuestion`: a form
 * whose answers fell into "Respostas do formulário" instead of the lead's own
 * columns would be a silent bug.
 */

export const LEAD_FORM_FIELDS = [
  'name',
  'whatsapp',
  'companyName',
  'instagram',
  'website',
] as const;
export type LeadFormFieldKey = (typeof LEAD_FORM_FIELDS)[number];

/** How Meta names each question on the wire; a `CUSTOM` question is known by its `key`. */
export type MetaQuestionType = 'FULL_NAME' | 'PHONE' | 'COMPANY_NAME' | 'CUSTOM';

export interface LeadFormQuestion {
  field: LeadFormFieldKey;
  /** The question as the person reads it. */
  label: string;
  metaType: MetaQuestionType;
  /** Meta's `field_data[].name` for this answer: what the intake maps by. */
  metaKey: string;
  /** Example answer for previews: fictitious, never a real person's. */
  sample: string;
}

export const LEAD_FORM_QUESTIONS: readonly LeadFormQuestion[] = [
  {
    field: 'name',
    label: LEAD_FIELD_LABELS.name,
    metaType: 'FULL_NAME',
    metaKey: 'full_name',
    sample: 'Ana Exemplo',
  },
  {
    field: 'whatsapp',
    label: LEAD_FIELD_LABELS.whatsapp,
    metaType: 'PHONE',
    metaKey: 'phone_number',
    sample: '+55 21 99999-0000',
  },
  {
    field: 'companyName',
    label: LEAD_FIELD_LABELS.companyName,
    metaType: 'COMPANY_NAME',
    metaKey: 'company_name',
    sample: 'Padaria Exemplo',
  },
  {
    field: 'instagram',
    label: 'Instagram da empresa',
    metaType: 'CUSTOM',
    metaKey: 'instagram',
    sample: '@padariaexemplo',
  },
  {
    field: 'website',
    label: 'Site da empresa',
    metaType: 'CUSTOM',
    metaKey: 'site',
    sample: 'padariaexemplo.com.br',
  },
];

/** The lead field each question fills, for the intake and the tests. */
export const LEAD_FORM_FIELD_OF_KEY: Record<LeadFormFieldKey, LeadFieldKey> = {
  name: 'name',
  whatsapp: 'whatsapp',
  companyName: 'companyName',
  instagram: 'instagram',
  website: 'website',
};

// --- the optional multiple-choice question --------------------------------------------------

export const LEAD_FORM_QUALIFIER_QUESTION_MAX = 80;
export const LEAD_FORM_QUALIFIER_OPTION_MAX = 40;
export const LEAD_FORM_QUALIFIER_MIN_OPTIONS = 2;
export const LEAD_FORM_QUALIFIER_MAX_OPTIONS = 5;

/** The suggestion the builder offers when the question is switched on. */
export const LEAD_FORM_QUALIFIER_SUGGESTION = {
  question: 'Quantas unidades você tem hoje?',
  options: ['1', '2 a 5', '6 a 20', 'Mais de 20'],
} as const;

/**
 * Meta's `field_data[].name` for the multiple-choice answer. Fixed, and chosen
 * so `leadFieldOfQuestion` maps it to no field: the intake reads answers by
 * this key, and a question worded "…a sua empresa…" must never put "2 a 5"
 * in the company's name (the test guards it).
 */
export const LEAD_FORM_QUALIFIER_META_KEY = 'qualificacao';

export const leadFormQualifierSchema = z.object({
  question: z
    .string()
    .trim()
    .min(5, 'Escreva a pergunta')
    .max(
      LEAD_FORM_QUALIFIER_QUESTION_MAX,
      `Máximo de ${LEAD_FORM_QUALIFIER_QUESTION_MAX} caracteres`,
    ),
  options: z
    .array(
      z
        .string()
        .trim()
        .min(1, 'Escreva a opção')
        .max(
          LEAD_FORM_QUALIFIER_OPTION_MAX,
          `Máximo de ${LEAD_FORM_QUALIFIER_OPTION_MAX} caracteres`,
        ),
    )
    .min(LEAD_FORM_QUALIFIER_MIN_OPTIONS, `Pelo menos ${LEAD_FORM_QUALIFIER_MIN_OPTIONS} opções`)
    .max(LEAD_FORM_QUALIFIER_MAX_OPTIONS, `No máximo ${LEAD_FORM_QUALIFIER_MAX_OPTIONS} opções`)
    .refine(
      (options) => new Set(options.map((option) => option.toLowerCase())).size === options.length,
      'As opções não podem se repetir',
    ),
});
export type LeadFormQualifier = z.output<typeof leadFormQualifierSchema>;

// --- the thank-you screen -------------------------------------------------------------------

export const LEAD_FORM_THANK_YOU_TITLE_MAX = 60;
export const LEAD_FORM_THANK_YOU_BODY_MAX = 200;
export const LEAD_FORM_THANK_YOU_BUTTON_MAX = 30;

export const LEAD_FORM_THANK_YOU_DEFAULT = {
  title: 'Recebemos os seus dados',
  body: 'O time da Wings entra em contato pelo WhatsApp em até um dia útil.',
  buttonText: 'Conhecer a Wings',
} as const;

const httpsUrl = z.url({ protocol: /^https$/, error: 'Informe um endereço https:// válido' });

export const leadFormThankYouSchema = z.object({
  title: z
    .string()
    .trim()
    .min(1, 'Informe o título')
    .max(LEAD_FORM_THANK_YOU_TITLE_MAX, `Máximo de ${LEAD_FORM_THANK_YOU_TITLE_MAX} caracteres`),
  body: z
    .string()
    .trim()
    .min(1, 'Informe o texto')
    .max(LEAD_FORM_THANK_YOU_BODY_MAX, `Máximo de ${LEAD_FORM_THANK_YOU_BODY_MAX} caracteres`),
  buttonText: z
    .string()
    .trim()
    .min(1, 'Informe o texto do botão')
    .max(LEAD_FORM_THANK_YOU_BUTTON_MAX, `Máximo de ${LEAD_FORM_THANK_YOU_BUTTON_MAX} caracteres`),
  /** Where the button goes: the Wings site, by default the campaign's destination. */
  buttonUrl: httpsUrl,
});
export type LeadFormThankYou = z.output<typeof leadFormThankYouSchema>;

// --- the funnel rule born with the form -----------------------------------------------------

/**
 * Which funnel the form's leads go to. Created together with the form (as a
 * `lead_source_rules` row on the form's id), so a lead never lands in
 * Formatação only because nobody wrote the rule.
 */
export const leadFormFunnelSchema = z.object({
  pipeline: z.enum(LEAD_PIPELINES, { error: 'Escolha o funil' }),
  /** Expansão: the franchise brand; null for Formatação and Consultoria. */
  brand: z.string().trim().min(1).max(120).nullable().default(null),
  /** The client the brand belongs to, when registered. */
  clientId: z.uuid().nullable().default(null),
});
export type LeadFormFunnel = z.output<typeof leadFormFunnelSchema>;

// --- the whole form -------------------------------------------------------------------------

/**
 * The form without its funnel: what the site page (`/lp/<slug>`) keeps as its
 * `site_form_spec`, since the page's funnel is the page's own rule.
 */
export const siteFormSpecSchema = z.object({
  /** Off by default: it exists for campaigns that want one qualifying answer first. */
  qualifier: leadFormQualifierSchema.nullable().default(null),
  /** The same link the current Meta forms use, read from the Page when available. */
  privacyPolicyUrl: httpsUrl,
  thankYou: leadFormThankYouSchema,
});
export type SiteFormSpec = z.output<typeof siteFormSpecSchema>;

export const leadFormSchema = siteFormSpecSchema
  .extend({
    funnel: leadFormFunnelSchema,
  })
  .superRefine((form, ctx) => {
    if (form.funnel.pipeline === 'expansao' && !form.funnel.brand) {
      ctx.addIssue({
        code: 'custom',
        path: ['funnel', 'brand'],
        message: 'Expansão precisa da marca',
      });
    }
  });
export type LeadFormInput = z.input<typeof leadFormSchema>;
export type LeadForm = z.output<typeof leadFormSchema>;

/**
 * Where the lead is captured. `instant_form` is Meta's form inside the ad;
 * `page` is a web page (the campaign's destination, which for the standard
 * form is the site page `/lp/<slug>`). Only Meta offers the first.
 */
export const LEAD_CAPTURES = ['page', 'instant_form'] as const;
export type LeadCapture = (typeof LEAD_CAPTURES)[number];

export const LEAD_CAPTURE_LABEL: Record<LeadCapture, string> = {
  page: 'Página de destino',
  instant_form: 'Formulário no anúncio (instantâneo)',
};

/** The questions in the order the person sees them: the optional one first. */
export function leadFormQuestionsInOrder(form: Pick<LeadForm, 'qualifier'>): {
  kind: 'qualifier' | 'field';
  label: string;
  options?: string[];
  field?: LeadFormFieldKey;
  sample?: string;
}[] {
  return [
    ...(form.qualifier
      ? [
          {
            kind: 'qualifier' as const,
            label: form.qualifier.question,
            options: form.qualifier.options,
          },
        ]
      : []),
    ...LEAD_FORM_QUESTIONS.map((question) => ({
      kind: 'field' as const,
      label: question.label,
      field: question.field,
      sample: question.sample,
    })),
  ];
}

/**
 * The form's identity for reuse: the same questions, policy and thank-you on
 * the same Page mean the same Meta form, created once. The funnel is not part
 * of it (it is a rule of ours, not of the form). Stable key order, so the
 * server's hash does not depend on how the object was built.
 */
export function leadFormFingerprint(form: LeadForm): string {
  return JSON.stringify({
    qualifier: form.qualifier
      ? { question: form.qualifier.question, options: form.qualifier.options }
      : null,
    questions: LEAD_FORM_QUESTIONS.map((question) => [
      question.metaType,
      question.metaKey,
      question.label,
    ]),
    privacyPolicyUrl: form.privacyPolicyUrl,
    thankYou: {
      title: form.thankYou.title,
      body: form.thankYou.body,
      buttonText: form.thankYou.buttonText,
      buttonUrl: form.thankYou.buttonUrl,
    },
  });
}

/** Consent line drawn under the instant form's button, in the preview only (Meta writes the real one). */
export const LEAD_FORM_CONSENT_PREVIEW =
  'Ao tocar em Enviar, você concorda em enviar as suas informações à Wings, que as usará conforme a Política de Privacidade.';
