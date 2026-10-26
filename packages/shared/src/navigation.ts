import type { PermissionKey } from './rbac/permissions.js';
import { CRM_ONLY_ROLES, type RoleKey } from './rbac/roles.js';

/**
 * The navigation tree: Module → Sub-module → Studio.
 *
 * One declaration drives the sidebar, the routes and the access rules, so a
 * screen cannot appear in the menu without a route or escape its permission by
 * being registered in one place and not the other.
 *
 * This is structure only. A sub-module marked `coming_soon` has no backend yet
 * and renders a clearly labelled placeholder — visible, disabled, never a blank
 * screen that looks broken.
 */

export type SubmoduleStatus = 'ready' | 'coming_soon';

/** What kind of screen sits behind a sub-module, for layout purposes. */
export type SubmoduleKind = 'studio' | 'report' | 'crud' | 'placeholder';

/**
 * The icons the menu may use, by name. The web app draws each one as a
 * stroke SVG; the tree only says which. Keeping the set here means a module
 * cannot ask for an icon the app does not have.
 */
export const NAV_ICONS = [
  'home',
  'target',
  'columns',
  'users',
  'building',
  'check-square',
  'pie-chart',
  'sliders',
  'layout',
  'sparkles',
  'file-text',
  'hammer',
  'megaphone',
  'bar-chart',
  'briefcase',
  'calendar',
  'folder',
  'headset',
  'settings',
  'globe',
  'bell',
  'message',
] as const;
export type NavIcon = (typeof NAV_ICONS)[number];

/** The three blocks of the side menu, in order: the home, the CRM, the rest. */
export const NAV_GROUPS = ['inicio', 'crm', 'modulos'] as const;
export type NavGroup = (typeof NAV_GROUPS)[number];
export const NAV_GROUP_LABELS: Record<NavGroup, string> = {
  inicio: 'Início',
  crm: 'CRM Vendas',
  modulos: 'Módulos',
};

export interface NavSubmodule {
  /** Full path, always absolute. */
  path: string;
  label: string;
  /** Shown beside the label when the sub-module is listed flat (the CRM group). */
  icon?: NavIcon;
  /**
   * Permission required to see and open it. Deny by default (Eric, 13/10): a
   * built sub-module with no permission is shown to nobody unless it says
   * `everyone`, and an "em breve" placeholder also needs `modules.preview`
   * (Admin Master and Diretoria), whatever permission it names.
   */
  permission?: PermissionKey;
  /** Open to every login (the home page). The only way to skip `permission`. */
  everyone?: true;
  /**
   * Only these levels see it, on top of `permission`: the sellers' copies, inside the CRM, of
   * screens everyone else opens in Dashboard and Gestão.
   */
  levels?: readonly RoleKey[];
  /**
   * Open to the sellers too, though it sits outside CRM Vendas: Agenda and Reuniões in
   * Produtividade (Eric, 19/10). `permission` still decides.
   */
  sellers?: true;
  status: SubmoduleStatus;
  kind: SubmoduleKind;
  /** Shown on the placeholder so it is obvious what will live there. */
  description?: string;
}

export interface NavModule {
  key: string;
  label: string;
  icon: NavIcon;
  /** Which block of the menu lists it. */
  group: NavGroup;
  /** SaaS administration is for the operator of the platform, not the tenant. */
  roles?: readonly RoleKey[];
  submodules: readonly NavSubmodule[];
}

const soon = (
  path: string,
  label: string,
  description?: string,
  permission?: PermissionKey,
): NavSubmodule => ({
  path,
  label,
  status: 'coming_soon',
  kind: 'placeholder',
  description,
  permission,
});

export const NAVIGATION: readonly NavModule[] = [
  {
    key: 'inicio',
    label: 'Início',
    icon: 'home',
    group: 'inicio',
    submodules: [
      {
        path: '/inicio',
        label: 'Início',
        icon: 'home',
        description: 'Atalhos para o que a pessoa pode abrir e o que precisa de atenção hoje',
        everyone: true,
        status: 'ready',
        kind: 'report',
      },
    ],
  },
  {
    key: 'crm-vendas',
    label: 'CRM Vendas',
    icon: 'target',
    group: 'crm',
    submodules: [
      {
        path: '/crm-vendas/negociacoes',
        label: 'Negociações',
        icon: 'columns',
        description: 'O quadro de cada funil: etapas, valores e o que fazer a seguir',
        permission: 'leads.read',
        status: 'ready',
        kind: 'crud',
      },
      {
        path: '/crm-vendas/whatsapp',
        label: 'WhatsApp',
        icon: 'message',
        description: 'As suas conversas pelo WhatsApp da empresa, como no WhatsApp Web',
        permission: 'leads.whatsapp',
        status: 'ready',
        kind: 'crud',
      },
      {
        path: '/crm-vendas/contatos',
        label: 'Contatos',
        icon: 'users',
        description: 'As pessoas das negociações',
        permission: 'leads.read',
        status: 'ready',
        kind: 'crud',
      },
      {
        path: '/crm-vendas/empresas',
        label: 'Empresas',
        icon: 'building',
        description: 'As empresas das negociações e as que viraram clientes',
        permission: 'companies.read',
        status: 'ready',
        kind: 'crud',
      },
      {
        path: '/crm-vendas/tarefas',
        label: 'Tarefas',
        icon: 'check-square',
        description: 'Atrasadas, de hoje e próximas',
        permission: 'leads.read',
        status: 'ready',
        kind: 'crud',
      },
      {
        path: '/crm-vendas/avisos',
        label: 'Avisos',
        icon: 'bell',
        description: 'Prazos vencidos, negociações paradas e avisos das automações',
        permission: 'leads.read',
        status: 'ready',
        kind: 'crud',
      },
      {
        ...soon('/crm-vendas/painel', 'Painel', 'Vendas por funil, marca e vendedor', 'leads.read'),
        icon: 'pie-chart',
      },
      // The sellers' menu is CRM Vendas alone (Eric, 14/10): the screens they still use from
      // Dashboard and Gestão sit here for them, the same pages at their own address.
      {
        path: '/crm-vendas/painel-de-vendas',
        label: 'Painel de Vendas',
        icon: 'pie-chart',
        description: 'Os números das suas negociações: funil, marcas e resultado',
        permission: 'leads.read',
        levels: CRM_ONLY_ROLES,
        status: 'ready',
        kind: 'report',
      },
      {
        path: '/crm-vendas/projetos',
        label: 'Projetos',
        icon: 'briefcase',
        description: 'O projeto de cada cliente: status e as oito etapas',
        permission: 'projects.read',
        levels: CRM_ONLY_ROLES,
        status: 'ready',
        kind: 'crud',
      },
      {
        path: '/crm-vendas/leads-campanhas',
        label: 'Leads das Campanhas',
        icon: 'megaphone',
        description: 'Leads do RD vindos das campanhas ativas',
        permission: 'campaign_leads.read',
        levels: CRM_ONLY_ROLES,
        status: 'ready',
        kind: 'report',
      },
      {
        path: '/crm-vendas/configuracoes',
        label: 'Configurações',
        icon: 'sliders',
        description: 'Etapas e probabilidades, distribuição de negociações e marcas',
        permission: 'crm.manage',
        status: 'ready',
        kind: 'crud',
      },
      {
        path: '/crm-vendas/landing-pages',
        label: 'Landing pages',
        icon: 'layout',
        description: 'Páginas por cliente e funil, desempenho e links com UTM',
        permission: 'landing_pages.read',
        status: 'ready',
        kind: 'crud',
      },
      {
        path: '/crm-vendas/sofia',
        label: 'Sofia (SDR IA)',
        icon: 'sparkles',
        description:
          'A atendente virtual: recebe toda conversa nova, qualifica e passa ao vendedor',
        permission: 'sofia.read',
        status: 'ready',
        kind: 'crud',
      },
    ],
  },
  {
    key: 'contratos',
    label: 'Contratos',
    icon: 'file-text',
    group: 'modulos',
    submodules: [
      soon('/contratos/cof', 'COF', 'Circular de Oferta de Franquia'),
      soon('/contratos/franquia', 'Contratos de franquia', 'Emissão e assinatura'),
      soon('/contratos/renovacoes', 'Renovações e prazos', 'Vencimentos e aditivos'),
    ],
  },
  {
    key: 'formatacao',
    label: 'Formatação',
    icon: 'hammer',
    group: 'modulos',
    submodules: [
      {
        path: '/formatacao/clientes',
        label: 'Clientes',
        description: 'Para quem o trabalho é feito',
        permission: 'clients.read',
        status: 'ready',
        kind: 'crud',
      },
      soon('/formatacao/projetos', 'Projetos', 'Projetos de formatação em andamento'),
      soon('/formatacao/consultor-juridico', 'Consultor Jurídico'),
      soon('/formatacao/consultor-financeiro', 'Consultor Financeiro'),
      soon('/formatacao/consultor-processos', 'Consultor de Processos'),
      soon('/formatacao/consultor-projetos', 'Consultor de Projetos'),
      soon('/formatacao/consultor-rh', 'Consultor de RH'),
      soon('/formatacao/consultor-logistico', 'Consultor Logístico'),
    ],
  },
  {
    key: 'marketing',
    label: 'Marketing',
    icon: 'megaphone',
    group: 'modulos',
    submodules: [
      {
        path: '/marketing/trafego-pago-wings',
        label: 'Agente de Tráfego Pago — Wings',
        permission: 'ads.read',
        status: 'ready',
        kind: 'studio',
      },
      {
        path: '/marketing/ads-intelligence',
        label: 'Wings Ads Intelligence',
        description: 'Auditoria, recomendações e anúncios com IA',
        permission: 'ads.read',
        status: 'ready',
        kind: 'report',
      },
      soon(
        '/marketing/trafego-pago-franqueadoras',
        'Agente de Tráfego Pago — Franqueadoras',
        'Mesmo agente, contas das franqueadoras',
        'ads.read',
      ),
      soon('/marketing/copywriter', 'Copywriter', 'Geração de textos e anúncios'),
      soon('/marketing/design', 'Design gráfico', 'Peças e identidade visual'),
      {
        path: '/marketing/edicao',
        label: 'Edição de fotos e vídeos',
        description: 'Agente de Edição Wings e biblioteca de mídia',
        permission: 'marketing.media.read',
        status: 'ready',
        kind: 'studio',
      },
      soon('/marketing/apresentacoes', 'Apresentações', 'Decks comerciais e institucionais'),
    ],
  },
  {
    key: 'dashboard',
    label: 'Dashboard',
    icon: 'bar-chart',
    group: 'modulos',
    submodules: [
      {
        path: '/dashboard/vendas',
        label: 'Vendas',
        description: 'Painel de vendas do CRM: funil, marcas e vendedores',
        permission: 'leads.read',
        status: 'ready',
        kind: 'report',
      },
      {
        path: '/dashboard/marketing',
        label: 'Marketing',
        permission: 'ads.read',
        status: 'ready',
        kind: 'report',
      },
      {
        path: '/dashboard/leads-campanhas',
        label: 'Leads das Campanhas',
        description: 'Leads do RD vindos das campanhas ativas',
        permission: 'campaign_leads.read',
        status: 'ready',
        kind: 'report',
      },
    ],
  },
  {
    key: 'gestao',
    label: 'Gestão',
    icon: 'briefcase',
    group: 'modulos',
    submodules: [
      {
        path: '/gestao/projetos',
        label: 'Projetos',
        description: 'O projeto de cada cliente: status e as oito etapas',
        permission: 'projects.read',
        status: 'ready',
        kind: 'crud',
      },
      soon('/gestao/financeiro', 'Financeiro', 'Contas a pagar e receber'),
      soon('/gestao/rh-dp', 'RH e DP', 'Ponto, férias e folha', 'timeclock.read'),
      soon('/gestao/fiscal', 'Fiscal', 'Notas e obrigações'),
      soon('/gestao/pdv', 'PDV'),
      soon('/gestao/produtos', 'Produtos'),
      soon('/gestao/estoque', 'Estoque e compras'),
    ],
  },
  {
    key: 'produtividade',
    label: 'Produtividade',
    icon: 'calendar',
    group: 'modulos',
    submodules: [
      // Everyone opens the Agenda (Eric, 14/10), the sellers included (Eric, 19/10: Agenda and
      // Reuniões in Produtividade, read-only; they schedule from the lead's page).
      {
        path: '/produtividade/agenda',
        label: 'Agenda',
        description: 'A sua agenda Google e a da Wings Company, como no Google Agenda',
        permission: 'calendar.use',
        sellers: true,
        status: 'ready',
        kind: 'crud',
      },
      {
        path: '/produtividade/reunioes',
        label: 'Reuniões',
        description: 'As reuniões marcadas pela ficha do lead, só leitura',
        permission: 'leads.read',
        sellers: true,
        status: 'ready',
        kind: 'report',
      },
      soon('/produtividade/drive', 'Drive'),
    ],
  },
  {
    // A general module: every department has its own tree in it, and the API
    // decides folder by folder what each person sees.
    key: 'drive',
    label: 'Drive',
    icon: 'folder',
    group: 'modulos',
    submodules: [
      {
        path: '/drive/arquivos',
        label: 'Arquivos',
        description: 'Pastas e arquivos por departamento e cliente',
        permission: 'drive.read',
        status: 'ready',
        kind: 'crud',
      },
    ],
  },
  {
    key: 'atendimento',
    label: 'Atendimento',
    icon: 'headset',
    group: 'modulos',
    submodules: [soon('/atendimento/pabx', 'PABX virtual', 'Ramais e gravações')],
  },
  {
    key: 'administracao',
    label: 'Administração',
    icon: 'settings',
    group: 'modulos',
    submodules: [
      {
        path: '/administracao/usuarios',
        label: 'Usuários e acessos',
        permission: 'employees.read',
        status: 'ready',
        kind: 'crud',
      },
      {
        path: '/administracao/roadmap',
        label: 'Roadmap',
        description: 'Progresso do sistema e relatório diário para a diretoria',
        permission: 'roadmap.manage',
        status: 'ready',
        kind: 'crud',
      },
      {
        path: '/administracao/drive',
        label: 'Drive: modelo de pastas',
        description: 'As pastas que todo departamento e todo cliente recebem',
        permission: 'drive.manage',
        status: 'ready',
        kind: 'crud',
      },
      soon('/administracao/configuracoes', 'Configurações', undefined, 'settings.manage'),
      {
        path: '/administracao/integracoes',
        label: 'Integrações',
        description: 'Contas de serviços externos ligadas ao sistema',
        permission: 'integrations.manage',
        status: 'ready',
        kind: 'crud',
      },
      soon(
        '/administracao/apis',
        'APIs e credenciais',
        'Tokens de plataformas e integrações',
        'api_credentials.manage',
      ),
      soon('/administracao/auditoria', 'Auditoria', 'Trilha append-only', 'audit.read'),
      soon(
        '/administracao/notificacoes',
        'Notificações',
        'Canais e destinatários',
        'settings.manage',
      ),
    ],
  },
  {
    key: 'saas',
    label: 'SaaS',
    icon: 'globe',
    group: 'modulos',
    // Platform administration, not tenant administration.
    roles: ['admin_master'],
    submodules: [
      soon('/saas/tenants', 'Tenants'),
      soon('/saas/billing', 'Billing'),
      soon('/saas/onboarding', 'Onboarding'),
    ],
  },
  {
    // Experiments shown to the Admin Master before they become a module.
    key: 'laboratorio',
    label: 'Laboratório',
    icon: 'sparkles',
    group: 'modulos',
    roles: ['admin_master'],
    submodules: [
      {
        path: '/laboratorio/escritorio',
        label: 'Escritório virtual',
        description:
          'A equipe e os agentes no escritório em 3D, com tarefas e eventos reais do CRM',
        permission: 'office.read',
        status: 'ready',
        kind: 'report',
      },
    ],
  },
];

/** Every sub-module, flattened — used to build routes. */
export const ALL_SUBMODULES: readonly (NavSubmodule & {
  moduleKey: string;
  moduleLabel: string;
})[] = NAVIGATION.flatMap((module) =>
  module.submodules.map((submodule) => ({
    ...submodule,
    moduleKey: module.key,
    moduleLabel: module.label,
  })),
);

export interface NavViewer {
  role: RoleKey;
  permissions: Partial<Record<PermissionKey, unknown>>;
}

/** The menu group of every sub-module, by path. */
const GROUP_OF_PATH: ReadonlyMap<string, NavGroup> = new Map(
  NAVIGATION.flatMap((module) =>
    module.submodules.map((submodule) => [submodule.path, module.group] as const),
  ),
);

export function canSeeSubmodule(viewer: NavViewer | null, submodule: NavSubmodule): boolean {
  if (!viewer) return false;
  if (submodule.levels && !submodule.levels.includes(viewer.role)) return false;
  // A seller sees Início, CRM Vendas and what says `sellers`, whatever else the level holds.
  if (
    !submodule.sellers &&
    CRM_ONLY_ROLES.includes(viewer.role) &&
    (GROUP_OF_PATH.get(submodule.path) ?? 'modulos') === 'modulos'
  ) {
    return false;
  }
  if (submodule.status === 'coming_soon' && !viewer.permissions['modules.preview']) return false;
  if (submodule.permission) return Boolean(viewer.permissions[submodule.permission]);
  return submodule.status === 'coming_soon' || submodule.everyone === true;
}

export function canSeeModule(viewer: NavViewer | null, module: NavModule): boolean {
  if (!viewer) return false;
  if (module.roles && !module.roles.includes(viewer.role)) return false;
  return module.submodules.some((submodule) => canSeeSubmodule(viewer, submodule));
}

/** The tree as one viewer sees it: modules and sub-modules they may reach. */
export function visibleNavigation(viewer: NavViewer | null): NavModule[] {
  if (!viewer) return [];
  return NAVIGATION.filter((module) => canSeeModule(viewer, module)).map((module) => ({
    ...module,
    submodules: module.submodules.filter((submodule) => canSeeSubmodule(viewer, submodule)),
  }));
}

/** Which module a path belongs to, for expanding the right menu section. */
export function moduleKeyForPath(path: string): string | null {
  const match = NAVIGATION.find((module) =>
    module.submodules.some((submodule) => path.startsWith(submodule.path)),
  );
  return match?.key ?? null;
}

/**
 * Paths that moved in Phase 0, kept as redirects.
 *
 * The WhatsApp approval link points at the old approvals path, and messages
 * already sent cannot be edited — a 404 there once cost us a stage.
 */
export const LEGACY_REDIRECTS: readonly { from: string; to: string }[] = [
  { from: '/trafego-pago', to: '/dashboard/marketing' },
  { from: '/trafego-pago/aprovacoes', to: '/marketing/trafego-pago-wings/aprovacoes' },
  { from: '/funcionarios', to: '/administracao/usuarios' },
  { from: '/ponto', to: '/gestao/rh-dp' },
  { from: '/configuracoes', to: '/administracao/configuracoes' },
  // Clientes moved from Administração to Formatação on 2026-09-30 (Eric).
  { from: '/administracao/clientes', to: '/formatacao/clientes' },
  // CRM Vendas redesigned on 2026-10-05 (Eric): Funil became Negociações, settings moved into the module.
  { from: '/crm-vendas/funil', to: '/crm-vendas/negociacoes' },
  { from: '/administracao/crm', to: '/crm-vendas/configuracoes' },
  // The sellers' Agenda moved to Produtividade on 2026-10-19 (Eric).
  { from: '/crm-vendas/agenda', to: '/produtividade/agenda' },
];

/** Where a signed-in user lands: the first sub-module they can actually open. */
export function defaultPathFor(viewer: NavViewer | null): string {
  for (const module of visibleNavigation(viewer)) {
    const ready = module.submodules.find((submodule) => submodule.status === 'ready');
    if (ready) return ready.path;
  }
  return '/sem-acesso';
}
