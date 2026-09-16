import type { PermissionKey, Scope, SessionUser } from '@wings/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from './client.js';

export const sessionKey = ['session'] as const;

/**
 * Current session. A 401 resolves to null rather than throwing, so the router
 * can simply redirect instead of rendering an error.
 */
export function useSession() {
  return useQuery({
    queryKey: sessionKey,
    retry: false,
    staleTime: 30_000,
    queryFn: async (): Promise<SessionUser | null> => {
      try {
        const body = await api.get<{ user: SessionUser }>('/auth/me');
        return body.user;
      } catch (error) {
        if (error instanceof ApiError && error.status === 401) return null;
        throw error;
      }
    },
  });
}

export function useLogin() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { email: string; password: string }) =>
      api.post<{ user: SessionUser }>('/auth/login', input),
    onSuccess: (data) => {
      queryClient.setQueryData(sessionKey, data.user);
    },
  });
}

export function useLogout() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<{ ok: true }>('/auth/logout'),
    onSuccess: () => {
      queryClient.setQueryData(sessionKey, null);
      queryClient.clear();
    },
  });
}

export function useForgotPassword() {
  return useMutation({
    mutationFn: (input: { email: string }) =>
      api.post<{ message: string }>('/auth/forgot-password', input),
  });
}

export function useSetPassword() {
  return useMutation({
    mutationFn: (input: { token: string; password: string }) =>
      api.post<{ ok: true; purpose: 'invite' | 'reset' }>('/auth/set-password', input),
  });
}

/** UI-only helper: hide what the viewer cannot use. The API decides for real. */
export function hasPermission(
  user: SessionUser | null | undefined,
  permission: PermissionKey,
): boolean {
  return Boolean(user?.permissions[permission]);
}

export function permissionScope(
  user: SessionUser | null | undefined,
  permission: PermissionKey,
): Scope | undefined {
  return user?.permissions[permission];
}
