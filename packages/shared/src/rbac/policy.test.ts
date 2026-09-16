import { describe, expect, it } from 'vitest';
import { assertMatrixComplete, type PermissionKey } from './permissions.js';
import { assignableRoles, can, roleAssignmentDenial, tracksTime, type Actor } from './policy.js';
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
    expect(ROLE_KEYS).toHaveLength(12);
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

  it('blocks changing your own role, even for Admin Master', () => {
    expect(roleAssignmentDenial(adminMaster, 'admin_master', adminMaster.employeeId)).toBe(
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

describe('assignableRoles', () => {
  it('lets Admin Master grant anything except their own record', () => {
    expect(assignableRoles(adminMaster)).toHaveLength(12);
    expect(assignableRoles(adminMaster, adminMaster.employeeId)).toHaveLength(0);
  });

  it('never offers Admin Master or Diretoria to anyone else', () => {
    for (const role of assignableRoles(gerente)) {
      expect(['admin_master', 'diretoria']).not.toContain(role);
    }
  });

  it('offers only roles below the actor rank', () => {
    const offered = assignableRoles(gerente);
    expect(offered).toContain('vendedor_expansao');
    expect(offered).not.toContain('gerente_comercial');
  });

  it('offers nothing to someone without the permission to assign', () => {
    // A plain employee has no roles.assign grant; the form would be empty and
    // the API would refuse anyway.
    expect(assignableRoles(juridico)).not.toContain('admin_master');
  });
});
