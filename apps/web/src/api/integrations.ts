import type { KairogenStatus } from '@wings/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './client.js';

const KEY = ['integrations', 'kairogen'];
interface StatusBody {
  status: KairogenStatus;
}

/** The connection's state. While an authorization is pending the page checks again on its own. */
export function useKairogenStatus() {
  return useQuery({ queryKey: KEY, queryFn: () => api.get<StatusBody>('/integrations/kairogen') });
}

function useStatusMutation<T>(call: (input: T) => Promise<StatusBody>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: call,
    onSuccess: (body) => queryClient.setQueryData(KEY, body),
  });
}

export const useConnectKairogen = () =>
  useStatusMutation((flow: 'device' | 'code') =>
    api.post<StatusBody>('/integrations/kairogen/connect', { flow }),
  );
export const usePollKairogen = () =>
  useStatusMutation((_: void) => api.post<StatusBody>('/integrations/kairogen/poll'));
export const useDisconnectKairogen = () =>
  useStatusMutation((_: void) => api.post<StatusBody>('/integrations/kairogen/disconnect'));
