/**
 * The hook the intake doors call when something arrives without a funnel
 * (docs/leads/triagem-jev.md). Kept apart from `triage.ts` so `service.ts` and
 * the WhatsApp intake can import it without a cycle: the triage itself imports
 * both of them.
 */

export type TriageTarget =
  /** A lead born without a funnel (site form, RD Station conversion). */
  | { leadId: string }
  /** A WhatsApp conversation opened by a message with no deal and Sofia off. */
  | { conversationId: string };

/** Which lead sources the triage reads: the doors whose origin may leave the funnel open. */
export const TRIAGE_SOURCES: ReadonlySet<string> = new Set(['site_form', 'rd_station']);

let run: ((target: TriageTarget) => void) | null = null;

/** Set once by the app (null = off, the default, and in tests without a stub). */
export function configureLeadTriage(runner: ((target: TriageTarget) => void) | null) {
  run = runner;
}

/** True when the app switched the triage on; the doors then leave the arrival notice to it. */
export function leadTriageEnabled(): boolean {
  return run !== null;
}

/** Runs the triage off the request; a no-op until configured. */
export function scheduleLeadTriage(target: TriageTarget) {
  run?.(target);
}
