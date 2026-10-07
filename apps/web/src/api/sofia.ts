import type {
  SofiaAttendanceAction,
  SofiaConversationDetail,
  SofiaConversationItem,
  SofiaOverview,
  SofiaSegment,
  SofiaSettings,
  SofiaState,
} from '@wings/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './client.js';

/**
 * Sofia, the virtual SDR (docs/whatsapp/sofia.md): her conversations with who
 * has each one, what she found out, and her settings. The list and the open
 * conversation refresh themselves while the screen is visible — passively, so
 * an open screen never keeps an idle session alive.
 */

const LIST_MS = 10_000;
const DETAIL_MS = 5_000;

export interface SofiaFilter {
  state?: SofiaState;
  /** `none`: conversations no funnel took yet. */
  segment?: SofiaSegment | 'none';
  /** A name, or phone digits. */
  q?: string;
}

export interface SofiaSettingsLoaded {
  settings: SofiaSettings;
  updatedAt: string | null;
  updatedBy: string | null;
}

export function useSofiaOverview() {
  return useQuery({
    queryKey: ['sofia', 'overview'],
    queryFn: () => api.poll<SofiaOverview>('/sofia/overview'),
    refetchInterval: LIST_MS,
  });
}

export function useSofiaConversations(filter: SofiaFilter) {
  const params = new URLSearchParams();
  if (filter.state) params.set('state', filter.state);
  if (filter.segment) params.set('segment', filter.segment);
  if (filter.q?.trim()) params.set('q', filter.q.trim());
  const query = params.toString();
  return useQuery({
    queryKey: ['sofia', 'conversations', query],
    queryFn: () =>
      api.poll<{ conversations: SofiaConversationItem[] }>(
        `/sofia/conversations${query ? `?${query}` : ''}`,
      ),
    refetchInterval: LIST_MS,
    // A new filter keeps the old rows on screen until the new ones arrive.
    placeholderData: (previous) => previous,
  });
}

export function useSofiaConversation(id: string | undefined) {
  return useQuery({
    queryKey: ['sofia', 'conversation', id],
    queryFn: () => api.poll<SofiaConversationDetail>(`/sofia/conversations/${id}`),
    enabled: Boolean(id),
    refetchInterval: DETAIL_MS,
    // A 404 is the reader's scope, not a hiccup: asking again changes nothing.
    retry: false,
  });
}

export function useSofiaAttendance(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (action: SofiaAttendanceAction) =>
      api.post<{ state: SofiaState }>(`/sofia/conversations/${id}/attendance`, { action }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['sofia'] }),
  });
}

export function useSofiaSettings() {
  return useQuery({
    queryKey: ['sofia', 'settings'],
    queryFn: () => api.get<SofiaSettingsLoaded>('/sofia/settings'),
  });
}

/** `sofia.manage` only; the server validates the whole form again. */
export function useSaveSofiaSettings() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (settings: SofiaSettings) =>
      api.put<{ settings: SofiaSettings }>('/sofia/settings', settings),
    // The overview's on/off and the "última alteração" line change with it.
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['sofia'] }),
  });
}
