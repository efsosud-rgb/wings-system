import type {
  ContactOptOutCreateInput,
  ContactOptOutRevokeInput,
  LeadContactOptOuts,
} from '@wings/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './client.js';

/** "Não me contate" on a deal (docs/crm/nao-me-contate.md): the API decides, the screen shows. */

export function useContactOptOuts(leadId: string) {
  return useQuery({
    queryKey: ['leads', 'contact-opt-outs', leadId],
    queryFn: () => api.get<LeadContactOptOuts>(`/leads/${leadId}/contact-opt-outs`),
  });
}

function useChange<T>(leadId: string, path: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: T) =>
      api.post<LeadContactOptOuts>(`/leads/${leadId}/contact-opt-outs${path}`, input),
    onSuccess: (data) => {
      queryClient.setQueryData(['leads', 'contact-opt-outs', leadId], data);
      // The sends and the timeline read it too.
      void queryClient.invalidateQueries({ queryKey: ['leads', 'emails', leadId] });
      void queryClient.invalidateQueries({ queryKey: ['leads', 'one', leadId] });
      void queryClient.invalidateQueries({ queryKey: ['whatsapp'] });
    },
  });
}

export const useRecordContactOptOut = (leadId: string) =>
  useChange<ContactOptOutCreateInput>(leadId, '');
export const useRevokeContactOptOut = (leadId: string) =>
  useChange<ContactOptOutRevokeInput>(leadId, '/revoke');
