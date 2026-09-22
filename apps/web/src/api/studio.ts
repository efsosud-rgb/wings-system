import type {
  DriveLink,
  StudioRender,
  StudioRenderRequest,
  StudioTranscription,
  StudioTranscriptionRequest,
} from '@wings/shared';
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

// ---------------------------------------------------------------------------
// Captions by Whisper: a `transcribe` job whose SRT is filed in the Drive
// ---------------------------------------------------------------------------

export const TRANSCRIPTION_POLL_MS = 5000;

export const useCreateTranscription = () =>
  useMutation({
    mutationFn: (request: StudioTranscriptionRequest) =>
      api.post<{ transcription: StudioTranscription }>('/studio/transcriptions', request),
  });

/** One transcription, followed until the SRT is in the Drive or the job failed. */
export const useTranscription = (id: string | null) =>
  useQuery({
    queryKey: ['studio', 'transcription', id],
    queryFn: () => api.get<{ transcription: StudioTranscription }>(`/studio/transcriptions/${id}`),
    enabled: id !== null,
    refetchInterval: (query) => {
      const state = query.state.data?.transcription.state;
      return state === 'pending' || state === 'running' ? TRANSCRIPTION_POLL_MS : false;
    },
  });
