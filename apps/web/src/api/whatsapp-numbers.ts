import type { WaNumber, WaNumberConnect, WaNumbersView } from '@wings/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './client.js';

/** The sellers' WhatsApp Business numbers (docs/whatsapp/conectar-numero.md). Admin Master only. */

const KEY = ['whatsapp', 'numbers'] as const;

export interface ConnectSteps {
  webhooks: 'ok' | 'failed';
  contacts: WaNumber['contactsSync'] | 'skipped';
  history: WaNumber['historySync'] | 'skipped';
}

export interface ConnectAnswer {
  number: WaNumber;
  steps: ConnectSteps;
}

export function useWhatsAppNumbers() {
  return useQuery({
    queryKey: KEY,
    queryFn: () => api.poll<WaNumbersView>('/whatsapp/numbers'),
    // The history's progress arrives by webhook while the seller's phone stays open.
    refetchInterval: 15_000,
  });
}

export function useConnectWhatsAppNumber() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: WaNumberConnect) =>
      api.post<ConnectAnswer>('/whatsapp/numbers/connect', input),
    onSettled: () => queryClient.invalidateQueries({ queryKey: KEY }),
  });
}

export function useRetryWhatsAppNumber() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.post<ConnectAnswer>(`/whatsapp/numbers/${id}/retry`, {}),
    onSettled: () => queryClient.invalidateQueries({ queryKey: KEY }),
  });
}
