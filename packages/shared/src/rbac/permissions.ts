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
  'leads.whatsapp': 'Conversar e ligar pelo WhatsApp do sistema (ver, enviar e ligar)',
  'productivity.read':
    'Ver a aba Produtividade do Painel de Vendas: números por resultado, pessoa a pessoa (own = só os próprios e a média da equipe; sector = a equipe do setor)',
  'whatsapp.import_bulk':
    'Importar em lote as conversas exportadas do celular, pareando cada uma com a negociação',
  'companies.read': 'Ver a tela de Empresas do CRM, com o cadastro de cada empresa',
  'landing_pages.read': 'Ver as landing pages de cada cliente e funil no CRM',
  'crm.manage': 'Configurar as etapas do funil e a distribuição de leads',
  'sofia.manage': 'Ligar e desligar a Sofia e editar as perguntas e mensagens dela',
  'sofia.read': 'Ver a tela da Sofia com todas as conversas do WhatsApp',
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
  'integrations.manage':
    'Conectar e desconectar integrações do sistema (Kairogen, os números do WhatsApp dos vendedores)',
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
  'modules.preview': 'Ver no menu os módulos ainda em construção ("em breve")',
  'calendar.use':
    'Usar a Agenda: a própria agenda Google e a da Wings Company, com a conta Google de cada um',
  'calendar.write':
    'Criar, editar e excluir eventos pela Agenda (os vendedores só leem e marcam reunião pela ficha)',
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

/**
 * The CRM screens that list the whole base: Empresas and Landing pages. For the levels that see
 * every lead; the sellers' CRM is their own deals, contacts and conversations (Eric, 14/10).
 */
const CRM_FULL_SCREENS: RolePermissions = {
  'companies.read': 'all',
  'landing_pages.read': 'all',
};

/**
 * The Agenda, for every level (Eric, 14/10: "Todos podem ter acesso a esse módulo"). `own`: each
 * person reads and writes only through their own Google connection; Google's sharing decides the
 * Wings Company calendar (docs/agenda.md).
 */
const AGENDA: RolePermissions = { 'calendar.use': 'own', 'calendar.write': 'own' };

/**
 * The sellers' Agenda is read-only (Eric, 19/10): they see their own calendar and Wings Company's
 * in full, and schedule only from the lead's page (`leads.write`), never from the Agenda.
 */
const AGENDA_READ: RolePermissions = { 'calendar.use': 'own' };

/**
 * Everyone who is not a manager: their own time clock and their department's
 * Drive. No employee register (Eric, 13/10): Usuários e acessos is for Admin
 * Master, Diretoria, RH/DP, the Gerente Comercial and whoever carries the
 * sector-manager flag (`SECTOR_MANAGER_GRANTS`).
 */
const SECTOR_STAFF: RolePermissions = { 'timeclock.read': 'own', ...DRIVE_STAFF, ...AGENDA };

/**
 * The sellers: their own time clock and no Drive (Eric, 14/10). `DRIVE_ROLE_DEPARTMENTS` still
 * names Comercial for them, because that is what lets them update stage 07 of a project.
 */
const SELLER_STAFF: RolePermissions = { 'timeclock.read': 'own', ...AGENDA_READ };

/**
 * The permission matrix. Anything not listed here is denied by default.
 *
 * Only the Admin Master holds `settings.manage` and `api_credentials.manage`
 * (Eric, 13/10: not Diretoria, not Formatação — TI). Diretoria is additionally
 * blocked from the TI sector by an explicit deny rule in policy.ts.
 *
 * The API refuses a route that does not name its permission, and the menu
 * hides a screen the person's permissions do not reach: this table is the one
 * place that decides who sees what (docs/niveis-de-acesso.md).
 */
export const ROLE_PERMISSIONS: Record<RoleKey, RolePermissions> = {
  admin_master: {
    ...AGENDA,
    'meetings.approve_send': 'all',
    ...CRM_FULL_SCREENS,
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
    'productivity.read': 'all',
    'leads.write': 'all',
    'leads.assign': 'all',
    'leads.whatsapp': 'all',
    'whatsapp.import_bulk': 'all',
    'sofia.manage': 'all',
    'sofia.read': 'all',
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
    // Modules still "em breve" show in the menu to Admin Master and Diretoria only.
    'modules.preview': 'all',
  },
  diretoria: {
    ...AGENDA,
    'meetings.approve_send': 'all',
    ...CRM_FULL_SCREENS,
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
    'productivity.read': 'all',
    'leads.assign': 'all',
    // Eric, 07/10: Diretoria reads, sends and calls on any lead's WhatsApp, though it does not edit the deal.
    'leads.whatsapp': 'all',
    'sofia.manage': 'all',
    'sofia.read': 'all',
    'campaign_leads.read': 'all',
    'campaign_leads.reveal': 'all',
    'audit.read': 'all',
    'ads.read': 'all',
    'ads.request': 'all',
    // Either Admin Master or Diretoria may approve a budget change.
    'ads.approve': 'all',
    'ads.reconcile.manual': 'all',
    'site.publish': 'all',
    'modules.preview': 'all',
  },
  // The employee register and the RH/DP module. No CPF reveal and no time-clock
  // approvals: neither was asked for, and both are easy to add later.
  rh_dp: {
    ...AGENDA,
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
    ...AGENDA,
    'meetings.approve_send': 'all',
    ...CRM_FULL_SCREENS,
    ...DRIVE_STAFF,
    ...PROJECT_STAFF,
    'employees.read': 'sector',
    'employees.create': 'sector',
    'employees.update': 'sector',
    'roles.assign': 'sector',
    'timeclock.read': 'sector',
    'leads.read': 'all',
    'productivity.read': 'sector',
    'leads.write': 'all',
    // Runs the team: hands leads over and keeps the funnel's stages and rotation.
    'leads.assign': 'all',
    'leads.whatsapp': 'all',
    'sofia.manage': 'all',
    'sofia.read': 'all',
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
  formatacao_ti: { ...SECTOR_STAFF, ...PROJECT_READ },
  // The sellers' menu is CRM Vendas alone (Eric, 14/10): no Drive, no Empresas, no Landing pages.
  // They still open, send and remove the files of their own deals, through the deal's own routes.
  vendedor_expansao: {
    ...SELLER_STAFF,
    ...PROJECT_STAFF,
    'leads.read': 'own',
    'productivity.read': 'own',
    'leads.write': 'own',
    'leads.whatsapp': 'own',
  },
  // Leads das Campanhas: only the leads RD assigns to them.
  vendedor_formatacao: {
    ...SELLER_STAFF,
    ...PROJECT_STAFF,
    'leads.read': 'own',
    'productivity.read': 'own',
    'leads.write': 'own',
    'leads.whatsapp': 'own',
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
