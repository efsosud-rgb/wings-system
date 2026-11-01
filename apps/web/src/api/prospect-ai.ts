import type {
  InstagramAttachInput,
  InstagramLeadInput,
  InstagramPasteBatch,
  InstagramPasteInput,
  InstagramProspect,
  InstagramProspectingSettings,
  InstagramStatus,
  PasteConfirmResponse,
  PastePreviewResponse,
} from '@wings/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './client.js';

/**
 * Prospecção → Instagram, parte 2 (docs/prospeccao/instagram.md §1.2) and the queue of parte 1
 * (§1.4). The pasted text goes to
 * the API in the request and nowhere else: it is not cached, and the preview lives in React
 * state only.
 */

const base = '/prospect-ai/instagram';
const key = ['prospect-ai', 'instagram'] as const;

export function useInstagramStatus() {
  return useQuery({
    queryKey: [...key, 'status'],
    queryFn: () => api.get<InstagramStatus>(`${base}/status`),
  });
}

export function useInstagramProspects(batch: string | null, enabled: boolean) {
  return useQuery({
    queryKey: [...key, 'prospects', batch],
    queryFn: () =>
      api.get<{ prospects: InstagramProspect[] }>(
        `${base}/prospects${batch ? `?batch=${encodeURIComponent(batch)}` : ''}`,
      ),
    enabled,
  });
}

export function useInstagramBatches(enabled: boolean) {
  return useQuery({
    queryKey: [...key, 'batches'],
    queryFn: () => api.get<{ batches: InstagramPasteBatch[] }>(`${base}/pastes`),
    enabled,
  });
}

export function useInstagramOwners(enabled: boolean) {
  return useQuery({
    queryKey: [...key, 'owners'],
    queryFn: () => api.get<{ owners: { id: string; name: string }[] }>(`${base}/owners`),
    enabled,
  });
}

/** Reads and crosses the paste; nothing is kept by the API. */
export const usePreviewPaste = () =>
  useMutation({
    mutationFn: (input: InstagramPasteInput) =>
      api.post<PastePreviewResponse>(`${base}/pastes/preview`, input),
  });

function useInvalidating<I, O>(fn: (input: I) => Promise<O>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: key }),
  });
}

export const useConfirmPaste = () =>
  useInvalidating((input: InstagramPasteInput) =>
    api.post<PasteConfirmResponse>(`${base}/pastes`, input),
  );

export const useAttachComment = () =>
  useInvalidating((input: InstagramAttachInput) =>
    api.post<{ ok: true }>(`${base}/pastes/attach`, input),
  );

export type InstagramAction =
  'approached' | 'promote' | 'discard' | 'do-not-contact' | 'transfer' | 'whatsapp-asked';

/** Parte 1: the comments on Wings' posts and ads (the webhook), own or every one. */
export function useWingsComments(enabled: boolean) {
  return useQuery({
    queryKey: [...key, 'prospects', 'parte-1'],
    queryFn: () => api.get<{ prospects: InstagramProspect[] }>(`${base}/prospects?parte=1`),
    enabled,
  });
}

/** "Enviar resposta privada": the API runs the gates of §5.3 and calls Meta once. */
export const usePrivateReply = () =>
  useInvalidating((id: string) =>
    api.post<{ ok: true; status: string }>(`${base}/prospects/${id}/private-reply`, {}),
  );

export const useProspectAction = () =>
  useInvalidating(({ id, action, body }: { id: string; action: InstagramAction; body?: unknown }) =>
    api.post<{ ok: true; prospect: InstagramProspect }>(
      `${base}/prospects/${id}/${action}`,
      body ?? {},
    ),
  );

export const useCreateInstagramLead = () =>
  useInvalidating(({ id, ...input }: InstagramLeadInput & { id: string }) =>
    api.post<{ ok: true; leadId: string; created: boolean }>(`${base}/prospects/${id}/lead`, input),
  );

/** The first message with the seller's name, or why it cannot be copied yet. */
export const fetchFirstMessage = (id: string) =>
  api.get<{ message: string | null; reason: string | null }>(`${base}/prospects/${id}/message`);

export const useSaveInstagramSettings = () =>
  useInvalidating((input: InstagramProspectingSettings) =>
    api.put<{ settings: InstagramProspectingSettings }>(`${base}/settings`, input),
  );
