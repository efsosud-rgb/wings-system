import type {
  EmployeeCreateInput,
  EmployeeListQuery,
  EmployeeListResult,
  EmployeeView,
  InviteOutcome,
} from '@wings/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './client.js';

export interface CreateEmployeeResponse {
  employee: EmployeeView;
  invite: InviteOutcome;
}

function listPath(query: EmployeeListQuery): string {
  const params = new URLSearchParams();
  if (query.search) params.set('search', query.search);
  if (query.sector) params.set('sector', query.sector);
  if (query.status) params.set('status', query.status);
  if (query.page) params.set('page', String(query.page));
  if (query.pageSize) params.set('pageSize', String(query.pageSize));
  const qs = params.toString();
  return `/employees${qs ? `?${qs}` : ''}`;
}

export function useEmployees(query: EmployeeListQuery) {
  return useQuery({
    queryKey: ['employees', query],
    queryFn: () => api.get<EmployeeListResult>(listPath(query)),
  });
}

export function useEmployee(id: string | undefined) {
  return useQuery({
    queryKey: ['employee', id],
    enabled: Boolean(id),
    queryFn: () => api.get<{ employee: EmployeeView }>(`/employees/${id ?? ''}`),
  });
}

export function useCreateEmployee() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: EmployeeCreateInput) =>
      api.post<CreateEmployeeResponse>('/employees', input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['employees'] }),
  });
}

export function useUpdateEmployee(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: Partial<EmployeeCreateInput>) =>
      api.patch<{ employee: EmployeeView }>(`/employees/${id}`, input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['employees'] });
      void queryClient.invalidateQueries({ queryKey: ['employee', id] });
    },
  });
}

/**
 * Reveals the full CPF. A POST, never a GET: the number must not land in a URL,
 * browser history or a log. Every call is audited server-side.
 */
export function useRevealCpf(id: string) {
  return useMutation({
    mutationFn: () => api.post<{ cpf: string }>(`/employees/${id}/reveal-cpf`),
  });
}

export function useResendInvite(id: string) {
  return useMutation({
    mutationFn: () => api.post<{ ok: true }>(`/employees/${id}/invite`),
  });
}
