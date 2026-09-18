import type { ReactNode } from 'react';

/**
 * The shape every agent studio takes: conversation on one side, tools on the
 * other.
 *
 * Layout only, on purpose. No chat, no agent, no transport — this is the room,
 * not the conversation. Each studio passes its own tools and its own header;
 * when the chat becomes real it arrives here once, for all of them.
 */

export interface StudioLayoutProps {
  title: string;
  /** One line under the title: what this agent is for. */
  subtitle?: string;
  /** Panel on the right: what the agent can act on. */
  tools: ReactNode;
  /** Optional banner above both panes, e.g. a live-account warning. */
  notice?: ReactNode;
  /**
   * Replaces the placeholder conversation. Absent until the chat is built,
   * which is deliberately not part of this phase.
   */
  conversation?: ReactNode;
}

function ConversationPlaceholder() {
  return (
    <div className="studio-chat-placeholder">
      <span aria-hidden="true">💬</span>
      <strong>Conversa com o agente</strong>
      <p className="muted">
        O chat ainda não está ligado. Esta área receberá a conversa com o agente — briefing,
        perguntas e propostas de alteração.
      </p>
      <p className="field-hint">
        Qualquer alteração de orçamento proposta aqui continuará passando pelo portão de aprovações.
        Nada é executado direto da conversa.
      </p>
    </div>
  );
}

export function StudioLayout({ title, subtitle, tools, notice, conversation }: StudioLayoutProps) {
  return (
    <>
      <header className="page-header">
        <h1>{title}</h1>
        {subtitle && <p>{subtitle}</p>}
      </header>

      {notice}

      <div className="studio">
        <section className="studio-chat" aria-label="Conversa com o agente">
          {conversation ?? <ConversationPlaceholder />}
        </section>
        <aside className="studio-tools" aria-label="Ferramentas do agente">
          {tools}
        </aside>
      </div>
    </>
  );
}

/** A labelled block inside the tools panel. */
export function StudioToolGroup({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="studio-tool-group">
      <h2>{title}</h2>
      {children}
    </section>
  );
}
