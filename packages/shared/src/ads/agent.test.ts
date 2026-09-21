import { describe, expect, it } from 'vitest';
import {
  AGENT_MODELS,
  AGENT_MODEL_PRICING,
  AGENT_PROPOSAL_TOOLS,
  AGENT_READ_TOOLS,
  AGENT_TOOL_LABEL,
  agentCampaignProposalSchema,
  agentChangeProposalSchema,
  agentSendMessageSchema,
  estimateAgentCostMicroUsd,
} from './agent.js';

const campaign = {
  platform: 'meta',
  name: 'Franquia SP — leads',
  objective: 'lead',
  dailyBudgetCents: 3000,
  startDate: '2026-10-01',
  endDate: '2026-10-10',
  copy: [
    { headline: 'Leve a Wings para sua cidade', primaryText: 'Conheça o modelo e o suporte.' },
  ],
  explanations: [{ field: 'dailyBudgetCents', reason: 'Cabe no disponível do mês.' }],
  summary: 'Leads de franquia em SP.',
};

describe('the agent contract', () => {
  it('prices every model it allows, and estimates in millionths of a dollar', () => {
    expect(Object.keys(AGENT_MODEL_PRICING).sort()).toEqual([...AGENT_MODELS].sort());
    // 3000 input at $2/M + 200 output at $10/M = $0.008
    expect(estimateAgentCostMicroUsd('anthropic/claude-sonnet-5', 3000, 200)).toBe(8000);
    expect(estimateAgentCostMicroUsd('anthropic/claude-haiku-4.5', 3000, 200)).toBe(4000);
  });

  it('names every tool for the screen, and none of them acts', () => {
    const tools = [...AGENT_READ_TOOLS, ...AGENT_PROPOSAL_TOOLS];
    expect(Object.keys(AGENT_TOOL_LABEL).sort()).toEqual([...tools].sort());
    expect(tools.join(' ')).not.toMatch(/execut|aprovar|criar_pedido/);
  });

  it('accepts a campaign proposal and drops whatever the builder has no field for', () => {
    const parsed = agentCampaignProposalSchema.parse({ ...campaign, startPaused: false });
    expect(parsed).not.toHaveProperty('startPaused');
    expect(parsed.copy[0]?.callToAction).toBe('LEARN_MORE');
  });

  it('holds the agent’s copy to the same compliance rules as a person’s', () => {
    const result = agentCampaignProposalSchema.safeParse({
      ...campaign,
      copy: [{ headline: 'Ganhe R$ 10 mil por mês', primaryText: 'Retorno garantido.' }],
    });
    expect(result.success).toBe(false);
  });

  it('keeps each platform’s parts on its own platform', () => {
    const search = {
      keywords: ['abrir franquia'],
      headlines: ['Franquia'],
      descriptions: ['Suporte.'],
    };
    expect(agentCampaignProposalSchema.safeParse({ ...campaign, search }).success).toBe(false);
    expect(
      agentCampaignProposalSchema.safeParse({
        ...campaign,
        platform: 'google_search',
        copy: [],
        search,
      }).success,
    ).toBe(true);
    expect(
      agentCampaignProposalSchema.safeParse({ ...campaign, platform: 'youtube' }).success,
    ).toBe(false);
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
