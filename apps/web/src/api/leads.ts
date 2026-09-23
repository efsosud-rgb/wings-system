import type {
  Client,
  ExpansionEntry,
  Lead,
  LeadCreateInput,
  LeadEvent,
  LeadLinkChannel,
  LeadListItem,
  LeadSource,
  LeadSourceRule,
  LeadSourceRuleKind,
  LeadTrackingLink,
} from '@wings/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './client.js';

/** CRM Vendas → Funil, and the intake pieces on the client's screen. */

export interface LeadFilter {
  q?: string;
  clientId?: string;
  source?: LeadSource | '';
}

export function useLeads(filter: LeadFilter) {
  const params = new URLSearchParams();
  if (filter.q) params.set('q', filter.q);
  if (filter.clientId) params.set('clientId', filter.clientId);
  if (filter.source) params.set('source', filter.source);
  const query = params.toString();
  return useQuery({
    queryKey: ['leads', filter],
    queryFn: () => api.get<{ leads: LeadListItem[] }>(`/leads${query ? `?${query}` : ''}`),
    // A research in flight settles within a minute; the list keeps an eye on it.
    refetchInterval: (state) =>
      state.state.data?.leads.some((lead) => lead.researchState === 'pending' || lead.researchState === 'running')
        ? 5_000
        : false,
  });
}

export function useLead(id: string | undefined) {
  return useQuery({
    queryKey: ['leads', 'one', id],
    queryFn: () => api.get<{ lead: Lead; events: LeadEvent[] }>(`/leads/${id}`),
    enabled: Boolean(id),
    refetchInterval: (state) => {
      const research = state.state.data?.lead.research.state;
      return research === 'pending' || research === 'running' ? 4_000 : false;
    },
  });
}

export function useCreateLead() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: LeadCreateInput) => api.post<{ lead: Lead; created: boolean }>('/leads', input),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['leads'] }),
  });
}

export function useResearchLead() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.post<{ lead: Lead; events: LeadEvent[] }>(`/leads/${id}/research`),
    onSuccess: (_data, id) => {
      void queryClient.invalidateQueries({ queryKey: ['leads', 'one', id] });
      void queryClient.invalidateQueries({ queryKey: ['leads'] });
    },
  });
}

// --- source rules -----------------------------------------------------------------

export function useSourceRules(enabled = true) {
  return useQuery({
    queryKey: ['leads', 'source-rules'],
    queryFn: () => api.get<{ rules: LeadSourceRule[] }>('/leads/source-rules'),
    enabled,
  });
}

export function useCreateSourceRule() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { kind: LeadSourceRuleKind; pattern: string; clientId: string }) =>
      api.post<{ rule: LeadSourceRule }>('/leads/source-rules', input),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['leads', 'source-rules'] }),
  });
}

export function useDeleteSourceRule() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete<void>(`/leads/source-rules/${id}`),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['leads', 'source-rules'] }),
  });
}

// --- tracked links and the expansion area ------------------------------------------

export function useTrackingLinks(clientId: string | undefined) {
  return useQuery({
    queryKey: ['clients', clientId, 'tracking-links'],
    queryFn: () =>
      api.get<{ links: LeadTrackingLink[]; phoneConfigured: boolean }>(`/clients/${clientId}/tracking-links`),
    enabled: Boolean(clientId),
  });
}

export function useCreateTrackingLink() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { clientId: string; channel: LeadLinkChannel }) =>
      api.post<{ link: LeadTrackingLink }>(`/clients/${input.clientId}/tracking-links`, { channel: input.channel }),
    onSuccess: (_data, input) =>
      void queryClient.invalidateQueries({ queryKey: ['clients', input.clientId, 'tracking-links'] }),
  });
}

export function useUpdateExpansionArea() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { clientId: string; expansionArea: string[] }) =>
      api.patch<{ client: Client & { expansionArea: ExpansionEntry[] } }>(`/clients/${input.clientId}/expansion-area`, {
        expansionArea: input.expansionArea,
      }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['clients'] }),
  });
}
