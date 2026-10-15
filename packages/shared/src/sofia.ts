import { z } from 'zod';
import type { LeadPipeline } from './leads.js';
import type { WaConversationItem, DealWhatsApp } from './whatsapp.js';
import { withArticle, type BrandArticle } from './whatsapp-art.js';

/**
 * Sofia, the virtual SDR (docs/whatsapp/sofia.md). Every new WhatsApp
 * conversation is hers: she says she is Wings' virtual assistant, finds out
 * what the person wants, asks the questions of that funnel one at a time and
 * creates the deal (Formatação by the rotation, Expansão with the brand), or
 * hands the conversation to a person. She never gives prices, never promises
 * anything and never passes for a human. A conversation whose deal already has
 * an owner goes straight to that owner.
 */

/** Who has the conversation now. */
export const SOFIA_STATES = [
  'sofia',
  'waiting_seller',
  'waiting_human',
  'with_person',
  'closed',
] as const;
export type SofiaState = (typeof SOFIA_STATES)[number];

export const SOFIA_STATE_LABELS: Record<SofiaState, string> = {
  sofia: 'Sofia atendendo',
  waiting_seller: 'Aguardando vendedor',
  waiting_human: 'Aguardando atendente',
  with_person: 'Com vendedor',
  closed: 'Encerrada',
};

/** What the person came for, as far as Sofia knows. */
export const SOFIA_SEGMENTS = ['formatacao', 'expansao', 'outro'] as const;
export type SofiaSegment = (typeof SOFIA_SEGMENTS)[number];

export const SOFIA_SEGMENT_LABELS: Record<SofiaSegment, string> = {
  formatacao: 'Formatação',
  expansao: 'Expansão',
  outro: 'Outro assunto',
};

export const SOFIA_SEGMENT_PIPELINE: Record<Exclude<SofiaSegment, 'outro'>, LeadPipeline> = {
  formatacao: 'formatacao',
  expansao: 'expansao',
};

/** Why Sofia passed the conversation to a person instead of a deal. */
export const SOFIA_HANDOFF_REASONS = [
  'cliente_atual',
  'fornecedor',
  'emprego',
  'reclamacao',
  'quer_pessoa',
  'nao_entendeu',
  'midia',
  'ia_indisponivel',
  'teto_diario',
  'sofia_desligada',
  'outro_assunto',
] as const;
export type SofiaHandoffReason = (typeof SOFIA_HANDOFF_REASONS)[number];

export const SOFIA_HANDOFF_LABELS: Record<SofiaHandoffReason, string> = {
  cliente_atual: 'Cliente ou franqueado atual',
  fornecedor: 'Fornecedor ou parceria',
  emprego: 'Procura emprego',
  reclamacao: 'Reclamação',
  quer_pessoa: 'Pediu para falar com uma pessoa',
  nao_entendeu: 'A Sofia não entendeu duas vezes',
  midia: 'Mandou áudio ou arquivo duas vezes',
  ia_indisponivel: 'A IA não respondeu',
  teto_diario: 'Teto diário de IA atingido',
  sofia_desligada: 'Sofia desligada',
  outro_assunto: 'Outro assunto',
};

/** Why a conversation ended without a deal (the only cases Sofia closes alone). */
export const SOFIA_CLOSE_REASONS = ['nao_contatar', 'spam', 'numero_errado', 'encerrada'] as const;
export type SofiaCloseReason = (typeof SOFIA_CLOSE_REASONS)[number];

export const SOFIA_CLOSE_LABELS: Record<SofiaCloseReason, string> = {
  nao_contatar: 'Pediu para não ser contatado',
  spam: 'Spam',
  numero_errado: 'Número errado',
  encerrada: 'Encerrada por uma pessoa',
};

/** The deal's loss reason when Sofia closes a conversation whose open deal has no owner. */
export const SOFIA_LOST_REASONS: Record<Exclude<SofiaCloseReason, 'encerrada'>, string> = {
  nao_contatar: 'Pediu para não ser contatado',
  spam: 'Contato errado ou spam',
  numero_errado: 'Contato errado ou spam',
};

// --- the questions ---------------------------------------------------------------------------

/**
 * `name` is the person's name: taken as written and never sent to the AI.
 * `choice` goes as a WhatsApp list (up to 10 options of 24 characters).
 */
export const SOFIA_QUESTION_KINDS = ['name', 'text', 'choice'] as const;
export type SofiaQuestionKind = (typeof SOFIA_QUESTION_KINDS)[number];

export const SOFIA_QUESTION_KIND_LABELS: Record<SofiaQuestionKind, string> = {
  name: 'Nome da pessoa',
  text: 'Texto livre',
  choice: 'Opções',
};

/** Where an answer also lands on the deal, besides "Dados do formulário". */
export const SOFIA_FIELD_TARGETS = ['name', 'companyName', 'instagram', 'website', 'city'] as const;
export type SofiaFieldTarget = (typeof SOFIA_FIELD_TARGETS)[number];

export const SOFIA_FIELD_TARGET_LABELS: Record<SofiaFieldTarget, string> = {
  name: 'Nome',
  companyName: 'Nome da empresa',
  instagram: 'Instagram',
  website: 'Site',
  city: 'Cidade',
};

/** WhatsApp's own limits for a list message. */
export const SOFIA_OPTION_MAX = 24;
export const SOFIA_OPTIONS_MAX = 10;

export const sofiaQuestionSchema = z
  .object({
    key: z
      .string()
      .trim()
      .regex(/^[a-z][a-z0-9_]{1,30}$/, 'Chave: letras minúsculas, números e _'),
    /** The column name shown on the deal ("Segmento", "Faturamento mensal"). */
    label: z.string().trim().min(2).max(60),
    text: z.string().trim().min(3, 'Escreva a pergunta.').max(300, 'Até 300 caracteres.'),
    kind: z.enum(SOFIA_QUESTION_KINDS),
    options: z
      .array(
        z
          .string()
          .trim()
          .min(1)
          .max(SOFIA_OPTION_MAX, `Cada opção com até ${SOFIA_OPTION_MAX} caracteres.`),
      )
      .max(SOFIA_OPTIONS_MAX, `Até ${SOFIA_OPTIONS_MAX} opções.`)
      .default([]),
    /** The person may skip it ("não tenho"). */
    optional: z.boolean().default(false),
    field: z.enum(SOFIA_FIELD_TARGETS).nullable().default(null),
  })
  .refine((q) => q.kind !== 'choice' || q.options.length >= 2, {
    message: 'Uma pergunta de opções precisa de ao menos 2 opções.',
    path: ['options'],
  })
  // The name never goes to the AI: only a "Nome da pessoa" question fills it, and it always does.
  .refine((q) => (q.kind === 'name') === (q.field === 'name'), {
    message:
      'O nome da pessoa só pode ser uma pergunta do tipo "Nome da pessoa", que vai para Nome.',
    path: ['field'],
  });
export type SofiaQuestion = z.infer<typeof sofiaQuestionSchema>;

// --- who Sofia speaks for (Eric, 07/10) ------------------------------------------------------

/**
 * A franchise lead never hears of Wings: in an Expansão conversation whose
 * brand is known, Sofia (and the seller, and the templates) speak for the
 * brand's expansion team. In Formatação, or before the brand is known, she is
 * Wings Company's. She always says she is a virtual assistant.
 *
 * Her texts say who she is with placeholders, never with the name itself:
 * `{quem}` → "da Wings Company" | "do time de expansão da/do <marca>";
 * `{empresa}` → "Wings Company" | "<marca>"; `{marca}` → the brand.
 */
export const SOFIA_WINGS_NAME = 'Wings Company';

export function sofiaVoice(brand: string | null, article: BrandArticle | null = null) {
  return brand
    ? // The brand's own article ("do Casal do Churros", "da Cabana da Barra"); "da" while nobody said.
      { quem: `do time de expansão ${withArticle(brand, article ?? 'a', 'of')}`, empresa: brand }
    : { quem: `da ${SOFIA_WINGS_NAME}`, empresa: SOFIA_WINGS_NAME };
}

/** A text of Sofia's with its placeholders filled for this conversation. */
export function sofiaWords(
  text: string,
  brand: string | null,
  article: BrandArticle | null = null,
): string {
  const voice = sofiaVoice(brand, article);
  return text
    .replaceAll('{quem}', voice.quem)
    .replaceAll('{empresa}', voice.empresa)
    .replaceAll('{marca}', brand ?? voice.empresa);
}

/** Whether a text names Wings (forbidden in a brand's conversation). */
export const mentionsWings = (text: string) => /wings/i.test(text);

const NO_WINGS = 'Não escreva "Wings": use {empresa} ou {quem}, que viram a marca na Expansão.';

const questionList = z
  .array(sofiaQuestionSchema)
  .min(1, 'Ao menos uma pergunta.')
  .max(12, 'Até 12 perguntas.')
  .refine((list) => new Set(list.map((q) => q.key)).size === list.length, {
    message: 'Cada pergunta precisa de uma chave diferente.',
  })
  .refine((list) => list.filter((q) => q.kind === 'name').length <= 1, {
    message: 'Só uma pergunta pode ser o nome da pessoa.',
  });

const line = (max: number) =>
  z
    .string()
    .trim()
    .min(2)
    .max(max)
    .refine((t) => !mentionsWings(t), { message: NO_WINGS });

/** Everything Sofia says that is not a question; Eric approves the wording. */
export const sofiaTextsSchema = z.object({
  /** First words of every conversation: "atendente virtual {quem}". */
  greeting: line(400)
    .refine((t) => /atendente virtual/i.test(t), {
      message: 'A apresentação precisa dizer que a Sofia é atendente virtual.',
    })
    .refine((t) => t.includes('{quem}'), {
      message: 'A apresentação precisa de {quem} (Wings Company ou o time de expansão da marca).',
    }),
  /** Goes with three buttons: Franquear negócio · Abrir uma franquia · Outro assunto. */
  objective: line(300),
  /** After "Outro assunto": what it is about. */
  otherSubject: line(300),
  /** With the brand of the link or ad: "{marca}" is replaced by its name. */
  brandConfirm: line(300),
  /** Expansão without a known brand. */
  brandQuestion: line(300),
  /** The deal was created and has its seller. */
  handoffSeller: line(400),
  /** To a person of the team, without a deal. */
  handoffHuman: line(400),
  /** Added to a handoff outside Mon–Fri 9h–18h (São Paulo). */
  outOfHours: line(400),
  /** The person asked about prices or conditions. */
  values: line(300),
  /** Before asking the same thing again. */
  notUnderstood: line(200),
  /** Audio, image or file while Sofia talks. */
  media: line(300),
  /** After SAIR / PARAR. */
  optOut: line(300),
  /** The AI failed or the daily ceiling ran out: a person takes over. */
  aiDown: line(300),
});
export type SofiaTexts = z.infer<typeof sofiaTextsSchema>;

export const sofiaSettingsSchema = z.object({
  /** Off: no message goes out from Sofia; new conversations wait for a person. */
  enabled: z.boolean(),
  texts: sofiaTextsSchema,
  formatacao: questionList,
  /** Asked for a brand: never with the word Wings. */
  expansao: questionList.refine(
    (list) => !list.some((q) => [q.text, q.label, ...q.options].some(mentionsWings)),
    { message: NO_WINGS },
  ),
});
export type SofiaSettings = z.infer<typeof sofiaSettingsSchema>;

const ORIGIN_OPTIONS = [
  'Instagram',
  'Facebook',
  'Google',
  'TikTok',
  'LinkedIn',
  'Indicação',
  'Evento ou feira',
  'Outro',
];

/** Starting point until Eric approves the wording (pacote da Sofia de 04/10). */
export const SOFIA_DEFAULT_SETTINGS: SofiaSettings = {
  enabled: false,
  texts: {
    greeting:
      'Olá! Eu sou a Sofia, atendente virtual {quem}. Vou te fazer algumas perguntas rápidas para te direcionar ao consultor certo.',
    objective:
      'Você quer transformar o seu negócio em franquia, abrir uma franquia de uma das nossas marcas ou é outro assunto?',
    otherSubject: 'Claro! Me conta em poucas palavras sobre o que você quer falar.',
    brandConfirm: 'Vi que você se interessou pela franquia {marca}. É isso mesmo?',
    brandQuestion: 'Qual marca de franquia te interessa?',
    handoffSeller:
      'Obrigada! Já passei as suas respostas para um consultor {quem}, que vai continuar o atendimento por aqui.',
    handoffHuman:
      'Vou te passar para uma pessoa da nossa equipe, que continua o atendimento por aqui.',
    outOfHours:
      'Nossa equipe atende de segunda a sexta, das 9h às 18h. Assim que abrirmos, alguém fala com você.',
    values: 'Valores e condições quem passa é o consultor, na conversa com você.',
    notUnderstood: 'Desculpe, não entendi.',
    media: 'Ainda não consigo ouvir áudios nem abrir arquivos. Pode me escrever?',
    optOut: 'Tudo certo, não vamos mais te enviar mensagens. Se precisar, é só escrever.',
    aiDown: 'Já vou te passar para um consultor.',
  },
  formatacao: [
    {
      key: 'nome',
      label: 'Nome',
      text: 'Para começar, qual é o seu nome?',
      kind: 'name',
      options: [],
      optional: false,
      field: 'name',
    },
    {
      key: 'empresa',
      label: 'Empresa',
      text: 'Qual é o nome da sua empresa?',
      kind: 'text',
      options: [],
      optional: false,
      field: 'companyName',
    },
    {
      key: 'segmento',
      label: 'Segmento',
      text: 'Em qual segmento ela atua?',
      kind: 'choice',
      options: [
        'Alimentação',
        'Beleza e estética',
        'Educação',
        'Saúde e bem-estar',
        'Serviços',
        'Varejo',
        'Outro',
      ],
      optional: false,
      field: null,
    },
    {
      key: 'cidade',
      label: 'Cidade',
      text: 'Em qual cidade e estado ela fica?',
      kind: 'text',
      options: [],
      optional: false,
      field: 'city',
    },
    {
      key: 'faturamento',
      label: 'Faturamento mensal',
      text: 'Qual é, mais ou menos, o faturamento mensal da empresa?',
      kind: 'choice',
      options: [
        'Até R$ 50 mil',
        'R$ 50 mil a 100 mil',
        'R$ 100 mil a 300 mil',
        'R$ 300 mil a 1 milhão',
        'Acima de R$ 1 milhão',
        'Prefiro não informar',
      ],
      optional: false,
      field: null,
    },
    {
      key: 'instagram',
      label: 'Instagram',
      text: 'Qual é o Instagram da empresa? Se não tiver, é só dizer "não tenho".',
      kind: 'text',
      options: [],
      optional: true,
      field: 'instagram',
    },
    {
      key: 'site',
      label: 'Site',
      text: 'E o site? Se não tiver, pode dizer "não tenho".',
      kind: 'text',
      options: [],
      optional: true,
      field: 'website',
    },
    {
      key: 'origem',
      label: 'Como conheceu a Wings',
      text: 'Por último: como você conheceu a {empresa}?',
      kind: 'choice',
      options: ORIGIN_OPTIONS,
      optional: false,
      field: null,
    },
  ],
  expansao: [
    {
      key: 'nome',
      label: 'Nome',
      text: 'Qual é o seu nome?',
      kind: 'name',
      options: [],
      optional: false,
      field: 'name',
    },
    {
      key: 'cidade',
      label: 'Cidade de interesse',
      text: 'Em qual cidade e estado você quer abrir a franquia?',
      kind: 'text',
      options: [],
      optional: false,
      field: 'city',
    },
    {
      key: 'investimento',
      label: 'Investimento pretendido',
      text: 'Quanto você pretende investir?',
      kind: 'choice',
      options: [
        'Até R$ 100 mil',
        'R$ 100 mil a 300 mil',
        'R$ 300 mil a 600 mil',
        'Acima de R$ 600 mil',
        'Prefiro não informar',
      ],
      optional: false,
      field: null,
    },
    {
      key: 'prazo',
      label: 'Quando quer começar',
      text: 'Quando você quer começar?',
      kind: 'choice',
      options: ['Nos próximos 3 meses', 'Em 3 a 6 meses', 'Em 6 a 12 meses', 'Ainda pesquisando'],
      optional: false,
      field: null,
    },
    {
      key: 'origem',
      label: 'Como conheceu a marca',
      text: 'Por último: como você chegou até nós?',
      kind: 'choice',
      options: ORIGIN_OPTIONS,
      optional: false,
      field: null,
    },
  ],
};

/** The ids of Sofia's buttons, read back from the person's reply. */
export const SOFIA_BUTTONS = {
  formatacao: 'sofia:formatacao',
  expansao: 'sofia:expansao',
  outro: 'sofia:outro',
  brandYes: 'sofia:marca-sim',
  brandOther: 'sofia:marca-outra',
} as const;

export const SOFIA_OBJECTIVE_BUTTONS = [
  { id: SOFIA_BUTTONS.formatacao, title: 'Franquear negócio' },
  { id: SOFIA_BUTTONS.expansao, title: 'Abrir uma franquia' },
  { id: SOFIA_BUTTONS.outro, title: 'Outro assunto' },
] as const;

export const SOFIA_BRAND_BUTTONS = [
  { id: SOFIA_BUTTONS.brandYes, title: 'Sim' },
  { id: SOFIA_BUTTONS.brandOther, title: 'Outra marca' },
  { id: SOFIA_BUTTONS.outro, title: 'Outro assunto' },
] as const;

// --- the screen ------------------------------------------------------------------------------

export interface SofiaConversationItem extends WaConversationItem {
  state: SofiaState;
  segment: SofiaSegment | null;
  brandName: string | null;
  stateChangedAt: string | null;
  /** A SofiaHandoffReason or SofiaCloseReason, already in Portuguese. */
  reason: string | null;
  ownerName: string | null;
}

export interface SofiaFact {
  key: string;
  label: string;
  answer: string;
}

export interface SofiaConversationDetail {
  item: SofiaConversationItem;
  /** What Sofia found out, in the order of the funnel's questions. */
  facts: SofiaFact[];
  origin: {
    code: string | null;
    /** The ad of a click-to-WhatsApp message (its headline and id), when there was one. */
    adHeadline: string | null;
    adId: string | null;
  };
  lead: {
    id: string;
    name: string | null;
    pipeline: LeadPipeline | null;
    stage: string | null;
    ownerName: string | null;
  } | null;
  thread: DealWhatsApp;
  /** What the reader may do here. */
  can: { take: boolean; giveBack: boolean; close: boolean };
}

export interface SofiaOverview {
  enabled: boolean;
  /** The WhatsApp number is connected (token and number set on the server). */
  whatsappConfigured: boolean;
  /** The AI key is set on the server. */
  aiConfigured: boolean;
  model: string;
  dailyUsd: number;
  spentTodayUsd: number;
  counts: Record<SofiaState, number>;
  canManage: boolean;
}

export const sofiaAttendanceSchema = z.object({
  action: z.enum(['take', 'give_back', 'close']),
});
export type SofiaAttendanceAction = z.infer<typeof sofiaAttendanceSchema>['action'];

export const SOFIA_MODEL = 'deepseek/deepseek-v4-flash';
export type SofiaModel = typeof SOFIA_MODEL;
/** Bumped whenever the prompt changes; stored with every AI call. */
export const SOFIA_PROMPT_VERSION = 'sofia-2026-10-15.1';
