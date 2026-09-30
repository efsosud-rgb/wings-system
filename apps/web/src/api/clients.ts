import type {
  Client,
  ClientAddress,
  ClientCompany,
  ClientCreateInput,
  ClientPartnerInput,
  ClientRecord,
} from '@wings/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './client.js';

/** Who work is done for: Wings Company first, then the rest. Read by the studio, kept in Administração. */
export function useClients(enabled = true) {
  return useQuery({
    queryKey: ['clients'],
    queryFn: () => api.get<{ clients: Client[] }>('/clients'),
    enabled,
    staleTime: 60_000,
  });
}

export function useCreateClient() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: ClientCreateInput) => api.post<{ client: Client }>('/clients', input),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['clients'] }),
  });
}

export function useUpdateClient() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { id: string; name?: string; active?: boolean; number?: number }) =>
      api.patch<{ client: Client }>(`/clients/${input.id}`, {
        name: input.name,
        active: input.active,
        number: input.number,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['clients'] });
      // Asset rows carry the client's name; the Drive's folders carry its number and name.
      void queryClient.invalidateQueries({ queryKey: ['media', 'assets'] });
      void queryClient.invalidateQueries({ queryKey: ['drive'] });
    },
  });
}

// --- the full record ("ficha") -------------------------------------------------------

export function useClientRecord(id: string) {
  return useQuery({
    queryKey: ['clients', id, 'record'],
    queryFn: () => api.get<ClientRecord>(`/clients/${id}/record`),
    retry: false,
  });
}

export type ClientRecordBlockPath =
  'company' | 'contacts' | 'business' | 'contracts' | 'franchise' | 'signature';

/** Saves one block; the answer is the whole record again, with its new %. */
export function useSaveClientBlock<T>(id: string, block: ClientRecordBlockPath) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: T) => api.put<ClientRecord>(`/clients/${id}/${block}`, payload),
    onSuccess: (record) => {
      queryClient.setQueryData(['clients', id, 'record'], record);
      void queryClient.invalidateQueries({ queryKey: ['clients'], exact: true });
    },
  });
}

export function useSavePartner(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      partnerId,
      payload,
    }: {
      partnerId: string | null;
      payload: ClientPartnerInput;
    }) =>
      partnerId
        ? api.put<ClientRecord>(`/clients/${id}/partners/${partnerId}`, payload)
        : api.post<ClientRecord>(`/clients/${id}/partners`, payload),
    onSuccess: (record) => queryClient.setQueryData(['clients', id, 'record'], record),
  });
}

export function useDeletePartner(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (partnerId: string) =>
      api.delete<ClientRecord>(`/clients/${id}/partners/${partnerId}`),
    onSuccess: (record) => queryClient.setQueryData(['clients', id, 'record'], record),
  });
}

/** The full CPF of a partner or witness. Audited on the server, never cached here. */
export function useRevealClientCpf(id: string) {
  return useMutation({
    mutationFn: (input: { kind: 'partner' | 'witness'; id: string }) =>
      api.post<{ cpf: string }>(`/clients/${id}/reveal-cpf`, input),
  });
}

export interface CnpjLookup {
  source: 'brasilapi' | 'receitaws';
  registrationStatus: string | null;
  company: Partial<ClientCompany>;
  partners: { name: string; role: string | null }[];
}

export function useCnpjLookup() {
  return useMutation({
    mutationFn: (cnpj: string) => api.post<CnpjLookup>('/clients/lookup/cnpj', { cnpj }),
  });
}

export function useCepLookup() {
  return useMutation({
    mutationFn: (cep: string) =>
      api.post<{ source: string; address: ClientAddress }>('/clients/lookup/cep', { cep }),
  });
}
