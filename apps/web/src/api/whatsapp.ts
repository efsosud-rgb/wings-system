import type {
  DealWhatsApp,
  WaConversationItem,
  WaMessage,
  WaSendTemplate,
  WaSendText,
  WaTemplate,
} from '@wings/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './client.js';

/**
 * The official WhatsApp of the CRM (docs/whatsapp/cloud-api.md). The open
 * conversation refreshes itself every few seconds while the screen is
 * visible — passively, so it never keeps an idle session alive.
 */

const REFRESH_MS = 5_000;

/** A deal's conversation (`leadId`), or one no deal took yet (`conversationId`). */
export type WhatsAppThread = { leadId: string } | { conversationId: string };

const threadPath = (thread: WhatsAppThread) =>
  'leadId' in thread
    ? `/leads/${thread.leadId}/whatsapp`
    : `/whatsapp/conversations/${thread.conversationId}`;

const threadKey = (thread: WhatsAppThread) => ['whatsapp', 'thread', threadPath(thread)] as const;

export function useWhatsAppThread(thread: WhatsAppThread, enabled = true) {
  return useQuery({
    queryKey: threadKey(thread),
    queryFn: () => api.poll<DealWhatsApp>(threadPath(thread)),
    enabled,
    refetchInterval: REFRESH_MS,
  });
}

export function useWhatsAppConversations(unanswered: boolean) {
  return useQuery({
    queryKey: ['whatsapp', 'conversations', unanswered],
    queryFn: () =>
      api.poll<{ conversations: WaConversationItem[] }>(
        `/whatsapp/conversations${unanswered ? '?unanswered=1' : ''}`,
      ),
    refetchInterval: 15_000,
  });
}

export function useWhatsAppTemplates(enabled: boolean) {
  return useQuery({
    queryKey: ['whatsapp', 'templates'],
    queryFn: () =>
      api.get<{ templates: WaTemplate[]; configured: boolean; syncError: string | null }>(
        '/whatsapp/templates',
      ),
    enabled,
    staleTime: 5 * 60_000,
  });
}

export function useRefreshWhatsAppTemplates() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () =>
      api.get<{ templates: WaTemplate[]; configured: boolean; syncError: string | null }>(
        '/whatsapp/templates?refresh=1',
      ),
    onSuccess: (data) => queryClient.setQueryData(['whatsapp', 'templates'], data),
  });
}

function useSend<T>(thread: WhatsAppThread, kind: 'text' | 'template') {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: T) =>
      api.post<{ message: WaMessage }>(`${threadPath(thread)}/${kind}`, input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: threadKey(thread) });
      void queryClient.invalidateQueries({ queryKey: ['whatsapp', 'conversations'] });
    },
  });
}

export const useSendWhatsAppText = (thread: WhatsAppThread) => useSend<WaSendText>(thread, 'text');
export const useSendWhatsAppTemplate = (thread: WhatsAppThread) =>
  useSend<WaSendTemplate>(thread, 'template');

/** Where the browser opens a received file (the API checks access and fetches it from Meta). */
export const whatsappMediaUrl = (messageId: string) => `/api/whatsapp/messages/${messageId}/media`;
