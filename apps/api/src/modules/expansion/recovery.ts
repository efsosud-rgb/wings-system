import { randomUUID } from 'node:crypto';
import { like } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { auditLog } from '../../db/schema/index.js';
import { writeAudit } from '../../lib/audit.js';
import { runExpansionIntake, type IntakeResult } from './intake.js';
import { RdCrm, RdMarketing } from './rd.js';
import { activeRules, dbLedger, recordDealOnLead } from './service.js';

/**
 * Recovery of conversions that leaked (no deal in RD CRM), for a fixed set of
 * forms. Two steps, in this order, and the server enforces the order:
 *
 *  1. POST { dryRun: true }: reads RD and reports what WOULD be created.
 *  2. POST { dryRun: false, planId, expectedCreated }: creates the deals, only
 *     if that dry run finished less than two hours ago, for the same window,
 *     and the number it would create is the one the person confirmed.
 *
 * The deal rule is the intake job's own (a contact with an open deal, or a
 * deal made after the conversion, is covered: never duplicated). Nothing
 * personal is answered: counts, identifiers and RD deal ids.
 */

export const RECOVERY_FORMATACAO_FORMS = [
  'wings-company-form-site',
  'lp-formatacao-whatsapp',
  'Formulário Simplificado. -02',
];
export const RECOVERY_EXPANSAO_PAGE = 'lp-calcadao-do-frango';
/** July's form: listed, never recovered. */
export const LIST_ONLY = ['fluentform_3'];
const PLAN_TTL_MS = 2 * 3_600_000;

type State =
  | {
      state: 'running';
      mode: 'dry' | 'real';
      planId: string;
      startedAt: string;
      days: number;
      /** Contacts read so far, out of those with a conversion in the window. */
      progress: { done: number; total: number } | null;
    }
  | {
      state: 'done';
      mode: 'dry' | 'real';
      planId: string;
      finishedAt: string;
      days: number;
      result: RecoverySummary;
    }
  | { state: 'failed'; mode: 'dry' | 'real'; finishedAt: string; error: string }
  /** The API restarted (a deploy) while it was running: the run is gone and nothing was left half-done in memory. */
  | { state: 'interrupted'; mode: 'dry' | 'real'; startedAt: string };

export interface RecoverySummary {
  wouldCreate: number;
  created: Record<string, number>;
  existingDeal: number;
  alreadyDecided: number;
  settling: number;
  failed: number;
  unverified: number;
  taskFailed: number;
  noContactData: number;
  conversionsSeen: number;
  /** Conversions of other identifiers, counted and left alone; the July form is among them. */
  ignored: Record<string, number>;
  listOnly: Record<string, number>;
  createdDealIds: string[];
}

function summarize(result: IntakeResult): RecoverySummary {
  const total = Object.values(result.created).reduce((sum, n) => sum + n, 0);
  return {
    wouldCreate: total,
    created: result.created,
    existingDeal: result.existingDeal,
    alreadyDecided: result.alreadyDecided,
    settling: result.settling,
    failed: result.failed,
    unverified: result.unverified,
    taskFailed: result.taskFailed,
    noContactData: result.noContactData,
    conversionsSeen: result.conversions,
    ignored: result.ignored,
    listOnly: Object.fromEntries(LIST_ONLY.map((id) => [id, result.ignored[id] ?? 0])),
    createdDealIds: result.createdDealIds,
  };
}

const body = z.discriminatedUnion('dryRun', [
  z.object({ dryRun: z.literal(true), days: z.number().int().min(1).max(30).default(30) }),
  z.object({
    dryRun: z.literal(false),
    planId: z.string().uuid(),
    expectedCreated: z.number().int().min(0).max(500),
  }),
]);

export const expansionRecoveryRoutes: FastifyPluginAsync = async (app) => {
  const { db } = app.wings;
  const guard = { preHandler: app.requirePermission('integrations.manage') };
  let current: State | null = null;
  let lastDry: { planId: string; days: number; finishedAt: number; wouldCreate: number } | null =
    null;

  app.get('/expansion/landing-recovery', guard, async (_request, reply) => {
    if (current) return reply.send(current);
    // After a restart the memory is empty: the audit trail says whether a run was cut short.
    const last = await db.query.auditLog.findFirst({
      where: like(auditLog.action, 'expansion.recovery%'),
      orderBy: (table, { desc }) => [desc(table.at)],
    });
    if (
      last &&
      (last.action === 'expansion.recovery_dry_run' || last.action === 'expansion.recovery_run')
    ) {
      return reply.send({
        state: 'interrupted',
        mode: last.action === 'expansion.recovery_run' ? 'real' : 'dry',
        startedAt: last.at.toISOString(),
      });
    }
    return reply.send({ state: 'idle' });
  });

  app.post('/expansion/landing-recovery', guard, async (request, reply) => {
    const parsed = body.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'dry_run_required' });
    const input = parsed.data;
    const env = app.wings.env;
    if (
      !env.RD_CRM_API_TOKEN ||
      !env.RD_MKT_CLIENT_ID ||
      !env.RD_MKT_CLIENT_SECRET ||
      !env.RD_MKT_REFRESH_TOKEN
    ) {
      return reply.code(503).send({ error: 'rd_not_configured' });
    }
    if (!env.EXPANSION_OWNER_RD_USER_ID) {
      return reply.code(503).send({ error: 'expansion_owner_not_configured' });
    }
    if (current?.state === 'running') return reply.code(409).send({ error: 'already_running' });

    let planId: string;
    let days: number;
    if (input.dryRun) {
      planId = randomUUID();
      days = input.days;
    } else {
      if (
        !lastDry ||
        lastDry.planId !== input.planId ||
        Date.now() - lastDry.finishedAt > PLAN_TTL_MS
      ) {
        return reply.code(409).send({ error: 'dry_run_needed' });
      }
      if (lastDry.wouldCreate !== input.expectedCreated) {
        return reply.code(409).send({ error: 'count_mismatch', wouldCreate: lastDry.wouldCreate });
      }
      planId = lastDry.planId;
      days = lastDry.days;
      lastDry = null; // one dry run authorises one real run
    }

    const rules = await activeRules(db, { forDeals: true });
    if (!rules.some((rule) => rule.identifier === RECOVERY_EXPANSAO_PAGE)) {
      return reply.code(409).send({ error: 'calcadao_not_registered' });
    }
    const mode: 'dry' | 'real' = input.dryRun ? 'dry' : 'real';
    const startedAt = new Date().toISOString();
    const running = {
      state: 'running' as const,
      mode,
      planId,
      startedAt,
      days,
      progress: null as { done: number; total: number } | null,
    };
    current = running;
    await writeAudit(db, {
      actorEmployeeId: request.session.actor.employeeId,
      action: input.dryRun ? 'expansion.recovery_dry_run' : 'expansion.recovery_run',
      entity: 'expansion_recovery',
      entityId: planId,
      metadata: { days, ...(input.dryRun ? {} : { expectedCreated: input.expectedCreated }) },
    });

    const credentials = {
      clientId: env.RD_MKT_CLIENT_ID,
      clientSecret: env.RD_MKT_CLIENT_SECRET,
      refreshToken: env.RD_MKT_REFRESH_TOKEN,
    };
    const crmToken = env.RD_CRM_API_TOKEN;
    const ownerId = env.EXPANSION_OWNER_RD_USER_ID;
    void (async () => {
      try {
        const crm = new RdCrm(crmToken, app.wings.rdFetch);
        // Both landing stages must exist before anything is read or made.
        const map = await crm.map();
        for (const [pipeline, stage] of [
          ['Formatação', 'Sem contato'],
          ['Expansão', 'Novo Contato'],
        ] as const) {
          if (!map.pipelines.get(pipeline)?.stages.has(stage)) {
            throw new Error(`stage "${pipeline} / ${stage}" not found in RD CRM`);
          }
        }
        const result = await runExpansionIntake({
          marketing: new RdMarketing(credentials, app.wings.rdFetch),
          crm,
          ledger: dbLedger(db),
          rules,
          expansionOwnerId: ownerId,
          since: new Date(Date.now() - days * 86_400_000),
          dryRun: input.dryRun,
          now: () => new Date(),
          onProgress: (done, total) => {
            running.progress = { done, total };
          },
          onDealCreated: (event) => recordDealOnLead(db, event),
          recovery: {
            only: [...RECOVERY_FORMATACAO_FORMS, RECOVERY_EXPANSAO_PAGE, ...LIST_ONLY],
            formatacaoIdentifiers: RECOVERY_FORMATACAO_FORMS,
            formatacaoStage: 'Sem contato',
          },
        });
        const summary = summarize(result);
        const finishedAt = new Date();
        // The trail first: a reader that finds "done" must find the run closed there too.
        await writeAudit(db, {
          actorEmployeeId: request.session.actor.employeeId,
          action: input.dryRun ? 'expansion.recovery_dry_run_done' : 'expansion.recovery_done',
          entity: 'expansion_recovery',
          entityId: planId,
          metadata: {
            wouldCreate: summary.wouldCreate,
            existingDeal: summary.existingDeal,
            failed: summary.failed,
            dealIds: summary.createdDealIds,
          },
        }).catch(() => undefined);
        current = {
          state: 'done',
          mode,
          planId,
          finishedAt: finishedAt.toISOString(),
          days,
          result: summary,
        };
        if (input.dryRun) {
          lastDry = {
            planId,
            days,
            finishedAt: finishedAt.getTime(),
            wouldCreate: summary.wouldCreate,
          };
        }
      } catch (error) {
        await writeAudit(db, {
          actorEmployeeId: request.session.actor.employeeId,
          action: 'expansion.recovery_failed',
          entity: 'expansion_recovery',
          entityId: planId,
          metadata: { mode },
        }).catch(() => undefined);
        current = {
          state: 'failed',
          mode,
          finishedAt: new Date().toISOString(),
          error: error instanceof Error ? error.message.slice(0, 200) : 'unknown',
        };
      }
    })();
    return reply.code(202).send(current);
  });
};
