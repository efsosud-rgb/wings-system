import type { LeadContactChange, LeadContactUpdateInput } from '@wings/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './client.js';

/** Editing a lead's contact data on the ficha (docs/crm/editar-contato.md): the API validates and decides who may. */

export function useUpdateLeadContact(leadId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: LeadContactUpdateInput) =>
      api.patch<unknown>(`/leads/${leadId}/contact`, input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['leads'] });
      void queryClient.invalidateQueries({ queryKey: ['crm'] });
      void queryClient.invalidateQueries({ queryKey: ['whatsapp'] });
    },
  });
}

export function useLeadContactChanges(leadId: string, enabled: boolean) {
  return useQuery({
    queryKey: ['leads', 'contact-changes', leadId],
    queryFn: () => api.get<{ changes: LeadContactChange[] }>(`/leads/${leadId}/contact-changes`),
    enabled,
  });
}
