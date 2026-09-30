import type { Database } from '../../db/client.js';
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
  stageFound: boolean;
  result: IntakeResult | null;
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
    return { dryRun: options.dryRun, stageFound: false, result: null };
  }
  const result = await runExpansionIntake({
    marketing: new RdMarketing(credentials.rdMarketing, options.fetchImpl),
    crm,
    ledger: dbLedger(db),
    rules: [],
    expansionOwnerId: null,
    since: new Date(now.getTime() - options.lookbackHours * 3_600_000),
    dryRun: options.dryRun,
    now: () => now,
    recovery: {
      only: FORMATACAO_FORMS,
      formatacaoIdentifiers: FORMATACAO_FORMS,
      formatacaoStage: FORMATACAO_STAGE,
    },
  });
  const created = Object.values(result.created).reduce((sum, n) => sum + n, 0);
  if (options.dryRun || created > 0 || result.failed > 0) {
    await writeAudit(db, {
      actorEmployeeId: null,
      action: options.dryRun ? 'formatacao.intake_dry_run' : 'formatacao.intake_run',
      entity: 'formatacao_intake',
      entityId: FORMATACAO_INTAKE_JOB,
      metadata: {
        lookbackHours: options.lookbackHours,
        contacts: result.contacts,
        conversions: result.conversions,
        [options.dryRun ? 'wouldCreate' : 'created']: created,
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
  return { dryRun: options.dryRun, stageFound: true, result };
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
