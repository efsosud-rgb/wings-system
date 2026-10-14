import type {
  AutomationRule,
  AutomationRuleCreateInput,
  AutomationSequence,
  EmailTemplate,
  EmailTemplateSaveInput,
  LeadPipeline,
  NewLeadPopups,
  SequenceSaveInput,
} from '@wings/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './client.js';

/** CRM Vendas → Regras de automação (`crm.manage`). */

const KEY = ['crm', 'automations'] as const;

export function useAutomationRules(pipeline: LeadPipeline) {
  return useQuery({
    queryKey: [...KEY, 'rules', pipeline],
    queryFn: () =>
      api.get<{ rules: AutomationRule[] }>(`/crm/automations/rules?pipeline=${pipeline}`),
  });
}

export function useEmailTemplates() {
  return useQuery({
    queryKey: [...KEY, 'templates'],
    queryFn: () => api.get<{ templates: EmailTemplate[] }>('/crm/automations/templates'),
  });
}

export function useSequences() {
  return useQuery({
    queryKey: [...KEY, 'sequences'],
    queryFn: () => api.get<{ sequences: AutomationSequence[] }>('/crm/automations/sequences'),
  });
}

function useInvalidating<TVars, TData>(run: (vars: TVars) => Promise<TData>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: run,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: KEY }),
  });
}

export const useCreateRule = () =>
  useInvalidating((input: AutomationRuleCreateInput) =>
    api.post<{ rule: AutomationRule }>('/crm/automations/rules', input),
  );

export const useUpdateRule = () =>
  useInvalidating(
    (input: {
      id: string;
      active?: boolean;
      delayMinutes?: number;
      config?: Record<string, unknown>;
    }) => {
      const { id, ...patch } = input;
      return api.patch<{ rule: AutomationRule }>(`/crm/automations/rules/${id}`, patch);
    },
  );

export const useDeleteRule = () =>
  useInvalidating((id: string) => api.delete<void>(`/crm/automations/rules/${id}`));

export function useStageLimits() {
  return useQuery({
    queryKey: [...KEY, 'stage-limits'],
    queryFn: () =>
      api.get<{ limits: { stageId: string; maxDays: number }[] }>('/crm/automations/stage-limits'),
  });
}

export const useSetStageLimit = () =>
  useInvalidating((input: { stageId: string; maxDays: number }) =>
    api.put<{ stageId: string; maxDays: number }>(
      `/crm/automations/stage-limits/${input.stageId}`,
      {
        maxDays: input.maxDays,
      },
    ),
  );

export interface CrmNotice {
  id: string;
  kind: string;
  message: string;
  leadId: string | null;
  createdAt: string;
  readAt: string | null;
}

/** The caller's own notices (alerts and automation warnings); polled every minute while open. */
export function useNotifications() {
  return useQuery({
    queryKey: ['crm', 'notifications'],
    // Passive: a bell left open on a screen nobody touches must not keep the session alive.
    queryFn: () => api.poll<{ unread: number; notifications: CrmNotice[] }>('/crm/notifications'),
    refetchInterval: 60_000,
  });
}

/**
 * The caller's new leads for the pop-up, asked every 15 s, also in a background tab (the browser
 * notification needs it) and always passive: it never counts as the person's activity.
 */
export function useNewLeadPopups(enabled: boolean) {
  return useQuery({
    queryKey: ['crm', 'new-lead-popups'],
    queryFn: () => api.poll<NewLeadPopups>('/crm/notifications/new-leads'),
    enabled,
    refetchInterval: 15_000,
    refetchIntervalInBackground: true,
  });
}

export function useMarkNotificationsRead() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (ids: string[] | 'all') =>
      api.post<{ marked: number }>('/crm/notifications/read', { ids }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['crm', 'new-lead-popups'] });
      return queryClient.invalidateQueries({ queryKey: ['crm', 'notifications'] });
    },
  });
}

export const useSaveTemplate = () =>
  useInvalidating((input: { id?: string } & EmailTemplateSaveInput) => {
    const { id, ...body } = input;
    return id
      ? api.put<{ template: EmailTemplate }>(`/crm/automations/templates/${id}`, body)
      : api.post<{ template: EmailTemplate }>('/crm/automations/templates', body);
  });

export const useSaveSequence = () =>
  useInvalidating((input: { id?: string } & SequenceSaveInput) => {
    const { id, ...body } = input;
    return id
      ? api.put<{ sequence: AutomationSequence }>(`/crm/automations/sequences/${id}`, body)
      : api.post<{ sequence: AutomationSequence }>('/crm/automations/sequences', body);
  });
