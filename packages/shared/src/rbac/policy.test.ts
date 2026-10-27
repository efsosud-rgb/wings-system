import { describe, expect, it } from 'vitest';
import { assertMatrixComplete, type PermissionKey } from './permissions.js';
import {
  assignableRoles,
  can,
  loginEmailChangeDenial,
  roleAssignmentDenial,
  roleChangeDenial,
  roleFieldState,
  statusChangeDenial,
  tracksTime,
  type Actor,
} from './policy.js';
import { ROLE_KEYS, type RoleKey } from './roles.js';
import type { SectorSlug } from './sectors.js';

function actor(
  role: RoleKey,
  sector: SectorSlug,
  opts: { id?: string; manager?: boolean } = {},
): Actor {
  return {
    employeeId: opts.id ?? `emp-${role}`,
    role,
    sector,
    isSectorManager: opts.manager ?? false,
  };
}

const adminMaster = actor('admin_master', 'diretoria');
const diretor = actor('diretoria', 'diretoria');
const gerente = actor('gerente_comercial', 'comercial');
const vendedor = actor('vendedor_expansao', 'comercial', { id: 'emp-vend-1' });
const ti = actor('formatacao_ti', 'formatacao-ti');
const marketingManager = actor('marketing', 'marketing', { id: 'emp-mkt-mgr', manager: true });
const juridico = actor('formatacao_juridico', 'formatacao-juridico');

describe('permission matrix', () => {
  it('covers every role', () => {
    expect(() => assertMatrixComplete()).not.toThrow();
    expect(ROLE_KEYS).toHaveLength(13);
  });
});

describe('Diretoria is fully blocked from the TI sector', () => {
  const tiTarget = { sector: 'formatacao-ti' as SectorSlug };

  it.each<PermissionKey>(['employees.read', 'employees.pii.view', 'timeclock.read'])(
    'denies %s on a TI employee record',
    (permission) => {
      const decision = can(diretor, permission, tiTarget);
      expect(decision).toEqual({ allowed: false, reason: 'diretoria_ti_block' });
    },
  );

  it('still allows Diretoria on other sectors', () => {
    expect(can(diretor, 'employees.read', { sector: 'comercial' }).allowed).toBe(true);
  });

  it('does not block Admin Master from TI', () => {
    expect(can(adminMaster, 'employees.read', tiTarget).allowed).toBe(true);
  });

  it('does not leak TI access through the sector-manager flag', () => {
    const diretorManager = { ...diretor, isSectorManager: true };
    expect(can(diretorManager, 'employees.update', tiTarget)).toEqual({
      allowed: false,
      reason: 'diretoria_ti_block',
    });
  });
});

describe('Diretoria has no settings or API credential access', () => {
  it.each<PermissionKey>(['settings.manage', 'api_credentials.manage'])('denies %s', (p) => {
    expect(can(diretor, p)).toEqual({ allowed: false, reason: 'no_permission' });
  });

  it('grants both to Admin Master and TI', () => {
    expect(can(adminMaster, 'settings.manage').allowed).toBe(true);
    expect(can(ti, 'api_credentials.manage').allowed).toBe(true);
  });
});

describe('lead scoping', () => {
  it('lets a vendedor read only their own leads', () => {
    expect(can(vendedor, 'leads.read', { ownerEmployeeId: 'emp-vend-1' }).allowed).toBe(true);
    expect(can(vendedor, 'leads.read', { ownerEmployeeId: 'emp-vend-2' })).toEqual({
      allowed: false,
      reason: 'out_of_scope',
    });
  });

  it('lets the gerente comercial see the whole funnel', () => {
    expect(can(gerente, 'leads.read', { ownerEmployeeId: 'emp-vend-2' })).toEqual({
      allowed: true,
      scope: 'all',
    });
  });
});

describe('sector managers', () => {
  it('may create employees inside their own sector', () => {
    expect(can(marketingManager, 'employees.create', { sector: 'marketing' }).allowed).toBe(true);
  });

  it('may not create employees in another sector', () => {
    expect(can(marketingManager, 'employees.create', { sector: 'comercial' })).toEqual({
      allowed: false,
      reason: 'out_of_scope',
    });
  });

  it('does not grant the flag to ordinary staff', () => {
    expect(can(juridico, 'employees.create', { sector: 'formatacao-juridico' })).toEqual({
      allowed: false,
      reason: 'no_permission',
    });
  });

  it('covers sub-sectors when managing a parent sector', () => {
    const formatacaoManager = actor('formatacao_financeiro', 'formatacao', { manager: true });
    expect(
      can(formatacaoManager, 'employees.update', { sector: 'formatacao-logistica' }).allowed,
    ).toBe(true);
  });
});

describe('privilege escalation guards', () => {
  it('blocks granting Admin Master or Diretoria unless Admin Master', () => {
    expect(roleAssignmentDenial(gerente, 'admin_master')).toBe('protected_role');
    expect(roleAssignmentDenial(marketingManager, 'diretoria')).toBe('protected_role');
    expect(roleAssignmentDenial(adminMaster, 'admin_master')).toBeNull();
  });

  it('blocks granting a role at or above the actor rank', () => {
    expect(roleAssignmentDenial(gerente, 'gerente_comercial')).toBe('role_rank_too_high');
    expect(roleAssignmentDenial(gerente, 'vendedor_expansao')).toBeNull();
  });

  it('blocks a manager changing their own role', () => {
    expect(roleAssignmentDenial(gerente, 'vendedor_expansao', gerente.employeeId)).toBe(
      'self_role_change',
    );
  });

  it('applies the guards through can()', () => {
    const decision = can(gerente, 'roles.assign', {
      sector: 'comercial',
      role: 'admin_master',
      ownerEmployeeId: 'emp-x',
    });
    expect(decision).toEqual({ allowed: false, reason: 'protected_role' });
  });
});

describe('time tracking exemptions', () => {
  it('exempts Admin Master and Diretoria only', () => {
    const exempt = ROLE_KEYS.filter((role) => !tracksTime(role));
    expect(exempt).toEqual(['admin_master', 'diretoria']);
  });
});

const rhDp = actor('rh_dp', 'diretoria', { id: 'emp-rh-1' });
const seller = {
  employeeId: 'emp-vend-9',
  sector: 'comercial',
  currentRole: 'vendedor_expansao',
} as const;

describe('RH / DP', () => {
  it('runs the employee register and sees the RH/DP module', () => {
    for (const permission of ['employees.read', 'employees.create', 'employees.update'] as const) {
      expect(can(rhDp, permission, { sector: 'marketing' }).allowed).toBe(true);
    }
    expect(can(rhDp, 'timeclock.read').allowed).toBe(true);
    expect(can(rhDp, 'employees.pii.view').allowed).toBe(false);
    expect(can(rhDp, 'ads.approve').allowed).toBe(false);
  });
});

describe('roleChangeDenial — holders of employees.assign_roles', () => {
  it('lets RH/DP change a seller, in any sector', () => {
    expect(roleChangeDenial(rhDp, seller, 'gerente_comercial')).toBeNull();
  });

  it('leaves Diretoria to Diretoria and Admin Master: RH/DP neither grants nor removes it', () => {
    const aDirector = {
      employeeId: 'emp-dir-2',
      sector: 'diretoria',
      currentRole: 'diretoria',
    } as const;
    expect(roleChangeDenial(rhDp, seller, 'diretoria')).toBe('diretoria_level');
    expect(roleChangeDenial(rhDp, { sector: 'diretoria' }, 'diretoria')).toBe('diretoria_level');
    expect(roleChangeDenial(rhDp, aDirector, 'marketing')).toBe('diretoria_level');
    expect(roleFieldState(rhDp, aDirector)).toEqual({
      options: ['diretoria'],
      locked: 'diretoria_level',
    });

    expect(roleChangeDenial(diretor, seller, 'diretoria')).toBeNull();
    expect(roleChangeDenial(diretor, aDirector, 'marketing')).toBeNull();
    expect(roleChangeDenial(adminMaster, aDirector, 'marketing')).toBeNull();
  });

  it('never lets Diretoria or RH/DP grant Admin Master', () => {
    expect(roleChangeDenial(diretor, seller, 'admin_master')).toBe('protected_role');
    expect(roleChangeDenial(rhDp, seller, 'admin_master')).toBe('protected_role');
    expect(roleChangeDenial(rhDp, { sector: 'comercial' }, 'admin_master')).toBe('protected_role');
  });

  it('never lets them take Admin Master away, or touch that record at all', () => {
    const anAdmin = {
      employeeId: 'emp-adm-2',
      sector: 'diretoria',
      currentRole: 'admin_master',
    } as const;
    expect(roleChangeDenial(diretor, anAdmin, 'diretoria')).toBe('admin_master_record');
    expect(roleChangeDenial(rhDp, anAdmin, 'vendedor_expansao')).toBe('admin_master_record');
  });

  it('blocks Diretoria changing their own level', () => {
    const self = {
      employeeId: diretor.employeeId,
      sector: 'diretoria',
      currentRole: 'diretoria',
    } as const;
    expect(roleChangeDenial(diretor, self, 'rh_dp')).toBe('self_role_change');
  });

  it('keeps Diretoria out of TI', () => {
    const tiEmployee = {
      employeeId: 'emp-ti-9',
      sector: 'formatacao-ti',
      currentRole: 'formatacao_ti',
    } as const;
    expect(roleChangeDenial(diretor, tiEmployee, 'marketing')).toBe('diretoria_ti_block');
    expect(roleChangeDenial(rhDp, tiEmployee, 'marketing')).toBeNull();
  });
});

describe('roleChangeDenial — Admin Master', () => {
  const self = {
    employeeId: adminMaster.employeeId,
    sector: 'diretoria',
    currentRole: 'admin_master',
  } as const;

  it('may change anyone, themselves included', () => {
    expect(roleChangeDenial(adminMaster, seller, 'admin_master')).toBeNull();
    expect(roleChangeDenial(adminMaster, self, 'diretoria')).toBeNull();
  });

  it('cannot demote the last Admin Master, whoever that is', () => {
    expect(
      roleChangeDenial(adminMaster, { ...self, isLastActiveAdminMaster: true }, 'diretoria'),
    ).toBe('last_admin_master');
    const other = {
      employeeId: 'emp-adm-2',
      sector: 'diretoria',
      currentRole: 'admin_master',
      isLastActiveAdminMaster: true,
    } as const;
    expect(roleChangeDenial(adminMaster, other, 'rh_dp')).toBe('last_admin_master');
  });
});

describe('roleChangeDenial — sector managers', () => {
  it('stays inside the sector and below the manager rank', () => {
    expect(roleChangeDenial(gerente, seller, 'vendedor_formatacao')).toBeNull();
    expect(roleChangeDenial(gerente, seller, 'gerente_comercial')).toBe('role_rank_too_high');
    expect(roleChangeDenial(gerente, seller, 'rh_dp')).toBe('role_rank_too_high');
    expect(roleChangeDenial(gerente, seller, 'diretoria')).toBe('diretoria_level');
    expect(
      roleChangeDenial(gerente, { ...seller, sector: 'marketing' }, 'vendedor_formatacao'),
    ).toBe('out_of_scope');
  });

  it('never touches the level of a colleague at or above their own (2026-10-13)', () => {
    const otherGerente = {
      employeeId: 'emp-ger-2',
      sector: 'comercial',
      currentRole: 'gerente_comercial',
    } as const;
    expect(roleChangeDenial(gerente, otherGerente, 'vendedor_expansao')).toBe('role_rank_too_high');
    const formatacaoManager = actor('formatacao_financeiro', 'formatacao', { manager: true });
    const tiPeer = {
      employeeId: 'emp-ti-9',
      sector: 'formatacao-ti',
      currentRole: 'formatacao_ti',
    } as const;
    expect(roleChangeDenial(formatacaoManager, tiPeer, 'vendedor_formatacao')).toBe(
      'role_rank_too_high',
    );
    expect(roleFieldState(gerente, otherGerente)).toEqual({
      options: ['gerente_comercial'],
      locked: 'role_rank_too_high',
    });
  });

  it('gives nothing to someone with no grant at all', () => {
    expect(roleChangeDenial(juridico, seller, 'vendedor_formatacao')).toBe('no_permission');
  });
});

describe('loginEmailChangeDenial — who may re-point a login', () => {
  const director = {
    employeeId: 'emp-dir-2',
    sector: 'diretoria',
    currentRole: 'diretoria',
  } as const;
  const tiPeer = {
    employeeId: 'emp-ti-9',
    sector: 'formatacao-ti',
    currentRole: 'formatacao_ti',
  } as const;
  const otherGerente = {
    employeeId: 'emp-ger-2',
    sector: 'comercial',
    currentRole: 'gerente_comercial',
  } as const;
  const anAdmin = {
    employeeId: 'emp-adm-2',
    sector: 'diretoria',
    currentRole: 'admin_master',
  } as const;
  const formatacaoManager = actor('formatacao_financeiro', 'formatacao', {
    id: 'emp-fmt-mgr',
    manager: true,
  });

  it('stops RH/DP on a director, the account takeover found by the audit', () => {
    expect(loginEmailChangeDenial(rhDp, director)).toBe('diretoria_level');
  });

  it('stops a manager on a colleague of equal or higher level in their sector', () => {
    // Nor demote that colleague first, which would then open the login.
    expect(roleChangeDenial(formatacaoManager, tiPeer, 'vendedor_formatacao')).toBe(
      'role_rank_too_high',
    );
    expect(loginEmailChangeDenial(formatacaoManager, tiPeer)).toBe('role_rank_too_high');
    expect(loginEmailChangeDenial(gerente, otherGerente)).toBe('role_rank_too_high');
    const mktPeer = {
      employeeId: 'emp-mkt-2',
      sector: 'marketing',
      currentRole: 'marketing',
    } as const;
    expect(loginEmailChangeDenial(marketingManager, mktPeer)).toBe('role_rank_too_high');
  });

  it('stops anyone but an Admin Master on their own login, and on an Admin Master', () => {
    const own = { employeeId: rhDp.employeeId, sector: 'diretoria', currentRole: 'rh_dp' } as const;
    expect(loginEmailChangeDenial(rhDp, own)).toBe('self_role_change');
    const gerenteSelf = {
      employeeId: gerente.employeeId,
      sector: 'comercial',
      currentRole: 'gerente_comercial',
    } as const;
    expect(loginEmailChangeDenial(gerente, gerenteSelf)).toBe('self_role_change');
    expect(loginEmailChangeDenial(rhDp, anAdmin)).toBe('admin_master_record');
  });

  it('needs the right to edit the record at all', () => {
    // Diretoria may change a level but not the rest of a record.
    expect(loginEmailChangeDenial(diretor, seller)).toBe('no_permission');
    expect(loginEmailChangeDenial(diretor, tiPeer)).toBe('diretoria_ti_block');
    expect(loginEmailChangeDenial(juridico, seller)).toBe('no_permission');
    expect(loginEmailChangeDenial(gerente, { ...seller, sector: 'marketing' })).toBe(
      'out_of_scope',
    );
  });

  it('keeps the allowed paths: RH/DP below Diretoria, a manager below their rank, Admin Master on anyone', () => {
    expect(loginEmailChangeDenial(rhDp, seller)).toBeNull();
    expect(loginEmailChangeDenial(rhDp, tiPeer)).toBeNull();
    expect(loginEmailChangeDenial(gerente, seller)).toBeNull();
    expect(
      loginEmailChangeDenial(formatacaoManager, { ...tiPeer, currentRole: 'vendedor_formatacao' }),
    ).toBeNull();
    expect(loginEmailChangeDenial(adminMaster, director)).toBeNull();
    expect(loginEmailChangeDenial(adminMaster, anAdmin)).toBeNull();
    const lastAdminSelf = {
      employeeId: adminMaster.employeeId,
      sector: 'diretoria',
      currentRole: 'admin_master',
      isLastActiveAdminMaster: true,
    } as const;
    expect(loginEmailChangeDenial(adminMaster, lastAdminSelf)).toBeNull();
  });
});

describe('statusChangeDenial — switching someone off or back on', () => {
  const comercial = { sector: 'comercial' } as const;

  it('needs employees.deactivate, which the Gerente Comercial does not hold', () => {
    expect(statusChangeDenial(gerente, comercial, 'active', 'inactive')).toBe('no_permission');
    expect(statusChangeDenial(gerente, comercial, 'inactive', 'active')).toBe('no_permission');
    expect(statusChangeDenial(gerente, comercial, 'on_leave', 'inactive')).toBe('no_permission');
  });

  it('leaves active and on leave as an ordinary edit', () => {
    expect(statusChangeDenial(gerente, comercial, 'active', 'on_leave')).toBeNull();
    expect(statusChangeDenial(gerente, comercial, 'on_leave', 'active')).toBeNull();
    expect(statusChangeDenial(gerente, comercial, 'inactive', 'inactive')).toBeNull();
  });

  it('lets RH/DP, Admin Master and a flagged manager in their sector do it', () => {
    expect(statusChangeDenial(rhDp, comercial, 'active', 'inactive')).toBeNull();
    expect(statusChangeDenial(adminMaster, comercial, 'inactive', 'active')).toBeNull();
    const flagged = actor('gerente_comercial', 'comercial', { id: 'emp-ger-mgr', manager: true });
    expect(statusChangeDenial(flagged, comercial, 'active', 'inactive')).toBeNull();
    expect(statusChangeDenial(marketingManager, comercial, 'active', 'inactive')).toBe(
      'out_of_scope',
    );
  });
});

describe('roleFieldState', () => {
  it('always offers the current level, so saving without changing it works', () => {
    const self = {
      employeeId: gerente.employeeId,
      sector: 'comercial',
      currentRole: 'gerente_comercial',
    } as const;
    expect(roleFieldState(gerente, self)).toEqual({
      options: ['gerente_comercial'],
      locked: 'self_role_change',
    });
    expect(roleFieldState(juridico, seller)).toEqual({
      options: ['vendedor_expansao'],
      locked: 'no_permission',
    });
  });

  it('locks the last Admin Master on Admin Master', () => {
    const self = {
      employeeId: adminMaster.employeeId,
      sector: 'diretoria',
      currentRole: 'admin_master',
      isLastActiveAdminMaster: true,
    } as const;
    expect(roleFieldState(adminMaster, self)).toEqual({
      options: ['admin_master'],
      locked: 'last_admin_master',
    });
  });

  it('offers RH/DP everything but Admin Master and Diretoria', () => {
    const state = roleFieldState(rhDp, seller);
    expect(state.locked).toBeNull();
    expect(state.options).toHaveLength(11);
    expect(state.options).not.toContain('admin_master');
    expect(state.options).not.toContain('diretoria');
  });
});

describe('assignableRoles', () => {
  it('lets Admin Master grant anything on a new record', () => {
    expect(assignableRoles(adminMaster)).toHaveLength(13);
  });

  it('never offers Admin Master or Diretoria to a manager', () => {
    for (const role of assignableRoles(gerente, { sector: 'comercial' })) {
      expect(['admin_master', 'diretoria']).not.toContain(role);
    }
  });

  it('offers a manager only roles below their rank', () => {
    const offered = assignableRoles(gerente, { sector: 'comercial' });
    expect(offered).toContain('vendedor_expansao');
    expect(offered).not.toContain('gerente_comercial');
  });

  it('offers nothing to someone without the permission to assign', () => {
    expect(assignableRoles(juridico)).toEqual([]);
  });
});
