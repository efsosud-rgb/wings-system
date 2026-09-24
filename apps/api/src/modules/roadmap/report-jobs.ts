import type { Database } from '../../db/client.js';
import type { Env } from '../../env.js';
import type { AgentLlm } from '../agent/llm.js';
import { applyGenerated } from './service.js';
import { generateRoadmap, type CommitReader } from './generator.js';
import type { RoadmapNotifier } from './notifiers/factory.js';
import { composeReportMessage } from './phrasing.js';
import {
  activeRecipientPhones,
  findOrCreateDraftRun,
  getReportRunByDate,
  markRunSent,
  snapshotOf,
} from './service.js';

/**
 * The three jobs `roadmap-cli.ts` runs: `--generate` (any time, idempotent),
 * `--preview` at 17:30 BRT and `--send` at 18:00 BRT (docs/roadmap.md). Kept
 * apart from the CLI's own env/db bootstrapping so they can be exercised in
 * tests against a throwaway database, the same way `ingest-cycle.ts` is
 * tested apart from `ingest-cli.ts`.
 */

function isWeekdayInSaoPaulo(date: Date): boolean {
  const weekday = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Sao_Paulo',
    weekday: 'short',
  }).format(date);
  return weekday !== 'Sat' && weekday !== 'Sun';
}

/** YYYY-MM-DD in America/Sao_Paulo, so "today" always means Eric's today. */
function todayInSaoPaulo(date: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(date);
}

// --- generate ----------------------------------------------------------------

export interface GenerateJobResult {
  modulesWritten: number;
  deliverablesCreated: number;
  deliverablesUpdated: number;
  deliverablesSkipped: number;
}

export async function runGenerateJob(
  db: Database,
  reader: CommitReader,
  log: (message: string) => void = console.warn,
): Promise<GenerateJobResult> {
  const generated = await generateRoadmap(reader);
  const result = await applyGenerated(
    db,
    generated.modules,
    generated.deliverables.map((d) => ({
      moduleKey: d.moduleKey,
      label: d.label,
      weight: d.weight,
      status: d.status,
      completedAt: d.completedAt,
    })),
  );
  log(
    `[roadmap] generated: ${result.modulesWritten} module(s), ${result.deliverablesCreated} new, ` +
      `${result.deliverablesUpdated} updated, ${result.deliverablesSkipped} skipped (edited by hand)`,
  );
  return result;
}

// --- preview (17:30 BRT) ------------------------------------------------------

export interface PreviewJobDeps {
  /** Null when OpenRouter isn't configured: the message falls back to a plain template. */
  llm: AgentLlm | null;
  notifier: RoadmapNotifier;
  log?: (message: string) => void;
}

export interface PreviewJobResult {
  skipped: 'weekend' | null;
  runId: string | null;
  created: boolean;
  sentTo: number;
}

export async function runPreviewJob(
  db: Database,
  env: Env,
  deps: PreviewJobDeps,
  now: Date,
): Promise<PreviewJobResult> {
  const log = deps.log ?? console.warn;

  if (!isWeekdayInSaoPaulo(now)) {
    log('[roadmap] preview skipped: weekend (America/Sao_Paulo)');
    return { skipped: 'weekend', runId: null, created: false, sentTo: 0 };
  }

  const reportDate = todayInSaoPaulo(now);
  const { computed } = await snapshotOf(db, now);

  const { run, created } = await findOrCreateDraftRun(db, reportDate, async (id) => {
    const linkUrl = `${env.APP_BASE_URL}/administracao/roadmap/relatorios/${id}`;
    const messageText = await composeReportMessage({ llm: deps.llm, computed, linkUrl });
    return { computed, messageText };
  });

  const recipients = await activeRecipientPhones(db, 'preview');
  for (const recipient of recipients) {
    await deps.notifier.sendText(recipient.phone, run.messageText);
  }
  log(
    `[roadmap] preview ${created ? 'created' : 'reused'} run ${run.id}, sent to ${recipients.length} recipient(s)`,
  );
  return { skipped: null, runId: run.id, created, sentTo: recipients.length };
}

// --- send (18:00 BRT) ----------------------------------------------------------

export interface SendJobDeps {
  notifier: RoadmapNotifier;
  log?: (message: string) => void;
}

export type SendJobOutcome = 'sent' | 'simulated' | 'not_approved' | 'no_run';

export interface SendJobResult {
  outcome: SendJobOutcome;
  runId: string | null;
  sentTo: number;
}

/**
 * Never sends an unapproved report: only a run whose status is `aprovado`
 * (Eric's click) is eligible at all. The message sent is the run's own
 * `message_text` — the exact text that was approved, not a fresh
 * recomputation — because approving is Eric approving specific content, not
 * a green light to compose something new at send time.
 */
export async function runSendJob(
  db: Database,
  env: Env,
  deps: SendJobDeps,
  now: Date,
): Promise<SendJobResult> {
  const log = deps.log ?? console.warn;
  const reportDate = todayInSaoPaulo(now);
  const run = await getReportRunByDate(db, reportDate);

  if (!run) {
    log(`[roadmap] send skipped: no run for ${reportDate}`);
    return { outcome: 'no_run', runId: null, sentTo: 0 };
  }
  if (run.status !== 'aprovado') {
    log(`[roadmap] send skipped: run ${run.id} is "${run.status}", not aprovado`);
    return { outcome: 'not_approved', runId: run.id, sentTo: 0 };
  }

  const recipients = await activeRecipientPhones(db, 'ceo');

  if (!env.ROADMAP_REPORT_SEND_ENABLED) {
    await markRunSent(db, run.id, 'enviado_simulado');
    log(
      `[roadmap] ROADMAP_REPORT_SEND_ENABLED is off: run ${run.id} marked enviado_simulado, ` +
        `nothing sent to ${recipients.length} recipient(s)`,
    );
    return { outcome: 'simulated', runId: run.id, sentTo: 0 };
  }

  for (const recipient of recipients) {
    await deps.notifier.sendText(recipient.phone, run.messageText);
  }
  await markRunSent(db, run.id, 'enviado');
  log(`[roadmap] sent run ${run.id} to ${recipients.length} recipient(s)`);
  return { outcome: 'sent', runId: run.id, sentTo: recipients.length };
}
