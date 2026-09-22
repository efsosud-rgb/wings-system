import { agentCampaignProposalSchema, type AgentCampaignProposal } from '@wings/shared';

/**
 * How a campaign suggestion travels from the dashboard to the studio's
 * builder: through the browser's session storage, read once on arrival and
 * removed. It fills the form and nothing else; launching stays the person's
 * own button in the studio.
 */

export const BUILDER_HANDOFF_KEY = 'wings.builder.proposal';

export interface BuilderHandoff {
  proposal: AgentCampaignProposal;
  pending: string[];
}

export function writeBuilderHandoff(handoff: BuilderHandoff): void {
  try {
    sessionStorage.setItem(BUILDER_HANDOFF_KEY, JSON.stringify(handoff));
  } catch {
    // Storage blocked (private window, quota): the studio opens empty and says nothing false.
  }
}

/** Reads and removes the handoff. Re-validated: storage is data too. */
export function takeBuilderHandoff(): BuilderHandoff | null {
  let raw: string | null;
  try {
    raw = sessionStorage.getItem(BUILDER_HANDOFF_KEY);
    sessionStorage.removeItem(BUILDER_HANDOFF_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { proposal?: unknown; pending?: unknown };
    const proposal = agentCampaignProposalSchema.safeParse(parsed.proposal);
    if (!proposal.success) return null;
    const pending = Array.isArray(parsed.pending)
      ? parsed.pending.filter((item): item is string => typeof item === 'string')
      : [];
    return { proposal: proposal.data, pending };
  } catch {
    return null;
  }
}
