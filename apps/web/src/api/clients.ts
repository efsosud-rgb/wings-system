import type { Client } from '@wings/shared';
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
    mutationFn: (name: string) => api.post<{ client: Client }>('/clients', { name }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['clients'] }),
  });
}

export function useUpdateClient() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { id: string; name?: string; active?: boolean }) =>
      api.patch<{ client: Client }>(`/clients/${input.id}`, {
        name: input.name,
        active: input.active,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['clients'] });
      // Asset rows carry the client's name.
      void queryClient.invalidateQueries({ queryKey: ['media', 'assets'] });
    },
  });
}
