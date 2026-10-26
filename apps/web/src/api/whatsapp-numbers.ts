import type {
  WaFailedEvent,
  WaNumber,
  WaNumberConnect,
  WaNumberRegister,
  WaNumbersView,
  WaNumberUpdate,
} from '@wings/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './client.js';

/** The company's work numbers (docs/whatsapp/central.md, conectar-numero.md). Admin Master only. */

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

/** "Renovar acesso": a new 60-day token from Meta, before the current one ends. */
export function useRenewWhatsAppNumber() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      api.post<{ number: WaNumber; renewed: boolean; metaCode: number | null }>(
        `/whatsapp/numbers/${id}/renew`,
        {},
      ),
    onSettled: () => queryClient.invalidateQueries({ queryKey: KEY }),
  });
}

export function useRegisterWhatsAppNumber() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: WaNumberRegister) =>
      api.post<{ number: WaNumber }>('/whatsapp/numbers', input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: KEY }),
  });
}

export function useUpdateWhatsAppNumber() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...input }: WaNumberUpdate & { id: string }) =>
      api.patch<{ number: WaNumber }>(`/whatsapp/numbers/${id}`, input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: KEY }),
  });
}

const FAILED_KEY = ['whatsapp', 'webhook-events', 'failed'] as const;

/** Webhook bodies the queue gave up on: ids, times and codes only. */
export function useFailedWebhookEvents() {
  return useQuery({
    queryKey: FAILED_KEY,
    queryFn: () => api.poll<{ events: WaFailedEvent[] }>('/whatsapp/webhook-events/failed'),
    refetchInterval: 60_000,
  });
}

export function useRetryWebhookEvent() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      api.post<{ id: string }>(`/whatsapp/webhook-events/${id}/retry`, {}),
    onSettled: () => queryClient.invalidateQueries({ queryKey: FAILED_KEY }),
  });
}
