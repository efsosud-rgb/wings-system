import {
  WA_ART_SUFFIX,
  WA_COMPANY_FALLBACK,
  WA_FIELD_LABELS,
  WA_TEMPLATE_FIELDS,
  WINGS_CLIENT_ID,
  templateParamCount,
  waArticleBefore,
  waFieldFallback,
  waFieldForm,
  waTemplateFamily,
  waTemplateFields,
  withArticle,
  withoutArticle,
  type BrandArticle,
  type WaFieldSpec,
  type WaTemplateField,
  type WaTemplatePreview,
} from '@wings/shared';
import { and, eq, inArray } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import { crmCompanies, employees, leads, waTemplates } from '../../db/schema/index.js';
import { artFileOf, type ArtFile } from './art.js';
import {
  buttonsPayload,
  ctaUrlPayload,
  imagePayload,
  templatePayload,
  textPayload,
  type InteractiveHeader,
  type OutgoingPayload,
} from './graph.js';
import type { Contact } from './outbox.js';
import { brandOf, windowOf, type BrandVoice } from './thread.js';

/**
 * Which message a template becomes (docs/whatsapp/arte-modelos.md), one rule
 * for the seller's screen and, later, for Sofia's follow-up:
 *
 * - inside Meta's 24-hour window the template goes as a common message (no
 *   charge): the same text with the fields filled, reply buttons as
 *   interactive buttons, one link button as a `cta_url`, the art as the
 *   header. A combination a common message cannot carry goes as the template,
 *   and the screen says why;
 * - outside the window the approved template goes: its `_arte` version, with
 *   the art in the header, when the art is registered and that version is
 *   approved; otherwise the first version.
 *
 * The art follows the conversation's voice: a brand's own art, or the Wings
 * art when the conversation is Wings Company's. A brand's lead never gets the
 * Wings art, nor a text that cites Wings (checked by the caller).
 */

export interface TemplateRow {
  name: string;
  language: string;
  category: string | null;
  components: unknown;
  /** Set on the Modelos screen: what fills each {{n}} and its fallback. */
  fields?: WaFieldSpec[] | null;
}

interface Component {
  type?: string;
  format?: string;
  text?: string;
  buttons?: { type?: string; text?: string; url?: string }[];
}

const componentsOf = (row: TemplateRow): Component[] =>
  Array.isArray(row.components) ? (row.components as Component[]) : [];
const componentOf = (row: TemplateRow, type: string) =>
  componentsOf(row).find((c) => c && typeof c === 'object' && c.type === type);

/** The BODY text of a template as Meta lists it. */
export function templateBody(components: unknown): string | null {
  if (!Array.isArray(components)) return null;
  const body = components.find(
    (c) => c && typeof c === 'object' && (c as { type?: string }).type === 'BODY',
  ) as { text?: unknown } | undefined;
  return typeof body?.text === 'string' ? body.text : null;
}

export function fillTemplate(body: string | null, params: string[]): string | null {
  if (!body) return null;
  return body.replace(/\{\{\s*(\d+)\s*\}\}/g, (all, n: string) => params[Number(n) - 1] ?? all);
}

const bodyOf = (row: TemplateRow) => templateBody(row.components);

/** Whether the template carries Meta's "Permitir ligações" request. */
export const asksCallPermission = (row: Pick<TemplateRow, 'components'>) =>
  Array.isArray(row.components) &&
  (row.components as Component[]).some(
    (c) => c && typeof c === 'object' && c.type?.toUpperCase() === 'CALL_PERMISSION_REQUEST',
  );
const headerFormat = (row: TemplateRow) => componentOf(row, 'HEADER')?.format ?? null;

// --- the plan (no database, no Meta) -------------------------------------------------------

export interface PlanInput {
  request: { name: string; language: string; params: string[]; companyArticle: BrandArticle };
  /** The approved templates of the request's family and language (`x` and `x_arte`). */
  templates: TemplateRow[];
  window: { open: boolean; expiresAt: string | null };
  /** The brand the conversation speaks for; null for Wings Company. */
  voice: Pick<BrandVoice, 'name' | 'article'> | null;
  /** The art of the voice is registered (the brand's, or the Wings art). */
  hasArt: boolean;
  /** What the server knows to fill: the lead's first name, the sender's, the lead's company. */
  defaults: { lead: string; seller: string; company: string };
}

/** A common message made from a template, before the art has its Meta id. */
export interface FreeMessage {
  kind: 'buttons' | 'cta_url' | 'image' | 'text';
  body: string;
  footer: string | null;
  header: { type: 'text'; text: string } | { type: 'image' } | null;
  replies: { id: string; title: string }[];
  link: { title: string; url: string } | null;
}

export type TemplatePlan =
  | { ok: false; status: number; error: string; message: string }
  | {
      ok: true;
      preview: WaTemplatePreview;
      /** The approved template whose text goes. */
      version: TemplateRow;
      /** The fields as they go, articles in. */
      params: string[];
      /** Set when it goes as a common message. */
      free: FreeMessage | null;
      /** The art goes in the header: the caller gets its Meta media id. */
      needsArt: boolean;
    };

const refuse = (status: number, error: string, message: string): TemplatePlan => ({
  ok: false,
  status,
  error,
  message,
});

export const ART_MISSING_BRAND = 'Cadastre a arte do WhatsApp desta marca (no cadastro da marca).';
export const ART_MISSING_WINGS =
  'Cadastre a arte do WhatsApp da Wings (Administração → Clientes, em Wings Company).';
export const ARTICLE_MISSING =
  'Cadastre o artigo (o/a) desta marca no cadastro dela; por ora vai "da".';
export const ART_VERSION_PENDING =
  'A versão com arte deste modelo ainda não está aprovada pela Meta: vai sem a arte.';

export function planTemplate(input: PlanInput): TemplatePlan {
  const { request, templates, window, voice, hasArt } = input;
  const named = (name: string) =>
    templates.find((t) => t.name === name && t.language === request.language);
  const requested = named(request.name);
  if (!requested)
    return refuse(422, 'template_unknown', 'Modelo não encontrado ou não aprovado pela Meta.');
  const count = templateParamCount(bodyOf(requested));
  const family = waTemplateFamily(request.name);
  const fits = (row: TemplateRow | undefined): row is TemplateRow =>
    row !== undefined && templateParamCount(bodyOf(row)) === count;
  const base = named(family);
  const arte = named(`${family}${WA_ART_SUFFIX}`);
  const arteFits = fits(arte) && headerFormat(arte) === 'IMAGE';

  const notices: string[] = [];
  let version: TemplateRow;
  if (hasArt) {
    version = arteFits ? arte : fits(base) ? base : requested;
    // One of ours whose art version Meta has not approved (yet): the template goes without the art.
    if (!arteFits && !window.open && WA_TEMPLATE_FIELDS[`${family}${WA_ART_SUFFIX}`])
      notices.push(ART_VERSION_PENDING);
  } else {
    version = fits(base) ? base : requested;
    notices.push(voice ? ART_MISSING_BRAND : ART_MISSING_WINGS);
    if (headerFormat(version) === 'IMAGE')
      return refuse(
        422,
        'art_missing',
        `Este modelo leva a arte no cabeçalho, e ela não está cadastrada. ${
          voice ? ART_MISSING_BRAND : ART_MISSING_WINGS
        }`,
      );
  }

  // The fields: what the seller typed (names without their article), or what the server knows.
  const body = bodyOf(version);
  // Saved fields: the version's own, or the base's (an `_arte` keeps its own form: "da Malkuth").
  const saved = [version, base].find((row) => row?.fields?.length === count)?.fields ?? null;
  const specs =
    version.fields?.length === count
      ? version.fields
      : waTemplateFields(version.name, count).map((spec, i) =>
          saved?.[i] ? { ...saved[i], form: spec.form } : spec,
        );
  const given = request.params.length === count ? request.params : null;
  const fellBack: string[] = [];
  const fields: WaTemplateField[] = specs.map((spec, i) => {
    const locked = spec.role === 'brand' && voice !== null;
    const typed = given?.[i]?.trim() ?? '';
    const known =
      spec.role === 'lead'
        ? input.defaults.lead
        : spec.role === 'seller'
          ? input.defaults.seller
          : spec.role === 'company'
            ? input.defaults.company
            : '';
    const value = given ? typed : known;
    const label =
      spec.label ?? (spec.role === 'free' ? `Campo {{${i + 1}}}` : WA_FIELD_LABELS[spec.role]);
    if (!locked && !value && waFieldFallback(spec))
      fellBack.push(`${label.toLowerCase()} → "${waFieldFallback(spec)}"`);
    return {
      index: i + 1,
      role: spec.role,
      label,
      value: locked ? (voice?.name ?? '') : value || waFieldFallback(spec),
      locked,
    };
  });
  if (fellBack.length > 0)
    notices.push(
      `Sem dado no CRM, vai o texto padrão: ${fellBack.join(', ')}. Troque no campo, se souber.`,
    );
  let usesCompanyArticle = false;
  let brandArticleMissing = false;
  const params = fields.map((field, i) => {
    const form = waFieldForm(body, i + 1, specs[i]!);
    if (form === 'plain') {
      // The text carries the article ("expansão da {{3}}"): "A Cabana da Barra" goes without its own.
      const named = field.role === 'brand' || field.role === 'company';
      const carried = named ? waArticleBefore(body, i + 1) : null;
      return carried ? withoutArticle(field.value, carried) : field.value;
    }
    if (field.role === 'company') {
      usesCompanyArticle = true;
      // "sua empresa" is feminine whatever the seller ticked: never "o sua empresa".
      const feminine = field.value === WA_COMPANY_FALLBACK;
      return withArticle(field.value, feminine ? 'a' : request.companyArticle, form);
    }
    if (field.role === 'brand') {
      if (voice && !voice.article) brandArticleMissing = true;
      return withArticle(field.value, voice?.article ?? 'a', form);
    }
    return field.value;
  });
  if (brandArticleMissing) notices.push(ARTICLE_MISSING);
  const ready = fields.every((field) => field.value.trim().length > 0);
  const text = fillTemplate(body, params) ?? version.name;

  let free: FreeMessage | null = null;
  let reason: string | null = null;
  if (window.open) {
    const converted = toFreeMessage(version, text, hasArt);
    if (typeof converted === 'string') reason = converted;
    else free = converted;
  }
  const sendAs = free ? 'free' : 'template';
  const category = version.category;
  const buttons = (componentOf(version, 'BUTTONS')?.buttons ?? []).map((b) => b.text ?? '');
  return {
    ok: true,
    version,
    params,
    free,
    needsArt: free ? free.header?.type === 'image' : headerFormat(version) === 'IMAGE',
    preview: {
      family,
      version: version.name,
      language: version.language,
      category,
      sendAs,
      // A free message, or a utility template inside the window, costs nothing (Meta, 07/2025).
      charged: sendAs === 'template' && !(window.open && category === 'UTILITY'),
      reason,
      windowExpiresAt: window.open ? window.expiresAt : null,
      text,
      footer: componentOf(version, 'FOOTER')?.text ?? null,
      buttons,
      withArt: free ? free.header?.type === 'image' : headerFormat(version) === 'IMAGE',
      notices,
      fields,
      usesCompanyArticle,
      ready,
    },
  };
}

const INTERACTIVE_BODY_MAX = 1024;
const TEXT_MAX = 4096;
const BUTTON_TITLE_MAX = 20;
const HEADER_TEXT_MAX = 60;
const FOOTER_MAX = 60;

/**
 * The template as a common message, or why it cannot be one (in the words the
 * screen shows). Meta's limits: up to 3 reply buttons of up to 20 characters,
 * or one link button; a body of up to 1024 characters with buttons or an image.
 */
export function toFreeMessage(
  version: TemplateRow,
  text: string,
  hasArt: boolean,
): FreeMessage | string {
  if (asksCallPermission(version))
    return 'Este modelo pede a permissão para ligar, e esse pedido só vai dentro do modelo.';
  const header = componentOf(version, 'HEADER');
  let head: FreeMessage['header'] = null;
  if (header) {
    if (header.format === 'IMAGE') head = { type: 'image' };
    else if (
      header.format === 'TEXT' &&
      header.text &&
      !/\{\{/.test(header.text) &&
      header.text.length <= HEADER_TEXT_MAX
    )
      head = { type: 'text', text: header.text };
    else
      return 'O cabeçalho deste modelo (vídeo, documento, local ou com campo) não vai numa mensagem comum.';
  } else if (hasArt) head = { type: 'image' };
  if (head?.type === 'image' && !hasArt)
    return 'Este modelo leva a arte, e ela não está cadastrada.';

  const footer = componentOf(version, 'FOOTER')?.text ?? null;
  const buttons = componentOf(version, 'BUTTONS')?.buttons ?? [];
  const replies = buttons.filter((b) => b.type === 'QUICK_REPLY');
  const links = buttons.filter((b) => b.type === 'URL');
  const others = buttons.filter((b) => b.type !== 'QUICK_REPLY' && b.type !== 'URL');
  if (others.some((b) => b.type === 'PHONE_NUMBER' || b.type === 'VOICE_CALL'))
    return 'A mensagem comum não tem botão de ligar.';
  if (others.length > 0)
    return 'A mensagem comum não tem esse tipo de botão (código, formulário…).';
  if (links.length > 0 && replies.length > 0)
    return 'A mensagem comum não junta link com botões de resposta.';
  if (links.length > 1) return 'A mensagem comum leva um link só.';
  if (replies.length > 3) return 'A mensagem comum leva até 3 botões de resposta.';
  const tooLong = [...replies, ...links].find((b) => (b.text ?? '').length > BUTTON_TITLE_MAX);
  if (tooLong) return `O botão "${tooLong.text}" passa de 20 letras e não cabe na mensagem comum.`;
  if (footer && footer.length > FOOTER_MAX && (replies.length > 0 || links.length > 0))
    return 'O rodapé deste modelo é longo demais para a mensagem comum.';

  if (links.length === 1) {
    const link = links[0]!;
    if (!link.url || /\{\{/.test(link.url) || !link.text)
      return 'O link deste modelo tem uma parte variável: só vai como modelo.';
    if (text.length > INTERACTIVE_BODY_MAX) return 'O texto é longo demais para a mensagem comum.';
    return {
      kind: 'cta_url',
      body: text,
      footer,
      header: head,
      replies: [],
      link: { title: link.text, url: link.url },
    };
  }
  if (replies.length > 0) {
    if (text.length > INTERACTIVE_BODY_MAX) return 'O texto é longo demais para a mensagem comum.';
    return {
      kind: 'buttons',
      body: text,
      footer,
      header: head,
      replies: replies.map((b, i) => ({ id: `modelo_resposta_${i + 1}`, title: b.text ?? '' })),
      link: null,
    };
  }
  if (head?.type === 'image') {
    const caption = footer ? `${text}\n\n${footer}` : text;
    if (caption.length > INTERACTIVE_BODY_MAX)
      return 'O texto é longo demais para ir junto da arte.';
    return { kind: 'image', body: caption, footer: null, header: head, replies: [], link: null };
  }
  const plain = [head?.type === 'text' ? `*${head.text}*` : null, text, footer]
    .filter((part): part is string => Boolean(part))
    .join('\n\n');
  if (plain.length > TEXT_MAX) return 'O texto é longo demais para a mensagem comum.';
  return { kind: 'text', body: plain, footer: null, header: null, replies: [], link: null };
}

/** What goes to Meta, once the art (when it goes) has its media id. */
export function payloadOf(
  plan: Extract<TemplatePlan, { ok: true }>,
  mediaId: string | null,
): OutgoingPayload {
  const { free, version } = plan;
  if (!free)
    return templatePayload(
      version.name,
      version.language,
      plan.params,
      headerFormat(version) === 'IMAGE' ? mediaId : null,
    );
  const header: InteractiveHeader | undefined =
    free.header?.type === 'image' && mediaId
      ? { type: 'image', image: { id: mediaId } }
      : free.header?.type === 'text'
        ? { type: 'text', text: free.header.text }
        : undefined;
  const extra = { header, footer: free.footer ?? undefined };
  if (free.kind === 'buttons') return buttonsPayload(free.body, free.replies, extra);
  if (free.kind === 'cta_url' && free.link) return ctaUrlPayload(free.body, free.link, extra);
  if (free.kind === 'image' && mediaId) return imagePayload(mediaId, free.body);
  return textPayload(free.body);
}

// --- what the database knows about this conversation -------------------------------------------

export interface TemplateContext {
  voice: BrandVoice | null;
  /** The art of the voice: the brand's, or the Wings art (Wings Company's record). */
  art: ArtFile | null;
  window: { open: boolean; expiresAt: string | null };
  defaults: PlanInput['defaults'];
}

const firstName = (name: string | null | undefined) => name?.trim().split(/\s+/)[0] ?? '';

export async function templateContextOf(
  db: Database,
  target: {
    leadId: string | null;
    conversationId: string | null;
    contact: Contact | null;
    /** Who sends: their first name fills "Aqui é {{2}}". */
    senderEmployeeId: string | null;
  },
  now: Date,
): Promise<TemplateContext> {
  const voice = await brandOf(db, target.leadId, target.conversationId);
  const art = await artFileOf(db, voice ? voice.clientId : WINGS_CLIENT_ID);
  const [lead] = target.leadId
    ? await db
        .select({ name: leads.name, companyName: leads.companyName, company: crmCompanies.name })
        .from(leads)
        .leftJoin(crmCompanies, eq(crmCompanies.id, leads.companyId))
        .where(eq(leads.id, target.leadId))
    : [];
  const [sender] = target.senderEmployeeId
    ? await db
        .select({ name: employees.fullName })
        .from(employees)
        .where(eq(employees.id, target.senderEmployeeId))
    : [];
  return {
    voice,
    art,
    window: windowOf(target.contact, now),
    defaults: {
      lead: firstName(lead?.name) || firstName(target.contact?.profileName),
      seller: firstName(sender?.name),
      company: (lead?.companyName ?? lead?.company ?? '').trim(),
    },
  };
}

/** The approved rows of a template's family (`x` and `x_arte`) in one language. */
export async function familyTemplates(
  db: Database,
  name: string,
  language: string,
): Promise<TemplateRow[]> {
  const family = waTemplateFamily(name);
  return db
    .select({
      name: waTemplates.name,
      language: waTemplates.language,
      category: waTemplates.category,
      components: waTemplates.components,
      fields: waTemplates.fields,
    })
    .from(waTemplates)
    .where(
      and(
        inArray(waTemplates.name, [family, `${family}${WA_ART_SUFFIX}`]),
        eq(waTemplates.language, language),
        eq(waTemplates.status, 'APPROVED'),
      ),
    );
}

/** Plans a template for this conversation, from what the database holds. */
export async function planTemplateFor(
  db: Database,
  context: TemplateContext,
  request: PlanInput['request'],
): Promise<TemplatePlan> {
  return planTemplate({
    request,
    templates: await familyTemplates(db, request.name, request.language),
    window: context.window,
    voice: context.voice,
    hasArt: context.art !== null,
    defaults: context.defaults,
  });
}
