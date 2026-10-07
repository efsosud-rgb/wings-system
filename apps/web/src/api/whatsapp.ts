import type {
  DealWhatsApp,
  WaCall,
  WaCallPermissionLive,
  WaConversationItem,
  WaMessage,
  WaNewTarget,
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

export type WhatsAppInboxFilter = 'all' | 'unread' | 'unanswered';

/** The reader's WhatsApp list (WhatsApp Web): search, unread per reader, last status. */
export function useWhatsAppInbox(filter: WhatsAppInboxFilter, q: string) {
  const params = new URLSearchParams({ filter });
  if (q.trim()) params.set('q', q.trim());
  return useQuery({
    queryKey: ['whatsapp', 'conversations', 'list', filter, q.trim()],
    queryFn: () =>
      api.poll<{ conversations: WaConversationItem[] }>(`/whatsapp/conversations?${params}`),
    refetchInterval: 10_000,
  });
}

/** One conversation by its id (a deal's or one with no deal), refreshed while open. */
export function useWhatsAppConversation(id: string | undefined) {
  return useQuery({
    queryKey: ['whatsapp', 'conversations', 'one', id],
    queryFn: () => api.poll<DealWhatsApp>(`/whatsapp/conversations/${id}`),
    enabled: Boolean(id),
    refetchInterval: REFRESH_MS,
  });
}

/** The reader opened the conversation: its unread count goes to zero, for them only. */
export function useMarkWhatsAppRead() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.passivePost<void>(`/whatsapp/conversations/${id}/read`),
    onSuccess: () =>
      void queryClient.invalidateQueries({ queryKey: ['whatsapp', 'conversations', 'list'] }),
  });
}

/** "Nova conversa": deals and contacts in the reader's scope matching the search. */
export function useWhatsAppTargets(q: string) {
  const term = q.trim();
  return useQuery({
    queryKey: ['whatsapp', 'targets', term],
    queryFn: () =>
      api.get<{ targets: WaNewTarget[] }>(`/whatsapp/targets?q=${encodeURIComponent(term)}`),
    enabled: term.length >= 2,
    staleTime: 10_000,
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
      // A person writing takes the conversation from Sofia: her screen shows it at once.
      void queryClient.invalidateQueries({ queryKey: ['sofia'] });
    },
  });
}

export const useSendWhatsAppText = (thread: WhatsAppThread) => useSend<WaSendText>(thread, 'text');
export const useSendWhatsAppTemplate = (thread: WhatsAppThread) =>
  useSend<WaSendTemplate>(thread, 'template');

/** Where the browser opens a received file (the API checks access and fetches it from Meta). */
export const whatsappMediaUrl = (messageId: string) => `/api/whatsapp/messages/${messageId}/media`;

// --- calls ----------------------------------------------------------------------------

/** The person's call permission, asked of Meta now (only when the call panel opens). */
export function useCallPermission(leadId: string, enabled: boolean) {
  return useQuery({
    queryKey: ['whatsapp', 'call-permission', leadId],
    queryFn: () => api.get<WaCallPermissionLive>(`/leads/${leadId}/whatsapp/call-permission`),
    enabled,
    staleTime: 30_000,
    retry: false,
  });
}

export function useRequestCallPermission(leadId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<{ message: WaMessage }>(`/leads/${leadId}/whatsapp/call-permission`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['whatsapp', 'call-permission', leadId] });
      void queryClient.invalidateQueries({ queryKey: threadKey({ leadId }) });
    },
  });
}

/** Calls ringing for the viewer: asked every few seconds while calling is on, slower when off. */
export function useRingingCalls(enabled: boolean) {
  return useQuery({
    queryKey: ['whatsapp', 'ringing'],
    queryFn: () => api.poll<{ calling: boolean; calls: WaCall[] }>('/whatsapp/calls/ringing'),
    enabled,
    refetchInterval: (query) => (query.state.data?.calling ? 3_000 : 60_000),
    refetchIntervalInBackground: true,
  });
}

/** The call steps, run by the call center in order (no cache: each is one action). */
export const whatsappCalls = {
  start: (leadId: string, sdp: string) =>
    api.post<{ call: WaCall }>(`/leads/${leadId}/whatsapp/calls`, { sdp }),
  get: (id: string) => api.poll<{ call: WaCall }>(`/whatsapp/calls/${id}`),
  connected: (id: string) => api.post<{ call: WaCall }>(`/whatsapp/calls/${id}/connected`),
  pickup: (id: string) =>
    api.post<{ offerSdp: string; call: WaCall }>(`/whatsapp/calls/${id}/pickup`),
  accept: (id: string, sdp: string) =>
    api.post<{ call: WaCall }>(`/whatsapp/calls/${id}/accept`, { sdp }),
  reject: (id: string) => api.post<{ call: WaCall }>(`/whatsapp/calls/${id}/reject`),
  hangup: (id: string) => api.post<{ call: WaCall }>(`/whatsapp/calls/${id}/hangup`),
};
