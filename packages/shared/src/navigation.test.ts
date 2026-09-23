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
  type NavViewer,
} from './navigation.js';

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
      if (submodule.status === 'ready') expect(submodule.permission).toBeTruthy();
    }
  });

  it('carries the modules the business asked for, in order', () => {
    expect(NAVIGATION.map((module) => module.label)).toEqual([
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
    expect(canSeeModule(adminMaster, saas)).toBe(true);
    expect(canSeeModule(marketing, saas)).toBe(false);
    // Even a role holding every permission is not the platform operator.
    expect(canSeeModule(viewer('diretoria', { 'ads.read': 'all' }), saas)).toBe(false);
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
    // Marketing reaches the traffic studio; Admin Master can open the Funil,
    // which sits earlier in the tree, so that is where it lands.
    expect(defaultPathFor(marketing)).toBe('/marketing/trafego-pago-wings');
    expect(defaultPathFor(adminMaster)).toBe('/crm-vendas/funil');
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
