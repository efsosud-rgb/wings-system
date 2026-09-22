import { INSIGHTS_SCHEDULE, type AgentModel } from '@wings/shared';
import type { Database } from '../../db/client.js';
import type { AgentLlm } from '../agent/llm.js';
import { runInsights } from './service.js';

/**
 * Every Monday at 07:00 in São Paulo: the insights, then the campaign
 * suggestions. A tick a minute decides whether the week's run is due; the
 * unique (kind, week_key) index on the run table is what keeps two API
 * replicas, or a restart, from running the same Monday twice. Never started
 * by `buildApp`, so no test starts it.
 */

const TICK_MS = 60_000;

/** São Paulo has been UTC−3 all year since 2019. */
function saoPauloParts(now: Date): { weekday: number; hour: number; day: string } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: INSIGHTS_SCHEDULE.timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hour12: false,
  }).formatToParts(now);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
  const day = `${get('year')}-${get('month')}-${get('day')}`;
  const hour = Number(get('hour')) % 24;
  return { weekday: new Date(`${day}T00:00:00Z`).getUTCDay(), hour, day };
}

/** ISO week of a calendar day, as `2026-W39`. */
export function isoWeekOf(day: string): string {
  const date = new Date(`${day}T00:00:00Z`);
  // Thursday of the same ISO week decides the year.
  const weekday = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - weekday);
  const yearStart = Date.UTC(date.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((date.getTime() - yearStart) / 86_400_000 + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

/**
 * The week key when a scheduled run is due at this instant, else null. Due
 * from 07:00 on Monday until the end of that Monday, so an API that was down
 * at seven catches up the same day and a Tuesday restart does not run it.
 */
export function dueWeekKey(now: Date): string | null {
  const { weekday, hour, day } = saoPauloParts(now);
  if (weekday !== INSIGHTS_SCHEDULE.weekday || hour < INSIGHTS_SCHEDULE.hour) return null;
  return isoWeekOf(day);
}

/** The next Monday 07:00 in São Paulo strictly after `now`. */
export function nextScheduledAt(now: Date): Date {
  const { weekday, hour, day } = saoPauloParts(now);
  const daysAhead =
    weekday === INSIGHTS_SCHEDULE.weekday && hour < INSIGHTS_SCHEDULE.hour
      ? 0
      : (INSIGHTS_SCHEDULE.weekday - weekday + 7) % 7 || 7;
  const monday = new Date(`${day}T00:00:00Z`);
  monday.setUTCDate(monday.getUTCDate() + daysAhead);
  const iso = monday.toISOString().slice(0, 10);
  return new Date(`${iso}T${String(INSIGHTS_SCHEDULE.hour).padStart(2, '0')}:00:00-03:00`);
}

export function startInsightsScheduler(deps: {
  db: Database;
  llm: AgentLlm;
  model: AgentModel;
  dailyLimitUsd: number;
  log: (facts: Record<string, unknown>) => void;
}): () => void {
  let busy = false;
  const tick = async () => {
    if (busy) return;
    const weekKey = dueWeekKey(new Date());
    if (!weekKey) return;
    busy = true;
    try {
      for (const kind of ['insights', 'campaign_suggestions'] as const) {
        const result = await runInsights(
          {
            db: deps.db,
            llm: deps.llm,
            model: deps.model,
            dailyLimitUsd: deps.dailyLimitUsd,
            log: deps.log,
          },
          { kind, trigger: 'schedule', requestedBy: null, weekKey },
        );
        if (result.ok || result.code !== 'already_ran') {
          deps.log({
            msg: 'insights schedule',
            kind,
            weekKey,
            ...(result.ok ? { runId: result.runId } : { refused: result.code }),
          });
        }
      }
    } catch (error) {
      deps.log({
        msg: 'insights schedule',
        error: error instanceof Error ? error.name : 'unknown',
      });
    } finally {
      busy = false;
    }
  };
  const timer = setInterval(() => void tick(), TICK_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}
