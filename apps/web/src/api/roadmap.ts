import type {
  RoadmapComputed,
  RoadmapDeliverable,
  RoadmapDeliverableUpdateInput,
  RoadmapModule,
  RoadmapRecipientCreateInput,
  RoadmapRecipientUpdateInput,
  RoadmapReportRecipient,
  RoadmapReportRun,
} from '@wings/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './client.js';

/**
 * Administração → Roadmap: módulos e entregáveis, os relatórios diários
 * (rascunho → aprovado → enviado) e os destinatários das mensagens de
 * WhatsApp. One query key family (`['roadmap', ...]`) so any mutation here
 * refreshes every roadmap screen at once.
 */

function useInvalidateRoadmap() {
  const queryClient = useQueryClient();
  return () => void queryClient.invalidateQueries({ queryKey: ['roadmap'] });
}

export function useRoadmapModules() {
  return useQuery({
    queryKey: ['roadmap', 'modules'],
    queryFn: () => api.get<{ modules: RoadmapModule[]; computed: RoadmapComputed }>('/roadmap/modules'),
    staleTime: 30_000,
  });
}

export function useUpdateDeliverable() {
  const invalidate = useInvalidateRoadmap();
  return useMutation({
    mutationFn: (input: { id: string } & RoadmapDeliverableUpdateInput) =>
      api.patch<{ deliverable: RoadmapDeliverable }>(`/roadmap/deliverables/${input.id}`, {
        status: input.status,
        weight: input.weight,
        notes: input.notes,
        completedAt: input.completedAt,
      }),
    onSuccess: invalidate,
  });
}

export function useRoadmapReports() {
  return useQuery({
    queryKey: ['roadmap', 'reports'],
    queryFn: () => api.get<{ runs: RoadmapReportRun[] }>('/roadmap/reports'),
    staleTime: 15_000,
  });
}

export function useRoadmapReport(id: string | null) {
  return useQuery({
    queryKey: ['roadmap', 'reports', id],
    queryFn: () => api.get<{ run: RoadmapReportRun }>(`/roadmap/reports/${id}`),
    enabled: id !== null,
    staleTime: 15_000,
  });
}

export function useApproveReport() {
  const invalidate = useInvalidateRoadmap();
  return useMutation({
    mutationFn: (id: string) => api.post<{ run: RoadmapReportRun }>(`/roadmap/reports/${id}/approve`),
    onSuccess: invalidate,
  });
}

export function useRoadmapRecipients() {
  return useQuery({
    queryKey: ['roadmap', 'recipients'],
    queryFn: () => api.get<{ recipients: RoadmapReportRecipient[] }>('/roadmap/recipients'),
    staleTime: 30_000,
  });
}

export function useCreateRecipient() {
  const invalidate = useInvalidateRoadmap();
  return useMutation({
    mutationFn: (input: RoadmapRecipientCreateInput) =>
      api.post<{ recipient: RoadmapReportRecipient }>('/roadmap/recipients', input),
    onSuccess: invalidate,
  });
}

export function useUpdateRecipient() {
  const invalidate = useInvalidateRoadmap();
  return useMutation({
    mutationFn: (input: { id: string } & RoadmapRecipientUpdateInput) =>
      api.patch<{ recipient: RoadmapReportRecipient }>(`/roadmap/recipients/${input.id}`, {
        name: input.name,
        phone: input.phone,
        active: input.active,
      }),
    onSuccess: invalidate,
  });
}

export function useDeleteRecipient() {
  const invalidate = useInvalidateRoadmap();
  return useMutation({
    mutationFn: (id: string) => api.delete<void>(`/roadmap/recipients/${id}`),
    onSuccess: invalidate,
  });
}
