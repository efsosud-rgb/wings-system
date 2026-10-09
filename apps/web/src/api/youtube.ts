import type { YoutubeChannelResponse } from '@wings/shared';
import { useQuery } from '@tanstack/react-query';
import { api } from './client.js';

/**
 * Wings' YouTube channel as the daily ingestion keeps it. One answer serves
 * the Canais próprios block and the builder's list of the channel's videos;
 * neither calls YouTube.
 */
export function useYoutubeChannel(options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: ['youtube', 'channel'],
    queryFn: () => api.get<YoutubeChannelResponse>('/marketing/youtube/videos'),
    staleTime: 5 * 60_000,
    enabled: options.enabled ?? true,
  });
}
