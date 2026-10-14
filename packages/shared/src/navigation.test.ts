import { describe, expect, it } from 'vitest';
import {
  ALL_SUBMODULES,
  canSeeModule,
  canSeeSubmodule,
  defaultPathFor,
  LEGACY_REDIRECTS,
  moduleKeyForPath,
  NAVIGATION,
  visibleNavigation,
  type NavSubmodule,
  type NavViewer,
} from './navigation.js';
import { ROLE_PERMISSIONS } from './rbac/permissions.js';
import { ROLE_KEYS, type RoleKey } from './rbac/roles.js';

/**
 * The navigation tree is the single declaration behind the sidebar, the routes
 * and who may reach what. These tests guard the properties that would let a
 * screen leak: a path with no module, a permissioned sub-module visible to
 * someone without it, or a menu entry that goes nowhere.
 */

const viewer = (role: NavViewer['role'], permissions: Record<string, string>): NavViewer => ({
  role,
  permissions: permissions as NavViewer['permissions'],
});

const adminMaster = viewer('admin_master', {
  'employees.read': 'all',
  'ads.read': 'all',
  'ads.approve': 'all',
  'leads.read': 'all',
  'timeclock.read': 'all',
  'settings.manage': 'all',
  'api_credentials.manage': 'all',
  'audit.read': 'all',
});
const marketing = viewer('marketing', { 'ads.read': 'all' });
const salesperson = viewer('vendedor_expansao', { 'leads.read': 'own' });

describe('the tree itself', () => {
  it('gives every sub-module an absolute path under its module', () => {
    for (const submodule of ALL_SUBMODULES) {
      expect(submodule.path.startsWith('/')).toBe(true);
      expect(moduleKeyForPath(submodule.path)).toBe(submodule.moduleKey);
    }
  });

  it('has no duplicate paths', () => {
    const paths = ALL_SUBMODULES.map((submodule) => submodule.path);
    expect(new Set(paths).size).toBe(paths.length);
  });

  it('requires a permission on everything that is actually built', () => {
    // A ready screen has a backend, so it must be gated. Placeholders have
    // nothing to protect yet.
    for (const submodule of ALL_SUBMODULES) {
      // Início has nothing of its own to protect: it only lists what the
      // viewer may already open, so it says `everyone` instead.
      if (submodule.everyone) {
        expect(submodule.path).toBe('/inicio');
        continue;
      }
      if (submodule.status === 'ready') expect(submodule.permission).toBeTruthy();
    }
  });

  it('carries the modules the business asked for, in order', () => {
    expect(NAVIGATION.map((module) => module.label)).toEqual([
      'Início',
      'CRM Vendas',
      'Contratos',
      'Formatação',
      'Marketing',
      'Dashboard',
      'Gestão',
      'Produtividade',
      'Drive',
      'Atendimento',
      'Administração',
      'SaaS',
      'Laboratório',
    ]);
  });
});

describe('who sees what', () => {
  it('hides a sub-module whose permission the viewer lacks', () => {
    const employees = ALL_SUBMODULES.find((s) => s.path === '/administracao/usuarios');
    if (!employees) throw new Error('missing');
    expect(canSeeSubmodule(adminMaster, employees)).toBe(true);
    expect(canSeeSubmodule(marketing, employees)).toBe(false);
  });

  it('keeps the traffic agent for those who hold ads.read', () => {
    const studio = ALL_SUBMODULES.find((s) => s.path === '/marketing/trafego-pago-wings');
    if (!studio) throw new Error('missing');
    expect(canSeeSubmodule(marketing, studio)).toBe(true);
    expect(canSeeSubmodule(salesperson, studio)).toBe(false);
  });

  it('shows SaaS only to Admin Master, whatever their permissions', () => {
    const saas = NAVIGATION.find((module) => module.key === 'saas');
    if (!saas) throw new Error('missing');
    // SaaS has only placeholders, which also need `modules.preview`.
    expect(canSeeModule(viewer('admin_master', { 'modules.preview': 'all' }), saas)).toBe(true);
    expect(canSeeModule(marketing, saas)).toBe(false);
    // Even a role holding every permission is not the platform operator.
    expect(
      canSeeModule(viewer('diretoria', { 'ads.read': 'all', 'modules.preview': 'all' }), saas),
    ).toBe(false);
  });

  it('drops a module entirely when none of its sub-modules are reachable', () => {
    const modules = visibleNavigation(marketing).map((module) => module.key);
    expect(modules).toContain('marketing');
    expect(modules).not.toContain('administracao'); // no employees.read
    expect(modules).not.toContain('saas');
  });

  it('shows nothing at all to an anonymous viewer', () => {
    expect(visibleNavigation(null)).toEqual([]);
  });

  it('never lists a sub-module the viewer cannot open', () => {
    for (const person of [adminMaster, marketing, salesperson]) {
      for (const module of visibleNavigation(person)) {
        for (const submodule of module.submodules) {
          expect(canSeeSubmodule(person, submodule)).toBe(true);
        }
      }
    }
  });
});

describe('where a viewer lands', () => {
  it('opens on the first screen that actually exists for them', () => {
    // Início is open to every login and sits first in the tree, so everyone
    // lands there; the first module screen is one click away.
    expect(defaultPathFor(marketing)).toBe('/inicio');
    expect(defaultPathFor(adminMaster)).toBe('/inicio');
  });

  it('never lands on a placeholder', () => {
    const landing = defaultPathFor(salesperson);
    const target = ALL_SUBMODULES.find((submodule) => submodule.path === landing);
    expect(target?.status ?? 'none').not.toBe('coming_soon');
  });
});

describe('screens that moved', () => {
  it('redirects every old path into a sub-module that exists in the tree', () => {
    // A target may be a sub-module or a screen nested under one, such as the
    // approvals list inside the traffic studio.
    for (const redirect of LEGACY_REDIRECTS) {
      const covered = ALL_SUBMODULES.some((submodule) => redirect.to.startsWith(submodule.path));
      expect(covered, `${redirect.from} -> ${redirect.to}`).toBe(true);
    }
  });

  it('keeps every administrative placeholder behind a permission', () => {
    // Otherwise the whole module surfaces to anyone, which is how "Administração"
    // first appeared for a marketing user.
    const admin = NAVIGATION.find((module) => module.key === 'administracao');
    for (const submodule of admin?.submodules ?? []) {
      expect(submodule.permission, submodule.label).toBeTruthy();
    }
  });

  it('keeps the WhatsApp approval link working', () => {
    // Messages already sent cannot be edited, and a 404 here cost us a stage.
    const approvals = LEGACY_REDIRECTS.find((r) => r.from === '/trafego-pago/aprovacoes');
    expect(approvals?.to).toBe('/marketing/trafego-pago-wings/aprovacoes');
  });
});

/**
 * The menu each level gets from the real matrix (Eric, 13/10). A seller who saw
 * the whole system on staging is what this pins down.
 */
describe('menu by access level', () => {
  const asRole = (role: RoleKey): NavViewer => ({ role, permissions: ROLE_PERMISSIONS[role] });
  const menuOf = (role: RoleKey) =>
    Object.fromEntries(
      visibleNavigation(asRole(role)).map((module) => [
        module.key,
        module.submodules.map((submodule) => submodule.path),
      ]),
    );

  // Eric, 14/10: a seller's whole menu is CRM Vendas. No Empresas, Landing pages, Drive, Dashboard
  // or Gestão; Painel de Vendas, Projetos and the Agenda sit inside the CRM for them.
  it('gives a Vendedor Expansão only the CRM of their own leads', () => {
    expect(menuOf('vendedor_expansao')).toEqual({
      inicio: ['/inicio'],
      'crm-vendas': [
        '/crm-vendas/negociacoes',
        '/crm-vendas/whatsapp',
        '/crm-vendas/contatos',
        '/crm-vendas/tarefas',
        '/crm-vendas/avisos',
        '/crm-vendas/painel-de-vendas',
        '/crm-vendas/projetos',
        '/crm-vendas/agenda',
      ],
    });
  });

  it('adds Leads das Campanhas inside the CRM for a Vendedor Formatação, and nothing more', () => {
    expect(menuOf('vendedor_formatacao')).toEqual({
      inicio: ['/inicio'],
      'crm-vendas': [
        '/crm-vendas/negociacoes',
        '/crm-vendas/whatsapp',
        '/crm-vendas/contatos',
        '/crm-vendas/tarefas',
        '/crm-vendas/avisos',
        '/crm-vendas/painel-de-vendas',
        '/crm-vendas/projetos',
        '/crm-vendas/agenda',
        '/crm-vendas/leads-campanhas',
      ],
    });
  });

  it("closes a seller's typed address outside the CRM, though the level holds its permission", () => {
    const seller = asRole('vendedor_formatacao');
    for (const path of ['/dashboard/vendas', '/dashboard/leads-campanhas', '/gestao/projetos']) {
      const screen = ALL_SUBMODULES.find((s) => s.path === path)!;
      expect(canSeeSubmodule(seller, screen), path).toBe(false);
    }
  });

  it('keeps the CRM copies to the sellers: every other level sees the screens where they were', () => {
    const copies = [
      '/crm-vendas/painel-de-vendas',
      '/crm-vendas/projetos',
      '/crm-vendas/agenda',
      '/crm-vendas/leads-campanhas',
    ];
    for (const role of ROLE_KEYS) {
      const seen = Object.values(menuOf(role)).flat();
      const seller = role === 'vendedor_expansao' || role === 'vendedor_formatacao';
      expect(
        seen.some((path) => copies.includes(path)),
        role,
      ).toBe(seller);
    }
    expect(menuOf('gerente_comercial').dashboard).toEqual([
      '/dashboard/vendas',
      '/dashboard/leads-campanhas',
    ]);
    expect(menuOf('gerente_comercial')['crm-vendas']).toEqual([
      '/crm-vendas/negociacoes',
      '/crm-vendas/whatsapp',
      '/crm-vendas/contatos',
      '/crm-vendas/empresas',
      '/crm-vendas/tarefas',
      '/crm-vendas/avisos',
      '/crm-vendas/configuracoes',
      '/crm-vendas/landing-pages',
      '/crm-vendas/sofia',
    ]);
  });

  it('keeps the Sofia screen to Gerente Comercial, Diretoria and Admin Master', () => {
    const withSofia = ROLE_KEYS.filter((role) =>
      Object.values(menuOf(role)).some((paths) => paths.includes('/crm-vendas/sofia')),
    );
    expect(withSofia.sort()).toEqual(['admin_master', 'diretoria', 'gerente_comercial']);
  });

  it('shows "em breve" placeholders only to Admin Master and Diretoria', () => {
    const placeholders = new Set(
      ALL_SUBMODULES.filter((s) => s.status === 'coming_soon').map((s) => s.path),
    );
    for (const role of ROLE_KEYS) {
      const seen = Object.values(menuOf(role)).flat();
      const anySoon = seen.some((path) => placeholders.has(path));
      expect(anySoon, role).toBe(role === 'admin_master' || role === 'diretoria');
    }
  });

  it('keeps Configurações and APIs to the Admin Master alone', () => {
    for (const role of ROLE_KEYS) {
      const seen = Object.values(menuOf(role)).flat();
      const sees =
        seen.includes('/administracao/configuracoes') || seen.includes('/administracao/apis');
      expect(sees, role).toBe(role === 'admin_master');
    }
  });

  it('opens Usuários e acessos only to who runs people', () => {
    const withRegister = ROLE_KEYS.filter((role) =>
      Object.values(menuOf(role)).some((paths) => paths.includes('/administracao/usuarios')),
    );
    expect(withRegister.sort()).toEqual([
      'admin_master',
      'diretoria',
      'gerente_comercial',
      'rh_dp',
    ]);
  });

  it('never shows a built screen without a permission behind it', () => {
    const bare: NavSubmodule = { path: '/x', label: 'X', status: 'ready', kind: 'crud' };
    expect(canSeeSubmodule(asRole('admin_master'), bare)).toBe(false);
  });
});
