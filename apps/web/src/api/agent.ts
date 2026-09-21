import type {
  AgentConversationResponse,
  AgentConversationSummary,
  AgentProposalCard,
  AgentProposalRequestResponse,
  AgentSendMessageInput,
  AgentStatusResponse,
  AgentStreamEvent,
} from '@wings/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, api, type ApiErrorBody } from './client.js';

/**
 * The conversation with the traffic agent. Reading and proposing only: the two
 * mutations here record that a person clicked a card, and nothing else.
 */

export function useAgentStatus() {
  return useQuery({
    queryKey: ['agent', 'status'],
    queryFn: () => api.get<AgentStatusResponse>('/agent/status'),
  });
}

export function useAgentConversations(enabled = true) {
  return useQuery({
    queryKey: ['agent', 'conversations'],
    queryFn: () => api.get<{ conversations: AgentConversationSummary[] }>('/agent/conversations'),
    enabled,
  });
}

export function useAgentConversation(id: string | undefined) {
  return useQuery({
    queryKey: ['agent', 'conversation', id],
    queryFn: () => api.get<AgentConversationResponse>(`/agent/conversations/${id}`),
    enabled: Boolean(id),
  });
}

/** Records that the person filled the builder from a campaign card. */
export function useMarkProposalApplied() {
  return useMutation({
    mutationFn: (proposalId: string) =>
      api.post<{ proposal: AgentProposalCard }>(`/agent/proposals/${proposalId}/applied`),
  });
}

/**
 * "Criar pedido": the request is the person's, marked as suggested by the
 * agent, and waits at the approvals gate like any other.
 */
export function useRequestFromProposal() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (proposalId: string) =>
      api.post<AgentProposalRequestResponse>(`/agent/proposals/${proposalId}/request`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['ads'] });
    },
  });
}

/**
 * Splits a `text/event-stream` body into events. Network chunks end anywhere —
 * in the middle of a line, of a JSON object, of a multi-byte character — so
 * text is buffered until a blank line closes the event.
 */
export function createSseParser(onEvent: (event: AgentStreamEvent) => void) {
  let buffer = '';

  const flush = (block: string) => {
    const data = block
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).replace(/^ /, ''))
      .join('\n');
    if (data === '') return;
    try {
      onEvent(JSON.parse(data) as AgentStreamEvent);
    } catch {
      // A line that is not JSON is not an event; the stream goes on.
    }
  };

  return {
    push(chunk: string) {
      buffer += chunk.replace(/\r\n/g, '\n');
      let end = buffer.indexOf('\n\n');
      while (end !== -1) {
        flush(buffer.slice(0, end));
        buffer = buffer.slice(end + 2);
        end = buffer.indexOf('\n\n');
      }
    },
    /** The server may close without the final blank line. */
    end() {
      if (buffer.trim() !== '') flush(buffer);
      buffer = '';
    },
  };
}

/**
 * Sends one message and reports the reply as it is written. Resolves when the
 * stream closes; an abort rejects with the browser's `AbortError`.
 */
export async function streamAgentMessage(
  input: AgentSendMessageInput,
  onEvent: (event: AgentStreamEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const response = await fetch('/api/agent/messages', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify(input),
    signal,
  });

  if (!response.ok) {
    let body: ApiErrorBody = {};
    try {
      body = (await response.json()) as ApiErrorBody;
    } catch {
      // No JSON body: the status alone is the error.
    }
    throw new ApiError(response.status, body);
  }
  if (!response.body) throw new ApiError(502, { message: 'A resposta chegou vazia.' });

  const parser = createSseParser(onEvent);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parser.push(decoder.decode(value, { stream: true }));
  }
  parser.push(decoder.decode());
  parser.end();
}
