import type {
  DealWhatsApp,
  WaCall,
  WaCallPermissionLive,
  WaConversationItem,
  WaMessage,
  WaTargets,
  WaArtLink,
  WaSendText,
  WaTemplate,
  WaTemplatePreview,
  WaRingingSnapshot,
  WaTemplateSend,
} from '@wings/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { permissionScope, useSession } from './auth.js';
import { api } from './client.js';
import { openRingingStream } from './ringing-stream.js';

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
/** Whether the official number is live (Eric, 14/10): until then a seller sees WhatsApp as "em breve". */
export function useOfficialNumber(enabled = true) {
  return useQuery({
    queryKey: ['whatsapp', 'official-number'],
    queryFn: () => api.get<{ live: boolean }>('/whatsapp/official-number'),
    enabled,
  });
}

/**
 * A seller's send and call (Eric, 19/10): "em breve" until the official number is live, as the API
 * refuses them (403 `whatsapp_soon`); reading the conversation stays. Not known yet is "not live".
 */
export const WHATSAPP_SOON_TEXT =
  'Em breve: enviar e ligar pelo WhatsApp do sistema começa depois da troca do número. Até lá, use o WhatsApp do celular.';

export function useWhatsAppSoon() {
  const session = useSession();
  const seller = permissionScope(session.data, 'leads.whatsapp') !== 'all';
  const official = useOfficialNumber(seller);
  return seller && official.data?.live !== true;
}

/** The Admin Master's switch, flipped on the day the number is swapped. */
export function useSetOfficialNumber() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (live: boolean) =>
      api.put<{ live: boolean }>('/whatsapp/official-number', { live }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['whatsapp', 'official-number'] }),
  });
}

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
    queryFn: () => api.get<WaTargets>(`/whatsapp/targets?q=${encodeURIComponent(term)}`),
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
  useSend<WaTemplateSend>(thread, 'template');

/**
 * What the chosen template becomes now (a common message inside the window,
 * or the approved template), with its fields filled. Read-only: the send
 * decides again on the server.
 */
export function useTemplatePreview(thread: WhatsAppThread, input: WaTemplateSend | null) {
  return useQuery({
    queryKey: ['whatsapp', 'template-preview', threadPath(thread), input],
    queryFn: () =>
      api.post<{ preview: WaTemplatePreview }>(`${threadPath(thread)}/template-preview`, input),
    enabled: input !== null,
    placeholderData: (previous) => previous,
    staleTime: 30_000,
    retry: false,
  });
}

/** The art this conversation's templates carry, for the preview (an address of 5 minutes). */
export function useWhatsAppArt(thread: WhatsAppThread, enabled: boolean) {
  return useQuery({
    queryKey: ['whatsapp', 'art', threadPath(thread)],
    queryFn: () => api.get<WaArtLink>(`${threadPath(thread)}/art`),
    enabled,
    staleTime: 4 * 60_000,
    retry: false,
  });
}

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

const RINGING_KEY = ['whatsapp', 'ringing'] as const;
/** While the stream is down: how often to ask when calling is on, and when it is off. */
const RINGING_FALLBACK_MS = 10_000;
const RINGING_FALLBACK_OFF_MS = 60_000;

/**
 * Calls ringing for the viewer. They arrive by the stream (`ringing-stream.ts`): the
 * whole answer on connect and each time it changes, no request per tab every few
 * seconds. Only while the stream is down does the screen ask for it, slowly (10 s,
 * 60 s when calling is off); the moment an answer comes by the stream the asking stops.
 */
export function useRingingCalls(enabled: boolean) {
  const queryClient = useQueryClient();
  const [live, setLive] = useState(false);

  useEffect(() => {
    if (!enabled) return;
    const close = openRingingStream({
      onSnapshot: (snapshot) => {
        // An ask still on its way would answer older than this: let it go first.
        void queryClient
          .cancelQueries({ queryKey: RINGING_KEY })
          .then(() => queryClient.setQueryData(RINGING_KEY, snapshot));
      },
      onLive: setLive,
    });
    return () => {
      close();
      setLive(false);
    };
  }, [enabled, queryClient]);

  return useQuery({
    queryKey: RINGING_KEY,
    queryFn: () => api.poll<WaRingingSnapshot>('/whatsapp/calls/ringing'),
    enabled: enabled && !live,
    refetchInterval: (query) =>
      query.state.data?.calling ? RINGING_FALLBACK_MS : RINGING_FALLBACK_OFF_MS,
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
