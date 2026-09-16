import { z } from 'zod';
import type { PermissionKey, Scope } from '../rbac/permissions.js';
import type { RoleKey } from '../rbac/roles.js';
import type { SectorSlug } from '../rbac/sectors.js';

/** Name of the session cookie. Same on every environment. */
export const SESSION_COOKIE = 'wings_session';

/** Session lifetimes. Idle expiry also closes the RH/DP time entry. */
export const SESSION_IDLE_MINUTES = 30;
export const SESSION_ABSOLUTE_HOURS = 12;

/** Account lockout after repeated failures. */
export const LOGIN_MAX_ATTEMPTS = 5;
export const LOGIN_LOCK_MINUTES = 15;

export const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email('E-mail inválido').max(160),
  password: z.string().min(1, 'Senha obrigatória').max(200),
});

export type LoginInput = z.output<typeof loginSchema>;

/** Payload of GET /api/auth/me — what the frontend needs to render the shell. */
export interface SessionUser {
  employeeId: string;
  fullName: string;
  email: string;
  cargo: string;
  role: RoleKey;
  sector: SectorSlug;
  isSectorManager: boolean;
  tracksTime: boolean;
  /** Effective permissions with their scope, for hiding UI only. */
  permissions: Partial<Record<PermissionKey, Scope>>;
  lastLoginAt: string | null;
  sessionExpiresAt: string;
}
