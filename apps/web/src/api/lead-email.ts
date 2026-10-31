import type { LeadEmailComposeInput, LeadEmailReceived, LeadEmailSent } from '@wings/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './client.js';

/** E-mail to the lead from the deal's page (written there, or from a template; test mode records, nothing leaves). */

export interface LeadEmails {
  to: string | null;
  /** Where "Escrever e-mail" may send to: the deal's e-mail first, then its other contacts'. */
  addresses: { email: string; name: string | null; primary: boolean }[];
  /** Expansão with a brand: no e-mail leaves (the lead must not see the Wings). */
  hidden: boolean;
  /** A "não me contate" by e-mail: why nothing can be sent, or null. */
  blocked: string | null;
  mode: 'test' | 'smtp' | 'gmail';
  /** The address a message sent now by this person leaves from; null in test mode or with no sender. */
  from: string | null;
  templates: { id: string; name: string }[];
  sent: LeadEmailSent[];
  /** The lead's e-mails read from the sellers' Gmail (t083), each in the conversation it answers. */
  received: LeadEmailReceived[];
  /** `reconnect`: this person must connect their Google account once more for the replies to come in. */
  mailRead: 'on' | 'reconnect' | 'off';
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
    mutationFn: (input: LeadEmailComposeInput) =>
      api.post<{ outboxId: string; mode: 'test' | 'smtp' | 'gmail' }>(`/leads/${id}/emails`, input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['leads', 'emails', id] });
      void queryClient.invalidateQueries({ queryKey: ['leads', 'one', id] });
    },
  });
}
