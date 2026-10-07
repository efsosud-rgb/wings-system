import type { GoogleWorkspaceStatus } from '@wings/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './client.js';

/** The session's own Google Workspace connection (Agenda, Meet, Gmail): never anyone else's. */
export const GOOGLE_KEY = ['me', 'google'];
interface StatusBody {
  status: GoogleWorkspaceStatus;
}

export function useGoogleStatus(enabled = true) {
  return useQuery({
    queryKey: GOOGLE_KEY,
    queryFn: () => api.get<StatusBody>('/me/google'),
    enabled,
    staleTime: 60_000,
  });
}

/** Asks where Google's consent screen is; the caller sends the browser there. */
export const useConnectGoogle = () =>
  useMutation({ mutationFn: (_: void) => api.post<{ url: string }>('/me/google/connect') });

export function useDisconnectGoogle() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (_: void) => api.delete<StatusBody>('/me/google'),
    onSuccess: (body) => queryClient.setQueryData(GOOGLE_KEY, body),
  });
}
