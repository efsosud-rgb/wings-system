import { z } from 'zod';
import { templateParamCount } from './whatsapp.js';
import { WA_FIELD_ROLES, type WaFieldSpec } from './whatsapp-art.js';

/**
 * CRM Vendas → WhatsApp → Modelos (Eric, 26/10): the message templates are
 * written and sent to Meta's review from the system. Meta's rules stand: the
 * approved text is what goes (the fields fill only the {{n}}), and editing a
 * template sends it back to review, at most once a day and 10 times in 30 days.
 * Each {{n}} says what fills it and a fallback, so a missing value never blocks
 * a send.
 */

export const WA_TEMPLATE_CATEGORIES = ['UTILITY', 'MARKETING'] as const;
export type WaTemplateCategory = (typeof WA_TEMPLATE_CATEGORIES)[number];

export const WA_TEMPLATE_CATEGORY_LABELS: Record<WaTemplateCategory, string> = {
  UTILITY: 'Utilidade (aviso sobre o atendimento)',
  MARKETING: 'Marketing (oferta, retomada)',
};

export const WA_TEMPLATE_STATUS_LABELS: Record<string, string> = {
  APPROVED: 'Aprovado',
  PENDING: 'Em análise na Meta',
  IN_APPEAL: 'Em recurso',
  REJECTED: 'Recusado',
  PAUSED: 'Pausado pela Meta',
  DISABLED: 'Desativado pela Meta',
  LIMIT_EXCEEDED: 'Limite da Meta atingido',
};

const fieldSchema = z.object({
  role: z.enum(WA_FIELD_ROLES),
  label: z.string().trim().max(60).optional(),
  fallback: z.string().trim().max(60).optional(),
});

/** What can change in a template: its words, buttons and fields. Name, language and category stay. */
export const waTemplateEditSchema = z
  .object({
    body: z.string().trim().min(1).max(1024),
    /** One example per {{n}}, in order: Meta reviews the text with them. */
    examples: z.array(z.string().trim().min(1).max(200)).max(20),
    /** One per {{n}}, in order: what fills it in a deal, and what goes when the CRM has nothing. */
    fields: z.array(fieldSchema).max(20),
    footer: z.string().trim().max(60).default(''),
    /** Quick replies ("Sim, pode perguntar", "Prefiro uma ligação"). */
    buttons: z.array(z.string().trim().min(1).max(25)).max(3).default([]),
    /** Meta's "Permitir ligações" request at the end of the message. */
    callPermission: z.boolean().default(false),
  })
  .superRefine((draft, ctx) => {
    const count = templateParamCount(draft.body);
    const used = new Set([...draft.body.matchAll(/\{\{\s*(\d+)\s*\}\}/g)].map((m) => Number(m[1])));
    if (used.size !== count)
      ctx.addIssue({
        code: 'custom',
        path: ['body'],
        message: 'Numere os campos em ordem, sem pular: {{1}}, {{2}}, {{3}}.',
      });
    if (draft.examples.length !== count || draft.fields.length !== count)
      ctx.addIssue({
        code: 'custom',
        path: ['examples'],
        message: 'Cada campo {{n}} do texto precisa de um exemplo e do que o preenche.',
      });
  });
export type WaTemplateEdit = z.infer<typeof waTemplateEditSchema>;

export const waTemplateCreateSchema = z.intersection(
  z.object({
    /** Meta's rule: lowercase letters, digits and _. */
    name: z
      .string()
      .trim()
      .regex(/^[a-z0-9_]{1,512}$/, 'Use só letras minúsculas, números e _ (ex.: boas_vindas_2).'),
    language: z.string().trim().min(2).max(15).default('pt_BR'),
    category: z.enum(WA_TEMPLATE_CATEGORIES),
  }),
  waTemplateEditSchema,
);
export type WaTemplateCreate = z.infer<typeof waTemplateCreateSchema>;

/** Only the fields: what fills each {{n}} and its fallback. Stays in the system, Meta sees nothing. */
export const waTemplateFieldsSchema = z.object({ fields: z.array(fieldSchema).max(20) });

/** A template on the Modelos screen, every status. */
export interface WaManagedTemplate {
  id: string;
  name: string;
  language: string;
  category: string | null;
  status: string;
  rejectedReason: string | null;
  body: string | null;
  footer: string | null;
  buttons: string[];
  /** IMAGE for the art versions; editing keeps the header as it is. */
  header: string | null;
  callPermission: boolean;
  paramCount: number;
  /** What fills each {{n}}: the saved ones, or the system's for our first templates. */
  fields: WaFieldSpec[];
  syncedAt: string;
}

export interface WaManagedTemplates {
  templates: WaManagedTemplate[];
  /** Null when the list was read; the reason otherwise ("—" is never a silent empty list). */
  syncError: string | null;
  configured: boolean;
}
