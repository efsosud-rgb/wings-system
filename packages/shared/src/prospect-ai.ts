import { z } from 'zod';
import {
  INSTAGRAM_PASTE_FORMATS,
  type PasteDiscardKind,
  type PasteIgnoredKind,
} from './instagram-paste.js';
import {
  DEFAULT_PRIVATE_REPLY_SETTINGS,
  privateReplySettingsSchema,
  type IgPrivateReplyBlock,
  type IgPrivateReplyStatus,
} from './instagram-intake.js';
import { LEAD_PIPELINES, type LeadPipeline } from './leads.js';

/**
 * Wings Prospect AI: the evidence, the opportunity queue and the classifier (spec PA, PR #54,
 * annexes 1 and 2), only as far as Prospecção Instagram's parte 2 uses them
 * (docs/prospeccao/instagram.md, Fase A). The lists here are the CHECKs of the tables.
 */

export const PROSPECT_EVIDENCE_SOURCES = [
  'instagram_comment',
  'instagram_dm',
  'instagram_ad_comment',
  'instagram_ad_referral',
  'instagram_mention',
  'competitor_radar',
  'instagram_colagem',
] as const;
export type ProspectEvidenceSource = (typeof PROSPECT_EVIDENCE_SOURCES)[number];

export const PROSPECT_OPPORTUNITY_STATES = [
  'nova',
  'em_revisao',
  'abordada',
  'aprovada',
  'rejeitada',
  'duplicada',
  'prazo_vencido',
] as const;
export type ProspectOpportunityState = (typeof PROSPECT_OPPORTUNITY_STATES)[number];
/** Still being worked: a second comment of the same @ joins it instead of opening another. */
export const PROSPECT_OPEN_STATES: ProspectOpportunityState[] = ['nova', 'em_revisao', 'abordada'];

export const PROSPECT_STATE_LABELS: Record<ProspectOpportunityState, string> = {
  nova: 'Nova',
  em_revisao: 'Revisar',
  abordada: 'Abordada',
  aprovada: 'Virou lead',
  rejeitada: 'Descartada',
  duplicada: 'Duplicada',
  prazo_vencido: 'Prazo vencido',
};

export const PROSPECT_INTENTS = [
  'interesse_declarado',
  'necessidade_provavel',
  'conteudo_educativo',
  'comentario_casual',
  'outro_assunto',
  'informacao_insuficiente',
] as const;
export type ProspectIntent = (typeof PROSPECT_INTENTS)[number];

/** The six buying signals Eric asked for (docs/prospeccao/instagram.md §3.1). */
export const BUY_SIGNALS = [
  'quer_comprar',
  'pediu_preco',
  'duvida',
  'elogio',
  'reclamacao',
  'spam',
] as const;
export type BuySignal = (typeof BUY_SIGNALS)[number];
export const BUYING_SIGNALS: BuySignal[] = ['quer_comprar', 'pediu_preco'];

export const BUY_SIGNAL_LABELS: Record<BuySignal, string> = {
  quer_comprar: 'Quer comprar',
  pediu_preco: 'Pediu preço',
  duvida: 'Dúvida',
  elogio: 'Elogio',
  reclamacao: 'Reclamação',
  spam: 'Spam',
};

export const PROSPECT_CLASSIFICATION_METHODS = [
  'palavra_chave',
  'regra',
  'ia',
  'ia_lote',
  'ia_sombra',
  'humano',
] as const;
export type ProspectClassificationMethod = (typeof PROSPECT_CLASSIFICATION_METHODS)[number];

export const PROSPECT_REVIEW_REASONS = [
  'confianca_baixa',
  'revisao_obrigatoria',
  'servico_nao_vendido',
  'sem_ia',
  'teto_ia',
  'ia_invalida',
  'registro_manual',
  'duvida',
] as const;
export type ProspectReviewReason = (typeof PROSPECT_REVIEW_REASONS)[number];

export const PROSPECT_REVIEW_REASON_LABELS: Record<ProspectReviewReason, string> = {
  confianca_baixa: 'Confiança baixa',
  revisao_obrigatoria: 'Serviço de revisão obrigatória',
  servico_nao_vendido: 'Serviço que a Wings não vende',
  sem_ia: 'Sem classificação automática: IA desligada',
  teto_ia: 'Sem classificação automática: teto de IA do dia',
  ia_invalida: 'Sem classificação automática: resposta inválida da IA',
  registro_manual: 'Registro manual',
  duvida: 'Dúvida, não pedido',
};

/** The services the classifier may name (spec PA, annex 1 §2.6), with the funnel each goes to. */
export const PROSPECT_SERVICES: { slug: string; nome: string; funil: LeadPipeline | null }[] = [
  { slug: 'formatacao_franquias', nome: 'Formatação de franquias', funil: 'formatacao' },
  { slug: 'expansao_rede', nome: 'Expansão da própria rede', funil: 'formatacao' },
  {
    slug: 'estruturacao_gestao',
    nome: 'Estruturação e profissionalização da gestão',
    funil: 'consultoria',
  },
  {
    slug: 'organizacao_operacional',
    nome: 'Organização administrativa e operacional',
    funil: 'consultoria',
  },
  { slug: 'sucessao_gestao', nome: 'Sucessão e transição de gestão', funil: 'consultoria' },
  { slug: 'reestruturacao', nome: 'Reestruturação organizacional', funil: 'consultoria' },
  { slug: 'planejamento_estrategico', nome: 'Planejamento estratégico', funil: 'consultoria' },
  {
    slug: 'consultoria_mentoria_coaching',
    nome: 'Consultoria, mentoria e coaching',
    funil: 'consultoria',
  },
  {
    slug: 'desenvolvimento_liderancas',
    nome: 'Desenvolvimento de lideranças',
    funil: 'consultoria',
  },
  {
    slug: 'investidor_franquia',
    nome: 'Investidor que quer comprar uma franquia',
    funil: 'expansao',
  },
  { slug: 'nao_identificada', nome: 'Necessidade não identificada', funil: null },
];
export const PROSPECT_SERVICE_SLUGS = PROSPECT_SERVICES.map((s) => s.slug) as [string, ...string[]];

/** The funnel a category leads to; null = the person who creates the lead chooses. */
export const pipelineOfCategory = (category: string | null): LeadPipeline | null =>
  PROSPECT_SERVICES.find((s) => s.slug === category)?.funil ?? null;

// --- settings (prospect_ai_settings.settings.instagram, §2.5) ---------------------------------

export const DEFAULT_FIRST_DIRECT_MESSAGE = [
  'Oi! Sou {nome_vendedora}, da Wings Company, consultoria de franquias e gestão. Vi o seu comentário no post de @{conta_do_post} e achei que podemos ajudar. Posso te contar como funciona?',
  'Se não quiser receber contato, é só responder "não" que não falamos mais. Privacidade: {link_politica}',
].join('\n');

export const instagramProspectingSettingsSchema = z.object({
  paste: z.object({
    maxChars: z.number().int().min(1_000).max(100_000),
    maxComments: z.number().int().min(10).max(500),
    perSellerPerDay: z.number().int().min(1).max(50),
  }),
  thresholds: z
    .object({
      listar: z.number().int().min(50).max(95),
      revisar: z.number().int().min(0).max(69),
    })
    .refine((t) => t.revisar < t.listar, {
      message: 'O limiar de revisão tem de ser menor que o de listar',
      path: ['revisar'],
    }),
  retention: z.object({ instagramSemLeadDias: z.number().int().min(7).max(90) }),
  /** Business Discovery (parte 3, §6.4); came later, so a saved row without it reads the defaults. */
  discovery: z
    .object({
      cacheDias: z.number().int().min(1).max(30),
      porDia: z.number().int().min(0).max(2_000),
      recentPosts: z.number().int().min(3).max(25),
    })
    .default({ cacheDias: 7, porDia: 500, recentPosts: 12 }),
  /** The private reply of parte 1 (§5.2 to §5.4); came later, so an older row reads the defaults. */
  privateReply: privateReplySettingsSchema.default(DEFAULT_PRIVATE_REPLY_SETTINGS),
  messages: z.object({
    primeiraAbordagemDirect: z
      .string()
      .trim()
      .min(1, 'Escreva o texto')
      .max(1_000)
      .refine((text) => text.includes('{link_politica}'), 'O texto tem de ter {link_politica}'),
    /** Null until the privacy policy is published (t063): "Copiar mensagem" waits for it. */
    linkPolitica: z
      .url({ protocol: /^https$/ })
      .max(300)
      .nullable(),
  }),
});
export type InstagramProspectingSettings = z.infer<typeof instagramProspectingSettingsSchema>;

export const DEFAULT_INSTAGRAM_PROSPECTING_SETTINGS: InstagramProspectingSettings = {
  paste: { maxChars: 50_000, maxComments: 300, perSellerPerDay: 10 },
  thresholds: { listar: 70, revisar: 40 },
  retention: { instagramSemLeadDias: 30 },
  discovery: { cacheDias: 7, porDia: 500, recentPosts: 12 },
  privateReply: DEFAULT_PRIVATE_REPLY_SETTINGS,
  messages: { primeiraAbordagemDirect: DEFAULT_FIRST_DIRECT_MESSAGE, linkPolitica: null },
};

/**
 * The first message the seller copies, with her first name, the post's @ and the policy's link
 * filled in; null while the policy has no link (nothing is copied without the privacy notice).
 */
export function firstDirectMessage(
  settings: InstagramProspectingSettings,
  sellerName: string,
  postOwner: string | null,
): string | null {
  const link = settings.messages.linkPolitica;
  if (!link) return null;
  return settings.messages.primeiraAbordagemDirect
    .replaceAll('{nome_vendedora}', sellerName.trim().split(/\s+/)[0] ?? '')
    .replaceAll('@{conta_do_post}', postOwner ? `@${postOwner}` : 'uma marca do nicho')
    .replaceAll('{conta_do_post}', postOwner ?? 'uma marca do nicho')
    .replaceAll('{link_politica}', link);
}

// --- the paste (§1.2, §4) ---------------------------------------------------------------------

export const instagramPasteSchema = z.object({
  /** Checked against `paste.maxChars` by the API (413), never kept. */
  text: z.string().min(1, 'Cole os comentários').max(100_000, 'Cole no máximo 100.000 caracteres'),
  postUrl: z.string().trim().min(1, 'Informe o link do post').max(300),
  postOwner: z.string().trim().max(60).optional().or(z.literal('')),
});
export type InstagramPasteInput = z.infer<typeof instagramPasteSchema>;

/** How a comment crosses the base (§2.4). */
export type PasteCommentTag =
  | { kind: 'nao_contatar' }
  | { kind: 'cliente' }
  | { kind: 'lead'; ownerName: string | null; leadId: string | null }
  | { kind: 'prospect'; ownerName: string | null };

export interface PastePreviewComment {
  username: string;
  /** Masked (§4.4), at most 280 characters. */
  excerpt: string;
  when: string | null;
  occurredAt: string;
  tag: PasteCommentTag | null;
}

export interface PastePreviewResponse {
  postUrl: string;
  postOwner: string | null;
  format: (typeof INSTAGRAM_PASTE_FORMATS)[number] | null;
  comments: PastePreviewComment[];
  /** Comments that will be classified (no "não contatar", lead or client tag). */
  usable: number;
  linesTotal: number;
  linesIgnored: number;
  ignored: Record<PasteIgnoredKind, number>;
  discarded: Record<PasteDiscardKind, number>;
  unrecognized: string[];
  linesUnrecognized: number;
  /** Known people, only counted. */
  alreadyKnown: { naoContatar: number; cliente: number; lead: number; prospect: number };
  /** The AI's estimated cost of the confirmation, in micro-dollars; null when the AI is off. */
  estimatedCostMicroUsd: number | null;
  aiEnabled: boolean;
}

export interface PasteConfirmResponse {
  batchId: string;
  created: number;
  /** A comment already on an open prospect: joined to it. */
  joined: number;
  /** The same comment pasted before: dropped. */
  repeated: number;
  skippedKnown: number;
  lists: { querComprar: number; revisar: number; outros: Record<BuySignal | 'sem_sinal', number> };
}

// --- the prospects (§1.2 step 5) ---------------------------------------------------------------

export type InstagramProspectList = 'quer_comprar' | 'revisar' | 'outros';
export const listOfState = (state: ProspectOpportunityState): InstagramProspectList =>
  state === 'em_revisao'
    ? 'revisar'
    : PROSPECT_OPEN_STATES.includes(state) || state === 'aprovada'
      ? 'quer_comprar'
      : 'outros';

export interface InstagramProspect {
  id: string;
  batchId: string | null;
  state: ProspectOpportunityState;
  list: InstagramProspectList;
  username: string;
  excerpt: string | null;
  occurredAt: string;
  occurredAtPrecision: 'exata' | 'aproximada';
  postUrl: string | null;
  postOwner: string | null;
  signal: BuySignal | null;
  confidence: number | null;
  justification: string | null;
  category: string | null;
  reviewReason: ProspectReviewReason | null;
  decisionReason: string | null;
  ownerEmployeeId: string | null;
  ownerName: string | null;
  mine: boolean;
  approachedAt: string | null;
  leadId: string | null;
  /** More comments of the same @ joined to this prospect. */
  moreComments: number;
  /** When it is deleted if it does not become a lead (§8.4). */
  purgeAt: string | null;
  createdAt: string;
}

export interface InstagramPasteBatch {
  id: string;
  createdBy: string;
  createdByName: string | null;
  postUrl: string;
  postOwner: string | null;
  commentsFound: number;
  linesIgnored: number;
  linesUnrecognized: number;
  alreadyKnown: number;
  formatDetected: string | null;
  createdAt: string;
  prospects: number;
}

export const instagramProspectListQuery = z.object({
  batch: z.uuid().optional(),
  state: z.enum(PROSPECT_OPPORTUNITY_STATES).optional(),
  owner: z.uuid().optional(),
});

export const instagramDiscardSchema = z.object({
  reason: z.string().trim().min(3, 'Diga o motivo').max(300),
});
export const instagramDoNotContactSchema = z.object({
  reason: z.string().trim().max(300).optional().or(z.literal('')),
});
export const instagramTransferSchema = z.object({ ownerEmployeeId: z.uuid() });
/** "Anexar o comentário ao lead" (§2.4): a comment of someone who is already a lead. */
export const instagramAttachSchema = z.object({
  leadId: z.uuid(),
  postUrl: z.string().trim().min(1).max(300),
  username: z.string().trim().min(1).max(60),
  text: z.string().min(1).max(5_000),
  when: z.string().trim().max(40).nullable().optional(),
});
export type InstagramAttachInput = z.infer<typeof instagramAttachSchema>;

/** "Criar lead" (§1.2): what the person wrote in the Direct, typed by the seller. */
export const instagramLeadSchema = z
  .object({
    contactName: z.string().trim().min(2, 'Informe o nome').max(120),
    companyName: z.string().trim().max(120).optional().or(z.literal('')),
    phone: z.string().trim().max(30).optional().or(z.literal('')),
    email: z.string().trim().max(200).optional().or(z.literal('')),
    pipeline: z.enum(LEAD_PIPELINES).optional(),
    notes: z.string().trim().max(2000).optional().or(z.literal('')),
    whatsappOptIn: z.boolean({ error: 'Diga se a pessoa pediu contato por WhatsApp' }),
  })
  .refine((v) => Boolean(v.phone || v.email), {
    message: 'Informe o telefone ou o e-mail que a pessoa passou',
    path: ['phone'],
  });
export type InstagramLeadInput = z.infer<typeof instagramLeadSchema>;

export interface InstagramStatus {
  /** PROSPECT_AI_INSTAGRAM_PASTE_ENABLED: off, every route but this one answers 503. */
  enabled: boolean;
  aiEnabled: boolean;
  settings: InstagramProspectingSettings;
  /** Pastes the actor made today (São Paulo) and the day's limit. */
  pastesToday: number;
}

// --- where a classified comment goes (§3.2, parte 2) -------------------------------------------

export interface CommentClassification {
  /** Null: no automatic classification (AI off, ceiling, invalid answer). */
  signal: BuySignal | null;
  confidence: number | null;
  reviewReason: ProspectReviewReason | null;
}

/**
 * "Quer comprar" (`nova`), "Revisar" (`em_revisao`) or "Outros" (`rejeitada`, only counted, the
 * seller may move one back). Nothing here leads to a message: every approach is by hand.
 */
export function placeOfComment(
  c: CommentClassification,
  t: InstagramProspectingSettings['thresholds'],
): { state: 'nova' | 'em_revisao' | 'rejeitada'; reviewReason: ProspectReviewReason | null } {
  if (!c.signal || c.confidence === null)
    return { state: 'em_revisao', reviewReason: c.reviewReason ?? 'ia_invalida' };
  if (c.signal === 'elogio' || c.signal === 'reclamacao' || c.signal === 'spam')
    return { state: 'rejeitada', reviewReason: null };
  if (c.confidence < t.revisar) return { state: 'rejeitada', reviewReason: null };
  if (c.signal === 'duvida') return { state: 'em_revisao', reviewReason: 'duvida' };
  if (c.confidence >= t.listar) return { state: 'nova', reviewReason: null };
  return { state: 'em_revisao', reviewReason: 'confianca_baixa' };
}

/** The decision reason an "Outros" comment is stored with, so the list can tell it from a discard. */
export const OUTROS_REASON_PREFIX = 'Outros: ';

/** The decision reason of a prospect closed by "não me contate": never reopened (lição 4). */
export const DO_NOT_CONTACT_REASON = 'Não contatar';
