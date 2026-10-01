import type {
  Client,
  ExpansionEntry,
  FunnelSummary,
  LandingPageCreateInput,
  LandingPageItem,
  LandingPageUpdateInput,
  Lead,
  LeadCreateInput,
  LeadEvent,
  LeadLinkChannel,
  LeadListItem,
  LeadOutcome,
  LeadPipeline,
  LeadSource,
  LeadSourceRule,
  LeadSourceRuleKind,
  LeadTrackingLink,
  SiteFormInfo,
  SiteFormSubmitInput,
} from '@wings/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './client.js';

/** CRM Vendas → Funil, and the intake pieces on the client's screen. */

export interface LeadFilter {
  q?: string;
  clientId?: string;
  source?: LeadSource | '';
  pipeline?: LeadPipeline | '';
  stage?: string;
  owner?: string;
  outcome?: LeadOutcome | '';
  staleDays?: string;
}

export function useLeads(filter: LeadFilter) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filter)) if (value) params.set(key, String(value));
  const query = params.toString();
  return useQuery({
    queryKey: ['leads', filter],
    queryFn: () =>
      api.get<{ leads: LeadListItem[]; total: number }>(`/leads${query ? `?${query}` : ''}`),
    // A research in flight settles within a minute; the list keeps an eye on it.
    refetchInterval: (state) =>
      state.state.data?.leads.some(
        (lead) => lead.researchState === 'pending' || lead.researchState === 'running',
      )
        ? 5_000
        : false,
  });
}

/** The mini-funnel per brand at the top of the Funil (30 or 90 days). */
export function useFunnelSummary(days: 30 | 90) {
  return useQuery({
    queryKey: ['leads', 'summary', days],
    queryFn: () => api.get<FunnelSummary>(`/leads/summary?days=${days}`),
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
    mutationFn: (input: LeadCreateInput) =>
      api.post<{ lead: Lead; created: boolean }>('/leads', input),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['leads'] }),
  });
}

export function useResearchLead() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      api.post<{ lead: Lead; events: LeadEvent[] }>(`/leads/${id}/research`),
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
      api.get<{ links: LeadTrackingLink[]; phoneConfigured: boolean }>(
        `/clients/${clientId}/tracking-links`,
      ),
    enabled: Boolean(clientId),
  });
}

export function useCreateTrackingLink() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { clientId: string; channel: LeadLinkChannel }) =>
      api.post<{ link: LeadTrackingLink }>(`/clients/${input.clientId}/tracking-links`, {
        channel: input.channel,
      }),
    onSuccess: (_data, input) =>
      void queryClient.invalidateQueries({
        queryKey: ['clients', input.clientId, 'tracking-links'],
      }),
  });
}

export function useUpdateExpansionArea() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { clientId: string; expansionArea: string[] }) =>
      api.patch<{ client: Client & { expansionArea: ExpansionEntry[] } }>(
        `/clients/${input.clientId}/expansion-area`,
        {
          expansionArea: input.expansionArea,
        },
      ),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['clients'] }),
  });
}

// --- CRM Vendas → Landing pages ----------------------------------------------------

const LANDING_KEY = ['leads', 'landing-pages'];

export function useLandingPages() {
  return useQuery({
    queryKey: LANDING_KEY,
    queryFn: () => api.get<{ pages: LandingPageItem[]; baseUrl: string }>('/crm/landing-pages'),
  });
}

export function useCreateLandingPage() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: LandingPageCreateInput) =>
      api.post<{ page: LandingPageItem }>('/crm/landing-pages', input),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['leads'] }),
  });
}

export function useArchiveLandingPage() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { id: string; archive: boolean }) =>
      api.post<{ ok: true }>(
        `/crm/landing-pages/${input.id}/${input.archive ? 'archive' : 'restore'}`,
      ),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['leads'] }),
  });
}

export function useDeleteLandingPage() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { id: string; confirm: string }) =>
      api.delete<void>(
        `/crm/landing-pages/${input.id}?confirm=${encodeURIComponent(input.confirm)}`,
      ),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['leads'] }),
  });
}

/** A page's own form on/off and its "Origem" for new RD deals (never applied to existing ones). */
export function useUpdateLandingPage() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { id: string } & LandingPageUpdateInput) => {
      const { id, ...body } = input;
      return api.patch<{ page: LandingPageItem }>(`/crm/landing-pages/${id}`, body);
    },
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['leads'] }),
  });
}

/** RD CRM's deal sources, to choose a page's "Origem" from; null with the reason when RD cannot be read. */
export function useDealSources(enabled: boolean) {
  return useQuery({
    queryKey: [...LANDING_KEY, 'deal-sources'],
    queryFn: () =>
      api.get<{ sources: string[] | null; reason?: string }>('/crm/landing-pages/deal-sources'),
    enabled,
    staleTime: 10 * 60_000,
  });
}

// --- the public site form (T5): no session ------------------------------------------

export function useSiteForm(slug: string | undefined) {
  return useQuery({
    queryKey: ['site-form', slug],
    queryFn: () => api.get<SiteFormInfo>(`/public/site-forms/${encodeURIComponent(slug ?? '')}`),
    enabled: Boolean(slug),
    retry: false,
  });
}

export function useSubmitSiteForm(slug: string) {
  return useMutation({
    mutationFn: (input: SiteFormSubmitInput) =>
      api.post<{ ok: true }>(`/public/site-forms/${encodeURIComponent(slug)}`, input),
  });
}
