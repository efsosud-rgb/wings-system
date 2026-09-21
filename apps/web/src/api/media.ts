import {
  isGenerationOver,
  type KairogenPlan,
  type KairogenStatus,
  type MediaAsset,
  type MediaBridgeResponse,
  type MediaEstimate,
  type MediaEstimateRequest,
  type MediaGeneration,
  type MediaModel,
  type MediaUsage,
} from '@wings/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { api } from './client.js';

/**
 * Marketing → Edição de Fotos e Vídeos. Nothing here spends a credit by being
 * called except `useStartGeneration`, and that one takes only the id of an
 * estimate the server already made: the cost is always known before the click.
 */

export interface MediaStudioState {
  usage: MediaUsage | null;
  connected: boolean;
  storageAvailable: boolean;
}

export function useMediaStudio() {
  return useQuery({
    queryKey: ['media', 'studio'],
    queryFn: () => api.get<MediaStudioState>('/media/studio'),
  });
}

export function useMediaModels(kind: 'image' | 'video', enabled = true) {
  return useQuery({
    queryKey: ['media', 'models', kind],
    queryFn: () =>
      api.get<{ models: MediaModel[]; cachedAt: string }>(`/media/models?kind=${kind}`),
    enabled,
    // The server caches the catalog for an hour; asking more often gains nothing.
    staleTime: 10 * 60_000,
  });
}

export interface MediaAssetFilters {
  kind?: 'image' | 'video';
  origin?: 'kairogen' | 'upload';
  aspect?: string;
  tag?: string;
  q?: string;
}

export function mediaAssetsPath(filters: MediaAssetFilters = {}): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (typeof value === 'string' && value.trim() !== '') query.set(key, value.trim());
  }
  const text = query.toString();
  return text === '' ? '/media/assets' : `/media/assets?${text}`;
}

export function useMediaAssets(filters: MediaAssetFilters = {}, enabled = true) {
  const path = mediaAssetsPath(filters);
  return useQuery({
    queryKey: ['media', 'assets', path],
    queryFn: () => api.get<{ assets: MediaAsset[]; storageAvailable: boolean }>(path),
    enabled,
  });
}

/** Where the browser fetches a library file from: the authenticated route, same origin. */
export const mediaFileUrl = (asset: Pick<MediaAsset, 'downloadPath'>) =>
  `/api${asset.downloadPath}`;

export function useUploadMedia() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (file: File) => api.upload<{ asset: MediaAsset }>('/media/assets', file),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['media', 'assets'] }),
  });
}

export function useFileMedia() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      id: string;
      client: string | null;
      folder: string | null;
      tags: string[];
    }) =>
      api.patch<{ asset: MediaAsset }>(`/media/assets/${input.id}`, {
        client: input.client,
        folder: input.folder,
        tags: input.tags,
      }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['media', 'assets'] }),
  });
}

/** Asks what something would cost. Spends nothing. */
export function useEstimate() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (request: MediaEstimateRequest) =>
      api.post<{ estimate: MediaEstimate }>('/media/estimates', request),
    onSuccess: (body) => {
      queryClient.setQueryData<MediaStudioState>(['media', 'studio'], (current) =>
        current ? { ...current, usage: body.estimate.usage } : current,
      );
    },
  });
}

/** The click that spends credits. It can only name an estimate, never parameters. */
export function useStartGeneration() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { estimateId: string; proposalId?: string }) =>
      api.post<{ generation: MediaGeneration }>('/media/generations', input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['media', 'generations'] });
      void queryClient.invalidateQueries({ queryKey: ['media', 'studio'] });
    },
  });
}

export function useGenerations(enabled = true) {
  return useQuery({
    queryKey: ['media', 'generations'],
    queryFn: () => api.get<{ generations: MediaGeneration[] }>('/media/generations'),
    enabled,
  });
}

export const GENERATION_POLL_MS = 4000;

/**
 * One generation, followed until it is over. The server does the real polling
 * of Kairogen; this only asks our own route how it stands. When it ends well,
 * the library and the credit figures are refreshed.
 */
export function useGeneration(id: string | undefined) {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: ['media', 'generation', id],
    queryFn: () => api.get<{ generation: MediaGeneration }>(`/media/generations/${id}`),
    enabled: Boolean(id),
    refetchInterval: (current) => {
      const status = current.state.data?.generation.status;
      return status && isGenerationOver(status) ? false : GENERATION_POLL_MS;
    },
  });
  const status = query.data?.generation.status;
  useEffect(() => {
    if (!status || !isGenerationOver(status)) return;
    void queryClient.invalidateQueries({ queryKey: ['media', 'studio'] });
    void queryClient.invalidateQueries({ queryKey: ['media', 'generations'] });
    if (status === 'succeeded')
      void queryClient.invalidateQueries({ queryKey: ['media', 'assets'] });
  }, [status, queryClient]);
  return query;
}

/** Makes a library asset usable by the campaign builder (needs `ads.request`). */
export function useMediaInBuilder() {
  return useMutation({
    mutationFn: (assetId: string) =>
      api.post<MediaBridgeResponse>(`/media/assets/${assetId}/use-in-builder`),
  });
}

export function useSaveKairogenPlan() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (plan: KairogenPlan) =>
      api.put<{ status: KairogenStatus }>('/integrations/kairogen/plan', { plan }),
    onSuccess: (body) => {
      queryClient.setQueryData(['integrations', 'kairogen'], body);
      void queryClient.invalidateQueries({ queryKey: ['media'] });
    },
  });
}

/** sessionStorage keys shared by the two studios. Small, per tab, gone when the tab closes. */
export const PICKED_MEDIA_KEY = 'wings.builder.pickedMedia';
export const BUILDER_DRAFT_KEY = 'wings.builder.draft';
