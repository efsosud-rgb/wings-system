import type {
  CameraDevice,
  CameraDeviceCreated,
  CameraDeviceCreateInput,
  CamerasDashboard,
} from '@wings/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './client.js';

/** Gestão → Câmeras (docs/cameras.md): counts per area, never an image. */

export function useCamerasDashboard(query: Record<string, string>) {
  const params = new URLSearchParams(query);
  return useQuery({
    queryKey: ['cameras', 'dashboard', params.toString()],
    queryFn: () => api.get<CamerasDashboard>(`/cameras/dashboard?${params.toString()}`),
    placeholderData: (previous) => previous,
  });
}

export function useCameraDevices(enabled = true) {
  return useQuery({
    queryKey: ['cameras', 'devices'],
    queryFn: () => api.get<{ devices: CameraDevice[] }>('/cameras/devices'),
    enabled,
  });
}

/** Registers a device; the answer carries the token once, and it is never shown again. */
export function useCreateCameraDevice() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CameraDeviceCreateInput) =>
      api.post<CameraDeviceCreated>('/cameras/devices', input),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['cameras'] }),
  });
}

export function useRevokeCameraDevice() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.post<{ ok: true }>(`/cameras/devices/${id}/revoke`),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['cameras'] }),
  });
}
