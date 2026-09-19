/**
 * Access roles ("nível de acesso"). These are distinct from `cargo` (job title),
 * which is free text on the employee record.
 *
 * `rank` drives privilege-escalation guards: nobody may assign a role at or
 * above their own rank. `tracksTime` decides whether login/logout generates
 * RH/DP time-clock entries — Admin Master and Diretoria are exempt.
 */
export const ROLES = {
  admin_master: { name: 'Admin Master', rank: 100, tracksTime: false },
  diretoria: { name: 'Diretoria', rank: 90, tracksTime: false },
  // Runs the RH/DP module and the employee register for the whole company.
  rh_dp: { name: 'RH / DP', rank: 70, tracksTime: true },
  gerente_comercial: { name: 'Gerente Comercial', rank: 60, tracksTime: true },
  marketing: { name: 'Marketing', rank: 50, tracksTime: true },
  formatacao_juridico: { name: 'Formatação — Jurídico', rank: 40, tracksTime: true },
  formatacao_financeiro: { name: 'Formatação — Financeiro', rank: 40, tracksTime: true },
  formatacao_processos_projetos: {
    name: 'Formatação — Processos e Projetos',
    rank: 40,
    tracksTime: true,
  },
  formatacao_contabil_tributario: {
    name: 'Formatação — Contábil/Tributário',
    rank: 40,
    tracksTime: true,
  },
  formatacao_logistica: { name: 'Formatação — Logística', rank: 40, tracksTime: true },
  formatacao_ti: { name: 'Formatação — TI', rank: 40, tracksTime: true },
  vendedor_expansao: { name: 'Vendedor Expansão', rank: 30, tracksTime: true },
  vendedor_formatacao: { name: 'Vendedor Formatação', rank: 30, tracksTime: true },
} as const satisfies Record<string, { name: string; rank: number; tracksTime: boolean }>;

export type RoleKey = keyof typeof ROLES;

export const ROLE_KEYS = Object.keys(ROLES) as RoleKey[];

/**
 * Roles a sector manager may never grant. Holders of `employees.assign_roles`
 * follow a different rule — see `roleChangeDenial` in policy.ts.
 */
export const PROTECTED_ROLES: readonly RoleKey[] = ['admin_master', 'diretoria'];

export function isRoleKey(value: string): value is RoleKey {
  return value in ROLES;
}
