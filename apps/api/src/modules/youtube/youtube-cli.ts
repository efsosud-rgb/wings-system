import { createDb } from '../../db/client.js';
import { loadDotEnv } from '../../db/load-env.js';
import { loadEnv } from '../../env.js';
import { runYoutubeLocked, youtubeCronOf } from './scheduler.js';

/**
 * A reading of the YouTube channel now, from a shell inside the API container
 * (the API's own timer does the daily one):
 *
 *   node dist/modules/youtube/youtube-cli.js
 *
 * Same lock and same run record as the scheduled reading (`manual_youtube`).
 * Read-only against YouTube; prints counts and codes, never the key.
 */
async function main() {
  loadDotEnv();
  const env = loadEnv();
  if (!env.YOUTUBE_API_KEY) {
    throw new Error('YOUTUBE_API_KEY não está definida: nada foi lido.');
  }
  const { db, pool } = createDb(env.DATABASE_URL);
  try {
    const result = await runYoutubeLocked({
      db,
      apiKey: env.YOUTUBE_API_KEY,
      channelEnv: env.YOUTUBE_CHANNEL_ID,
      cron: youtubeCronOf(env.YOUTUBE_INGEST_CRON),
      trigger: 'manual_youtube',
      force: true,
    });
    if ('ran' in result) {
      console.warn('já há uma leitura do YouTube em andamento; esta sai sem fazer nada');
      return;
    }
    if (result.status === 'ok') {
      console.warn(`youtube: ${result.videos} vídeo(s) lidos, ${result.units} unidade(s) de quota`);
    } else if (result.status === 'failed') {
      throw new Error(`youtube: falhou (${result.error}), ${result.units} unidade(s) de quota`);
    }
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
