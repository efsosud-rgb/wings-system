import type {
  AdCopyDraft,
  AdCopyRequest,
  AuditRunDetail,
  AuditRunRequest,
  AuditRunSummary,
  IntelligenceOverview,
} from '@wings/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './client.js';

/**
 * Marketing → Wings Ads Intelligence. Reading and auditing call no platform
 * and no model; the only calls that change anything sit behind a click: a
 * request through the budget guard and the approval gate, a finding set aside,
 * an ad package generated (text only, nothing published).
 */

export function useIntelligenceOverview() {
  return useQuery({
    queryKey: ['intelligence', 'overview'],
    queryFn: () => api.get<IntelligenceOverview>('/ads/intelligence/overview'),
    staleTime: 60_000,
  });
}

export function useAuditRuns() {
  return useQuery({
    queryKey: ['intelligence', 'audits'],
    queryFn: () => api.get<{ runs: AuditRunSummary[] }>('/ads/intelligence/audits'),
  });
}

export function useAuditRun(id: string | null) {
  return useQuery({
    queryKey: ['intelligence', 'audit', id],
    queryFn: () => api.get<AuditRunDetail>(`/ads/intelligence/audits/${id}`),
    enabled: id !== null,
  });
}

export function useRunAudit() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: AuditRunRequest) =>
      api.post<AuditRunDetail>('/ads/intelligence/audits', input),
    onSuccess: (detail) => {
      queryClient.setQueryData(['intelligence', 'audit', detail.run.id], detail);
      void queryClient.invalidateQueries({ queryKey: ['intelligence', 'audits'] });
      void queryClient.invalidateQueries({ queryKey: ['intelligence', 'overview'] });
    },
  });
}

export function useFindingAction(runId: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, action }: { id: string; action: 'request' | 'dismiss' }) =>
      api.post<{ approvalId?: string | null }>(`/ads/intelligence/findings/${id}/${action}`),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ['intelligence', 'audit', runId] });
      void queryClient.invalidateQueries({ queryKey: ['intelligence', 'overview'] });
    },
  });
}

export function useCopyDrafts() {
  return useQuery({
    queryKey: ['intelligence', 'copy-drafts'],
    queryFn: () => api.get<{ drafts: AdCopyDraft[] }>('/ads/intelligence/copy-drafts'),
  });
}

export function useGenerateCopy() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: AdCopyRequest) =>
      api.post<{ draft: AdCopyDraft }>('/ads/intelligence/copy-drafts', input),
    onSuccess: () =>
      void queryClient.invalidateQueries({ queryKey: ['intelligence', 'copy-drafts'] }),
  });
}
