import { useState } from 'react';
import { AgentChat } from '../../agent-chat/AgentChat.js';
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
  canGenerate,
  getBuilderDraft,
}: {
  canGenerate: boolean;
  getBuilderDraft: () => Record<string, unknown> | undefined;
}) {
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
          <AgentChat
            scope="media"
            tab="media"
            title="Agente de Edição Wings"
            canRequest={false}
            canGenerate={canGenerate}
            getBuilderDraft={getBuilderDraft}
            emptyHint="Peça uma imagem ou um vídeo para uma campanha, pergunte quanto custa um modelo ou o que já existe na biblioteca."
            standingHint="O agente lê, estima e propõe no provedor mais barato que atende. Nada é gerado daqui sem o seu clique, e o custo aparece antes."
          />
        )}
      </div>
    </section>
  );
}
