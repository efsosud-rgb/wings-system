import type {
  DashboardAudience,
  DashboardCampaigns,
  DashboardCreatives,
  DashboardOverview,
  DashboardPlatforms,
  DashboardWindow,
} from '@wings/shared';
import { useQuery } from '@tanstack/react-query';
import { api } from './client.js';

/**
 * Dashboard → Marketing. Every read is of data the ingest job already
 * mirrored: opening a tab calls no platform. The job runs hourly, so a minute
 * of staleness costs nothing and refetching faster only adds noise.
 */

const STALE_MS = 60_000;

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
