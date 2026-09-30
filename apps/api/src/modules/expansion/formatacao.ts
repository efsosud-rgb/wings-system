import { and, desc, eq, gte, inArray, isNotNull } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import { auditLog, expansionIntakeLedger } from '../../db/schema/index.js';
import { writeAudit } from '../../lib/audit.js';
import { runExpansionIntake, type IntakeResult } from './intake.js';
import { RdCrm, RdMarketing, type RdMarketingCredentials } from './rd.js';
import { RECOVERY_FORMATACAO_FORMS } from './recovery.js';
import { dbLedger } from './service.js';

/**
 * The Formatação safety net. Every 5 minutes, the conversions of the three
 * Formatação forms (the site form, the WhatsApp pop-up and the simplified
 * form) that have no deal get one in Formatação / "Sem contato", with the
 * origin (identifier, UTMs, campaign) on it. It is the intake job's rule and
 * ledger: a contact with an open deal in any funnel, or a deal made after the
 * conversion, is left alone, and a conversion already decided is not decided
 * again. It only creates; it never changes an existing deal.
 *
 * Every pass that counted or made something writes an audit entry
 * (`formatacao.intake_dry_run` / `formatacao.intake_run`) with counts and, for
 * a real pass, the RD deal ids. Never a name, e-mail or phone.
 */

export const FORMATACAO_INTAKE_JOB = 'formatacao-intake';
export const FORMATACAO_FORMS = RECOVERY_FORMATACAO_FORMS;
/** The funnel's first stage: RD's Formatação pipeline has no "Novo Contato" (that one is Expansão's). */
export const FORMATACAO_STAGE = 'Sem contato';
const TICK_MS = 5 * 60_000;
/** The first pass after a start looks back three days; later ones six hours (the ledger makes the overlap free). */
const FIRST_LOOKBACK_HOURS = 72;
const LOOKBACK_HOURS = 6;

let blockedReported = false;

export interface FormatacaoCredentials {
  rdCrmToken: string;
  rdMarketing: RdMarketingCredentials;
}

export interface FormatacaoPass {
  dryRun: boolean;
  /** Counting only because a deal without a contact is unresolved (see `isHalted`). */
  halted: boolean;
  repair?: Awaited<ReturnType<typeof repairOrphans>>;
  stageFound: boolean;
  result: IntakeResult | null;
}

/**
 * The stop-loss: a deal RD keeps without a contact is no use, so when one is
 * made (or found) and no way of tying a contact to it works, the net writes
 * `formatacao.intake_halted` and counts instead of creating, until a deal is
 * read back with its contact (`formatacao.intake_linked_ok`).
 */
async function isHalted(db: Database): Promise<boolean> {
  const last = await db.query.auditLog.findFirst({
    where: inArray(auditLog.action, ['formatacao.intake_halted', 'formatacao.intake_linked_ok']),
    orderBy: [desc(auditLog.at)],
    columns: { action: true },
  });
  return last?.action === 'formatacao.intake_halted';
}

const MAX_REPAIRS_PER_DEAL = 3;

/** Deals this net made in the last three days that RD holds without a contact: tie the person to each. */
async function repairOrphans(
  db: Database,
  crm: RdCrm,
  marketing: RdMarketing,
  now: Date,
): Promise<{
  checked: number;
  orphans: number;
  linked: number;
  /** Each deal this net made lately, as RD reads it back: deal id, has a contact, has a source. */
  verified: { dealId: string; contact: boolean; source: boolean }[];
}> {
  const rows = await db
    .select({ key: expansionIntakeLedger.conversionKey, dealId: expansionIntakeLedger.rdDealId })
    .from(expansionIntakeLedger)
    .where(
      and(
        eq(expansionIntakeLedger.target, 'formatacao'),
        eq(expansionIntakeLedger.outcome, 'created'),
        isNotNull(expansionIntakeLedger.rdDealId),
        gte(expansionIntakeLedger.decidedAt, new Date(now.getTime() - 3 * 86_400_000)),
      ),
    )
    .orderBy(desc(expansionIntakeLedger.decidedAt))
    .limit(20);
  let orphans = 0;
  let linked = 0;
  let withContact = 0;
  const verified: { dealId: string; contact: boolean; source: boolean }[] = [];
  for (const row of rows) {
    const dealId = row.dealId as string;
    const back = await crm.checkDeal(dealId).catch(() => null);
    if (back) verified.push({ dealId, contact: back.hasContact, source: back.hasSource });
    if (back?.hasContact) withContact += 1;
    if (!back || back.hasContact) continue;
    orphans += 1;
    const tried = await db.$count(
      auditLog,
      and(eq(auditLog.action, 'formatacao.intake_repair'), eq(auditLog.entityId, dealId)),
    );
    if (tried >= MAX_REPAIRS_PER_DEAL) continue;
    const uuid = row.key.split('|')[0] as string;
    const person = await marketing.contactOf(uuid);
    const existing = await crm.findContact(person.email, person.phone);
    const tie = await crm.linkContact(dealId, person, existing);
    if (tie.linked) linked += 1;
    await writeAudit(db, {
      actorEmployeeId: null,
      action: 'formatacao.intake_repair',
      entity: 'formatacao_intake',
      entityId: dealId,
      metadata: {
        linked: tie.linked,
        contactKnownToCrm: Boolean(existing),
        attempts: tie.attempts,
      },
    });
    await writeAudit(db, {
      actorEmployeeId: null,
      action: tie.linked ? 'formatacao.intake_linked_ok' : 'formatacao.intake_halted',
      entity: 'formatacao_intake',
      entityId: dealId,
      metadata: { via: 'repair' },
    });
  }
  // A deal read back with its contact lifts a halt that an earlier wrong read may have caused.
  if (orphans === 0 && withContact > 0 && (await isHalted(db))) {
    await writeAudit(db, {
      actorEmployeeId: null,
      action: 'formatacao.intake_linked_ok',
      entity: 'formatacao_intake',
      entityId: FORMATACAO_INTAKE_JOB,
      metadata: { via: 'readback', dealsWithContact: withContact },
    });
  }
  return { checked: rows.length, orphans, linked, verified };
}

export async function runFormatacaoOnce(
  db: Database,
  credentials: FormatacaoCredentials,
  options: { lookbackHours: number; dryRun: boolean; fetchImpl?: typeof fetch; now?: Date },
): Promise<FormatacaoPass> {
  const now = options.now ?? new Date();
  const crm = new RdCrm(credentials.rdCrmToken, options.fetchImpl);
  const map = await crm.map();
  if (!map.pipelines.get('Formatação')?.stages.has(FORMATACAO_STAGE)) {
    // Once per process: pipeline and stage names are labels, and they say what to fix.
    if (!blockedReported) {
      blockedReported = true;
      await writeAudit(db, {
        actorEmployeeId: null,
        action: 'formatacao.intake_blocked',
        entity: 'formatacao_intake',
        entityId: 'stage',
        metadata: {
          reason: 'stage "Formatação / Sem contato" not found in RD CRM',
          pipelines: Object.fromEntries(
            [...map.pipelines].map(([name, pipeline]) => [name, [...pipeline.stages.keys()]]),
          ),
        },
      });
    }
    return { dryRun: options.dryRun, halted: false, stageFound: false, result: null };
  }
  const marketing = new RdMarketing(credentials.rdMarketing, options.fetchImpl);
  // First heal what was already made, so the stop-loss below sees the truth.
  const repair = await repairOrphans(db, crm, marketing, now);
  const halted = await isHalted(db);
  const dryRun = options.dryRun || halted;
  const result = await runExpansionIntake({
    marketing,
    crm,
    ledger: dbLedger(db),
    rules: [],
    expansionOwnerId: null,
    since: new Date(now.getTime() - options.lookbackHours * 3_600_000),
    dryRun,
    now: () => now,
    recovery: {
      only: FORMATACAO_FORMS,
      formatacaoIdentifiers: FORMATACAO_FORMS,
      formatacaoStage: FORMATACAO_STAGE,
    },
  });
  const created = Object.values(result.created).reduce((sum, n) => sum + n, 0);
  if (!dryRun && created > 0) {
    await writeAudit(db, {
      actorEmployeeId: null,
      action: result.orphanDealIds.length
        ? 'formatacao.intake_halted'
        : 'formatacao.intake_linked_ok',
      entity: 'formatacao_intake',
      entityId: FORMATACAO_INTAKE_JOB,
      metadata: { via: 'create', orphans: result.orphanDealIds },
    });
  }
  if (dryRun || created > 0 || result.failed > 0 || repair.orphans > 0) {
    await writeAudit(db, {
      actorEmployeeId: null,
      action: dryRun ? 'formatacao.intake_dry_run' : 'formatacao.intake_run',
      entity: 'formatacao_intake',
      entityId: FORMATACAO_INTAKE_JOB,
      metadata: {
        lookbackHours: options.lookbackHours,
        contacts: result.contacts,
        conversions: result.conversions,
        [dryRun ? 'wouldCreate' : 'created']: created,
        haltedByOrphan: halted,
        repair,
        linked: result.linked,
        orphanDealIds: result.orphanDealIds,
        linkAttempts: result.linkAttempts,
        byForm: result.createdByIdentifier,
        existingDeal: result.existingDeal,
        alreadyDecided: result.alreadyDecided,
        settling: result.settling,
        noContactData: result.noContactData,
        failed: result.failed,
        unverified: result.unverified,
        dealIds: result.createdDealIds,
      },
    });
  }
  return { dryRun, halted, repair, stageFound: true, result };
}

export function startFormatacaoIntakeScheduler(deps: {
  db: Database;
  credentials: FormatacaoCredentials;
  dryRun: boolean;
  log: (facts: Record<string, unknown>) => void;
  tickMs?: number;
}): () => void {
  let busy = false;
  let first = true;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      const pass = await runFormatacaoOnce(deps.db, deps.credentials, {
        lookbackHours: first ? FIRST_LOOKBACK_HOURS : LOOKBACK_HOURS,
        dryRun: deps.dryRun,
      });
      first = false;
      // Counts only: no name, e-mail, phone or RD text.
      deps.log({
        job: FORMATACAO_INTAKE_JOB,
        dryRun: pass.dryRun,
        halted: pass.halted,
        repair: pass.repair,
        stageFound: pass.stageFound,
        conversions: pass.result?.conversions,
        created: pass.result?.created,
        existingDeal: pass.result?.existingDeal,
        alreadyDecided: pass.result?.alreadyDecided,
        settling: pass.result?.settling,
        failed: pass.result?.failed,
        unverified: pass.result?.unverified,
      });
    } catch (error) {
      deps.log({
        job: FORMATACAO_INTAKE_JOB,
        error: error instanceof Error ? error.message.slice(0, 200) : 'unknown',
      });
    } finally {
      busy = false;
    }
  };
  // Run once right away (the first pass is the three-day catch-up), then every 5 minutes.
  void tick();
  const timer = setInterval(() => void tick(), deps.tickMs ?? TICK_MS);
  timer.unref();
  return () => clearInterval(timer);
}
