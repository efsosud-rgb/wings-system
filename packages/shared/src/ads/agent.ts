import { z } from 'zod';
import { studioTimelineSnapshotSchema, type StoredTimelineEdit } from '../studio-agent.js';
import {
  BRAZIL_STATES,
  CALLS_TO_ACTION,
  CAMPAIGN_OBJECTIVES,
  COMPLIANCE_RULE_LABEL,
  CREATIVE_FORMATS,
  DRAFT_PLATFORMS,
  HEADLINE_MAX,
  ICP_MAX,
  ICP_MIN,
  KEYWORD_MAX_LENGTH,
  MAX_AGE,
  MAX_KEYWORDS,
  MAX_NEGATIVE_KEYWORDS,
  MAX_SEARCH_DESCRIPTIONS,
  MAX_SEARCH_HEADLINES,
  MAX_VARIATIONS,
  MIN_VARIATIONS,
  MIN_AGE,
  MIN_DAILY_BUDGET_CENTS,
  PRIMARY_TEXT_MAX,
  SEARCH_DESCRIPTION_MAX,
  SEARCH_HEADLINE_MAX,
  campaignDays,
  checkCopyCompliance,
  customLocationSchema,
  isGooglePlatform,
  parseYoutubeVideoId,
  placementsSchema,
  reachRefusal,
  AD_GROUP_NAME_MAX,
  MAX_MAX_CPC_CENTS,
  MIN_MAX_CPC_CENTS,
  SEARCH_BIDDING_STRATEGIES,
  SEARCH_LOCATION_MODES,
} from './campaign-builder.js';
import type { MediaProviderId } from '../marketing/media-providers.js';
import type { AgentGenerationProposal } from '../marketing/media-studio.js';

/**
 * The conversation with the traffic agent: what the API stores and streams and
 * what the studio renders.
 *
 * The agent reads and proposes. It has no tool that executes anything on an ad
 * platform and none that creates a request: a proposal is a card on the screen,
 * and it becomes an action only when a person clicks. Both sides agree on that
 * here, so neither can grow a shortcut the other does not know about.
 */

// ---------------------------------------------------------------------------
// Models and cost
// ---------------------------------------------------------------------------

/** OpenRouter ids. An allow-list, so a typo in the env never picks a model nobody priced. */
export const AGENT_MODELS = ['anthropic/claude-sonnet-5', 'anthropic/claude-haiku-4.5'] as const;
export type AgentModel = (typeof AGENT_MODELS)[number];
export const DEFAULT_AGENT_MODEL: AgentModel = 'anthropic/claude-sonnet-5';

/**
 * US dollars per million tokens. Only the fallback: when OpenRouter reports
 * what a call cost, that figure is recorded instead.
 */
export const AGENT_MODEL_PRICING: Record<AgentModel, { inputUsd: number; outputUsd: number }> = {
  'anthropic/claude-sonnet-5': { inputUsd: 2, outputUsd: 10 },
  'anthropic/claude-haiku-4.5': { inputUsd: 1, outputUsd: 5 },
};

/** Cost in millionths of a dollar, so sums stay integers. */
export function estimateAgentCostMicroUsd(
  model: AgentModel,
  inputTokens: number,
  outputTokens: number,
): number {
  const price = AGENT_MODEL_PRICING[model];
  return Math.round(inputTokens * price.inputUsd + outputTokens * price.outputUsd);
}

export const DEFAULT_AGENT_DAILY_USD = 2;
export const AGENT_MESSAGE_MAX = 4000;

// ---------------------------------------------------------------------------
// Tools, as the screen names them
// ---------------------------------------------------------------------------

export const AGENT_READ_TOOLS = [
  'estado_da_conta',
  'desempenho_campanhas',
  'conjuntos_e_anuncios',
  'alertas_abertos',
  'termos_de_pesquisa',
  'perfil_cliente_ideal',
  'rascunho_atual',
] as const;
export const AGENT_PROPOSAL_TOOLS = ['propor_campanha', 'propor_alteracao'] as const;

/**
 * One chat infrastructure, one agent per sub-module. Conversations never cross:
 * what was asked of the traffic agent is not context for the editing agent.
 */
export const AGENT_SCOPES = ['traffic', 'media'] as const;
export type AgentScope = (typeof AGENT_SCOPES)[number];

/** The editing agent (Marketing → Edição de Fotos e Vídeos). It reads, estimates and proposes. */
export const MEDIA_AGENT_READ_TOOLS = [
  'listar_provedores',
  'listar_modelos',
  'estimar_custo',
  'consultar_biblioteca',
  'consultar_saldo',
  'rascunho_da_campanha',
  'listar_clientes',
  'linha_do_tempo',
] as const;
export const MEDIA_AGENT_PROPOSAL_TOOLS = ['propor_geracao', 'propor_edicao'] as const;
export type MediaAgentToolName =
  (typeof MEDIA_AGENT_READ_TOOLS)[number] | (typeof MEDIA_AGENT_PROPOSAL_TOOLS)[number];
export type AgentReadTool = (typeof AGENT_READ_TOOLS)[number];
export type AgentProposalTool = (typeof AGENT_PROPOSAL_TOOLS)[number];

/**
 * The insights generator (Dashboard → Marketing → Insights e sugestões) runs
 * on the same infrastructure with the traffic agent's read tools plus these.
 * `registrar_*` are its only "proposal" tools: they write cards, nothing else.
 */
export const INSIGHT_READ_TOOLS = [
  'quebras_de_publico',
  'curva_gasto_leads',
  'desgaste_criativos',
  'vereditos_campanhas',
  'metas_de_cpl',
] as const;
export const INSIGHT_WRITE_TOOLS = ['registrar_insights', 'registrar_sugestoes'] as const;
export type InsightToolName =
  (typeof INSIGHT_READ_TOOLS)[number] | (typeof INSIGHT_WRITE_TOOLS)[number];

export type AgentToolName =
  AgentReadTool | AgentProposalTool | MediaAgentToolName | InsightToolName;

/** "O que consultei": one plain phrase per tool. */
export const AGENT_TOOL_LABEL: Record<AgentToolName, string> = {
  estado_da_conta: 'Conta, tetos e saldo',
  desempenho_campanhas: 'Desempenho das campanhas',
  conjuntos_e_anuncios: 'Conjuntos e anúncios',
  alertas_abertos: 'Alertas abertos',
  termos_de_pesquisa: 'Palavras-chave e termos de pesquisa',
  perfil_cliente_ideal: 'Perfil de cliente ideal salvo',
  rascunho_atual: 'Rascunho aberto no construtor',
  propor_campanha: 'Proposta de campanha',
  propor_alteracao: 'Proposta de alteração',
  listar_provedores: 'Provedores de mídia, saldo e cota',
  listar_modelos: 'Modelos e preços por provedor',
  estimar_custo: 'Custo estimado',
  consultar_biblioteca: 'Biblioteca de mídia',
  consultar_saldo: 'Saldo e limites de créditos',
  rascunho_da_campanha: 'Rascunho aberto no construtor de campanha',
  listar_clientes: 'Clientes cadastrados',
  propor_geracao: 'Proposta de geração',
  linha_do_tempo: 'Linha do tempo aberta no Studio',
  propor_edicao: 'Proposta de edição',
  quebras_de_publico: 'Público, região, posicionamentos, horários e dispositivos',
  curva_gasto_leads: 'Curva de gasto × leads por campanha',
  desgaste_criativos: 'Desgaste dos criativos',
  vereditos_campanhas: 'Veredito por campanha',
  metas_de_cpl: 'Metas de CPL confirmadas',
  registrar_insights: 'Insights registrados',
  registrar_sugestoes: 'Sugestões de campanha registradas',
};

// ---------------------------------------------------------------------------
// Proposals
// ---------------------------------------------------------------------------

function refuseBlockedCopy(ctx: z.RefinementCtx, path: (string | number)[], text: string): void {
  for (const finding of checkCopyCompliance(text)) {
    ctx.addIssue({
      code: 'custom',
      path,
      message: `${COMPLIANCE_RULE_LABEL[finding.rule]}: "${finding.excerpt}"`,
    });
  }
}

const dateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Data no formato AAAA-MM-DD');

/** The fields of the builder a proposal may fill, and so may explain. */
export const AGENT_DRAFT_FIELDS = [
  'platform',
  'name',
  'objective',
  'idealCustomerProfile',
  'reach',
  'destinationUrl',
  'dailyBudgetCents',
  'dates',
  'age',
  'placements',
  'format',
  'copy',
  'search',
  'youtube',
  'utms',
] as const;
export type AgentDraftField = (typeof AGENT_DRAFT_FIELDS)[number];

export const AGENT_DRAFT_FIELD_LABEL: Record<AgentDraftField, string> = {
  platform: 'Plataforma',
  name: 'Nome',
  objective: 'Objetivo',
  idealCustomerProfile: 'Cliente ideal',
  reach: 'Área de alcance',
  destinationUrl: 'Página de destino',
  dailyBudgetCents: 'Verba diária',
  dates: 'Período',
  age: 'Faixa de idade',
  placements: 'Posicionamentos',
  format: 'Formato',
  copy: 'Textos do anúncio',
  search: 'Palavras-chave e anúncio de pesquisa',
  youtube: 'Vídeo',
  utms: 'UTMs',
};

/**
 * What a complete proposal must justify, per platform. A senior traffic
 * manager does not hand over "broad, default" anything: every choice that
 * shapes who sees the ad and what it costs comes with its reason.
 */
const EXPLAINED_ALWAYS: AgentDraftField[] = [
  'objective',
  'idealCustomerProfile',
  'reach',
  'dailyBudgetCents',
  'dates',
];
export const AGENT_EXPLAINED_FIELDS: Record<
  'meta' | 'google_search' | 'youtube',
  readonly AgentDraftField[]
> = {
  meta: [...EXPLAINED_ALWAYS, 'age', 'placements', 'format', 'copy'],
  google_search: [...EXPLAINED_ALWAYS, 'search'],
  youtube: [...EXPLAINED_ALWAYS, 'youtube'],
};

/** A campaign shorter than this never leaves the platform's learning phase. */
export const AGENT_MIN_CAMPAIGN_DAYS = 7;
/** Leads a week a leads campaign should be funded for, by the account's own CPL. */
export const AGENT_LEARNING_LEADS_PER_WEEK = 10;
export const AGENT_MIN_NEGATIVE_KEYWORDS = 5;

/**
 * Searches that are known to bring people who will never buy a franchise. The
 * agent starts every Google proposal's negatives from this list.
 */
export const AGENT_JUNK_SEARCH_TERMS = [
  'vaga',
  'vagas',
  'emprego',
  'currículo',
  'trabalhe conosco',
  'curso',
  'grátis',
  'gratuito',
  'franquia barata',
  'franquia sem investimento',
  'pdf',
  'o que é',
] as const;

export const KEYWORD_MATCH_TYPES = ['exact', 'phrase', 'broad'] as const;
export type KeywordMatchType = (typeof KEYWORD_MATCH_TYPES)[number];

/** A keyword the way Google Ads writes its match type: [exact], "phrase", broad. */
export function keywordWithMatch(keyword: { text: string; match: KeywordMatchType }): string {
  if (keyword.match === 'exact') return `[${keyword.text}]`;
  if (keyword.match === 'phrase') return `"${keyword.text}"`;
  return keyword.text;
}

const mediaBrief = z
  .string()
  .trim()
  .min(20, 'Descreva em duas linhas o que a imagem ou o vídeo deve mostrar')
  .max(400);

/**
 * A campaign the agent proposes, in the builder's own terms.
 *
 * Deliberately NOT a complete `CampaignDraft`: images, videos, the Facebook
 * Page and the Instagram account are things only a person in the studio can
 * choose, so they are absent here and the builder keeps asking for them. What
 * is here is held to the same limits and the same compliance rules as what a
 * person types — a proposal that promises income is refused before it is ever
 * shown.
 */
export const agentCampaignProposalSchema = z
  .object({
    platform: z.enum(DRAFT_PLATFORMS),
    name: z.string().trim().min(3).max(120),
    objective: z.enum(CAMPAIGN_OBJECTIVES),
    idealCustomerProfile: z.string().trim().min(ICP_MIN).max(ICP_MAX),
    reach: z
      .object({
        states: z.array(z.enum(BRAZIL_STATES)).default([]),
        cities: z
          .array(z.object({ name: z.string().trim().min(2).max(80), state: z.enum(BRAZIL_STATES) }))
          .max(50)
          .default([]),
        customLocations: z.array(customLocationSchema).max(5).default([]),
      })
      .refine(
        (reach) => reach.states.length + reach.cities.length + reach.customLocations.length > 0,
        'Escolha a região: estados, cidades ou raio',
      ),
    destinationUrl: z.url({ protocol: /^https$/ }),
    utms: z.object({
      utm_source: z.string().trim().min(1).max(80),
      utm_medium: z.string().trim().min(1).max(80),
      utm_campaign: z.string().trim().min(1).max(80),
      utm_content: z.string().trim().max(80).default(''),
    }),
    dailyBudgetCents: z.number().int().min(MIN_DAILY_BUDGET_CENTS),
    startDate: dateString,
    endDate: dateString,
    ageMin: z.number().int().min(MIN_AGE).max(MAX_AGE).optional(),
    ageMax: z.number().int().min(MIN_AGE).max(MAX_AGE).optional(),
    /** Meta only. */
    placements: placementsSchema.optional(),
    /** Meta only: one of the builder's creative formats. */
    formatKey: z
      .enum(CREATIVE_FORMATS.meta.map((format) => format.key) as [string, ...string[]])
      .optional(),
    /**
     * Meta: the words of each variation. The image or video stays the person's
     * choice, so each variation carries a brief for Design instead.
     */
    copy: z
      .array(
        z.object({
          headline: z.string().trim().min(1).max(HEADLINE_MAX),
          primaryText: z.string().trim().min(1).max(PRIMARY_TEXT_MAX),
          callToAction: z.enum(CALLS_TO_ACTION),
          mediaBrief,
        }),
      )
      .max(MAX_VARIATIONS)
      .default([]),
    search: z
      .object({
        /** The ad group's name; the builder falls back to the campaign's. */
        adGroupName: z.string().trim().min(2).max(AD_GROUP_NAME_MAX).optional(),
        /** Defaults in the builder: presence, maximize_clicks at R$ 6,00. */
        locationMode: z.enum(SEARCH_LOCATION_MODES).optional(),
        bidding: z.enum(SEARCH_BIDDING_STRATEGIES).optional(),
        maxCpcCents: z.number().int().min(MIN_MAX_CPC_CENTS).max(MAX_MAX_CPC_CENTS).optional(),
        keywords: z
          .array(
            z.object({
              text: z
                .string()
                .trim()
                .min(2)
                .max(KEYWORD_MAX_LENGTH - 2)
                .regex(/^[^[\]"]+$/, 'Sem colchetes nem aspas: use match'),
              match: z.enum(KEYWORD_MATCH_TYPES),
            }),
          )
          .min(3, 'Ao menos 3 palavras-chave')
          .max(MAX_KEYWORDS),
        negativeKeywords: z
          .array(z.string().trim().min(2).max(KEYWORD_MAX_LENGTH))
          .min(AGENT_MIN_NEGATIVE_KEYWORDS, `Ao menos ${AGENT_MIN_NEGATIVE_KEYWORDS} negativas`)
          .max(MAX_NEGATIVE_KEYWORDS),
        headlines: z
          .array(z.string().trim().min(1).max(SEARCH_HEADLINE_MAX))
          .min(1)
          .max(MAX_SEARCH_HEADLINES),
        descriptions: z
          .array(z.string().trim().min(1).max(SEARCH_DESCRIPTION_MAX))
          .min(1)
          .max(MAX_SEARCH_DESCRIPTIONS),
      })
      .optional(),
    youtube: z
      .object({
        headline: z.string().trim().min(1).max(HEADLINE_MAX),
        videoUrl: z
          .string()
          .trim()
          .refine((value) => parseYoutubeVideoId(value) !== null, 'Link do YouTube inválido')
          .optional(),
        mediaBrief,
      })
      .optional(),
    /** What was assumed for lack of data. Shown at the end of the card. */
    assumptions: z.array(z.string().trim().min(5).max(300)).min(1).max(8),
    /** Required when the budget is below what the learning phase asks for. */
    budgetNote: z.string().trim().min(10).max(400).optional(),
    /** Why each choice: shown beside the field it explains. */
    explanations: z
      .array(
        z.object({
          field: z.enum(AGENT_DRAFT_FIELDS),
          reason: z.string().trim().min(3).max(400),
        }),
      )
      .min(1)
      .max(AGENT_DRAFT_FIELDS.length),
    summary: z.string().trim().min(3).max(600),
  })
  .superRefine((proposal, ctx) => {
    const days = campaignDays(proposal.startDate, proposal.endDate);
    if (days === null) {
      ctx.addIssue({ code: 'custom', path: ['endDate'], message: 'O fim é antes do início' });
    } else if (days < AGENT_MIN_CAMPAIGN_DAYS) {
      ctx.addIssue({
        code: 'custom',
        path: ['endDate'],
        message: `Duração mínima de ${AGENT_MIN_CAMPAIGN_DAYS} dias, para sair da fase de aprendizado`,
      });
    }

    // Complete, per platform: nothing left at "default".
    const missing = (path: string, message: string) =>
      ctx.addIssue({ code: 'custom', path: [path], message });
    if (proposal.platform === 'meta') {
      if (proposal.ageMin === undefined || proposal.ageMax === undefined) {
        missing('ageMin', 'Informe a faixa de idade (ageMin e ageMax)');
      }
      if (!proposal.placements) missing('placements', 'Informe os posicionamentos');
      if (!proposal.formatKey) missing('formatKey', 'Informe o formato');
      if (proposal.copy.length < MIN_VARIATIONS) {
        missing('copy', `Escreva de ${MIN_VARIATIONS} a ${MAX_VARIATIONS} variações de texto`);
      }
    }
    if (proposal.platform === 'google_search' && !proposal.search) {
      missing('search', 'Informe palavras-chave, negativas, títulos e descrições');
    }
    if (proposal.platform === 'youtube' && !proposal.youtube) {
      missing('youtube', 'Informe o título e o briefing do vídeo');
    }

    // Every choice justified.
    const explained = new Set(proposal.explanations.map((item) => item.field));
    const unexplained = AGENT_EXPLAINED_FIELDS[proposal.platform].filter(
      (field) => !explained.has(field),
    );
    if (unexplained.length > 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['explanations'],
        message: `Falta justificar: ${unexplained.map((field) => AGENT_DRAFT_FIELD_LABEL[field]).join(', ')}`,
      });
    }
    if (
      proposal.ageMin !== undefined &&
      proposal.ageMax !== undefined &&
      proposal.ageMax < proposal.ageMin
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['ageMax'],
        message: 'Idade máxima menor que a mínima',
      });
    }
    const reachProblem = proposal.reach ? reachRefusal(proposal.platform, proposal.reach) : null;
    if (reachProblem) ctx.addIssue({ code: 'custom', path: ['reach'], message: reachProblem });

    const google = isGooglePlatform(proposal.platform);
    if (google && proposal.copy.length > 0) {
      ctx.addIssue({ code: 'custom', path: ['copy'], message: 'Textos de imagem são só da Meta' });
    }
    if (proposal.platform !== 'google_search' && proposal.search) {
      ctx.addIssue({ code: 'custom', path: ['search'], message: 'Só no Google Pesquisa' });
    }
    if (proposal.platform !== 'youtube' && proposal.youtube) {
      ctx.addIssue({ code: 'custom', path: ['youtube'], message: 'Só no YouTube' });
    }
    if (google && (proposal.ageMin !== undefined || proposal.ageMax !== undefined)) {
      ctx.addIssue({ code: 'custom', path: ['ageMin'], message: 'Faixa de idade é só da Meta' });
    }
    if (google && (proposal.placements || proposal.formatKey)) {
      ctx.addIssue({
        code: 'custom',
        path: ['placements'],
        message: 'Posicionamentos e formato são só da Meta',
      });
    }

    // The same compliance rules as the builder, on every word the agent wrote.
    proposal.copy.forEach((item, index) => {
      refuseBlockedCopy(ctx, ['copy', index, 'headline'], item.headline);
      refuseBlockedCopy(ctx, ['copy', index, 'primaryText'], item.primaryText);
    });
    proposal.search?.headlines.forEach((text, index) =>
      refuseBlockedCopy(ctx, ['search', 'headlines', index], text),
    );
    proposal.search?.descriptions.forEach((text, index) =>
      refuseBlockedCopy(ctx, ['search', 'descriptions', index], text),
    );
    if (proposal.youtube)
      refuseBlockedCopy(ctx, ['youtube', 'headline'], proposal.youtube.headline);
  });
export type AgentCampaignProposal = z.output<typeof agentCampaignProposalSchema>;

export const AGENT_CHANGE_KINDS = [
  'pause_campaign',
  'set_daily_budget',
  'add_negative_keyword',
] as const;
export type AgentChangeKind = (typeof AGENT_CHANGE_KINDS)[number];

export const AGENT_CHANGE_KIND_LABEL: Record<AgentChangeKind, string> = {
  pause_campaign: 'Pausar campanha',
  set_daily_budget: 'Mudar a verba diária',
  add_negative_keyword: 'Negativar termo',
};

/**
 * A change to something that already exists, with the numbers behind it.
 *
 * `evidence` is mandatory: a proposal to move money with no figure attached is
 * an opinion, and an approver cannot weigh an opinion.
 */
export const agentChangeProposalSchema = z
  .object({
    kind: z.enum(AGENT_CHANGE_KINDS),
    /** The platform's own id of the campaign, as the read tools report it. */
    campaignExternalId: z.string().trim().min(1).max(64),
    toDailyBudgetCents: z.number().int().min(MIN_DAILY_BUDGET_CENTS).optional(),
    term: z.string().trim().min(2).max(KEYWORD_MAX_LENGTH).optional(),
    justification: z.string().trim().min(10).max(600),
    evidence: z
      .array(
        z.object({
          label: z.string().trim().min(1).max(60),
          value: z.string().trim().min(1).max(60),
        }),
      )
      .min(1)
      .max(8),
  })
  .superRefine((proposal, ctx) => {
    if (proposal.kind === 'set_daily_budget' && proposal.toDailyBudgetCents === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['toDailyBudgetCents'],
        message: 'Informe a verba nova',
      });
    }
    if (proposal.kind === 'add_negative_keyword' && !proposal.term) {
      ctx.addIssue({ code: 'custom', path: ['term'], message: 'Informe o termo' });
    }
    if (!proposal.evidence.some((item) => /\d/.test(item.value))) {
      ctx.addIssue({
        code: 'custom',
        path: ['evidence'],
        message: 'A justificativa precisa de ao menos um número',
      });
    }
  });
export type AgentChangeProposal = z.output<typeof agentChangeProposalSchema>;

export const AGENT_PROPOSAL_STATUSES = ['open', 'applied', 'requested', 'refused'] as const;
export type AgentProposalStatus = (typeof AGENT_PROPOSAL_STATUSES)[number];

interface AgentProposalBase {
  id: string;
  status: AgentProposalStatus;
  createdAt: string;
  /** When a request came out of it: where to find that request. */
  approvalId: string | null;
}

export interface AgentCampaignProposalCard extends AgentProposalBase {
  kind: 'campaign';
  payload: AgentCampaignProposal;
  /**
   * What only a person can choose, named by the server: images or video, the
   * Facebook Page and the Instagram account. The briefs in the payload say
   * what that media should show.
   */
  pending: string[];
}

export interface AgentChangeProposalCard extends AgentProposalBase {
  kind: 'change';
  payload: AgentChangeProposal;
  /** Filled by the server from its own tables, never by the model. */
  campaignName: string;
  platform: 'meta' | 'google' | 'tiktok';
  currentDailyBudgetCents: number | null;
  /**
   * False when the system has no request of this kind to create — a negative
   * keyword, or a budget held at ad-set level. The card then says the change
   * is done by hand, and offers no button.
   */
  requestable: boolean;
  notRequestableReason: string | null;
}

/**
 * A picture or a video the editing agent proposes. The server already asked
 * the provider what it costs, so the button can say "Gerar (R$ X)" or
 * "Gerar (N créditos)"; only the click spends anything.
 */
export interface AgentGenerationProposalCard extends AgentProposalBase {
  kind: 'generation';
  payload: AgentGenerationProposal;
  /** Who the proposal is for, by name, for the card. Null when the client row is gone. */
  clientName: string | null;
  /** Null when the estimate could not be made or has been used. */
  estimate: {
    id: string;
    credits: number;
    brlCents: number;
    providerId: MediaProviderId;
    expiresAt: string;
  } | null;
  /** Set once somebody clicked: the generation to follow. */
  generationId: string | null;
  /** Why the price on the button changed after a click (Kairogen named the real one). */
  priceNote?: string | null;
}

/**
 * Changes to the timeline open in the Studio. The lines were written by the
 * server from the operations; the operations run in the browser only on
 * "Pré-visualizar", as one step that "Descartar" takes back.
 */
export interface AgentTimelineEditProposalCard extends AgentProposalBase {
  kind: 'timeline_edit';
  payload: StoredTimelineEdit;
}

export type AgentProposalCard =
  | AgentCampaignProposalCard
  | AgentChangeProposalCard
  | AgentGenerationProposalCard
  | AgentTimelineEditProposalCard;

// ---------------------------------------------------------------------------
// Conversations
// ---------------------------------------------------------------------------

export interface AgentConsultation {
  tool: AgentToolName;
  label: string;
  /** One short line about what came back, e.g. "3 campanhas, últimos 7 dias". */
  summary: string;
}

export interface AgentChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: string;
  /** Assistant only. */
  consulted: AgentConsultation[];
  proposals: AgentProposalCard[];
  /** Set when the reply was cut short: daily ceiling, provider failure. */
  notice: string | null;
  /**
   * True when asking again may work: the provider failed, the reply was cut or
   * the connection dropped. The screen then offers "Tentar de novo". False for
   * the daily ceiling, where asking again cannot help.
   */
  retryable: boolean;
}

export interface AgentConversationSummary {
  id: string;
  title: string;
  updatedAt: string;
}

export interface AgentUsageToday {
  spentMicroUsd: number;
  limitMicroUsd: number;
  exhausted: boolean;
}

/** What the studio knows that the database does not: the form on screen. */
export const agentBuilderContextSchema = z
  .object({
    tab: z.enum(['paid', 'owned', 'media']),
    /** The builder's current values, as typed. Data for a read tool, nothing more. */
    draft: z.record(z.string(), z.unknown()).optional(),
    /** The Studio's timeline, when the editor is open. Data for a read tool, nothing more. */
    timeline: studioTimelineSnapshotSchema.optional(),
  })
  .optional();

export const agentSendMessageSchema = z.object({
  /** Which agent is being talked to. Absent means the traffic agent, as before. */
  scope: z.enum(AGENT_SCOPES).default('traffic'),
  conversationId: z.uuid().optional(),
  message: z.string().trim().min(1, 'Escreva a mensagem').max(AGENT_MESSAGE_MAX),
  context: agentBuilderContextSchema,
  /**
   * "Tentar de novo": the same words as the last message of the conversation.
   * The server then answers that message again instead of storing a copy of it.
   */
  retry: z.boolean().optional(),
});
export type AgentSendMessageInput = z.input<typeof agentSendMessageSchema>;

/** One `data:` line of the reply stream. */
export type AgentStreamEvent =
  | { type: 'conversation'; conversationId: string; title: string; userMessageId: string }
  | { type: 'consulting'; tool: AgentToolName; label: string }
  | { type: 'consulted'; consultation: AgentConsultation }
  | { type: 'delta'; text: string }
  | { type: 'proposal'; proposal: AgentProposalCard }
  | { type: 'done'; message: AgentChatMessage; usage: AgentUsageToday }
  | { type: 'error'; code: string; message: string };

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------
//
//   GET  /agent/status                  -> AgentStatusResponse
//   GET  /agent/conversations?scope=    -> { conversations: AgentConversationSummary[] }
//   GET  /agent/conversations/:id       -> AgentConversationResponse
//   POST /agent/messages                -> text/event-stream of AgentStreamEvent,
//                                          one JSON object per `data:` line
//   POST /agent/proposals/:id/applied   -> { proposal: AgentProposalCard }
//   POST /agent/proposals/:id/request   -> AgentProposalRequestResponse   (ads.request)
//
// Everything needs `ads.read`. A refusal before the stream opens is ordinary
// JSON `{ error, message }`: 400 invalid_request, 404 not_found, 503
// agent_not_configured. Once the stream is open, problems arrive as an `error`
// event. Reaching the daily ceiling is not an error: the reply is a normal
// `done` whose message carries a `notice` and no model was called.

export interface AgentStatusResponse {
  /** False while OPENROUTER_API_KEY is unset: the panel says so and takes no message. */
  configured: boolean;
  usage: AgentUsageToday;
}

export interface AgentConversationResponse {
  conversation: AgentConversationSummary;
  messages: AgentChatMessage[];
}

export interface AgentProposalRequestResponse {
  proposal: AgentProposalCard;
  approvalId: string | null;
}
