import { useState } from 'react';
import { AgentChat } from '../../agent-chat/AgentChat.js';
import { TimelineEditContext, type TimelineEditBridge } from '../../agent-chat/ProposalCards.js';
import type { StudioSession } from '../session.js';
import { ChevronIcon } from './icons.js';

const OPEN_KEY = 'wings.studio.agentOpen';

function remembered(): boolean | null {
  try {
    const value = localStorage.getItem(OPEN_KEY);
    return value === null ? null : value === '1';
  } catch {
    return null;
  }
}

/**
 * The editing agent, folded under the properties. Open by default on wide
 * screens, closed under 1440 px, and whatever the person chose after that.
 */
export function AgentDrawer({
  session,
  canGenerate,
  getBuilderDraft,
}: {
  session: StudioSession;
  canGenerate: boolean;
  getBuilderDraft: () => Record<string, unknown> | undefined;
}) {
  // The agent's timeline cards act on this editor, and only through the session.
  const bridge: TimelineEditBridge = {
    previewing: session.agentPreview?.proposalId ?? null,
    kept: session.agentEditsKept,
    preview: (card) => session.previewAgentEdit(card),
    keep: () => session.keepAgentEdit(),
    discard: () => session.discardAgentEdit(),
  };
  const [open, setOpen] = useState(
    () => remembered() ?? (typeof window !== 'undefined' ? window.innerWidth >= 1440 : true),
  );
  const toggle = () => {
    const next = !open;
    setOpen(next);
    try {
      localStorage.setItem(OPEN_KEY, next ? '1' : '0');
    } catch {
      // Remembering the drawer is a convenience; a blocked storage changes nothing.
    }
  };

  return (
    <section className={`ws-agent${open ? ' ws-agent-open' : ''}`} aria-label="Agente de Edição">
      <button
        type="button"
        className="ws-agent-head"
        aria-expanded={open}
        aria-controls="ws-agent-body"
        onClick={toggle}
      >
        <ChevronIcon open={open} />
        <span>Agente de Edição</span>
        <span className="muted">lê, estima e propõe; gera só no seu clique</span>
      </button>
      <div id="ws-agent-body" className="ws-agent-body" hidden={!open}>
        {open && (
          <TimelineEditContext.Provider value={bridge}>
            <AgentChat
              scope="media"
              tab="media"
              title="Agente de Edição Wings"
              canRequest={false}
              canGenerate={canGenerate}
              getBuilderDraft={getBuilderDraft}
              getTimeline={() => session.timelineForAgent()}
              emptyHint="Peça uma imagem ou um vídeo, ou uma edição: “corta os 3 primeiros segundos”, “põe um título no começo”, “divide o vídeo no segundo 10”."
              standingHint="O agente lê, estima e propõe. Edições viram um cartão com Pré-visualizar; nada muda na linha do tempo nem é gerado sem o seu clique, e o custo de gerar aparece antes."
            />
          </TimelineEditContext.Provider>
        )}
      </div>
    </section>
  );
}
