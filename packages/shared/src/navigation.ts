import type { PermissionKey } from './rbac/permissions.js';
import type { RoleKey } from './rbac/roles.js';

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

export interface NavSubmodule {
  /** Full path, always absolute. */
  path: string;
  label: string;
  /**
   * Permission required to see and open it. When absent, the sub-module is a
   * placeholder visible to anyone who can see its module — there is no backend
   * to protect yet, and inventing a permission matrix for unbuilt modules
   * would be a business decision, not navigation.
   */
  permission?: PermissionKey;
  status: SubmoduleStatus;
  kind: SubmoduleKind;
  /** Shown on the placeholder so it is obvious what will live there. */
  description?: string;
}

export interface NavModule {
  key: string;
  label: string;
  icon: string;
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
    key: 'crm-vendas',
    label: 'CRM Vendas',
    icon: '🎯',
    submodules: [
      {
        path: '/crm-vendas/funil',
        label: 'Funil',
        description: 'Leads captados, de onde vieram e o que a pesquisa encontrou',
        permission: 'leads.read',
        status: 'ready',
        kind: 'crud',
      },
      soon('/crm-vendas/sofia', 'Sofia (SDR IA)', 'Agente de pré-venda'),
      soon('/crm-vendas/clientes', 'Clientes', 'Base de clientes e histórico', 'leads.read'),
    ],
  },
  {
    key: 'contratos',
    label: 'Contratos',
    icon: '📄',
    submodules: [
      soon('/contratos/cof', 'COF', 'Circular de Oferta de Franquia'),
      soon('/contratos/franquia', 'Contratos de franquia', 'Emissão e assinatura'),
      soon('/contratos/renovacoes', 'Renovações e prazos', 'Vencimentos e aditivos'),
    ],
  },
  {
    key: 'formatacao',
    label: 'Formatação',
    icon: '🏗️',
    submodules: [
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
    icon: '🚀',
    submodules: [
      {
        path: '/marketing/trafego-pago-wings',
        label: 'Agente de Tráfego Pago — Wings',
        permission: 'ads.read',
        status: 'ready',
        kind: 'studio',
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
    icon: '📊',
    submodules: [
      soon('/dashboard/vendas', 'Vendas', 'Resultado comercial consolidado', 'leads.read'),
      {
        path: '/dashboard/marketing',
        label: 'Marketing',
        permission: 'ads.read',
        status: 'ready',
        kind: 'report',
      },
    ],
  },
  {
    key: 'gestao',
    label: 'Gestão',
    icon: '🏢',
    submodules: [
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
    icon: '🗓️',
    submodules: [
      soon('/produtividade/agenda', 'Agenda'),
      soon('/produtividade/reunioes', 'Reuniões'),
      soon('/produtividade/drive', 'Drive'),
    ],
  },
  {
    // A general module: every department has its own tree in it, and the API
    // decides folder by folder what each person sees.
    key: 'drive',
    label: 'Drive',
    icon: '🗂️',
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
    icon: '☎️',
    submodules: [soon('/atendimento/pabx', 'PABX virtual', 'Ramais e gravações')],
  },
  {
    key: 'administracao',
    label: 'Administração',
    icon: '⚙️',
    submodules: [
      {
        path: '/administracao/usuarios',
        label: 'Usuários e acessos',
        permission: 'employees.read',
        status: 'ready',
        kind: 'crud',
      },
      {
        path: '/administracao/clientes',
        label: 'Clientes',
        description: 'Para quem o trabalho é feito',
        permission: 'clients.manage',
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
    icon: '🛰️',
    // Platform administration, not tenant administration.
    roles: ['admin_master'],
    submodules: [
      soon('/saas/tenants', 'Tenants'),
      soon('/saas/billing', 'Billing'),
      soon('/saas/onboarding', 'Onboarding'),
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

export function canSeeSubmodule(viewer: NavViewer | null, submodule: NavSubmodule): boolean {
  if (!viewer) return false;
  if (!submodule.permission) return true;
  return Boolean(viewer.permissions[submodule.permission]);
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
];

/** Where a signed-in user lands: the first sub-module they can actually open. */
export function defaultPathFor(viewer: NavViewer | null): string {
  for (const module of visibleNavigation(viewer)) {
    const ready = module.submodules.find((submodule) => submodule.status === 'ready');
    if (ready) return ready.path;
  }
  return '/sem-acesso';
}
