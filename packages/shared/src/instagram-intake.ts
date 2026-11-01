import { z } from 'zod';

/**
 * Prospecção Instagram, parte 1 (docs/prospeccao/instagram.md §5.2 to §5.4): the rules of the one
 * private reply to a comment on Wings' posts and ads, shared by the API and Ajustes. Reading the
 * webhook is the API's (`modules/instagram/payload.ts`).
 */

export const IG_WEBHOOK_KINDS = ['comment', 'mention', 'message', 'echo', 'referral', 'other'] as const;
export type IgWebhookKind = (typeof IG_WEBHOOK_KINDS)[number];
export const IG_WEBHOOK_STATUSES = ['pending', 'done', 'ignored', 'failed'] as const;

// --- the private reply (§5.2 to §5.4) -------------------------------------------------------

export const PRIVATE_REPLY_MODES = ['desligado', 'clique', 'automatico'] as const;
export type PrivateReplyMode = (typeof PRIVATE_REPLY_MODES)[number];
export const PRIVATE_REPLY_MODE_LABELS: Record<PrivateReplyMode, string> = {
  desligado: 'Desligada: só a oportunidade, nenhuma resposta',
  clique: 'Pelo clique: a dona ou a gerência clica "Enviar resposta privada"',
  automatico: 'Sozinha, só com confiança alta (as outras continuam pelo clique)',
};

/** Meta: within 7 days of the comment; we stop one hour earlier (spec PA §3.1, step 6). */
export const PRIVATE_REPLY_DAYS = 7;
export const PRIVATE_REPLY_MARGIN_MS = 60 * 60_000;
/** Spec PA proposals: under Meta's 750 an hour; one reply per person every 7 days (our care). */
export const PRIVATE_REPLIES_PER_HOUR = 600;
export const PRIVATE_REPLY_SAME_PERSON_DAYS = 7;
/** Meta: a follow-up only within 24 h of the person's last message. */
export const DIRECT_WINDOW_HOURS = 24;

/** The last moment a private reply may leave for a comment made at `commentAt`. */
export const privateReplyDeadline = (commentAt: Date) =>
  new Date(commentAt.getTime() + PRIVATE_REPLY_DAYS * 86_400_000 - PRIVATE_REPLY_MARGIN_MS);

export const IG_PRIVATE_REPLY_STATUSES = [
  'sending',
  'sent',
  'failed',
  'rate_limited',
  'unknown',
] as const;
export type IgPrivateReplyStatus = (typeof IG_PRIVATE_REPLY_STATUSES)[number];

export const IG_PRIVATE_REPLY_BLOCKS = [
  'desligado',
  'sem_texto',
  'prazo_meta',
  'nao_contatar',
  'limite_pessoa',
  'limite_hora',
] as const;
export type IgPrivateReplyBlock = (typeof IG_PRIVATE_REPLY_BLOCKS)[number];

export const IG_PRIVATE_REPLY_BLOCK_LABELS: Record<IgPrivateReplyBlock, string> = {
  desligado: 'Resposta privada desligada',
  sem_texto: 'A política de privacidade ainda não tem link em Ajustes',
  prazo_meta: 'Passou o prazo de 7 dias da Meta',
  nao_contatar: 'Pediu para não ser contatado',
  limite_pessoa: 'Esta pessoa já recebeu uma resposta nos últimos 7 dias',
  limite_hora: 'Limite de respostas da hora; tente de novo em alguns minutos',
};

export const IG_PRIVATE_REPLY_STATUS_LABELS: Record<IgPrivateReplyStatus, string> = {
  sending: 'Enviando',
  sent: 'Resposta privada enviada',
  failed: 'A Meta recusou a resposta',
  rate_limited: 'A Meta pediu para esperar; sai de novo sozinha dentro do prazo',
  unknown: 'Envio não confirmado; confira no Instagram (não é reenviado)',
};

export const DEFAULT_PRIVATE_REPLY_TEXT = [
  'Oi! Aqui é a Wings Company, consultoria de franquias e gestão. Vimos o seu comentário no nosso post e queremos te responder direitinho.',
  'Qual o melhor jeito de um consultor falar com você: por aqui, por telefone, por WhatsApp ou por e-mail? Se for telefone, WhatsApp ou e-mail, pode mandar o contato nesta conversa.',
  'Usamos só o que você enviar aqui para responder ao seu pedido. Para não receber mais mensagens, responda PARAR. Privacidade: {link_politica}',
].join('\n');

export const privateReplySettingsSchema = z.object({
  modo: z.enum(PRIVATE_REPLY_MODES),
  confiancaAutomatica: z.number().int().min(70).max(100),
  /** Fixed, approved by Eric; never written by the AI. */
  texto: z
    .string()
    .trim()
    .min(20, 'Escreva o texto')
    .max(1_000)
    .refine((text) => text.includes('{link_politica}'), 'O texto tem de ter {link_politica}'),
});
export type PrivateReplySettings = z.infer<typeof privateReplySettingsSchema>;

/** Off until Fase C goes live (§5.2): only the opportunity, no reply. */
export const DEFAULT_PRIVATE_REPLY_SETTINGS: PrivateReplySettings = {
  modo: 'desligado',
  confiancaAutomatica: 85,
  texto: DEFAULT_PRIVATE_REPLY_TEXT,
};

/**
 * The text that goes, with the policy's link; on an ad, "no nosso anúncio". Null while the policy
 * has no link: nothing leaves without the privacy notice. Nothing else is interpolated.
 */
export function privateReplyText(
  reply: PrivateReplySettings,
  linkPolitica: string | null,
  onAd: boolean,
): string | null {
  if (!linkPolitica) return null;
  const text = reply.texto.replaceAll('{link_politica}', linkPolitica);
  return onAd ? text.replaceAll('no nosso post', 'no nosso anúncio') : text;
}

/** In `automatico`, a buying comment at or above the threshold goes alone; the rest wait a click. */
export const repliesAlone = (
  reply: PrivateReplySettings,
  signal: string | null,
  confidence: number | null,
) =>
  reply.modo === 'automatico' &&
  (signal === 'quer_comprar' || signal === 'pediu_preco') &&
  confidence !== null &&
  confidence >= reply.confiancaAutomatica;

/**
 * Turning the reply on alone, lowering its threshold or changing its text is only for
 * `prospect_ai.instagram_auto_reply` (Admin Master, §9); switching it off or to the click is not.
 */
export function privateReplyChangeDenial(
  before: PrivateReplySettings,
  after: PrivateReplySettings,
  canAutoReply: boolean,
): string | null {
  if (canAutoReply) return null;
  if (after.texto !== before.texto) return 'Só o Admin Master troca o texto da resposta privada.';
  if (after.modo === 'automatico' && before.modo !== 'automatico')
    return 'Só o Admin Master liga a resposta privada sozinha.';
  if (after.modo === 'automatico' && after.confiancaAutomatica < before.confiancaAutomatica)
    return 'Só o Admin Master baixa a confiança da resposta sozinha.';
  return null;
}
