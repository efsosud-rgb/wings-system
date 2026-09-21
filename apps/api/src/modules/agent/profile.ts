import type { AgentConsultation, AgentScope, AgentToolName } from '@wings/shared';
import type { LlmToolDefinition } from './llm.js';
import { AGENT_SYSTEM_PROMPT, contextLine } from './prompt.js';
import {
  AGENT_TOOL_DEFINITIONS,
  isAgentTool,
  runAgentTool,
  type ToolContext,
  type ToolOutcome,
} from './tools.js';

/**
 * One chat infrastructure, one agent per sub-module. A profile is everything
 * that makes an agent itself: who it is, what it can read and what it can
 * propose. The loop around it — streaming, the daily ceiling, the PII filter,
 * the record of every tool call — is the same for all of them.
 */
export interface AgentProfile {
  scope: AgentScope;
  systemPrompt: string;
  tools: LlmToolDefinition[];
  isTool(name: string): name is AgentToolName;
  run(
    ctx: ToolContext,
    call: { name: string; arguments: string },
    proposalsSoFar: number,
    options?: { cut?: boolean },
  ): Promise<ToolOutcome & { consultation: AgentConsultation | null }>;
  /** The volatile first line of the person's message: date, where they are. */
  contextLine(input: { today: string; tab: string | null }): string;
}

export const TRAFFIC_AGENT: AgentProfile = {
  scope: 'traffic',
  systemPrompt: AGENT_SYSTEM_PROMPT,
  tools: AGENT_TOOL_DEFINITIONS,
  isTool: isAgentTool,
  run: runAgentTool,
  contextLine: ({ today, tab }) =>
    contextLine({ today, tab: tab === 'paid' || tab === 'owned' ? tab : null }),
};
