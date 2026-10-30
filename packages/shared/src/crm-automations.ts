import { z } from 'zod';
import { LEAD_TASK_KINDS } from './crm.js';
import { LEAD_PIPELINES } from './leads.js';

/**
 * CRM Vendas → Regras de automação (the Bitrix24 model): per funnel stage, what
 * happens when a deal enters it. A rule is one action, optionally delayed;
 * "start a sequence" hands the lead to a list of timed steps. Nothing here
 * holds a name, an e-mail or a phone: a rule names templates, people and
 * sequences by id, and the e-mail text is a template with `{{variables}}`.
 */

export const AUTOMATION_RULE_KINDS = [
  'create_task',
  'change_owner',
  'notify',
  'start_sequence',
  'send_email',
] as const;
export type AutomationRuleKind = (typeof AUTOMATION_RULE_KINDS)[number];
export const AUTOMATION_RULE_KIND_LABELS: Record<AutomationRuleKind, string> = {
  create_task: 'Criar tarefa',
  change_owner: 'Mudar o responsável',
  notify: 'Avisar alguém',
  start_sequence: 'Iniciar uma sequência',
  send_email: 'Enviar modelo de e-mail',
};

/** Who is meant: the deal's owner, or one named person. */
export const automationPersonSchema = z.union([z.literal('owner'), z.uuid()]);

const taskTitle = z.string().trim().min(2, 'Informe o título da tarefa').max(160);
/** Up to 90 days; counted in business hours (Mon–Fri 9h–18h) when `businessHours` is on. */
const afterHours = z
  .number()
  .int()
  .min(0)
  .max(24 * 90);

export const automationTaskConfigSchema = z.object({
  title: taskTitle,
  taskKind: z.enum(LEAD_TASK_KINDS).default('follow_up'),
  dueInHours: afterHours,
  businessHours: z.boolean().default(true),
  assignee: automationPersonSchema.default('owner'),
});
export const automationOwnerConfigSchema = z.object({
  /** `rotation` hands the deal to the funnel's next seller. */
  to: z.union([z.literal('rotation'), z.uuid()]),
});
export const automationNotifyConfigSchema = z.object({
  recipients: z.array(automationPersonSchema).min(1).max(10),
  message: z.string().trim().min(2, 'Informe o aviso').max(240),
});
export const automationSequenceConfigSchema = z.object({ sequenceId: z.uuid() });
export const automationEmailConfigSchema = z.object({ templateId: z.uuid() });

export const AUTOMATION_DELAY_MAX_MINUTES = 60 * 24 * 90;

const ruleBase = {
  pipeline: z.enum(LEAD_PIPELINES),
  stageId: z.uuid(),
  /** Minutes after entering the stage (0 = at once). */
  delayMinutes: z.number().int().min(0).max(AUTOMATION_DELAY_MAX_MINUTES).default(0),
  active: z.boolean().default(true),
};

export const automationRuleCreateSchema = z.discriminatedUnion('kind', [
  z.object({ ...ruleBase, kind: z.literal('create_task'), config: automationTaskConfigSchema }),
  z.object({ ...ruleBase, kind: z.literal('change_owner'), config: automationOwnerConfigSchema }),
  z.object({ ...ruleBase, kind: z.literal('notify'), config: automationNotifyConfigSchema }),
  z.object({
    ...ruleBase,
    kind: z.literal('start_sequence'),
    config: automationSequenceConfigSchema,
  }),
  z.object({ ...ruleBase, kind: z.literal('send_email'), config: automationEmailConfigSchema }),
]);
export type AutomationRuleCreateInput = z.input<typeof automationRuleCreateSchema>;

export const automationRuleUpdateSchema = z
  .object({
    delayMinutes: z.number().int().min(0).max(AUTOMATION_DELAY_MAX_MINUTES).optional(),
    active: z.boolean().optional(),
    config: z.record(z.string(), z.unknown()).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, 'Nada para alterar');

export interface AutomationRule {
  id: string;
  pipeline: string;
  stageId: string;
  position: number;
  kind: AutomationRuleKind;
  config: Record<string, unknown>;
  delayMinutes: number;
  active: boolean;
}

// --- sequences ---------------------------------------------------------------------------

export const SEQUENCE_STEP_KINDS = ['create_task', 'send_email', 'notify'] as const;
export type SequenceStepKind = (typeof SEQUENCE_STEP_KINDS)[number];

export const sequenceStepSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('create_task'),
    /** Hours after the previous step (the first: after the sequence starts). */
    afterHours,
    config: automationTaskConfigSchema,
  }),
  z.object({ kind: z.literal('send_email'), afterHours, config: automationEmailConfigSchema }),
  z.object({ kind: z.literal('notify'), afterHours, config: automationNotifyConfigSchema }),
]);
export type SequenceStepInput = z.input<typeof sequenceStepSchema>;

export const sequenceSaveSchema = z.object({
  name: z.string().trim().min(2, 'Informe o nome da sequência').max(80),
  active: z.boolean().default(true),
  steps: z.array(sequenceStepSchema).min(1, 'A sequência precisa de ao menos um passo').max(20),
});
export type SequenceSaveInput = z.input<typeof sequenceSaveSchema>;

export interface AutomationSequence {
  id: string;
  name: string;
  active: boolean;
  steps: {
    id: string;
    position: number;
    kind: SequenceStepKind;
    afterHours: number;
    config: Record<string, unknown>;
  }[];
}

// --- e-mail templates ----------------------------------------------------------------------

/** What a template may mention; anything else in `{{ }}` is refused when saving. */
export const EMAIL_TEMPLATE_VARIABLES = ['nome', 'marca', 'vendedor', 'etapa'] as const;
export type EmailTemplateVariable = (typeof EMAIL_TEMPLATE_VARIABLES)[number];

/** The variables a text names, in order, without repeats. */
export function templateVariablesOf(text: string): string[] {
  return [...new Set([...text.matchAll(/\{\{\s*([a-z_]+)\s*\}\}/g)].map((m) => m[1]!))];
}

export const emailTemplateSaveSchema = z
  .object({
    name: z.string().trim().min(2, 'Informe o nome do modelo').max(80),
    subject: z.string().trim().min(2, 'Informe o assunto').max(160),
    body: z.string().trim().min(2, 'Escreva a mensagem').max(8000),
    active: z.boolean().default(true),
  })
  .superRefine((value, ctx) => {
    const unknown = templateVariablesOf(`${value.subject}\n${value.body}`).filter(
      (v) => !(EMAIL_TEMPLATE_VARIABLES as readonly string[]).includes(v),
    );
    if (unknown.length > 0)
      ctx.addIssue({
        code: 'custom',
        path: ['body'],
        message: `Variável desconhecida: ${unknown.map((v) => `{{${v}}}`).join(', ')}`,
      });
  });
export type EmailTemplateSaveInput = z.input<typeof emailTemplateSaveSchema>;

export interface EmailTemplate {
  id: string;
  name: string;
  subject: string;
  body: string;
  active: boolean;
}

/** One message recorded for a deal (sent through the CRM transport, or only recorded in test mode). */
export interface LeadEmailSent {
  id: string;
  subject: string;
  body: string;
  /** test = only recorded; smtp = the company's address; gmail = the sender's own Gmail. */
  mode: 'test' | 'smtp' | 'gmail';
  status: 'recorded' | 'sent' | 'failed';
  at: string;
  templateName: string | null;
  sentByName: string | null;
  /** The address it left from; null in test mode. */
  fromEmail: string | null;
  /** Who it went to; null on messages recorded before free-text e-mail (they went to the lead). */
  toEmail: string | null;
  attachments: LeadEmailAttachment[];
}

// --- free-text e-mail from the deal (t081, Eric 30/10/2026) --------------------------------

/** What the history keeps of an attachment: the deal's file, its name and size; never its bytes. */
export interface LeadEmailAttachment {
  fileId: string;
  name: string;
  byteSize: number;
}

/** All attachments of one e-mail together (Gmail takes 25 MB; the base64 of 20 MB fits). */
export const EMAIL_ATTACHMENTS_MAX_BYTES = 20 * 1024 * 1024;
export const EMAIL_ATTACHMENTS_MAX_COUNT = 10;

/** Programs and scripts never leave as an attachment (Gmail's own list, and the scripts it misses). */
const BLOCKED_EXTENSIONS = new Set(
  (
    'ade adp apk appx appxbundle bat cab chm cmd com cpl diagcab diagcfg diagpack dll dmg ex ex_ ' +
    'exe hta img ins iso isp jar jnlp js jse lib lnk mde mjs msc msi msix msixbundle msp mst nsh ' +
    'pif ps1 scr sct shb sys vb vbe vbs vhd vxd wsc wsf wsh xll ' +
    'sh bash zsh command py rb pl php app deb rpm run'
  ).split(' '),
);
const BLOCKED_TYPE =
  /^application\/(x-(msdownload|msdos-program|ms-installer|executable|elf|sh|csh|bat|python|perl|php|ruby|java-archive)|vnd\.microsoft\.portable-executable|java-archive|javascript|ecmascript)$|^text\/(javascript|ecmascript|x-(sh|python|perl|php|ruby|script))/i;

/** Why this file cannot go as an attachment, or null when it can. */
export function emailAttachmentRefusal(name: string, mimeType: string | null): string | null {
  const extension = name.includes('.') ? (name.toLowerCase().split('.').pop() ?? '') : '';
  return BLOCKED_EXTENSIONS.has(extension) || BLOCKED_TYPE.test(mimeType ?? '')
    ? 'Programas e scripts não vão como anexo.'
    : null;
}

/** "Escrever e-mail": to one of the deal's addresses, with the deal's files as attachments. */
export const leadEmailComposeSchema = z.object({
  to: z.email('E-mail inválido').max(254),
  subject: z.string().trim().min(1, 'Escreva o assunto').max(200),
  text: z.string().trim().min(1, 'Escreva o texto').max(20_000),
  /** The template it started from, for the history; the text sent is what the person left. */
  templateId: z.uuid().nullable().default(null),
  fileIds: z
    .array(z.uuid())
    .max(EMAIL_ATTACHMENTS_MAX_COUNT, `No máximo ${EMAIL_ATTACHMENTS_MAX_COUNT} anexos`)
    .default([]),
});
export type LeadEmailComposeInput = z.input<typeof leadEmailComposeSchema>;

/** Fills the variables; a missing value becomes an empty string, never "undefined". */
export function renderTemplate(
  text: string,
  values: Partial<Record<EmailTemplateVariable, string | null | undefined>>,
): string {
  return text.replace(/\{\{\s*([a-z_]+)\s*\}\}/g, (_, key: string) => {
    const value = (values as Record<string, string | null | undefined>)[key];
    return value ?? '';
  });
}
