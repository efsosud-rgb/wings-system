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
  'leads.assign': 'Atribuir e redistribuir leads entre vendedores',
  'crm.manage': 'Configurar as etapas do funil e a distribuição de leads',
  'campaign_leads.read': 'Ver os leads das campanhas de tráfego pago (RD CRM)',
  'campaign_leads.reveal':
    'Revelar telefone e e-mail dos leads das campanhas (registrado em auditoria)',
  'settings.manage': 'Configurações do sistema',
  'api_credentials.manage': 'Gerenciar credenciais de API',
  'audit.read': 'Consultar log de auditoria',
  'ads.read': 'Ver campanhas e gastos de tráfego pago',
  'ads.request': 'Pedir a criação de campanhas de tráfego pago',
  'site.publish': 'Criar rascunhos de post no site da Wings',
  'ads.approve': 'Aprovar alterações de orçamento de tráfego pago',
  'ads.budget_caps.manage': 'Editar o teto interno de orçamento de tráfego pago por conta',
  'ads.reconcile.manual':
    'Forçar agora a reconciliação de uma conta de tráfego pago com a plataforma',
  'integrations.manage': 'Conectar e desconectar integrações do sistema (Kairogen)',
  'marketing.media.read': 'Ver a biblioteca de mídia do marketing',
  'marketing.media.generate': 'Gerar imagens e vídeos gastando créditos',
  'marketing.media.edit': 'Editar vídeos no Studio, exportar e salvar no Drive',
  'clients.manage': 'Cadastrar, renomear e desativar clientes',
  'clients.read': 'Ver a ficha completa dos clientes',
  'clients.edit': 'Preencher a ficha completa dos clientes',
  'clients.sensitive':
    'Ver e editar CPF, estado civil e regime de bens dos sócios dos clientes (revelação registrada em auditoria)',
  'drive.read': 'Ver pastas e arquivos do Drive',
  'drive.write': 'Enviar, mover, renomear e excluir arquivos do Drive',
  'drive.manage': 'Editar o modelo de pastas do Drive, sincronizar e esvaziar a lixeira',
  'projects.read': 'Ver o quadro de projetos dos clientes',
  'projects.manage': 'Mudar status, etapa atual e andamento das etapas dos projetos dos clientes',
  'roadmap.manage': 'Editar o roadmap e aprovar o relatório diário para a diretoria',
  'meetings.approve_send':
    'Aprovar e mandar o resumo de uma reunião de Expansão ao dono da franqueadora',
  'office.read': 'Ver o escritório virtual (laboratório): equipe, tarefas e eventos do CRM',
} as const;

export type PermissionKey = keyof typeof PERMISSIONS;
export const PERMISSION_KEYS = Object.keys(PERMISSIONS) as PermissionKey[];

export const SCOPES = ['own', 'sector', 'all'] as const;
export type Scope = (typeof SCOPES)[number];

export type RolePermissions = Partial<Record<PermissionKey, Scope>>;

/**
 * The Drive for a department: its own tree and the client folders inside it.
 * `sector` here means the departments of the ROLE (`DRIVE_ROLE_DEPARTMENTS`),
 * decided by the API folder by folder.
 */
const DRIVE_STAFF: RolePermissions = { 'drive.read': 'sector', 'drive.write': 'sector' };
const DRIVE_ALL: RolePermissions = {
  'drive.read': 'all',
  'drive.write': 'all',
  'drive.manage': 'all',
};

/**
 * The projects board (Gestão → Projetos): everyone who works for the clients
 * sees every client's project. `sector` on `projects.manage` is the progress
 * of the stages of the role's own departments (`stageEditableBy`); `all` is the
 * status, the current stage and every stage.
 */
const PROJECT_STAFF: RolePermissions = { 'projects.read': 'all', 'projects.manage': 'sector' };
const PROJECT_READ: RolePermissions = { 'projects.read': 'all' };
const PROJECT_ALL: RolePermissions = { 'projects.read': 'all', 'projects.manage': 'all' };

/**
 * The client's full record (Administração → Clientes → ficha). `clients.sensitive`
 * is the partners' CPF, marital status and property regime: Jurídico, Diretoria
 * and Admin Master only, and every CPF reveal is audited.
 */
const CLIENT_RECORD: RolePermissions = { 'clients.read': 'all', 'clients.edit': 'all' };
const CLIENT_RECORD_LEGAL: RolePermissions = { ...CLIENT_RECORD, 'clients.sensitive': 'all' };

const SECTOR_STAFF: RolePermissions = {
  'employees.read': 'sector',
  'timeclock.read': 'own',
  ...DRIVE_STAFF,
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
    'meetings.approve_send': 'all',
    ...DRIVE_ALL,
    ...PROJECT_ALL,
    // The one connection to Kairogen belongs to the system: only an Admin Master makes it.
    'integrations.manage': 'all',
    ...CLIENT_RECORD_LEGAL,
    'clients.manage': 'all',
    'marketing.media.read': 'all',
    'marketing.media.generate': 'all',
    'marketing.media.edit': 'all',
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
    'leads.assign': 'all',
    'crm.manage': 'all',
    'campaign_leads.read': 'all',
    'campaign_leads.reveal': 'all',
    'settings.manage': 'all',
    'api_credentials.manage': 'all',
    'audit.read': 'all',
    'ads.read': 'all',
    'ads.request': 'all',
    'ads.approve': 'all',
    // The internal monthly cap is what the guardrail refuses against; only an
    // Admin Master moves it, the same as the CLI it replaces on screen.
    'ads.budget_caps.manage': 'all',
    // Same pair as ads.approve: whoever may approve a spend change may also
    // force the read that tells them whether it is safe to approve.
    'ads.reconcile.manual': 'all',
    'site.publish': 'all',
    // The roadmap report goes to the CEOs; only an Admin Master edits and approves it.
    'roadmap.manage': 'all',
    // Laboratório: only the Admin Master sees the virtual office while it is a prototype.
    'office.read': 'all',
  },
  diretoria: {
    'meetings.approve_send': 'all',
    ...DRIVE_ALL,
    ...PROJECT_ALL,
    ...CLIENT_RECORD_LEGAL,
    'clients.manage': 'all',
    'marketing.media.read': 'all',
    'marketing.media.generate': 'all',
    'marketing.media.edit': 'all',
    'employees.read': 'all',
    'employees.pii.view': 'all',
    // Access levels only: Diretoria still cannot edit the rest of a record.
    'employees.assign_roles': 'all',
    'timeclock.read': 'all',
    'leads.read': 'all',
    'leads.assign': 'all',
    'campaign_leads.read': 'all',
    'campaign_leads.reveal': 'all',
    'audit.read': 'all',
    'ads.read': 'all',
    'ads.request': 'all',
    // Either Admin Master or Diretoria may approve a budget change.
    'ads.approve': 'all',
    'ads.reconcile.manual': 'all',
    'site.publish': 'all',
  },
  // The employee register and the RH/DP module. No CPF reveal and no time-clock
  // approvals: neither was asked for, and both are easy to add later.
  rh_dp: {
    ...DRIVE_STAFF,
    ...PROJECT_READ,
    'employees.read': 'all',
    'employees.create': 'all',
    'employees.update': 'all',
    'employees.deactivate': 'all',
    'employees.assign_roles': 'all',
    'timeclock.read': 'all',
  },
  gerente_comercial: {
    'meetings.approve_send': 'all',
    ...DRIVE_STAFF,
    ...PROJECT_STAFF,
    'employees.read': 'sector',
    'employees.create': 'sector',
    'employees.update': 'sector',
    'roles.assign': 'sector',
    'timeclock.read': 'sector',
    'leads.read': 'all',
    'leads.write': 'all',
    // Runs the team: hands leads over and keeps the funnel's stages and rotation.
    'leads.assign': 'all',
    'crm.manage': 'all',
    'campaign_leads.read': 'all',
    'campaign_leads.reveal': 'all',
  },
  // Marketing builds and asks; only Admin Master or Diretoria approve.
  marketing: {
    // Marketing is who works for the clients, so it keeps their register too.
    'clients.manage': 'all',
    ...CLIENT_RECORD,
    'marketing.media.read': 'all',
    'marketing.media.generate': 'all',
    'marketing.media.edit': 'all',
    ...SECTOR_STAFF,
    ...PROJECT_STAFF,
    'ads.read': 'all',
    'ads.request': 'all',
    'site.publish': 'all',
  },
  // Jurídico drafts the contracts and the COF from the client's record, so it
  // fills the record and sees the partners' qualification.
  formatacao_juridico: { ...SECTOR_STAFF, ...PROJECT_STAFF, ...CLIENT_RECORD_LEGAL },
  formatacao_financeiro: { ...SECTOR_STAFF, ...PROJECT_STAFF },
  // Processos e Projetos runs the client: status, current stage and every stage.
  formatacao_processos_projetos: { ...SECTOR_STAFF, ...PROJECT_ALL },
  formatacao_contabil_tributario: { ...SECTOR_STAFF, ...PROJECT_STAFF },
  // No stage of the client belongs to Logística or TI: they read the board only.
  formatacao_logistica: { ...SECTOR_STAFF, ...PROJECT_READ },
  formatacao_ti: {
    ...SECTOR_STAFF,
    ...PROJECT_READ,
    'settings.manage': 'all',
    'api_credentials.manage': 'all',
  },
  vendedor_expansao: {
    ...SECTOR_STAFF,
    ...PROJECT_STAFF,
    'leads.read': 'own',
    'leads.write': 'own',
  },
  // Leads das Campanhas: only the leads RD assigns to them.
  vendedor_formatacao: {
    ...SECTOR_STAFF,
    ...PROJECT_STAFF,
    'leads.read': 'own',
    'leads.write': 'own',
    'campaign_leads.read': 'own',
    'campaign_leads.reveal': 'own',
  },
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
