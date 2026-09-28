import type { CampaignLeadsResponse } from '@wings/shared';
import { useMutation, useQuery } from '@tanstack/react-query';
import { api } from './client.js';

/** Dashboard → Leads das Campanhas. Refreshed every minute; the sync itself runs every 15. */
export function useCampaignLeads() {
  return useQuery({
    queryKey: ['campaign-leads'],
    queryFn: () => api.get<CampaignLeadsResponse>('/campaign-leads'),
    refetchInterval: 60_000,
  });
}

/** The full phone or e-mail of one lead. Audited on the server; never cached. */
export function useRevealCampaignLead() {
  return useMutation({
    mutationFn: ({ id, field }: { id: string; field: 'phone' | 'email' }) =>
      api.post<{ value: string }>(`/campaign-leads/${id}/reveal`, { field }),
  });
}
