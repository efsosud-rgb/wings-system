import {
  EMPTY_INSTAGRAM_STEPS,
  declaresNone,
  normalizeInstagram,
  type InstagramCheckSource,
  type InstagramCheckSteps,
} from '@wings/shared';
import { z } from 'zod';
import { reserveSpend, writeLedger } from '../lib/enrichment.js';
import {
  outcomeOf,
  profilePageOf,
  type InstagramOutcome,
  type JudgeInput,
} from '../lib/instagram-check.js';
import type { Job } from '../queue.js';
import type { JobContext, JobHandler } from './types.js';

const inputSchema = z.object({ leadId: z.uuid() });

interface LeadRow {
  instagram: string | null;
  company_name: string | null;
  website: string | null;
}

export interface CheckInstagramOutput {
  leadId: string;
  /** Why nothing was checked, when that is so. */
  skipped?: 'disabled' | 'no_instagram';
  status?: InstagramOutcome['status'];
  source?: InstagramOutcome['source'];
  verdict?: InstagramOutcome['verdict'];
  costUsdMicro?: number;
}

/** The old per-field check (`leads.field_checks.instagram`) says the same in its three words. */
const fieldCheckStatusOf = (status: InstagramOutcome['status']) =>
  status === 'confere'
    ? 'confere'
    : status === 'nao_encontrado' || status === 'nao_bate'
      ? 'nao_confere'
      : 'nao_verificado';

/**
 * Checks the Instagram a site-form lead gave (docs/leads/instagram.md), after the lead exists: the
 * form never waits for it. Stops at the first step that decides: the format, Meta's Business
 * Discovery, a web search for the profile page, then a cheap model comparing the profile with the
 * company. The paid steps (search, model) go through the ledger under their own daily ceiling and
 * are never retried. A missing provider skips its step and the result says so. The job is one
 * attempt; a person asks again with "Conferir de novo".
 */
export const runCheckInstagramJob: JobHandler = async (job: Job, ctx: JobContext) => {
  const { leadId } = inputSchema.parse(job.input);
  const { db } = ctx;
  const config = ctx.instagramCheck;
  if (!config?.enabled) return { leadId, skipped: 'disabled' } satisfies CheckInstagramOutput;
  const now = ctx.now?.() ?? new Date();

  const found = await db.query<LeadRow>(
    `select instagram, company_name, website from leads where id = $1`,
    [leadId],
  );
  const lead = found.rows[0];
  if (!lead) throw new Error('lead not found');

  const handle = lead.instagram && !declaresNone(lead.instagram) ? normalizeInstagram(lead.instagram) : null;
  if (!lead.instagram || declaresNone(lead.instagram)) {
    // "Não tenho": nothing to check. A mark the API left while waiting is taken off.
    await db.query(
      `update leads set instagram_check_status = null, instagram_check_source = null, instagram_check_detail = null
        where id = $1 and instagram_check_status = 'pendente'`,
      [leadId],
    );
    return { leadId, skipped: 'no_instagram' } satisfies CheckInstagramOutput;
  }

  const steps: InstagramCheckSteps = { ...EMPTY_INSTAGRAM_STEPS };
  let costUsdMicro = 0;
  let foundBy: InstagramCheckSource = 'nenhuma';
  let followers: number | null = null;
  let posts: number | null = null;
  let profile: JudgeInput['profile'] | null = null;

  try {
    if (!handle) {
      steps.format = 'invalid';
    } else {
      // --- Meta's official API (free) -----------------------------------------------------
      if (config.discovery) {
        const answer = await config.discovery.lookup(handle);
        if (answer.kind === 'found') {
          steps.meta = 'found';
          foundBy = 'meta';
          followers = answer.followers;
          posts = answer.posts;
          profile = { name: answer.name, text: answer.biography, website: answer.website };
        } else {
          steps.meta = answer.kind === 'not_found' ? 'not_found' : 'error';
        }
        await writeLedger(db, {
          leadId,
          jobId: job.id,
          step: 'ig_meta',
          status: answer.kind === 'error' ? 'failed' : 'done',
          usdMicro: 0,
          detail: { result: answer.kind },
        });
      }

      // --- the web search (paid) ----------------------------------------------------------
      if (foundBy === 'nenhuma' && ctx.enrichment.search) {
        const searchUsdMicro = Math.round(ctx.enrichment.budget.searchUsdPerQuery * 1_000_000);
        const reserved = await reserveSpend(db, {
          leadId,
          jobId: job.id,
          step: 'ig_search',
          usdMicro: searchUsdMicro,
          dailyUsd: config.dailyUsd,
          now,
          detail: { purpose: 'instagram_profile' },
        });
        if (!reserved) {
          steps.search = 'refused';
        } else {
          costUsdMicro += searchUsdMicro;
          try {
            const results = await ctx.enrichment.search.search(`instagram.com/${handle}`);
            const page = profilePageOf(handle, results);
            await writeLedger(db, {
              leadId,
              jobId: job.id,
              step: 'ig_search',
              status: 'done',
              usdMicro: 0,
              detail: { results: results.length, found: page !== null },
            });
            if (page) {
              steps.search = 'found';
              foundBy = 'busca';
              profile = { name: page.title, text: page.snippet, website: null };
            } else {
              steps.search = 'not_found';
            }
          } catch (error) {
            // The row that reserved the cost stays: the call was made, whatever it answered.
            steps.search = 'error';
            await writeLedger(db, {
              leadId,
              jobId: job.id,
              step: 'ig_search',
              status: 'failed',
              usdMicro: 0,
              detail: { reason: messageOf(error) },
            });
          }
        }
      }

      // --- the comparison with the company (paid) -----------------------------------------
      const hasCompany = Boolean(lead.company_name?.trim() || lead.website?.trim());
      if (foundBy !== 'nenhuma' && profile && hasCompany && config.judge) {
        const reserved = await reserveSpend(db, {
          leadId,
          jobId: job.id,
          step: 'ig_ai',
          usdMicro: config.judge.reserveUsdMicro,
          dailyUsd: config.dailyUsd,
          now,
          detail: { provider: config.judge.name },
        });
        if (!reserved) {
          steps.ai = 'refused';
        } else {
          costUsdMicro += config.judge.reserveUsdMicro;
          try {
            const answer = await config.judge.judge({
              profile,
              companyName: lead.company_name,
              siteUrl: lead.website,
            });
            const settle = answer.costUsdMicro - config.judge.reserveUsdMicro;
            costUsdMicro += settle;
            await writeLedger(db, {
              leadId,
              jobId: job.id,
              step: 'ig_ai',
              status: 'done',
              usdMicro: settle,
              detail: { actualUsdMicro: answer.costUsdMicro, verdict: answer.verdict },
            });
            steps.ai = answer.verdict;
          } catch (error) {
            steps.ai = 'error';
            await writeLedger(db, {
              leadId,
              jobId: job.id,
              step: 'ig_ai',
              status: 'failed',
              usdMicro: 0,
              detail: { reason: messageOf(error) },
            });
          }
        }
      }
    }

    const outcome = outcomeOf({ steps, found: foundBy, followers, posts });
    await saveOutcome(db, leadId, job.id, outcome, costUsdMicro, now);
    return {
      leadId,
      status: outcome.status,
      source: outcome.source,
      verdict: outcome.verdict,
      costUsdMicro,
    } satisfies CheckInstagramOutput;
  } catch (error) {
    // The lead must not stay "Conferindo…": the person can ask again.
    const failed = outcomeOf({ steps: { ...steps, meta: 'error' }, found: 'nenhuma', followers: null, posts: null });
    await saveOutcome(db, leadId, job.id, failed, costUsdMicro, now).catch(() => undefined);
    throw error;
  }
};

async function saveOutcome(
  db: JobContext['db'],
  leadId: string,
  jobId: string,
  outcome: InstagramOutcome,
  costUsdMicro: number,
  now: Date,
) {
  const detail = {
    reason: outcome.reason,
    steps: outcome.steps,
    followers: outcome.followers,
    posts: outcome.posts,
    costUsdMicro,
  };
  const fieldCheck = {
    status: fieldCheckStatusOf(outcome.status),
    reason: outcome.reason,
    checkedAt: now.toISOString(),
  };
  // A seller's correction stays: the effective verdict is theirs when they made one.
  await db.query(
    `update leads
        set instagram_check_status = $2, instagram_check_source = $3, instagram_checked_at = $4,
            instagram_check_detail = $5, instagram_verdict = $6,
            instagram_verdict_effective = case
              when instagram_manual = 'falso' then 'falso'
              when instagram_manual = 'confere' then null
              else $6::text end,
            field_checks = jsonb_set(coalesce(field_checks, '{}'::jsonb), '{instagram}', $7::jsonb),
            updated_at = now()
      where id = $1`,
    [
      leadId,
      outcome.status,
      outcome.source,
      now,
      JSON.stringify(detail),
      outcome.verdict,
      JSON.stringify(fieldCheck),
    ],
  );
  await db.query(`insert into lead_events (lead_id, kind, detail) values ($1, 'instagram.checked', $2)`, [
    leadId,
    JSON.stringify({
      jobId,
      status: outcome.status,
      source: outcome.source,
      verdict: outcome.verdict,
      steps: outcome.steps,
    }),
  ]);
}

/** A message, never a stack, a query or a name. */
function messageOf(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.slice(0, 200);
}
