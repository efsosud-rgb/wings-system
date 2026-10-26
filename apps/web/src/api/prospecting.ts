import type {
  Prospect,
  ProspectClaimInput,
  ProspectEnrichResponse,
  ProspectingIcp,
  ProspectingQuota,
  ProspectingSettings,
  ProspectingUsage,
  ProspectLeadInput,
  ProspectPlaceResponse,
  ProspectQuery,
  ProspectSearchInput,
  ProspectSearchResponse,
  ProspectStatus,
  ProspectUpdateInput,
} from '@wings/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './client.js';

/**
 * CRM Vendas → Prospecção (docs/crm/prospeccao.md). Every call that reaches
 * Google (search, ficha) is a mutation: it runs once per click, spends quota,
 * and its answer lives in React state only, never cached for a later screen.
 */

export interface ProspectingStatus {
  configured: boolean;
  aiConfigured: boolean;
}

export interface ProspectOwner {
  id: string;
  name: string;
}

const usageKey = ['prospecting', 'usage'] as const;

export function useProspectingStatus() {
  return useQuery({
    queryKey: ['prospecting', 'status'],
    queryFn: () => api.get<ProspectingStatus>('/prospecting/status'),
  });
}

export function useProspectingUsage() {
  return useQuery({
    queryKey: usageKey,
    queryFn: () => api.get<ProspectingUsage>('/prospecting/usage'),
  });
}

export function useProspectingSettings(enabled = true) {
  return useQuery({
    queryKey: ['prospecting', 'settings'],
    queryFn: () => api.get<ProspectingSettings>('/prospecting/settings'),
    enabled,
  });
}

function useSaveSettings<T>(path: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: T) => api.put<ProspectingSettings>(path, input),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['prospecting'] }),
  });
}

export const useSaveIcp = () => useSaveSettings<ProspectingIcp>('/prospecting/settings/icp');
export const useSaveQuota = () => useSaveSettings<ProspectingQuota>('/prospecting/settings/quota');

/** The seller's sentence turned into search parameters; it fills the form only on a click. */
export function useParseProspectQuery() {
  return useMutation({
    mutationFn: (text: string) => api.post<ProspectQuery>('/prospecting/parse', { text }),
  });
}

/** A Google answer carries the usage after it; a failed call may have counted too, so re-read it. */
function useKeepUsage() {
  const queryClient = useQueryClient();
  return {
    onSuccess: (answer: { usage: ProspectingUsage }) =>
      queryClient.setQueryData(usageKey, answer.usage),
    onError: () => void queryClient.invalidateQueries({ queryKey: usageKey }),
  };
}

export function useProspectSearch() {
  return useMutation({
    mutationFn: (input: Partial<ProspectSearchInput>) =>
      api.post<ProspectSearchResponse>('/prospecting/search', input),
    ...useKeepUsage(),
  });
}

export function useProspects(filter: { status?: ProspectStatus | ''; owner?: string }) {
  const params = new URLSearchParams();
  if (filter.status) params.set('status', filter.status);
  if (filter.owner) params.set('owner', filter.owner);
  const query = params.toString();
  return useQuery({
    queryKey: ['prospecting', 'prospects', query],
    queryFn: () => api.get<Prospect[]>(`/prospecting/prospects${query ? `?${query}` : ''}`),
  });
}

/** Who may own a prospect (managers transfer to them). */
export function useProspectOwners(enabled: boolean) {
  return useQuery({
    queryKey: ['prospecting', 'owners'],
    queryFn: () => api.get<ProspectOwner[]>('/prospecting/owners'),
    enabled,
  });
}

function useProspectMutation<TInput, TAnswer>(run: (input: TInput) => Promise<TAnswer>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: run,
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['prospecting', 'prospects'] }),
  });
}

export const useClaimProspect = () =>
  useProspectMutation((input: ProspectClaimInput) =>
    api.post<Prospect>('/prospecting/prospects', input),
  );

export const useUpdateProspect = () =>
  useProspectMutation(({ id, ...input }: ProspectUpdateInput & { id: string }) =>
    api.patch<Prospect>(`/prospecting/prospects/${id}`, input),
  );

export const useEnrichProspect = () =>
  useProspectMutation(({ id, website }: { id: string; website: string }) =>
    api.post<ProspectEnrichResponse>(`/prospecting/prospects/${id}/enrich`, { website }),
  );

export const useProspectLead = () =>
  useProspectMutation(({ id, ...input }: ProspectLeadInput & { id: string }) =>
    api.post<{ leadId: string }>(`/prospecting/prospects/${id}/lead`, input),
  );

/**
 * The live ficha: of a saved prospect, or of a lead that came from one. Each
 * load spends one ficha of the month, so it runs only when the person clicks.
 */
export function usePlaceDetails(of: 'prospects' | 'leads') {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.get<ProspectPlaceResponse>(`/prospecting/${of}/${id}/place`),
    ...useKeepUsage(),
    // A prospect not found on Google turns `nao_encontrado` on the server.
    onSettled: () => {
      if (of === 'prospects')
        void queryClient.invalidateQueries({ queryKey: ['prospecting', 'prospects'] });
    },
  });
}
