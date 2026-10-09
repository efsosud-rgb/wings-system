import {
  AD_ACCOUNT_PLATFORM,
  type AdAccountBudgetCapView,
  type AddAdsRequest,
  type ApprovalDecisionInput,
  type ApprovalDetail,
  type ApprovalListItem,
  type AudienceProfile,
  type AudienceProfileInput,
  type BudgetCapUpdateInput,
  type CampaignDraft,
  type ChangeSimulation,
  type CockpitSnapshot,
  type DemandGenOptions,
  type SpendCapReset,
  type CreativeUpload,
  type MetaIdentities,
  type MetaIdentity,
  type NextPendingLink,
  type OfficialPreview,
  type PendingGroup,
  type PreviewPlacement,
  type SavedCampaignDraft,
  type SiteImageUpload,
  type SitePostFormInput,
  type SitePostRecord,
  type SiteStatus,
  type SiteTerms,
  type VideoUpload,
  type YoutubeVideoCheck,
} from '@wings/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './client.js';
import {
  sendCreativeImage,
  sendCreativeVideo,
  useFileUpload,
  type FileUploadState,
} from './uploads.js';

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

/**
 * Rehearses an approval's change against the real account without writing:
 * Google's validateOnly. Works with the write switch off, before or after the
 * decision — it changes nothing about the request.
 */
export interface PreflightAnswer {
  status: 'ok' | 'rejected' | 'unavailable';
  operations?: string[];
  code?: string;
  message?: string;
  reason?: string;
}

export function usePreflightApproval(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<PreflightAnswer>(`/ads/approvals/${id}/preflight`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['ads', 'approval', id] });
    },
  });
}

/** A budget, pause or resume on a campaign that exists: a request of its own. */
export interface ChangeRequestInput {
  accountExternalId: string;
  campaignExternalId: string;
  kind: 'set_daily_budget' | 'pause_campaign' | 'resume_campaign';
  toDailyBudgetCents?: number;
  reason: string;
}

export function useRequestCampaignChange() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: ChangeRequestInput) =>
      api.post<{ approvalId: string | null; changeRequestId: string; exposureDeltaCents: number }>(
        '/ads/change-requests',
        input,
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['ads'] });
      // Requested from the dashboard too: its campaign rows show what is pending.
      void queryClient.invalidateQueries({ queryKey: ['dashboard', 'campaigns'] });
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

/**
 * The cockpit snapshot: performance, pacing and open alerts in one read.
 *
 * `platform` is the campaign builder's own choice ('meta' | 'google_search' |
 * 'youtube'); the backend only knows ad-account platforms ('meta' | 'google'),
 * so the mapping happens here, on the frontend, via `AD_ACCOUNT_PLATFORM`.
 * Omitting it keeps the old behaviour: the account the cockpit has always
 * opened on (Meta).
 */
export function useCockpit({
  days,
  platform,
}: {
  days: number;
  platform?: keyof typeof AD_ACCOUNT_PLATFORM;
}) {
  const accountPlatform = platform ? AD_ACCOUNT_PLATFORM[platform] : undefined;
  return useQuery({
    queryKey: ['ads', 'cockpit', days, accountPlatform ?? null],
    queryFn: () =>
      api.get<{ cockpit: CockpitSnapshot }>(
        `/ads/cockpit?days=${days}${accountPlatform ? `&platform=${accountPlatform}` : ''}`,
      ),
    // The ingest job runs hourly; refetching faster only adds noise.
    staleTime: 60_000,
  });
}

/**
 * "Atualizar agora": the same read the scheduled reconciliation does, run
 * once on a click. The server enforces the cooldown against repeated
 * clicks — this just surfaces its answer, never counts down on its own.
 */
export function useReconcileNow(accountId: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () =>
      api.post<{ ok: true; lastReconciledAt: string | null }>(
        `/ads/accounts/${accountId ?? ''}/reconcile-now`,
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['ads'] });
    },
  });
}

/**
 * The platform's account figures, re-read when the builder opens and every
 * few minutes while it stays open. The server skips the platform call when
 * the account was read in the last two minutes, so this never piles up calls.
 */
export function usePlatformRefresh(accountId: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () =>
      api.post<{ refreshed: boolean; reason?: string }>(
        `/ads/accounts/${accountId ?? ''}/platform-refresh`,
      ),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ['ads', 'cockpit'] });
    },
  });
}

/** The account's rule for when its spending limit starts over (`ads.budget_caps.manage`). */
export function useSetSpendCapReset(accountId: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (reset: SpendCapReset | null) =>
      api.put<{ ok: true; reset: SpendCapReset | null }>(
        `/ads/accounts/${accountId ?? ''}/spend-cap-reset`,
        { reset },
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['ads', 'cockpit'] });
    },
  });
}

/**
 * Administração → Integrações: every account's current cap, for the edit
 * form. `enabled` so a viewer without `ads.budget_caps.manage` never fires
 * the request — the section is hidden for them, and the API would refuse it.
 */
export function useAdAccountBudgetCaps(enabled: boolean) {
  return useQuery({
    queryKey: ['ads', 'accounts', 'budget-caps'],
    enabled,
    queryFn: () => api.get<{ accounts: AdAccountBudgetCapView[] }>('/ads/accounts/budget-caps'),
  });
}

/** Opens or edits this month's internal cap for one account. Admin Master only. */
export function useSetBudgetCap(accountId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: BudgetCapUpdateInput) =>
      api.post<{ account: AdAccountBudgetCapView }>(`/ads/accounts/${accountId}/budget-cap`, input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['ads', 'accounts', 'budget-caps'] });
      void queryClient.invalidateQueries({ queryKey: ['ads', 'cockpit'] });
    },
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

/**
 * Uploads one creative image, reporting progress. It goes to our database,
 * never to a platform.
 */
export function useUploadCreative(): FileUploadState<{ creative: CreativeUpload }> {
  return useFileUpload(uploadImage);
}
const uploadImage = async (
  file: File,
  onProgress: (fraction: number) => void,
  signal: AbortSignal,
) => ({ creative: await sendCreativeImage(file, onProgress, signal) });

/**
 * Uploads one creative video in parts, reporting progress. It goes to our own
 * storage; reaching Meta is part of executing an approved request.
 */
export function useUploadVideo(): FileUploadState<{ video: VideoUpload }> {
  return useFileUpload(uploadVideo);
}
const uploadVideo = async (
  file: File,
  onProgress: (fraction: number) => void,
  signal: AbortSignal,
) => ({ video: await sendCreativeVideo(file, onProgress, signal) });

/**
 * The Facebook Pages and Instagram accounts the system user can publish as,
 * read from Meta, plus Wings' saved choice. Never retried on its own: a 503
 * means the environment has no Meta credentials, and asking again changes nothing.
 */
export function useMetaIdentities(enabled: boolean) {
  return useQuery({
    queryKey: ['ads', 'meta-identities'],
    enabled,
    retry: false,
    staleTime: 5 * 60_000,
    queryFn: () => api.get<{ identities: MetaIdentities }>('/ads/meta/identities'),
  });
}

export function useSaveMetaIdentityDefault() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (identity: MetaIdentity) =>
      api.put<{ default: MetaIdentity }>('/ads/meta/identities/default', identity),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['ads', 'meta-identities'] });
    },
  });
}

/** Meta's own preview of the ads a request created. Read-only; 409 until they exist. */
export function useOfficialPreviews(
  approvalId: string | undefined,
  placement: PreviewPlacement,
  enabled: boolean,
) {
  return useQuery({
    queryKey: ['ads', 'official-previews', approvalId, placement],
    enabled: enabled && Boolean(approvalId),
    retry: false,
    queryFn: () =>
      api.get<{ previews: OfficialPreview[] }>(
        `/ads/approvals/${approvalId ?? ''}/previews?placement=${placement}`,
      ),
  });
}

/** The tenant's standing ideal-customer profile and reach; null until saved. */
export function useAudienceProfile() {
  return useQuery({
    queryKey: ['ads', 'audience-profile'],
    queryFn: () => api.get<{ profile: AudienceProfile | null }>('/ads/audience-profile'),
  });
}

/** Campaigns saved in the builder to come back to. Loading one fills the form only. */
/**
 * What a YouTube campaign can bid for and use as signals, read from the
 * Google Ads account (never written). Read once per builder visit.
 */
export function useDemandGenOptions(enabled: boolean) {
  return useQuery({
    queryKey: ['ads', 'demand-gen-options'],
    enabled,
    staleTime: 5 * 60_000,
    retry: false,
    queryFn: () => api.get<DemandGenOptions>('/ads/google/demand-gen-options'),
  });
}

/**
 * The logo of a YouTube request, for the approver: a 5-minute link, and
 * whether it is still the image that was asked for.
 */
export function useApprovalYoutubeLogo(approvalId: string | undefined, enabled: boolean) {
  return useQuery({
    queryKey: ['ads', 'approval-youtube-logo', approvalId],
    enabled: enabled && Boolean(approvalId),
    staleTime: 4 * 60_000,
    refetchInterval: 4 * 60_000,
    retry: false,
    queryFn: () =>
      api.get<{ fileId: string; url: string; unchanged: boolean }>(
        `/ads/approvals/${approvalId ?? ''}/youtube-logo`,
      ),
  });
}

/** Whether YouTube videos can go in an ad: public or unlisted, one answer each. */
export function useCheckYoutubeVideos() {
  return useMutation({
    mutationFn: (videos: string[]) =>
      api.post<{ videos: YoutubeVideoCheck[] }>('/ads/youtube/videos/check', { videos }),
  });
}

export function useSavedDrafts(enabled: boolean) {
  return useQuery({
    queryKey: ['ads', 'saved-drafts'],
    enabled,
    queryFn: () => api.get<{ drafts: SavedCampaignDraft[] }>('/ads/saved-drafts'),
  });
}

export function loadSavedDraft(id: string) {
  return api.get<{ id: string; name: string; draft: CampaignDraft }>(`/ads/saved-drafts/${id}`);
}

export function useSaveDraft() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { name?: string; draft: CampaignDraft }) =>
      api.post<{ id: string }>('/ads/saved-drafts', input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['ads', 'saved-drafts'] });
    },
  });
}

export function useDeleteSavedDraft() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete<void>(`/ads/saved-drafts/${id}`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['ads', 'saved-drafts'] });
    },
  });
}

export function useSaveAudienceProfile() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: AudienceProfileInput) =>
      api.put<{ ok: true; updatedAt: string }>('/ads/audience-profile', input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['ads', 'audience-profile'] });
    },
  });
}

/** Whether the server can reach Wings' WordPress site at all. */
export function useSiteStatus() {
  return useQuery({
    queryKey: ['site', 'status'],
    queryFn: () => api.get<{ status: SiteStatus }>('/marketing/site/status'),
  });
}

export function useSitePosts() {
  return useQuery({
    queryKey: ['site', 'posts'],
    queryFn: () => api.get<{ posts: SitePostRecord[] }>('/marketing/site/posts'),
  });
}

/** The site's real categories and tags. The server caches them for an hour. */
export function useSiteTerms(enabled: boolean) {
  return useQuery({
    queryKey: ['site', 'terms'],
    enabled,
    staleTime: 60 * 60 * 1000,
    queryFn: () => api.get<{ terms: SiteTerms; stale?: boolean }>('/marketing/site/terms'),
  });
}

/** "Atualizar": asks the server to read the site again, and keeps the answer. */
export function useRefreshSiteTerms() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () =>
      api.get<{ terms: SiteTerms; stale?: boolean }>('/marketing/site/terms?refresh=1'),
    onSuccess: (data) => queryClient.setQueryData(['site', 'terms'], data),
  });
}

/** Holds an image in OUR database for preview. Nothing goes to the site yet. */
export function useHoldSiteImage() {
  return useMutation({
    mutationFn: (file: File) =>
      api.upload<{ image: SiteImageUpload }>('/marketing/site/images', file),
  });
}

/** Creates a DRAFT post on the site. Publishing happens inside WordPress. */
export function useCreateSiteDraft() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: SitePostFormInput) =>
      api.post<{ outcome: 'draft_created'; editUrl: string }>('/marketing/site/posts', input),
    // Refused and unconfirmed attempts are recorded too, so refresh either way.
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ['site', 'posts'] });
    },
  });
}

/** New ads (1 to 5 creatives) in a Meta campaign that exists: a request an approver decides. */
export function useRequestAddAds() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: AddAdsRequest) =>
      api.post<{ approvalId: string | null; changeRequestId: string; firstPosition: number }>(
        '/ads/add-ads',
        input,
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['ads'] });
    },
  });
}
