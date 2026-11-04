import type {
  Prospect,
  ProspectApproach,
  ProspectApproachInput,
  ProspectBatchResponse,
  ProspectClaimInput,
  ProspectEnrichResponse,
  ProspectingIcp,
  ProspectingMetrics,
  ProspectingQuota,
  ProspectingRetention,
  ProspectingSettings,
  ProspectingUsage,
  ProspectLeadInput,
  ProspectPlaceResponse,
  ProspectQuery,
  ProspectSearchHistoryItem,
  ProspectSearchInput,
  ProspectSearchResponse,
  ProspectStatus,
  ProspectUpdateInput,
} from '@wings/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, noteUnauthorized } from './client.js';

/**
 * CRM Vendas → Prospecção (docs/crm/prospeccao.md). Every call that reaches
 * Google (search, ficha) is a mutation: it runs once per click, spends quota,
 * and its answer lives in React state only, never cached for a later screen.
 */

export interface ProspectingStatus {
  configured: boolean;
  aiConfigured: boolean;
  /** Business Discovery (Instagram numbers in the score) is on and configured. */
  instagramDiscovery: boolean;
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
export const useSaveRetention = () =>
  useSaveSettings<ProspectingRetention>('/prospecting/settings/retention');

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
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: Partial<ProspectSearchInput>) =>
      api.post<ProspectSearchResponse>('/prospecting/search', input),
    ...useKeepUsage(),
    // Spent calls are history even when Google failed.
    onSettled: () => void queryClient.invalidateQueries({ queryKey: ['prospecting', 'history'] }),
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
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['prospecting', 'prospects'] });
      void queryClient.invalidateQueries({ queryKey: ['prospecting', 'metrics'] });
    },
  });
}

export const useClaimProspect = () =>
  useProspectMutation((input: ProspectClaimInput) =>
    api.post<Prospect>('/prospecting/prospects', input),
  );

/** Reservar em lote: the ticked results, each reserved on its own; the answer says which went. */
export const useBatchReserve = () =>
  useProspectMutation((placeIds: string[]) =>
    api.post<ProspectBatchResponse>('/prospecting/prospects/batch', { placeIds }),
  );

/** Past searches (what was typed): a seller's own, a manager's everyone's. */
export function useProspectHistory() {
  return useQuery({
    queryKey: ['prospecting', 'history'],
    queryFn: () => api.get<ProspectSearchHistoryItem[]>('/prospecting/history'),
  });
}

export function useProspectingMetrics() {
  return useQuery({
    queryKey: ['prospecting', 'metrics'],
    queryFn: () => api.get<ProspectingMetrics>('/prospecting/metrics'),
  });
}

/** Sugerir abordagem: one model call per click; the answer is a draft, nothing is sent. */
export function useProspectApproach() {
  return useMutation({
    mutationFn: ({ id, ...input }: ProspectApproachInput & { id: string }) =>
      api.post<ProspectApproach>(`/prospecting/prospects/${id}/approach`, input),
  });
}

/** The prospects as a spreadsheet (our data only); the browser saves the file. */
export async function downloadProspectsExport(filter: {
  status?: ProspectStatus | '';
  owner?: string;
}): Promise<void> {
  const params = new URLSearchParams();
  if (filter.status) params.set('status', filter.status);
  if (filter.owner) params.set('owner', filter.owner);
  const path = '/prospecting/prospects/export.csv';
  const response = await fetch(`/api${path}?${params.toString()}`, { credentials: 'include' });
  if (!response.ok) {
    noteUnauthorized(response.status, path);
    throw new Error('export_failed');
  }
  const url = URL.createObjectURL(await response.blob());
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `prospects-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

export const useUpdateProspect = () =>
  useProspectMutation(({ id, ...input }: ProspectUpdateInput & { id: string }) =>
    api.patch<Prospect>(`/prospecting/prospects/${id}`, input),
  );

export const useEnrichProspect = () =>
  useProspectMutation(
    ({ id, website, findTicket }: { id: string; website: string; findTicket?: string }) =>
      api.post<ProspectEnrichResponse>(`/prospecting/prospects/${id}/enrich`, {
        website,
        findTicket,
      }),
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
