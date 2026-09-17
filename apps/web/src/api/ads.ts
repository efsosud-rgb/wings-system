import type { ApprovalDecisionInput, ApprovalDetail, ApprovalListItem } from '@wings/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './client.js';

export function useApprovals() {
  return useQuery({
    queryKey: ['ads', 'approvals'],
    queryFn: () => api.get<{ approvals: ApprovalListItem[] }>('/ads/approvals'),
  });
}

export function useApproval(id: string | undefined) {
  return useQuery({
    queryKey: ['ads', 'approval', id],
    enabled: Boolean(id),
    queryFn: () => api.get<{ approval: ApprovalDetail }>(`/ads/approvals/${id ?? ''}`),
  });
}

export function useDecideApproval(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: ApprovalDecisionInput) =>
      api.post<{ ok: true; status: 'approved' | 'rejected' }>(
        `/ads/approvals/${id}/decision`,
        input,
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['ads'] });
    },
  });
}
