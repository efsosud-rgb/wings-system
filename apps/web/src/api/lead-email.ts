import type { LeadEmailSent } from '@wings/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './client.js';

/** E-mail to the lead from the deal's page (templates only; test mode records, nothing leaves). */

export interface LeadEmails {
  to: string | null;
  mode: 'test' | 'smtp' | 'gmail';
  /** The address a message sent now by this person leaves from; null in test mode or with no sender. */
  from: string | null;
  templates: { id: string; name: string }[];
  sent: LeadEmailSent[];
}

export function useLeadEmails(id: string) {
  return useQuery({
    queryKey: ['leads', 'emails', id],
    queryFn: () => api.get<LeadEmails>(`/leads/${id}/emails`),
  });
}

export function useEmailPreview(id: string) {
  return useMutation({
    mutationFn: (templateId: string) =>
      api.post<{ subject: string; body: string }>(`/leads/${id}/emails/preview`, { templateId }),
  });
}

export function useSendEmail(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (templateId: string) =>
      api.post<{ outboxId: string; mode: 'test' | 'smtp' | 'gmail' }>(`/leads/${id}/emails`, {
        templateId,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['leads', 'emails', id] });
      void queryClient.invalidateQueries({ queryKey: ['leads', 'one', id] });
    },
  });
}
