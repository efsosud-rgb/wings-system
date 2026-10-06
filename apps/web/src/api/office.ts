import type { OfficeSnapshot } from '@wings/shared';
import { useQuery } from '@tanstack/react-query';
import { api } from './client.js';

/**
 * Laboratório → Escritório virtual: one snapshot of the floor, read again
 * every minute so a new lead or a won sale shows up without a reload.
 */
export function useOffice() {
  return useQuery({
    queryKey: ['office'],
    queryFn: () => api.get<OfficeSnapshot>('/office'),
    refetchInterval: 60_000,
    staleTime: 30_000,
  });
}
