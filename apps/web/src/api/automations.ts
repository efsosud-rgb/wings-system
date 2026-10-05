import type {
  AutomationRule,
  AutomationRuleCreateInput,
  AutomationSequence,
  EmailTemplate,
  EmailTemplateSaveInput,
  LeadPipeline,
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
