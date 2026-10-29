import type { WaInboxSummary } from '@wings/shared';
import { useQuery, type QueryClient } from '@tanstack/react-query';
import { api } from './client.js';

/**
 * The inbox at a glance (docs/whatsapp/cloud-api.md): the menu's count of unread
 * conversations and the stamp that moves with the reader's conversations. It comes
 * by the stream every screen keeps open (`event: inbox` of `ringing-stream.ts`, fed
 * in by `useRingingCalls`); only while the stream is down is it asked for, slowly.
 * When the stamp moves, the lists and the open conversation are fetched again at
 * once, so a new message shows without waiting for their own refresh.
 */

export const INBOX_SUMMARY_KEY = ['whatsapp', 'inbox-summary'] as const;
/** While the stream is down. */
const INBOX_FALLBACK_MS = 30_000;

/** `live`: the last answer came by the stream, which is still open. */
type CachedSummary = WaInboxSummary & { live: boolean };

/** An answer from the stream: kept, and when the stamp moved, what the screens show is fetched again. */
export function receiveInboxSummary(queryClient: QueryClient, summary: WaInboxSummary) {
  const before = queryClient.getQueryData<CachedSummary>(INBOX_SUMMARY_KEY);
  // An ask still on its way would answer older than this: let it go first.
  void queryClient
    .cancelQueries({ queryKey: INBOX_SUMMARY_KEY })
    .then(() =>
      queryClient.setQueryData<CachedSummary>(INBOX_SUMMARY_KEY, { ...summary, live: true }),
    );
  if (before && before.stamp !== summary.stamp) {
    void queryClient.invalidateQueries({ queryKey: ['whatsapp', 'conversations'] });
    void queryClient.invalidateQueries({ queryKey: ['whatsapp', 'thread'] });
  }
}

/** The stream ended: the count is asked for again until it comes back. */
export function inboxStreamDown(queryClient: QueryClient) {
  queryClient.setQueryData<CachedSummary>(INBOX_SUMMARY_KEY, (current) =>
    current ? { ...current, live: false } : current,
  );
}

export function useInboxSummary() {
  return useQuery({
    queryKey: INBOX_SUMMARY_KEY,
    queryFn: async (): Promise<CachedSummary> => ({
      ...(await api.poll<WaInboxSummary>('/whatsapp/inbox/summary')),
      live: false,
    }),
    enabled: (query) => query.state.data?.live !== true,
    refetchInterval: INBOX_FALLBACK_MS,
  });
}
