import { describe, expect, it } from 'vitest';
import { ROLE_KEYS, type RoleKey } from './rbac/roles.js';
import type { Actor } from './rbac/policy.js';
import type { SectorSlug } from './rbac/sectors.js';
import {
  PROJECT_STAGES,
  PROJECT_STAGE_SLOTS,
  nextOpenStage,
  projectCurrentStageSchema,
  projectListQuerySchema,
  projectStageUpdateSchema,
  projectStatusChangeSchema,
  projectStatusEditableBy,
  stageEditableBy,
} from './projects.js';

const actor = (role: RoleKey, sector: SectorSlug = 'diretoria'): Actor => ({
  employeeId: `emp-${role}`,
  role,
  sector,
  isSectorManager: false,
});

describe('who edits what on a client project', () => {
  it('Admin Master, Diretoria and Processos e Projetos set the status and every stage', () => {
    for (const role of ['admin_master', 'diretoria', 'formatacao_processos_projetos'] as const) {
      expect(projectStatusEditableBy(actor(role))).toBe(true);
      for (const stage of PROJECT_STAGES) {
        expect(stageEditableBy(actor(role), stage.department)).toBe(true);
      }
    }
  });

  it('a department sets the progress of its own stage only, and never the status', () => {
    const cases: [RoleKey, string[]][] = [
      ['formatacao_financeiro', ['04']],
      ['formatacao_contabil_tributario', ['04']],
      ['formatacao_juridico', ['06']],
      ['gerente_comercial', ['07']],
      ['vendedor_expansao', ['07']],
      ['vendedor_formatacao', ['07']],
      ['marketing', ['08']],
      ['formatacao_logistica', []],
      ['formatacao_ti', []],
      ['rh_dp', []],
    ];
    for (const [role, slots] of cases) {
      expect(projectStatusEditableBy(actor(role))).toBe(false);
      const editable = PROJECT_STAGES.filter((stage) =>
        stageEditableBy(actor(role), stage.department),
      ).map((stage) => stage.slot);
      expect(editable, role).toEqual(slots);
    }
  });

  it('every role is either a manager or a reader; nobody falls through', () => {
    const covered = new Set<RoleKey>();
    for (const role of ROLE_KEYS) {
      const any = PROJECT_STAGES.some((stage) => stageEditableBy(actor(role), stage.department));
      if (any || projectStatusEditableBy(actor(role))) covered.add(role);
    }
    expect([...covered].sort()).toEqual(
      [
        'admin_master',
        'diretoria',
        'formatacao_processos_projetos',
        'formatacao_financeiro',
        'formatacao_contabil_tributario',
        'formatacao_juridico',
        'gerente_comercial',
        'vendedor_expansao',
        'vendedor_formatacao',
        'marketing',
      ].sort(),
    );
  });
});

describe('the inputs', () => {
  it('Parado and Cancelado need a reason; the others take one or not', () => {
    expect(projectStatusChangeSchema.safeParse({ status: 'parado' }).success).toBe(false);
    expect(projectStatusChangeSchema.safeParse({ status: 'parado', reason: '   ' }).success).toBe(
      false,
    );
    expect(projectStatusChangeSchema.safeParse({ status: 'cancelado' }).success).toBe(false);
    expect(
      projectStatusChangeSchema.safeParse({ status: 'parado', reason: 'Aguardando contrato' }),
    ).toMatchObject({ success: true, data: { status: 'parado', reason: 'Aguardando contrato' } });
    expect(projectStatusChangeSchema.safeParse({ status: 'em_andamento' }).success).toBe(true);
    expect(projectStatusChangeSchema.safeParse({ status: 'finalizado' }).success).toBe(true);
    expect(projectStatusChangeSchema.safeParse({ status: 'feito' }).success).toBe(false);
  });

  it('a blocked stage says what blocks it', () => {
    expect(projectStageUpdateSchema.safeParse({ progress: 'bloqueada' }).success).toBe(false);
    expect(
      projectStageUpdateSchema.safeParse({ progress: 'bloqueada', note: 'Falta o CNPJ' }).success,
    ).toBe(true);
    expect(projectStageUpdateSchema.safeParse({ progress: 'concluida' }).success).toBe(true);
    expect(projectStageUpdateSchema.safeParse({ progress: 'pronta' }).success).toBe(false);
  });

  it('the current stage is one of the eight, and the list filter is by status', () => {
    expect(PROJECT_STAGE_SLOTS).toEqual(['01', '02', '03', '04', '05', '06', '07', '08']);
    expect(projectCurrentStageSchema.safeParse({ stage: '05' }).success).toBe(true);
    expect(projectCurrentStageSchema.safeParse({ stage: '09' }).success).toBe(false);
    expect(projectListQuerySchema.parse({})).toEqual({ inactive: false });
    expect(projectListQuerySchema.parse({ status: 'parado', inactive: 'true' })).toEqual({
      status: 'parado',
      inactive: true,
    });
  });
});

describe('advancing the current stage', () => {
  it('skips concluded stages and stops at the end', () => {
    expect(nextOpenStage('01', {})).toBe('02');
    expect(nextOpenStage('03', { '04': 'concluida', '05': 'concluida' })).toBe('06');
    expect(nextOpenStage('07', { '08': 'concluida' })).toBeNull();
    expect(nextOpenStage('08', {})).toBeNull();
  });
});
