import type {
  DashboardAudience,
  DashboardCampaigns,
  DashboardCreatives,
  DashboardFunnel,
  DashboardOverview,
  DashboardPlatforms,
  DashboardSettings,
  DashboardSite,
  DashboardWindow,
  CampaignSuggestionCard,
  InsightCard,
  InsightRun,
  InsightsResponse,
  OwnedChannelsResponse,
  SetAccountCplTargetInput,
  SetCplTargetInput,
  SuggestionsResponse,
} from '@wings/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './client.js';

/**
 * Dashboard → Marketing. Every read is of data the ingest job already
 * mirrored: opening a tab calls no platform. The job runs on a schedule, so a
 * minute of staleness costs nothing and refetching faster only adds noise.
 *
 * The insights and suggestions are written by the model on a schedule or on
 * "Gerar agora"; reading them costs nothing either. The only calls here that
 * change anything are the ones behind a click: a request through the
 * approval gate, a target confirmed, a card marked as seen.
 */

const STALE_MS = 60_000;
/** How often the screen asks about a run still going. */
const RUN_POLL_MS = 3_000;

export function useDashboardOverview() {
  return useQuery({
    queryKey: ['dashboard', 'overview'],
    queryFn: () => api.get<{ overview: DashboardOverview }>('/ads/dashboard/overview'),
    staleTime: STALE_MS,
  });
}

export function useDashboardPlatforms(days: DashboardWindow) {
  return useQuery({
    queryKey: ['dashboard', 'platforms', days],
    queryFn: () =>
      api.get<{ platforms: DashboardPlatforms }>(`/ads/dashboard/platforms?days=${days}`),
    staleTime: STALE_MS,
  });
}

export function useDashboardCampaigns(days: DashboardWindow) {
  return useQuery({
    queryKey: ['dashboard', 'campaigns', days],
    queryFn: () =>
      api.get<{ campaigns: DashboardCampaigns }>(`/ads/dashboard/campaigns?days=${days}`),
    staleTime: STALE_MS,
  });
}

export function useDashboardSite(days: DashboardWindow) {
  return useQuery({
    queryKey: ['dashboard', 'site', days],
    queryFn: () => api.get<{ site: DashboardSite }>(`/ads/dashboard/site?days=${days}`),
    staleTime: STALE_MS,
  });
}

export function useDashboardFunnel(days: DashboardWindow) {
  return useQuery({
    queryKey: ['dashboard', 'funnel', days],
    queryFn: () => api.get<{ funnel: DashboardFunnel }>(`/ads/dashboard/funnel?days=${days}`),
    staleTime: STALE_MS,
  });
}

export function useDashboardCreatives(days: DashboardWindow) {
  return useQuery({
    queryKey: ['dashboard', 'creatives', days],
    queryFn: () =>
      api.get<{ creatives: DashboardCreatives }>(`/ads/dashboard/creatives?days=${days}`),
    staleTime: STALE_MS,
  });
}

export function useDashboardAudience(days: DashboardWindow) {
  return useQuery({
    queryKey: ['dashboard', 'audience', days],
    queryFn: () =>
      api.get<{ audience: DashboardAudience }>(`/ads/dashboard/audience?days=${days}`),
    staleTime: STALE_MS,
  });
}

// ---------------------------------------------------------------------------
// Insights
// ---------------------------------------------------------------------------

const insightsKey = ['dashboard', 'insights'] as const;
const suggestionsKey = ['dashboard', 'suggestions'] as const;

export function useInsights() {
  return useQuery({
    queryKey: insightsKey,
    queryFn: () => api.get<InsightsResponse>('/ads/insights'),
    staleTime: STALE_MS,
  });
}

/** Follows one run while it is going; the caller turns it on with `enabled`. */
export function useInsightRun(id: string | undefined, enabled: boolean) {
  return useQuery({
    queryKey: ['dashboard', 'insight-run', id],
    queryFn: () => api.get<{ run: InsightRun }>(`/ads/insights/runs/${id}`),
    enabled: enabled && Boolean(id),
    refetchInterval: (query) =>
      query.state.data?.run.status === 'running' ? RUN_POLL_MS : false,
  });
}

export function useGenerateInsights() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<{ run: InsightRun }>('/ads/insights/generate'),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: insightsKey }),
  });
}

export function useMarkInsightSeen() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.post<{ insight: InsightCard }>(`/ads/insights/${id}/seen`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: insightsKey }),
  });
}

/**
 * "Criar pedido" on an insight. The request is the person's own, through the
 * budget guard and the approval gate, marked "sugerido pela IA".
 */
export function useRequestFromInsight() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      api.post<{ insight: InsightCard; approvalId: string | null }>(
        `/ads/insights/${id}/request`,
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: insightsKey });
      void queryClient.invalidateQueries({ queryKey: ['dashboard', 'overview'] });
    },
  });
}

// ---------------------------------------------------------------------------
// Campaign suggestions
// ---------------------------------------------------------------------------

export function useSuggestions() {
  return useQuery({
    queryKey: suggestionsKey,
    queryFn: () => api.get<SuggestionsResponse>('/ads/insights/suggestions'),
    staleTime: STALE_MS,
  });
}

export function useGenerateSuggestions() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<{ run: InsightRun }>('/ads/insights/suggestions/generate'),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: suggestionsKey }),
  });
}

/** "Abrir no construtor" was clicked. The form is filled in the browser; this is the record. */
export function useSuggestionApplied() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      api.post<{ suggestion: CampaignSuggestionCard }>(`/ads/insights/suggestions/${id}/applied`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: suggestionsKey }),
  });
}

export function useDismissSuggestion() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      api.post<{ suggestion: CampaignSuggestionCard }>(`/ads/insights/suggestions/${id}/dismiss`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: suggestionsKey }),
  });
}

// ---------------------------------------------------------------------------
// Settings (CPL targets) and owned channels
// ---------------------------------------------------------------------------

const settingsKey = ['dashboard', 'settings'] as const;

export function useDashboardSettings() {
  return useQuery({
    queryKey: settingsKey,
    queryFn: () => api.get<DashboardSettings>('/ads/dashboard/settings'),
    staleTime: STALE_MS,
  });
}

export function useSetCplTarget() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: SetCplTargetInput) =>
      api.put<DashboardSettings>('/ads/dashboard/settings/cpl-target', input),
    onSuccess: (data) => {
      queryClient.setQueryData(settingsKey, data);
      // The verdicts judge against the target: every campaign read is stale now.
      void queryClient.invalidateQueries({ queryKey: ['dashboard', 'campaigns'] });
    },
  });
}

export function useSetAccountCplTarget() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: SetAccountCplTargetInput) =>
      api.put<DashboardSettings>('/ads/dashboard/settings/account-cpl-target', input),
    onSuccess: (data) => {
      queryClient.setQueryData(settingsKey, data);
      void queryClient.invalidateQueries({ queryKey: ['dashboard', 'campaigns'] });
    },
  });
}

export function useOwnedChannels(days: DashboardWindow) {
  return useQuery({
    queryKey: ['dashboard', 'owned-channels', days],
    queryFn: () => api.get<OwnedChannelsResponse>(`/marketing/site/blog-posts?days=${days}`),
    staleTime: STALE_MS,
  });
}
