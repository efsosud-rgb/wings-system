import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './client.js';

export interface ExpansionLandingPage {
  identifier: string;
  brand: string;
  active: boolean;
}

const KEY = ['expansion', 'landing-pages'];

export function useExpansionLandingPages() {
  return useQuery({
    queryKey: KEY,
    queryFn: () =>
      api.get<{ enabled: boolean; landingPages: ExpansionLandingPage[] }>(
        '/expansion/landing-pages',
      ),
  });
}

export function useSaveLandingPage() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (page: ExpansionLandingPage) => api.put('/expansion/landing-pages', page),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: KEY }),
  });
}

export function useRemoveLandingPage() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (identifier: string) =>
      api.delete(`/expansion/landing-pages/${encodeURIComponent(identifier)}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: KEY }),
  });
}

export interface RecoverySummary {
  wouldCreate: number;
  created: Record<string, number>;
  existingDeal: number;
  alreadyDecided: number;
  settling: number;
  failed: number;
  unverified: number;
  taskFailed: number;
  noContactData: number;
  conversionsSeen: number;
  ignored: Record<string, number>;
  listOnly: Record<string, number>;
  createdDealIds: string[];
}

export type RecoveryState =
  | { state: 'idle' }
  | { state: 'running'; mode: 'dry' | 'real'; startedAt: string; days: number }
  | {
      state: 'done';
      mode: 'dry' | 'real';
      planId: string;
      finishedAt: string;
      days: number;
      result: RecoverySummary;
    }
  | { state: 'failed'; mode: 'dry' | 'real'; finishedAt: string; error: string };

const RECOVERY_KEY = ['expansion', 'landing-recovery'];

export function useRecoveryState(enabled: boolean) {
  return useQuery({
    queryKey: RECOVERY_KEY,
    enabled,
    queryFn: () => api.get<RecoveryState>('/expansion/landing-recovery'),
    refetchInterval: (query) => (query.state.data?.state === 'running' ? 4000 : false),
  });
}

/** Step 1 (dry run, creates nothing) or step 2 (the real run, with the plan and the count confirmed). */
export function useStartRecovery() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (
      body:
        { dryRun: true; days: number } | { dryRun: false; planId: string; expectedCreated: number },
    ) => api.post('/expansion/landing-recovery', body),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: RECOVERY_KEY }),
  });
}
