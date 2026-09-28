import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './client.js';

export interface ExpansionLandingPage {
  identifier: string;
  brand: string;
  active: boolean;
}

const KEY = ['expansion', 'landing-pages'];

export function useExpansionLandingPages() {
  return useQuery({
    queryKey: KEY,
    queryFn: () =>
      api.get<{ enabled: boolean; landingPages: ExpansionLandingPage[] }>(
        '/expansion/landing-pages',
      ),
  });
}

export function useSaveLandingPage() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (page: ExpansionLandingPage) => api.put('/expansion/landing-pages', page),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: KEY }),
  });
}

export function useRemoveLandingPage() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (identifier: string) =>
      api.delete(`/expansion/landing-pages/${encodeURIComponent(identifier)}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: KEY }),
  });
}
