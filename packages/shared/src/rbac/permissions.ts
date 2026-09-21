import { ROLE_KEYS, type RoleKey } from './roles.js';

/**
 * Permission names and the scope each role gets them at.
 *
 * Scope meaning:
 *  - `own`    — only rows belonging to the actor
 *  - `sector` — rows in the actor's sector (including its sub-sectors)
 *  - `all`    — every row
 */
export const PERMISSIONS = {
  'employees.read': 'Ver registros de funcionários',
  'employees.create': 'Cadastrar funcionários',
  'employees.update': 'Editar funcionários',
  'employees.deactivate': 'Inativar funcionários',
  'employees.pii.view': 'Revelar CPF completo (registrado em auditoria)',
  'roles.assign': 'Definir nível de acesso de funcionários',
  'employees.assign_roles': 'Alterar o nível de acesso de qualquer funcionário',
  'timeclock.read': 'Ver registros de ponto',
  'timeclock.adjust': 'Aprovar ajustes de ponto',
  'leads.read': 'Ver leads do funil',
  'leads.write': 'Criar e editar leads',
  'settings.manage': 'Configurações do sistema',
  'api_credentials.manage': 'Gerenciar credenciais de API',
  'audit.read': 'Consultar log de auditoria',
  'ads.read': 'Ver campanhas e gastos de tráfego pago',
  'ads.request': 'Pedir a criação de campanhas de tráfego pago',
  'site.publish': 'Criar rascunhos de post no site da Wings',
  'ads.approve': 'Aprovar alterações de orçamento de tráfego pago',
  'integrations.manage': 'Conectar e desconectar integrações do sistema (Kairogen)',
  'marketing.media.read': 'Ver a biblioteca de mídia do marketing',
  'marketing.media.generate': 'Gerar imagens e vídeos gastando créditos',
  'clients.manage': 'Cadastrar e editar clientes',
} as const;

export type PermissionKey = keyof typeof PERMISSIONS;
export const PERMISSION_KEYS = Object.keys(PERMISSIONS) as PermissionKey[];

export const SCOPES = ['own', 'sector', 'all'] as const;
export type Scope = (typeof SCOPES)[number];

export type RolePermissions = Partial<Record<PermissionKey, Scope>>;

const SECTOR_STAFF: RolePermissions = {
  'employees.read': 'sector',
  'timeclock.read': 'own',
};

/**
 * The permission matrix. Anything not listed here is denied by default.
 *
 * Diretoria intentionally has no `settings.manage` and no
 * `api_credentials.manage`, and is additionally blocked from the TI sector by
 * an explicit deny rule in policy.ts.
 */
export const ROLE_PERMISSIONS: Record<RoleKey, RolePermissions> = {
  admin_master: {
    // The one connection to Kairogen belongs to the system: only an Admin Master makes it.
    'integrations.manage': 'all',
    'clients.manage': 'all',
    'marketing.media.read': 'all',
    'marketing.media.generate': 'all',
    'employees.read': 'all',
    'employees.create': 'all',
    'employees.update': 'all',
    'employees.deactivate': 'all',
    'employees.pii.view': 'all',
    'roles.assign': 'all',
    'employees.assign_roles': 'all',
    'timeclock.read': 'all',
    'timeclock.adjust': 'all',
    'leads.read': 'all',
    'leads.write': 'all',
    'settings.manage': 'all',
    'api_credentials.manage': 'all',
    'audit.read': 'all',
    'ads.read': 'all',
    'ads.request': 'all',
    'ads.approve': 'all',
    'site.publish': 'all',
  },
  diretoria: {
    'clients.manage': 'all',
    'marketing.media.read': 'all',
    'marketing.media.generate': 'all',
    'employees.read': 'all',
    'employees.pii.view': 'all',
    // Access levels only: Diretoria still cannot edit the rest of a record.
    'employees.assign_roles': 'all',
    'timeclock.read': 'all',
    'leads.read': 'all',
    'audit.read': 'all',
    'ads.read': 'all',
    'ads.request': 'all',
    // Either Admin Master or Diretoria may approve a budget change.
    'ads.approve': 'all',
    'site.publish': 'all',
  },
  // The employee register and the RH/DP module. No CPF reveal and no time-clock
  // approvals: neither was asked for, and both are easy to add later.
  rh_dp: {
    'employees.read': 'all',
    'employees.create': 'all',
    'employees.update': 'all',
    'employees.deactivate': 'all',
    'employees.assign_roles': 'all',
    'timeclock.read': 'all',
  },
  gerente_comercial: {
    'employees.read': 'sector',
    'employees.create': 'sector',
    'employees.update': 'sector',
    'roles.assign': 'sector',
    'timeclock.read': 'sector',
    'leads.read': 'all',
    'leads.write': 'all',
  },
  // Marketing builds and asks; only Admin Master or Diretoria approve.
  marketing: {
    // Marketing is who works for the clients, so it keeps their register too.
    'clients.manage': 'all',
    'marketing.media.read': 'all',
    'marketing.media.generate': 'all',
    ...SECTOR_STAFF,
    'ads.read': 'all',
    'ads.request': 'all',
    'site.publish': 'all',
  },
  formatacao_juridico: { ...SECTOR_STAFF },
  formatacao_financeiro: { ...SECTOR_STAFF },
  formatacao_processos_projetos: { ...SECTOR_STAFF },
  formatacao_contabil_tributario: { ...SECTOR_STAFF },
  formatacao_logistica: { ...SECTOR_STAFF },
  formatacao_ti: { ...SECTOR_STAFF, 'settings.manage': 'all', 'api_credentials.manage': 'all' },
  vendedor_expansao: { ...SECTOR_STAFF, 'leads.read': 'own', 'leads.write': 'own' },
  vendedor_formatacao: { ...SECTOR_STAFF, 'leads.read': 'own', 'leads.write': 'own' },
};

/**
 * Extra grants conferred by the `is_sector_manager` flag on an employee,
 * independent of their role: managers run their own sector's staff.
 */
export const SECTOR_MANAGER_GRANTS: RolePermissions = {
  'employees.read': 'sector',
  'employees.create': 'sector',
  'employees.update': 'sector',
  'employees.deactivate': 'sector',
  'roles.assign': 'sector',
  'timeclock.read': 'sector',
};

/** Sanity guard: every role must appear in the matrix. */
export function assertMatrixComplete(): void {
  const missing = ROLE_KEYS.filter((role) => !(role in ROLE_PERMISSIONS));
  if (missing.length > 0) {
    throw new Error(`ROLE_PERMISSIONS missing roles: ${missing.join(', ')}`);
  }
}
