import { describe, expect, it } from 'vitest';
import {
  AGENT_JUNK_SEARCH_TERMS,
  AGENT_MODELS,
  AGENT_MODEL_PRICING,
  AGENT_PROPOSAL_TOOLS,
  AGENT_READ_TOOLS,
  AGENT_TOOL_LABEL,
  MEDIA_AGENT_PROPOSAL_TOOLS,
  MEDIA_AGENT_READ_TOOLS,
  agentCampaignProposalSchema,
  agentChangeProposalSchema,
  agentSendMessageSchema,
  estimateAgentCostMicroUsd,
  keywordWithMatch,
} from './agent.js';

/** A copy without the named keys. */
function without<T extends object, K extends keyof T>(value: T, ...keys: K[]): Omit<T, K> {
  return Object.fromEntries(
    Object.entries(value).filter(([key]) => !keys.includes(key as K)),
  ) as Omit<T, K>;
}

const campaign = {
  platform: 'meta',
  name: 'Franquia SP — leads',
  objective: 'lead',
  idealCustomerProfile: 'Empresário dono de negócio que quer expandir por franquias.',
  reach: { states: ['SP'] },
  destinationUrl: 'https://wingscompany.com.br/franquia',
  utms: { utm_source: 'meta', utm_medium: 'paid_social', utm_campaign: 'franquia-sp' },
  dailyBudgetCents: 3000,
  startDate: '2026-10-01',
  endDate: '2026-10-10',
  ageMin: 30,
  ageMax: 55,
  placements: { mode: 'automatic' },
  formatKey: 'feed_square',
  copy: [
    {
      headline: 'Leve a Wings para sua cidade',
      primaryText: 'Conheça o modelo e o suporte.',
      callToAction: 'LEARN_MORE',
      mediaBrief: 'Dono de loja em frente ao negócio, com a frase "Sua marca em outras cidades".',
    },
    {
      headline: 'Expanda por franquias',
      primaryText: 'Método, contratos e operação com a Wings.',
      callToAction: 'CONTACT_US',
      mediaBrief: 'Mapa com pontos em várias cidades e a marca ao centro, sem números.',
    },
  ],
  explanations: [
    'objective',
    'idealCustomerProfile',
    'reach',
    'dailyBudgetCents',
    'dates',
    'age',
    'placements',
    'format',
    'copy',
  ].map((field) => ({ field, reason: 'Motivo curto com um número: 30.' })),
  assumptions: ['A página de destino é a de franquia do site.'],
  summary: 'Leads de franquia em SP.',
};

const search = {
  keywords: [
    { text: 'abrir franquia', match: 'phrase' as const },
    { text: 'formatação de franquia', match: 'exact' as const },
    { text: 'como franquear', match: 'broad' as const },
  ],
  negativeKeywords: ['vaga', 'emprego', 'currículo', 'curso', 'grátis'],
  headlines: ['Franquia Wings', 'Franqueie sua marca', 'Expanda já'],
  descriptions: ['Suporte completo.', 'Fale com um consultor.'],
};
const common = without(campaign, 'ageMin', 'ageMax', 'placements', 'formatKey', 'copy');
const searchCampaign = {
  ...common,
  platform: 'google_search',
  search,
  explanations: [
    'objective',
    'idealCustomerProfile',
    'reach',
    'dailyBudgetCents',
    'dates',
    'search',
  ].map((field) => ({ field, reason: 'Motivo curto.' })),
};

describe('the agent contract', () => {
  it('prices every model it allows, and estimates in millionths of a dollar', () => {
    expect(Object.keys(AGENT_MODEL_PRICING).sort()).toEqual([...AGENT_MODELS].sort());
    // 3000 input at $2/M + 200 output at $10/M = $0.008
    expect(estimateAgentCostMicroUsd('anthropic/claude-sonnet-5', 3000, 200)).toBe(8000);
    expect(estimateAgentCostMicroUsd('anthropic/claude-haiku-4.5', 3000, 200)).toBe(4000);
  });

  it('names every tool for the screen, and none of them acts', () => {
    const tools = [
      ...AGENT_READ_TOOLS,
      ...AGENT_PROPOSAL_TOOLS,
      ...MEDIA_AGENT_READ_TOOLS,
      ...MEDIA_AGENT_PROPOSAL_TOOLS,
    ];
    expect(Object.keys(AGENT_TOOL_LABEL).sort()).toEqual([...tools].sort());
    expect(tools.join(' ')).not.toMatch(/execut|aprovar|criar_pedido|gerar_|generate/);
  });

  it('accepts a complete campaign proposal and drops whatever the builder has no field for', () => {
    const parsed = agentCampaignProposalSchema.parse({ ...campaign, startPaused: false });
    expect(parsed).not.toHaveProperty('startPaused');
    expect(agentCampaignProposalSchema.safeParse(searchCampaign).success).toBe(true);
  });

  it('holds the agent’s copy to the same compliance rules as a person’s', () => {
    const result = agentCampaignProposalSchema.safeParse({
      ...campaign,
      copy: campaign.copy.map((item) => ({ ...item, headline: 'Ganhe R$ 10 mil por mês' })),
    });
    expect(result.success).toBe(false);
  });

  it('keeps each platform’s parts on its own platform', () => {
    expect(agentCampaignProposalSchema.safeParse({ ...campaign, search }).success).toBe(false);
    expect(agentCampaignProposalSchema.safeParse({ ...searchCampaign, ageMin: 30 }).success).toBe(
      false,
    );
    expect(
      agentCampaignProposalSchema.safeParse({ ...searchCampaign, platform: 'youtube' }).success,
    ).toBe(false);
  });

  it.each([
    ['no placements', { placements: undefined }, 'Informe os posicionamentos'],
    ['no format', { formatKey: undefined }, 'Informe o formato'],
    ['no age range', { ageMin: undefined }, 'Informe a faixa de idade'],
    ['a single variation', { copy: campaign.copy.slice(0, 1) }, 'variações de texto'],
    [
      'a variation with no brief for Design',
      { copy: campaign.copy.map((item) => without(item, 'mediaBrief')) },
      '',
    ],
    ['no assumptions', { assumptions: [] }, ''],
    ['no region', { reach: { states: [] } }, 'Escolha a região'],
    ['fewer than 7 days', { endDate: '2026-10-05' }, 'Duração mínima de 7 dias'],
    [
      'choices without their reasons',
      { explanations: campaign.explanations.slice(0, 2) },
      'Falta justificar: Área de alcance, Verba diária, Período, Faixa de idade, Posicionamentos, Formato, Textos do anúncio',
    ],
  ])('refuses a proposal with %s', (_label, overrides, message) => {
    const result = agentCampaignProposalSchema.safeParse({ ...campaign, ...overrides });
    expect(result.success).toBe(false);
    if (!result.success && message) {
      expect(result.error.issues.map((issue) => issue.message).join(' | ')).toContain(message);
    }
  });

  it('asks Google proposals for match types and the usual negatives', () => {
    expect(
      agentCampaignProposalSchema.safeParse({
        ...searchCampaign,
        search: { ...search, negativeKeywords: ['vaga'] },
      }).success,
    ).toBe(false);
    expect(
      agentCampaignProposalSchema.safeParse({
        ...searchCampaign,
        search: {
          ...search,
          keywords: search.keywords.map((item) => ({ text: `[${item.text}]`, match: 'exact' })),
        },
      }).success,
    ).toBe(false);
    expect(search.keywords.map(keywordWithMatch)).toEqual([
      '"abrir franquia"',
      '[formatação de franquia]',
      'como franquear',
    ]);
    expect(AGENT_JUNK_SEARCH_TERMS).toEqual(
      expect.arrayContaining([
        'vaga',
        'emprego',
        'currículo',
        'curso',
        'grátis',
        'franquia barata',
      ]),
    );
  });

  it('wants a number behind every proposed change, and what each kind needs', () => {
    const base = {
      campaignExternalId: '120000000000000001',
      justification: 'CPL acima do dobro da média da conta.',
      evidence: [{ label: 'CPL 7 dias', value: 'R$ 92,00' }],
    };
    expect(agentChangeProposalSchema.safeParse({ ...base, kind: 'pause_campaign' }).success).toBe(
      true,
    );
    expect(agentChangeProposalSchema.safeParse({ ...base, kind: 'set_daily_budget' }).success).toBe(
      false,
    );
    expect(
      agentChangeProposalSchema.safeParse({ ...base, kind: 'add_negative_keyword' }).success,
    ).toBe(false);
    expect(
      agentChangeProposalSchema.safeParse({
        ...base,
        kind: 'pause_campaign',
        evidence: [{ label: 'Impressão', value: 'ruim' }],
      }).success,
    ).toBe(false);
  });

  it('bounds a message', () => {
    expect(agentSendMessageSchema.safeParse({ message: '  ' }).success).toBe(false);
    expect(agentSendMessageSchema.safeParse({ message: 'x'.repeat(4001) }).success).toBe(false);
    expect(
      agentSendMessageSchema.safeParse({ message: 'oi', context: { tab: 'owned' } }).success,
    ).toBe(true);
  });
});
