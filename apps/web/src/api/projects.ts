import type {
  ClientProject,
  ProjectStageSlot,
  ProjectStageUpdateInput,
  ProjectStatus,
  ProjectStatusChange,
  ProjectStatusChangeInput,
} from '@wings/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './client.js';

/**
 * Gestão → Projetos: the one `/projects` API. The board, the tag on a client's
 * Drive folder and Formatação → Clientes all read from here, so a change in
 * one place shows in the others as soon as the queries refresh.
 */

export interface ProjectFilter {
  status?: ProjectStatus;
  /** Inactive clients keep their project but leave the board unless asked for. */
  inactive?: boolean;
  /** Hidden projects (B5: brands moved to Expansão) are kept and leave the board unless asked for. */
  hidden?: boolean;
}

export function useProjects(filter: ProjectFilter = {}, enabled = true) {
  const params = new URLSearchParams();
  if (filter.status) params.set('status', filter.status);
  if (filter.inactive) params.set('inactive', 'true');
  if (filter.hidden) params.set('hidden', 'true');
  const query = params.toString();
  return useQuery({
    queryKey: [
      'projects',
      'list',
      filter.status ?? '',
      Boolean(filter.inactive),
      Boolean(filter.hidden),
    ],
    queryFn: () => api.get<{ projects: ClientProject[] }>(`/projects${query ? `?${query}` : ''}`),
    enabled,
    staleTime: 30_000,
  });
}

export function useProject(clientId: string | null, enabled = true) {
  return useQuery({
    queryKey: ['projects', 'one', clientId],
    queryFn: () =>
      api.get<{ project: ClientProject; history: ProjectStatusChange[] }>(`/projects/${clientId}`),
    enabled: enabled && clientId !== null,
    staleTime: 30_000,
    retry: false,
  });
}

function useProjectMutation<TInput>(run: (input: TInput) => Promise<{ project: ClientProject }>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: run,
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['projects'] }),
  });
}

export const useChangeProjectStatus = () =>
  useProjectMutation((input: { clientId: string } & ProjectStatusChangeInput) =>
    api.patch<{ project: ClientProject }>(`/projects/${input.clientId}/status`, {
      status: input.status,
      reason: input.reason || undefined,
    }),
  );

export const useSetCurrentStage = () =>
  useProjectMutation((input: { clientId: string; stage: ProjectStageSlot }) =>
    api.patch<{ project: ClientProject }>(`/projects/${input.clientId}/current-stage`, {
      stage: input.stage,
    }),
  );

export const useUpdateProjectStage = () =>
  useProjectMutation(
    (input: { clientId: string; slot: ProjectStageSlot } & ProjectStageUpdateInput) =>
      api.patch<{ project: ClientProject }>(`/projects/${input.clientId}/stages/${input.slot}`, {
        progress: input.progress,
        note: input.note || undefined,
      }),
  );
