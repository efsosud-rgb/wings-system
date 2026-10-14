import type {
  Board,
  LeadActivity,
  Client,
  CrmStage,
  CrmStageCreateInput,
  CrmStageOrderInput,
  CrmStageUpdateInput,
  Distribution,
  DistributionUpdateInput,
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
  LeadNote,
  LeadNoteCreateInput,
  LeadOutcome,
  LeadPipeline,
  LeadStageHistoryEntry,
  LeadTask,
  LeadTaskCreateInput,
  LeadTaskUpdateInput,
  LeadUpdateInput,
  Seller,
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
    queryFn: () => api.get<LoadedLead>(`/leads/${id}`),
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

/** "Conferir de novo": the arrival checks of the form fields, again (answers when done). */
export function useCheckLead() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      api.post<{ lead: Lead; events: LeadEvent[] }>(`/leads/${id}/checks`),
    onSuccess: (_data, id) => {
      void queryClient.invalidateQueries({ queryKey: ['leads', 'one', id] });
    },
  });
}

/** "Não é robô": the seller clears the suspect mark of the lead. */
export function useClearSuspect() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      api.post<{ lead: Lead; events: LeadEvent[] }>(`/leads/${id}/suspect/clear`),
    onSuccess: (_data, id) => {
      void queryClient.invalidateQueries({ queryKey: ['leads', 'one', id] });
    },
  });
}

export function useResearchLead() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      api.post<{ lead: Lead; events: LeadEvent[] }>(`/leads/${id}/research`),
    // Returned, so the request stays pending until the lead is read again and shows the queued state:
    // no second click can slip between the answer and the refresh.
    onSuccess: async (_data, id) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['leads', 'one', id] }),
        queryClient.invalidateQueries({ queryKey: ['leads'] }),
      ]);
    },
  });
}

// --- Meta Lead Ads queue ----------------------------------------------------------------

export interface MetaLeadsStatus {
  pending: number;
  failed: number;
  done: number;
  rdMissing: number;
  lastReceivedAt: string | null;
  lastProcessedAt: string | null;
  webhookConfigured: boolean;
  tokenConfigured: boolean;
  /** The periodic read with only the key (every `everyMinutes`). */
  polling?: {
    enabled: boolean;
    everyMinutes: number;
    lastRunAt: string | null;
    lastOkAt: string | null;
    lastError: string | null;
    forms: number;
    formsWithError: number;
  };
}

/** Why a Meta event gave up, in words; a warning is a lead with nothing to call, an error is ours or Meta's. */
export interface MetaFailureReason {
  code: string;
  label: string;
  severity: 'warning' | 'error';
}

/** One event that failed: ids, form and campaign names and a reason; never the person. */
export interface MetaFailedEvent {
  leadgenId: string;
  leadAt: string;
  formId: string | null;
  formName: string | null;
  adId: string | null;
  campaignName: string | null;
  attempts: number;
  reason: MetaFailureReason;
}

export interface MetaFailedEvents {
  total: number;
  items: MetaFailedEvent[];
}

export interface MetaConnectionTest {
  pages: number;
  forms: number;
  leads: number;
  truncated: boolean;
  failed: Record<string, string>;
}

export interface MetaPollResult {
  pages: number;
  forms: number;
  listed: number;
  queued: number;
  alreadyKnown: number;
  failed: Record<string, string>;
}

/** "Testar conexão": what the key sees, as totals (pages, forms, leads of 90 days). */
export function useTestMetaConnection() {
  return useMutation({
    mutationFn: () => api.post<MetaConnectionTest>('/crm/meta-leads/test'),
  });
}

/** "Buscar agora": one pass of the periodic read at once. */
export function usePollMetaLeads() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<MetaPollResult>('/crm/meta-leads/poll'),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['leads'] }),
  });
}

export interface MetaLeadsSyncResult {
  forms: number;
  listed: number;
  queued: number;
  alreadyKnown: number;
  failed: Record<string, string>;
  truncated: number;
}

export function useMetaLeadsStatus(enabled = true) {
  return useQuery({
    queryKey: ['leads', 'meta-status'],
    queryFn: () => api.get<MetaLeadsStatus>('/crm/meta-leads/status'),
    enabled,
    refetchInterval: (state) => ((state.state.data?.pending ?? 0) > 0 ? 5_000 : false),
  });
}

/** The Meta events that failed (integrations.manage only): when, form, campaign and why. */
export function useMetaFailedEvents(enabled = true) {
  return useQuery({
    queryKey: ['leads', 'meta-failed'],
    queryFn: () => api.get<MetaFailedEvents>('/crm/meta-leads/failed'),
    enabled,
  });
}

/** "Buscar leads da Meta": the last 90 days of every form with a rule; totals only. */
export function useSyncMetaLeads() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<MetaLeadsSyncResult>('/crm/meta-leads/sync'),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['leads'] }),
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
      api.post<{ ok: true; whatsappUrl: string | null }>(
        `/public/site-forms/${encodeURIComponent(slug)}`,
        input,
      ),
  });
}

// --- CRM Fase 1: stages, the lead's work, notes, tasks, board, distribution -------------

export type LoadedLead = {
  lead: Lead;
  events: LeadEvent[];
  notes: LeadNote[];
  tasks: LeadTask[];
  history: LeadStageHistoryEntry[];
  activities: LeadActivity[];
};

export function useStages(pipeline?: LeadPipeline | '') {
  return useQuery({
    queryKey: ['crm', 'stages', pipeline ?? ''],
    queryFn: () =>
      api.get<{ stages: CrmStage[] }>(`/crm/stages${pipeline ? `?pipeline=${pipeline}` : ''}`),
  });
}

function invalidateLead(queryClient: ReturnType<typeof useQueryClient>, id: string) {
  void queryClient.invalidateQueries({ queryKey: ['leads', 'one', id] });
  void queryClient.invalidateQueries({ queryKey: ['leads'] });
  void queryClient.invalidateQueries({ queryKey: ['crm'] });
}

export function useUpdateLead(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: LeadUpdateInput) => api.patch<LoadedLead>(`/leads/${id}`, input),
    onSuccess: () => invalidateLead(queryClient, id),
  });
}

export function useAddNote(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: LeadNoteCreateInput) =>
      api.post<{ note: LeadNote }>(`/leads/${id}/notes`, input),
    onSuccess: () => invalidateLead(queryClient, id),
  });
}

export function useCreateTask(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: LeadTaskCreateInput) =>
      api.post<{ task: LeadTask }>(`/leads/${id}/tasks`, input),
    onSuccess: () => invalidateLead(queryClient, id),
  });
}

export function useUpdateTask(leadId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ taskId, ...input }: LeadTaskUpdateInput & { taskId: string }) =>
      api.patch<{ task: LeadTask }>(`/leads/${leadId}/tasks/${taskId}`, input),
    onSuccess: () => invalidateLead(queryClient, leadId),
  });
}

export function useMyTasks(status: 'open' | 'overdue' | 'done' | 'all', everyone: boolean) {
  return useQuery({
    queryKey: ['crm', 'tasks', status, everyone],
    queryFn: () =>
      api.get<{ tasks: LeadTask[] }>(
        `/crm/tasks?status=${status}${everyone ? '&everyone=true' : ''}`,
      ),
  });
}

export function useBoard(pipeline: LeadPipeline, filter: { owner?: string; clientId?: string }) {
  const params = new URLSearchParams({ pipeline });
  if (filter.owner) params.set('owner', filter.owner);
  if (filter.clientId) params.set('clientId', filter.clientId);
  return useQuery({
    queryKey: ['leads', 'board', pipeline, filter],
    queryFn: () => api.get<Board>(`/leads/board?${params.toString()}`),
  });
}

/** Moves a card on the board: the same PATCH as the lead's page. */
export function useMoveLead() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, stageId }: { id: string; stageId: string }) =>
      api.patch<LoadedLead>(`/leads/${id}`, { stageId }),
    onSuccess: (_data, { id }) => invalidateLead(queryClient, id),
  });
}

/** The team list. Only for who hands deals over (`leads.assign`): a seller is refused it. */
export function useSellers(enabled = true) {
  return useQuery({
    queryKey: ['crm', 'sellers'],
    queryFn: () => api.get<{ sellers: Seller[] }>('/crm/sellers'),
    enabled,
  });
}

export function useDistribution(enabled = true) {
  return useQuery({
    queryKey: ['crm', 'distribution'],
    queryFn: () => api.get<{ distributions: Distribution[] }>('/crm/distribution'),
    enabled,
  });
}

export function useSetDistribution() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: DistributionUpdateInput) =>
      api.put<{ distribution: Distribution }>('/crm/distribution', input),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['crm', 'distribution'] }),
  });
}

/** Stages are read on their own and inside the board's columns: both go stale together. */
function invalidateStages(queryClient: ReturnType<typeof useQueryClient>) {
  void queryClient.invalidateQueries({ queryKey: ['crm', 'stages'] });
  void queryClient.invalidateQueries({ queryKey: ['leads', 'board'] });
}

export function useCreateStage() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CrmStageCreateInput) => api.post<{ stage: CrmStage }>('/crm/stages', input),
    onSuccess: () => invalidateStages(queryClient),
  });
}

export function useUpdateStage() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...input }: CrmStageUpdateInput & { id: string }) =>
      api.patch<{ stage: CrmStage }>(`/crm/stages/${id}`, input),
    onSuccess: () => invalidateStages(queryClient),
  });
}

export function useReorderStages() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CrmStageOrderInput) =>
      api.put<{ stages: CrmStage[] }>('/crm/stages/order', input),
    onSuccess: () => invalidateStages(queryClient),
  });
}
