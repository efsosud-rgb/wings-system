import {
  AGENT_MESSAGE_MAX,
  type AgentCampaignProposal,
  type AgentChatMessage,
  type AgentConsultation,
  type AgentProposalCard,
  type AgentStatusResponse,
  type AgentStreamEvent,
} from '@wings/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useId, useRef, useState } from 'react';
import {
  streamAgentMessage,
  useAgentConversation,
  useAgentConversations,
  useAgentStatus,
} from '../../api/agent.js';
import { Button } from '../ui.js';
import { ProposalCard } from './ProposalCards.js';

/**
 * The conversation with the traffic agent, in the studio's side column.
 *
 * The agent reads and proposes. This panel has two kinds of button that do
 * something beyond talking, both inside proposal cards, and both act only when
 * pressed: nothing the agent writes fills a form or creates a request by itself.
 */

export interface AgentChatProps {
  canRequest: boolean;
  tab: 'paid' | 'owned';
  /** The builder's current values, read at the moment a message is sent. */
  getBuilderDraft?: () => Record<string, unknown> | undefined;
  /** Present only while the builder is on screen. */
  onApplyCampaign?: (proposal: AgentCampaignProposal) => void;
}

interface StreamingReply {
  text: string;
  consulting: string | null;
  consulted: AgentConsultation[];
  proposals: AgentProposalCard[];
}

const EMPTY_REPLY: StreamingReply = { text: '', consulting: null, consulted: [], proposals: [] };

function formatUsd(microUsd: number): string {
  return `US$ ${(microUsd / 1_000_000).toLocaleString('pt-BR', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function Consulted({ items }: { items: AgentConsultation[] }) {
  if (items.length === 0) return null;
  return (
    <details className="agent-details agent-consulted">
      <summary>O que consultei</summary>
      <ul>
        {items.map((item, index) => (
          <li key={`${item.tool}-${index}`}>
            <span>{item.label}</span>
            <span className="muted">{item.summary}</span>
          </li>
        ))}
      </ul>
    </details>
  );
}

function AssistantBody({
  content,
  consulted,
  proposals,
  notice,
  canRequest,
  onApplyCampaign,
  acted,
  onActed,
}: {
  content: string;
  consulted: AgentConsultation[];
  proposals: AgentProposalCard[];
  notice: string | null;
  canRequest: boolean;
  onApplyCampaign?: (proposal: AgentCampaignProposal) => void;
  acted: Record<string, AgentProposalCard>;
  onActed: (next: AgentProposalCard) => void;
}) {
  return (
    <>
      {content !== '' && <p className="agent-text">{content}</p>}
      {notice && (
        <div className="alert alert-warning" role="status">
          {notice}
        </div>
      )}
      {proposals.map((proposal) => (
        <ProposalCard
          key={proposal.id}
          proposal={acted[proposal.id] ?? proposal}
          canRequest={canRequest}
          onApplyCampaign={onApplyCampaign}
          onActed={onActed}
        />
      ))}
      <Consulted items={consulted} />
    </>
  );
}

export function AgentChat({ canRequest, tab, getBuilderDraft, onApplyCampaign }: AgentChatProps) {
  const queryClient = useQueryClient();
  const status = useAgentStatus();
  const configured = status.data?.configured ?? false;
  const conversations = useAgentConversations(configured);

  const [conversationId, setConversationId] = useState<string | undefined>();
  const [messages, setMessages] = useState<AgentChatMessage[]>([]);
  const [reply, setReply] = useState<StreamingReply | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [text, setText] = useState('');
  // Cards a person already clicked, as they stand now. Held here because a card
  // moves from the reply being written to the finished message.
  const [acted, setActed] = useState<Record<string, AgentProposalCard>>({});
  const onActed = (next: AgentProposalCard) =>
    setActed((current) => ({ ...current, [next.id]: next }));
  const abort = useRef<AbortController | null>(null);
  const bottom = useRef<HTMLDivElement | null>(null);
  const fieldId = useId();

  // An earlier conversation, chosen in the picker. Copied in once: from then on
  // the list on screen is this panel's own, so a refetch never drops a message
  // that is still being written.
  const [loadId, setLoadId] = useState<string | undefined>();
  const loaded = useAgentConversation(loadId);
  const copiedId = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!loadId || !loaded.data || copiedId.current === loadId) return;
    if (loaded.data.conversation.id !== loadId) return;
    copiedId.current = loadId;
    setMessages(loaded.data.messages);
  }, [loadId, loaded.data]);

  const streaming = reply !== null;
  const lastLength = messages.length + (reply?.text.length ?? 0) + (reply?.proposals.length ?? 0);
  useEffect(() => {
    bottom.current?.scrollIntoView?.({ block: 'nearest' });
  }, [lastLength]);

  useEffect(() => () => abort.current?.abort(), []);

  const usage = status.data?.usage;
  const exhausted = usage?.exhausted ?? false;

  function startNew() {
    abort.current?.abort();
    setConversationId(undefined);
    setLoadId(undefined);
    copiedId.current = undefined;
    setMessages([]);
    setReply(null);
    setProblem(null);
  }

  function open(id: string) {
    if (id === '') return startNew();
    abort.current?.abort();
    copiedId.current = undefined;
    setMessages([]);
    setReply(null);
    setProblem(null);
    setConversationId(id);
    setLoadId(id);
  }

  async function send() {
    const message = text.trim();
    if (message === '' || streaming || exhausted) return;

    const temporaryId = `local-${Date.now()}`;
    setMessages((current) => [
      ...current,
      {
        id: temporaryId,
        role: 'user',
        content: message,
        createdAt: new Date().toISOString(),
        consulted: [],
        proposals: [],
        notice: null,
      },
    ]);
    setText('');
    setProblem(null);
    setReply(EMPTY_REPLY);

    const controller = new AbortController();
    abort.current = controller;
    // Kept outside React state so an interrupted reply can be saved as it stood.
    let partial: StreamingReply = EMPTY_REPLY;
    let finished = false;
    const update = (next: StreamingReply) => {
      partial = next;
      setReply(next);
    };

    const onEvent = (event: AgentStreamEvent) => {
      switch (event.type) {
        case 'conversation':
          setConversationId(event.conversationId);
          setMessages((current) =>
            current.map((item) =>
              item.id === temporaryId ? { ...item, id: event.userMessageId } : item,
            ),
          );
          break;
        case 'consulting':
          update({ ...partial, consulting: event.label });
          break;
        case 'consulted':
          update({
            ...partial,
            consulting: null,
            consulted: [...partial.consulted, event.consultation],
          });
          break;
        case 'delta':
          update({ ...partial, consulting: null, text: partial.text + event.text });
          break;
        case 'proposal':
          update({ ...partial, proposals: [...partial.proposals, event.proposal] });
          break;
        case 'done':
          finished = true;
          setMessages((current) => [...current, event.message]);
          setReply(null);
          queryClient.setQueryData<AgentStatusResponse>(['agent', 'status'], (current) =>
            current ? { ...current, usage: event.usage } : current,
          );
          void queryClient.invalidateQueries({ queryKey: ['agent', 'conversations'] });
          break;
        case 'error':
          setProblem(event.message);
          break;
      }
    };

    try {
      const draft = getBuilderDraft?.();
      await streamAgentMessage(
        {
          conversationId,
          message,
          context: { tab, ...(draft ? { draft } : {}) },
        },
        onEvent,
        controller.signal,
      );
    } catch (error) {
      const aborted = error instanceof DOMException && error.name === 'AbortError';
      if (!aborted) {
        setProblem(error instanceof Error ? error.message : 'Não foi possível falar com o agente.');
      }
    } finally {
      if (!finished) {
        // Whatever was written before the stream stopped stays on screen.
        const kept = partial;
        if (kept.text !== '' || kept.proposals.length > 0) {
          setMessages((current) => [
            ...current,
            {
              id: `local-reply-${Date.now()}`,
              role: 'assistant',
              content: kept.text,
              createdAt: new Date().toISOString(),
              consulted: kept.consulted,
              proposals: kept.proposals,
              notice: 'Resposta interrompida.',
            },
          ]);
        }
        setReply(null);
        void queryClient.invalidateQueries({ queryKey: ['agent', 'status'] });
      }
      if (abort.current === controller) abort.current = null;
    }
  }

  if (status.isLoading) {
    return (
      <div className="agent-chat">
        <h2 className="agent-chat-title">Conversa com o agente</h2>
        <p className="muted" role="status">
          Carregando…
        </p>
      </div>
    );
  }

  if (!configured) {
    return (
      <div className="agent-chat">
        <h2 className="agent-chat-title">Conversa com o agente</h2>
        <p className="muted">O agente ainda não está configurado neste ambiente.</p>
      </div>
    );
  }

  const earlier = conversations.data?.conversations ?? [];

  return (
    <div className="agent-chat">
      <div className="agent-chat-head">
        <h2 className="agent-chat-title">Conversa com o agente</h2>
        <button type="button" className="link-button" onClick={startNew}>
          Nova conversa
        </button>
      </div>

      {earlier.length > 0 && (
        <label className="agent-chat-picker">
          <span className="field-label">Conversas anteriores</span>
          <select
            className="control"
            value={conversationId ?? ''}
            onChange={(event) => open(event.target.value)}
            disabled={streaming}
          >
            <option value="">Conversa nova</option>
            {earlier.map((item) => (
              <option key={item.id} value={item.id}>
                {item.title}
              </option>
            ))}
          </select>
        </label>
      )}

      <p className="field-hint">
        O agente só lê e propõe. Nada é executado daqui: toda proposta vira ação só quando você
        clica, e todo pedido passa pelo portão de aprovações.
      </p>

      <div className="agent-messages" role="log" aria-label="Mensagens" aria-live="off">
        {messages.length === 0 && !streaming && (
          <p className="muted agent-empty">
            {loadId && loaded.isLoading
              ? 'Carregando a conversa…'
              : 'Pergunte sobre gasto, leads, CPL ou alertas, ou peça uma proposta de campanha.'}
          </p>
        )}
        {messages.map((message) => (
          <div key={message.id} className={`agent-message agent-message-${message.role}`}>
            <span className="agent-author">{message.role === 'user' ? 'Você' : 'Agente'}</span>
            {message.role === 'user' ? (
              <p className="agent-text">{message.content}</p>
            ) : (
              <AssistantBody
                content={message.content}
                consulted={message.consulted}
                proposals={message.proposals}
                notice={message.notice}
                canRequest={canRequest}
                onApplyCampaign={onApplyCampaign}
                acted={acted}
                onActed={onActed}
              />
            )}
          </div>
        ))}
        {reply && (
          <div
            className="agent-message agent-message-assistant"
            aria-live="polite"
            aria-busy="true"
          >
            <span className="agent-author">Agente</span>
            {reply.consulting && (
              <p className="muted agent-consulting">Consultando: {reply.consulting}…</p>
            )}
            {reply.text === '' && !reply.consulting && reply.proposals.length === 0 && (
              <p className="muted agent-consulting">Escrevendo…</p>
            )}
            <AssistantBody
              content={reply.text}
              consulted={reply.consulted}
              proposals={reply.proposals}
              notice={null}
              canRequest={canRequest}
              onApplyCampaign={onApplyCampaign}
              acted={acted}
              onActed={onActed}
            />
          </div>
        )}
        <div ref={bottom} />
      </div>

      {problem && (
        <p className="field-error" role="alert">
          {problem}
        </p>
      )}
      {exhausted && usage && (
        <div className="alert alert-warning" role="status">
          O teto de uso de hoje ({formatUsd(usage.limitMicroUsd)}) foi atingido. O agente volta a
          responder amanhã.
        </div>
      )}

      <form
        className="agent-form"
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
      >
        <label className="field-label" htmlFor={fieldId}>
          Mensagem
        </label>
        <textarea
          id={fieldId}
          className="control agent-input"
          rows={3}
          maxLength={AGENT_MESSAGE_MAX}
          value={text}
          disabled={exhausted}
          placeholder="Escreva e tecle Enter"
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return;
            event.preventDefault();
            void send();
          }}
        />
        <div className="agent-form-actions">
          {usage && (
            <span className="agent-usage muted">
              Uso de hoje: {formatUsd(usage.spentMicroUsd)} de {formatUsd(usage.limitMicroUsd)}
            </span>
          )}
          {streaming && (
            <Button type="button" variant="ghost" onClick={() => abort.current?.abort()}>
              Parar
            </Button>
          )}
          <Button type="submit" disabled={streaming || exhausted || text.trim() === ''}>
            Enviar
          </Button>
        </div>
        <span className="field-hint">Enter envia. Shift + Enter quebra a linha.</span>
      </form>
    </div>
  );
}
