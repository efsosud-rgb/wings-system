import { z } from 'zod';
import {
  BRAZIL_STATES,
  CALLS_TO_ACTION,
  CAMPAIGN_OBJECTIVES,
  COMPLIANCE_RULE_LABEL,
  DRAFT_PLATFORMS,
  HEADLINE_MAX,
  ICP_MAX,
  KEYWORD_MAX_LENGTH,
  MAX_AGE,
  MAX_KEYWORDS,
  MAX_NEGATIVE_KEYWORDS,
  MAX_SEARCH_DESCRIPTIONS,
  MAX_SEARCH_HEADLINES,
  MAX_VARIATIONS,
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
  reachRefusal,
} from './campaign-builder.js';

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
export type AgentReadTool = (typeof AGENT_READ_TOOLS)[number];
export type AgentProposalTool = (typeof AGENT_PROPOSAL_TOOLS)[number];
export type AgentToolName = AgentReadTool | AgentProposalTool;

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
  'copy',
  'search',
  'youtube',
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
  copy: 'Textos do anúncio',
  search: 'Palavras-chave e anúncio de pesquisa',
  youtube: 'Vídeo',
};

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
    idealCustomerProfile: z.string().trim().max(ICP_MAX).optional(),
    reach: z
      .object({
        states: z.array(z.enum(BRAZIL_STATES)).default([]),
        cities: z
          .array(z.object({ name: z.string().trim().min(2).max(80), state: z.enum(BRAZIL_STATES) }))
          .max(50)
          .default([]),
        customLocations: z.array(customLocationSchema).max(5).default([]),
      })
      .optional(),
    destinationUrl: z.url({ protocol: /^https$/ }).optional(),
    dailyBudgetCents: z.number().int().min(MIN_DAILY_BUDGET_CENTS),
    startDate: dateString,
    endDate: dateString,
    ageMin: z.number().int().min(MIN_AGE).max(MAX_AGE).optional(),
    ageMax: z.number().int().min(MIN_AGE).max(MAX_AGE).optional(),
    /** Meta: the words of each variation. The image stays the person's choice. */
    copy: z
      .array(
        z.object({
          headline: z.string().trim().min(1).max(HEADLINE_MAX),
          primaryText: z.string().trim().min(1).max(PRIMARY_TEXT_MAX),
          callToAction: z.enum(CALLS_TO_ACTION).default('LEARN_MORE'),
        }),
      )
      .max(MAX_VARIATIONS)
      .default([]),
    search: z
      .object({
        keywords: z
          .array(z.string().trim().min(2).max(KEYWORD_MAX_LENGTH))
          .min(1)
          .max(MAX_KEYWORDS),
        negativeKeywords: z
          .array(z.string().trim().min(2).max(KEYWORD_MAX_LENGTH))
          .max(MAX_NEGATIVE_KEYWORDS)
          .default([]),
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
      })
      .optional(),
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
    if (campaignDays(proposal.startDate, proposal.endDate) === null) {
      ctx.addIssue({ code: 'custom', path: ['endDate'], message: 'O fim é antes do início' });
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
   * keyword, or anything on a Google campaign that already exists. The card
   * then says the change is done by hand, and offers no button.
   */
  requestable: boolean;
  notRequestableReason: string | null;
}

export type AgentProposalCard = AgentCampaignProposalCard | AgentChangeProposalCard;

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
    tab: z.enum(['paid', 'owned']),
    /** The builder's current values, as typed. Data for a read tool, nothing more. */
    draft: z.record(z.string(), z.unknown()).optional(),
  })
  .optional();

export const agentSendMessageSchema = z.object({
  conversationId: z.uuid().optional(),
  message: z.string().trim().min(1, 'Escreva a mensagem').max(AGENT_MESSAGE_MAX),
  context: agentBuilderContextSchema,
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
//   GET  /agent/conversations           -> { conversations: AgentConversationSummary[] }
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
