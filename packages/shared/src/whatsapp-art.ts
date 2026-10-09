import { z } from 'zod';

/**
 * The art at the head of a WhatsApp template, and the article of a name
 * (docs/whatsapp/arte-modelos.md). Each Expansão brand has its own art (its
 * logo); the Formatação templates carry the Wings art, kept once on the Wings
 * Company record. The same rule checks a file on the screen, before it is
 * sent, and on the server, from the bytes that arrived.
 */

export const WA_ART_WIDTH = 1125;
export const WA_ART_HEIGHT = 600;
export const WA_ART_MAX_BYTES = 2 * 1024 * 1024;
export const WA_ART_TYPES = ['image/png', 'image/jpeg'] as const;
export type WaArtType = (typeof WA_ART_TYPES)[number];

export const waArtUploadSchema = z.object({
  mimeType: z.enum(WA_ART_TYPES, 'A arte precisa ser PNG ou JPEG.'),
  byteSize: z.number().int().positive().max(WA_ART_MAX_BYTES, 'A arte pode ter até 2 MB.'),
});
export type WaArtUpload = z.infer<typeof waArtUploadSchema>;

export const WA_ART_REFUSALS = {
  type: 'A arte precisa ser PNG ou JPEG.',
  size: 'A arte pode ter até 2 MB.',
  dimensions: `A arte precisa ter ${WA_ART_WIDTH} × ${WA_ART_HEIGHT} pixels.`,
  unreadable: 'Não deu para ler a imagem: o arquivo não é um PNG ou JPEG válido.',
  mismatch: 'O conteúdo do arquivo não é do tipo que ele diz ser.',
} as const;
export type WaArtRefusal = keyof typeof WA_ART_REFUSALS;

/** Why a file cannot be the art, or null when it can. */
export function waArtRefusal(file: {
  type: string | null;
  byteSize: number;
  width: number | null;
  height: number | null;
}): WaArtRefusal | null {
  if (!file.type || !(WA_ART_TYPES as readonly string[]).includes(file.type)) return 'type';
  if (file.byteSize <= 0 || file.byteSize > WA_ART_MAX_BYTES) return 'size';
  if (file.width === null || file.height === null) return 'unreadable';
  if (file.width !== WA_ART_WIDTH || file.height !== WA_ART_HEIGHT) return 'dimensions';
  return null;
}

// --- the article of a name -------------------------------------------------------------

/** "o" Casal do Churros, "a" Malkuth. */
export const BRAND_ARTICLES = ['o', 'a'] as const;
export type BrandArticle = (typeof BRAND_ARTICLES)[number];

export const BRAND_ARTICLE_LABELS: Record<BrandArticle, string> = {
  o: 'o (do Casal do Churros)',
  a: 'a (da Malkuth)',
};

export const waArticleSchema = z.object({
  article: z.enum(BRAND_ARTICLES).nullable(),
});

/**
 * How a name enters a template's field: as it is ("franquia Malkuth"), with
 * its article ("transformar a Padaria Aurora") or with "de" + article
 * ("time de expansão da Malkuth", "do Casal do Churros").
 */
export type WaNameForm = 'plain' | 'article' | 'of';

/** "A Cabana da Barra" → `{ own: 'a', rest: 'Cabana da Barra' }`: a name that already starts with an article. */
function leadingArticle(name: string): { own: 'o' | 'a' | 'os' | 'as'; rest: string } | null {
  const match = /^(o|a|os|as)\s+(\S.*)$/i.exec(name);
  if (!match) return null;
  return { own: match[1]!.toLowerCase() as 'o' | 'a' | 'os' | 'as', rest: match[2]! };
}

const OF: Record<'o' | 'a' | 'os' | 'as', string> = { o: 'do', a: 'da', os: 'dos', as: 'das' };

/**
 * A name that already starts with an article ("A Cabana da Barra", "O
 * Boticário") keeps its own: "a Cabana da Barra", "da Cabana da Barra" —
 * never "a A Cabana" or "da A Cabana". The name's article wins over the
 * stored one, since it is what the name says.
 */
export function withArticle(name: string, article: BrandArticle, form: WaNameForm): string {
  const clean = name.trim().replace(/\s+/g, ' ');
  if (!clean || form === 'plain') return clean;
  const own = leadingArticle(clean);
  if (own) return form === 'article' ? `${own.own} ${own.rest}` : `${OF[own.own]} ${own.rest}`;
  if (form === 'article') return `${article} ${clean}`;
  return `${OF[article]} ${clean}`;
}

// --- what each field of our templates is -------------------------------------------------

export const WA_ART_SUFFIX = '_arte';

/** `expansao_boas_vindas_arte` and `expansao_boas_vindas` are one template for the seller. */
export const waTemplateFamily = (name: string) =>
  name.endsWith(WA_ART_SUFFIX) ? name.slice(0, -WA_ART_SUFFIX.length) : name;

export const WA_FIELD_ROLES = ['lead', 'seller', 'brand', 'company', 'free'] as const;
export type WaFieldRole = (typeof WA_FIELD_ROLES)[number];

export const WA_FIELD_LABELS: Record<WaFieldRole, string> = {
  lead: 'Nome do lead',
  seller: 'Seu nome',
  brand: 'Marca',
  company: 'Empresa do lead',
  free: 'Campo',
};

export interface WaFieldSpec {
  role: WaFieldRole;
  /** For a brand or a company: how the name enters (default `plain`). */
  form?: WaNameForm;
  /** For a free field: what to type ("Dia", "Link da reunião"). */
  label?: string;
}

const lead: WaFieldSpec = { role: 'lead' };
const seller: WaFieldSpec = { role: 'seller' };
const brand = (form: WaNameForm): WaFieldSpec => ({ role: 'brand', form });
const company = (form: WaNameForm): WaFieldSpec => ({ role: 'company', form });
const day: WaFieldSpec = { role: 'free', label: 'Dia (ex.: sexta-feira, 10/10)' };
const hour: WaFieldSpec = { role: 'free', label: 'Hora (ex.: 10h)' };
const link: WaFieldSpec = { role: 'free', label: 'Link da reunião' };

/**
 * Each `{{n}}` of the templates made on 07/10/2026, in order, from the texts
 * and examples sent to Meta (`modelos-whatsapp-2026-10-07.json` and
 * `modelos-arte-12-2026-10-07.json`). The `_arte` versions carry the article
 * inside the field ("do time de expansão {{3}}" ← "da Malkuth"); the first
 * versions have it in the text ("da {{3}}" ← "Malkuth"). A template not
 * listed here has free fields only, typed as they go.
 */
export const WA_TEMPLATE_FIELDS: Readonly<Record<string, readonly WaFieldSpec[]>> = {
  expansao_boas_vindas: [lead, seller, brand('plain')],
  expansao_boas_vindas_arte: [lead, seller, brand('of')],
  expansao_agendar_apresentacao: [lead, brand('plain')],
  expansao_agendar_apresentacao_arte: [lead, brand('plain')],
  expansao_lembrete_reuniao: [lead, brand('plain'), day, hour, link],
  expansao_lembrete_reuniao_arte: [lead, brand('plain'), day, hour, link],
  expansao_cof_enviada: [lead, brand('plain')],
  expansao_cof_enviada_arte: [lead, brand('of')],
  expansao_retomar_contato: [lead, brand('plain')],
  expansao_retomar_contato_arte: [lead, brand('plain')],
  sofia_expansao_retomar_atendimento: [lead, brand('plain')],
  sofia_expansao_retomar_atendimento_arte: [lead, brand('of')],
  wings_formatacao_boas_vindas: [lead, seller, company('plain')],
  wings_formatacao_boas_vindas_arte: [lead, seller, company('article')],
  wings_formatacao_agendar_reuniao: [lead, company('plain')],
  wings_formatacao_agendar_reuniao_arte: [lead, company('of')],
  wings_formatacao_lembrete_reuniao: [lead, day, hour, link],
  wings_formatacao_lembrete_reuniao_arte: [lead, day, hour, link],
  wings_formatacao_proposta_enviada: [lead, company('plain')],
  wings_formatacao_proposta_enviada_arte: [lead, company('of')],
  wings_formatacao_retomar_contato: [lead, company('plain')],
  wings_formatacao_retomar_contato_arte: [lead, company('article')],
  sofia_formatacao_retomar_atendimento: [lead],
  sofia_formatacao_retomar_atendimento_arte: [lead],
};

const ARTICLE_BEFORE = /(?:^|[\s(])(?:da|do|das|dos|de|a|o|as|os)\s*$/i;

/**
 * The form a field really takes in this text: when the words just before
 * `{{n}}` already carry the article ("expansão da {{3}}", a template made with
 * the old text), the name goes plain, so nothing comes out as "da da Malkuth".
 */
export function waFieldForm(body: string | null, index: number, spec: WaFieldSpec): WaNameForm {
  const form = spec.form ?? 'plain';
  if (form === 'plain' || !body) return form;
  const at = body.search(new RegExp(`\\{\\{\\s*${index}\\s*\\}\\}`));
  if (at < 0) return form;
  return ARTICLE_BEFORE.test(body.slice(0, at)) ? 'plain' : form;
}

/** The fields of a template with `count` placeholders: the listed ones, or free ones. */
export function waTemplateFields(name: string, count: number): WaFieldSpec[] {
  const listed = WA_TEMPLATE_FIELDS[name];
  return Array.from({ length: count }, (_, i) => listed?.[i] ?? { role: 'free' as const });
}

// --- what the seller sees before sending ------------------------------------------------

export const waTemplateSendSchema = z.object({
  name: z.string().trim().min(1).max(512),
  language: z.string().trim().min(2).max(15),
  /**
   * One value per `{{n}}` of the chosen template, names WITHOUT their article
   * (the server puts it, by the version that goes). Empty on a first preview:
   * the server fills what it knows.
   */
  params: z.array(z.string().trim().max(1024)).max(20).default([]),
  /** The lead's company: "a Padaria" (default) or "o Bar". */
  companyArticle: z.enum(BRAND_ARTICLES).default('a'),
  /**
   * What the screen showed before the click. When the send would now go
   * otherwise (the window closed: a paid template instead of a free message),
   * the server refuses with `send_mode_changed` and the seller looks again.
   */
  expect: z.object({ sendAs: z.enum(['free', 'template']), charged: z.boolean() }).optional(),
});
export type WaTemplateSend = z.input<typeof waTemplateSendSchema>;

export interface WaTemplateField {
  /** 1 for `{{1}}`. */
  index: number;
  role: WaFieldRole;
  label: string;
  value: string;
  /** The brand of a brand's conversation: always the conversation's own. */
  locked: boolean;
}

export interface WaTemplatePreview {
  /** The template as the seller chose it (without `_arte`). */
  family: string;
  /** The approved template whose text goes (the `_arte` one when it applies). */
  version: string;
  language: string;
  category: string | null;
  /** `free`: a common message inside the 24-hour window; `template`: the approved template. */
  sendAs: 'free' | 'template';
  /** Whether Meta charges for it (a free message or a utility template inside the window: no). */
  charged: boolean;
  /** Why the approved template goes although the window is open. */
  reason: string | null;
  windowExpiresAt: string | null;
  /** The body with the fields filled in, as the person will read it. */
  text: string;
  footer: string | null;
  buttons: string[];
  /** The art goes in the header (the image comes from `…/whatsapp/art`). */
  withArt: boolean;
  /** What to fix before it looks right: no art, no article, the art version not approved. */
  notices: string[];
  fields: WaTemplateField[];
  /** Whether the company's article changes this text (the a/o switch shows only then). */
  usesCompanyArticle: boolean;
  /** All fields are filled: it can go. */
  ready: boolean;
}

/** The art of the conversation's voice, for the preview: an address that lasts 5 minutes. */
export interface WaArtLink {
  fileId: string;
  url: string;
  expiresAt: string;
}

/** A brand's (or Wings') WhatsApp header, as its record shows it. */
export interface ClientWhatsAppArt {
  clientId: string;
  /** Null for Wings Company, whose templates name it in their own text. */
  article: BrandArticle | null;
  art: { fileId: string; url: string; expiresAt: string; setAt: string | null } | null;
}
