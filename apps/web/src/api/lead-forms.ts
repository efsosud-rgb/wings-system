import type { SiteFormSpec } from '@wings/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './client.js';

/**
 * The reads and the one write around Wings' standard lead form, for the
 * campaign builder: is the Facebook Page ready for an instant form (and which
 * policy do its forms use), which site pages take the standard form, and the
 * proposal/approval of a change to a page's form. Nothing here creates a form
 * on Meta: that happens in the executor, behind the approval gate.
 */

export interface MetaLeadFormReadiness {
  access: { pageId: string; canManage: boolean; reason: string | null };
  forms: { id: string; name: string; status: string | null; privacyPolicyUrl: string | null }[];
  privacyPolicyUrl: string | null;
}

export interface SiteFormPage {
  id: string;
  slug: string;
  path: string;
  brand: string;
  pipeline: string | null;
  clientId: string | null;
  form: SiteFormSpec | null;
  pending: { form: SiteFormSpec; by: string | null; at: string } | null;
  approvedAt: string | null;
}

export function useMetaLeadFormReadiness(pageId: string | undefined) {
  return useQuery({
    queryKey: ['ads', 'meta', 'lead-forms', pageId],
    queryFn: () =>
      api.get<MetaLeadFormReadiness>(
        `/ads/meta/lead-forms?pageId=${encodeURIComponent(pageId ?? '')}`,
      ),
    enabled: Boolean(pageId && /^\d{5,25}$/.test(pageId)),
    staleTime: 5 * 60_000,
    retry: false,
  });
}

const PAGES_KEY = ['ads', 'lead-forms', 'site-pages'];

export function useSiteFormPages(enabled = true) {
  return useQuery({
    queryKey: PAGES_KEY,
    queryFn: () => api.get<{ pages: SiteFormPage[] }>('/ads/lead-forms/site-pages'),
    enabled,
    staleTime: 60_000,
  });
}

function useSiteFormAction(action: 'propose' | 'approve' | 'reject') {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { id: string; form?: SiteFormSpec }) =>
      api.post<{ page: SiteFormPage | null }>(
        `/ads/lead-forms/site-pages/${encodeURIComponent(input.id)}/${action}`,
        action === 'propose' ? input.form : {},
      ),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: PAGES_KEY }),
  });
}

/** Marketing proposes; the page keeps showing what it showed. */
export const useProposeSiteForm = () => useSiteFormAction('propose');
/** Diretoria's (or an Admin Master's) click; never the proposer's own. */
export const useApproveSiteForm = () => useSiteFormAction('approve');
export const useRejectSiteForm = () => useSiteFormAction('reject');
