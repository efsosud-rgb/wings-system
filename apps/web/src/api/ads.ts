import type {
  ApprovalDecisionInput,
  ApprovalDetail,
  ApprovalListItem,
  CampaignDraft,
  ChangeSimulation,
  CockpitSnapshot,
  NextPendingLink,
  PendingGroup,
} from '@wings/shared';
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

/**
 * Executes an approved change. Deliberately a separate, explicit action: the
 * decision and the write are two different moments, each with a person behind
 * them.
 */
export function useExecuteApproval(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<{ ok: true; outcome: 'applied' }>(`/ads/approvals/${id}/execute`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['ads'] });
    },
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

/** The cockpit snapshot: performance, pacing and open alerts in one read. */
export function useCockpit(days: number) {
  return useQuery({
    queryKey: ['ads', 'cockpit', days],
    queryFn: () => api.get<{ cockpit: CockpitSnapshot }>(`/ads/cockpit?days=${days}`),
    // The ingest job runs hourly; refetching faster only adds noise.
    staleTime: 60_000,
  });
}

export function useAcknowledgeAlert() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (alertId: string) => api.post<{ ok: true }>(`/ads/alerts/${alertId}/acknowledge`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['ads', 'cockpit'] });
    },
  });
}

/**
 * Scenario simulation for one pending change.
 *
 * `alternativeDailyBudgetCents` is exploration only — the server never edits
 * the request from here, and there is no path that approves from this view.
 */
export function useSimulation(id: string | undefined, alternativeDailyBudgetCents?: number) {
  const query =
    alternativeDailyBudgetCents === undefined
      ? ''
      : `?dailyBudgetCents=${alternativeDailyBudgetCents}`;
  return useQuery({
    queryKey: ['ads', 'simulation', id, alternativeDailyBudgetCents ?? null],
    enabled: Boolean(id),
    queryFn: () =>
      api.get<{ simulation: ChangeSimulation; nextPending: NextPendingLink | null }>(
        `/ads/approvals/${id ?? ''}/simulation${query}`,
      ),
  });
}

/** Waiting approvals grouped by campaign. A view; decisions stay individual. */
export function useApprovalGroups() {
  return useQuery({
    queryKey: ['ads', 'approval-groups'],
    queryFn: () => api.get<{ groups: PendingGroup[] }>('/ads/approvals-groups'),
  });
}

/**
 * "Lançar campanha": asks for the campaign to be created. The answer is an
 * approval to wait on, never a campaign — nothing is published from here.
 */
export function useRequestCampaign() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (draft: CampaignDraft) =>
      api.post<{ approvalId: string | null; changeRequestId: string; exposureDeltaCents: number }>(
        '/ads/campaign-requests',
        draft,
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['ads'] });
    },
  });
}
