import type { DriveLink, StudioRender, StudioRenderRequest } from '@wings/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './client.js';

/**
 * Wings Studio: links for the editor, and renders on the server. The editor
 * itself talks to the Drive through api/drive.ts (sendFile).
 */

/** A link good for an hour, to put a Drive file on the timeline. */
export const studioFileLink = (fileId: string) =>
  api.get<DriveLink>(`/studio/files/${fileId}/link`);

export const RENDER_POLL_MS = 5000;

export const useRenders = () =>
  useQuery({
    queryKey: ['studio', 'renders'],
    queryFn: () => api.get<{ renders: StudioRender[] }>('/studio/renders'),
  });

export const useRender = (id: string | null) =>
  useQuery({
    queryKey: ['studio', 'render', id],
    queryFn: () => api.get<{ render: StudioRender }>(`/studio/renders/${id}`),
    enabled: id !== null,
    refetchInterval: (query) => {
      const state = query.state.data?.render.state;
      return state === 'pending' || state === 'running' ? RENDER_POLL_MS : false;
    },
  });

export const useCreateRender = () => {
  const queries = useQueryClient();
  return useMutation({
    mutationFn: (request: StudioRenderRequest) =>
      api.post<{ render: StudioRender }>('/studio/renders', request),
    onSuccess: () => queries.invalidateQueries({ queryKey: ['studio', 'renders'] }),
  });
};
