import { createDb } from '../../db/client.js';
import { loadDotEnv } from '../../db/load-env.js';
import { loadEnv } from '../../env.js';
import { GithubRepoHistoryClient } from '../../lib/github-repo-history.js';
import { createOpenRouterLlm } from '../agent/llm.js';
import { createRoadmapNotifier } from './notifiers/factory.js';
import { runGenerateJob, runPreviewJob, runSendJob } from './report-jobs.js';

/**
 * The two jobs a Coolify Scheduled Task runs against the existing
 * `wings-api` / `wings-api-staging` container — no new worker, no new
 * Coolify app, the same pattern `docs/ads/primeira-escrita.md` already
 * describes for ad ingestion (docs/roadmap.md).
 *
 *   node dist/modules/roadmap/roadmap-cli.js --generate  # any time, idempotent
 *   node dist/modules/roadmap/roadmap-cli.js --preview   # 17:30 BRT: draft + Eric's link
 *   node dist/modules/roadmap/roadmap-cli.js --send      # 18:00 BRT: sends an approved run
 */

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

async function main() {
  loadDotEnv();
  const env = loadEnv();
  const { db, pool } = createDb(env.DATABASE_URL);
  const now = new Date();

  try {
    if (flag('generate')) {
      // Fail loudly: a scheduled task that quietly writes an empty or wrong
      // roadmap is worse than one that fails visibly.
      if (!env.GITHUB_ROADMAP_TOKEN || !env.GITHUB_ROADMAP_REPO) {
        throw new Error(
          'GITHUB_ROADMAP_TOKEN and GITHUB_ROADMAP_REPO are required for --generate — nothing generated.',
        );
      }
      const reader = new GithubRepoHistoryClient({
        token: env.GITHUB_ROADMAP_TOKEN,
        repo: env.GITHUB_ROADMAP_REPO,
      });
      await runGenerateJob(db, reader);
      return;
    }

    if (flag('preview')) {
      const llm = env.OPENROUTER_API_KEY
        ? createOpenRouterLlm({ apiKey: env.OPENROUTER_API_KEY })
        : null;
      await runPreviewJob(db, env, { llm, notifier: createRoadmapNotifier(env) }, now);
      return;
    }

    if (flag('send')) {
      await runSendJob(db, env, { notifier: createRoadmapNotifier(env) }, now);
      return;
    }

    throw new Error('Nothing to do — pass --generate, --preview or --send.');
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? `${error.name}: ${error.message}` : error);
  process.exit(1);
});
