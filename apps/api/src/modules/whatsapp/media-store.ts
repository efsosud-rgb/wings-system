import { eq, isNull, sql } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import { waMessageFiles } from '../../db/schema/index.js';
import type { ObjectStorage } from '../../lib/storage/index.js';
import { downloadWhatsAppMedia, type WhatsAppConfig } from './graph.js';

/**
 * The received files' queue (docs/whatsapp/cloud-api.md, "Arquivos recebidos"):
 * each message's file goes from Meta to our storage once, soon after it
 * arrives, and is deleted when its message is. Reading a file from Meta sends
 * nothing and costs nothing, so a failure is tried again later, then once a
 * day, for as long as Meta keeps the file (a revoked token or a storage outage
 * fixed in a week loses nothing); only then is the row left `failed` (the
 * screen still asks Meta). Nothing about the person is logged: ids and counts.
 */

export const WHATSAPP_MEDIA_JOB = 'whatsapp_media';
/** Meta keeps a received file for 30 days: an older message is not queued nor tried again. */
const QUEUE_DAYS = 30;
/** Minutes before each new try; the last one repeats until the 30 days end. */
const RETRY_MINUTES = [1, 5, 30, 120, 360, 720, 1440];
/** A copy that stopped half-way (a restart) is tried again after this. */
const LEASE_MINUTES = 10;
/** Answers that will not change on a new try. */
const FINAL = new Set(['too_large', 'no_media_id']);

export interface MediaStoreDeps {
  db: Database;
  storage: ObjectStorage;
  config: WhatsAppConfig;
  fetchImpl: typeof fetch;
  log: (facts: Record<string, unknown>) => void;
  now?: () => Date;
}

export interface MediaStoreResult {
  queued: number;
  stored: number;
  retried: number;
  failed: number;
  deleted: number;
}

const minutesAfter = (at: Date, minutes: number) => new Date(at.getTime() + minutes * 60_000);

export async function storeWhatsAppMedia(
  deps: MediaStoreDeps & { limit?: number },
): Promise<MediaStoreResult> {
  const { db, storage } = deps;
  const now = () => deps.now?.() ?? new Date();
  const result: MediaStoreResult = { queued: 0, stored: 0, retried: 0, failed: 0, deleted: 0 };

  // A message that is gone (deleted with its deal) took its file's link: the object goes, then the row.
  const orphans = await db
    .select({ id: waMessageFiles.id, storageKey: waMessageFiles.storageKey })
    .from(waMessageFiles)
    .where(isNull(waMessageFiles.messageId))
    .limit(100);
  for (const orphan of orphans) {
    try {
      await storage.delete(orphan.storageKey);
      await db.delete(waMessageFiles).where(eq(waMessageFiles.id, orphan.id));
      result.deleted++;
    } catch {
      deps.log({ job: WHATSAPP_MEDIA_JOB, file: orphan.id, error: 'storage_delete' });
    }
  }

  // Every recent message with a file gets its row, whichever door it came in by.
  const at = now();
  const queued = await db.execute<{ id: string }>(sql`
    insert into wa_message_files (message_id, storage_key, next_attempt_at)
    select m.id,
           'whatsapp/' || to_char(${at.toISOString()}::timestamptz at time zone 'UTC', 'YYYY-MM') || '/' || gen_random_uuid(),
           ${at.toISOString()}::timestamptz
    from wa_messages m
    where (m.content -> 'media' ->> 'id') is not null
      and m.created_at > ${new Date(at.getTime() - QUEUE_DAYS * 86_400_000).toISOString()}::timestamptz
      and not exists (select 1 from wa_message_files f where f.message_id = m.id)
    order by m.created_at
    limit 500
    on conflict (message_id) do nothing
    returning id`);
  result.queued = queued.rows.length;

  for (let i = 0; i < (deps.limit ?? 20); i++) {
    const claimedAt = now();
    const claimed = await db.execute<{
      id: string;
      storage_key: string;
      attempts: number;
      media_id: string | null;
      message_at: string;
    }>(sql`
      with claimed as (
        update wa_message_files
        set attempts = attempts + 1,
            next_attempt_at = ${minutesAfter(claimedAt, LEASE_MINUTES).toISOString()}::timestamptz
        where id = (
          select id from wa_message_files
          where status = 'pending' and message_id is not null
            and next_attempt_at <= ${claimedAt.toISOString()}::timestamptz
          order by next_attempt_at limit 1 for update skip locked
        )
        returning id, message_id, storage_key, attempts
      )
      select c.id, c.storage_key, c.attempts, m.content -> 'media' ->> 'id' as media_id,
             m.created_at as message_at
      from claimed c join wa_messages m on m.id = c.message_id`);
    const file = claimed.rows[0];
    if (!file) break;
    const outcome = await copyOne(deps, file.storage_key, file.media_id);
    const doneAt = now();
    if (outcome.ok) {
      await db
        .update(waMessageFiles)
        .set({
          status: 'stored',
          mimeType: outcome.mimeType,
          byteSize: outcome.size,
          storedAt: doneAt,
          lastError: null,
        })
        .where(eq(waMessageFiles.id, file.id));
      result.stored++;
      continue;
    }
    const metaForgot =
      doneAt.getTime() - new Date(file.message_at).getTime() >= QUEUE_DAYS * 86_400_000;
    const giveUp = FINAL.has(outcome.reason) || metaForgot;
    const wait = RETRY_MINUTES[Math.min(file.attempts, RETRY_MINUTES.length) - 1]!;
    await db
      .update(waMessageFiles)
      .set({
        status: giveUp ? 'failed' : 'pending',
        lastError: outcome.reason,
        nextAttemptAt: minutesAfter(doneAt, wait),
      })
      .where(eq(waMessageFiles.id, file.id));
    if (giveUp) result.failed++;
    else result.retried++;
  }
  return result;
}

type CopyOutcome =
  { ok: true; mimeType: string | null; size: number } | { ok: false; reason: string };

async function copyOne(
  deps: MediaStoreDeps,
  storageKey: string,
  mediaId: string | null,
): Promise<CopyOutcome> {
  if (!mediaId) return { ok: false, reason: 'no_media_id' };
  const file = await downloadWhatsAppMedia(deps.fetchImpl, deps.config, mediaId);
  if (!file.ok) {
    // Meta's code, or our own word for what went wrong: never Meta's free text.
    const reason =
      file.code !== null
        ? `meta_${file.code}`
        : file.title === 'too_large' || file.title === 'bad_media_url'
          ? file.title
          : 'media_unavailable';
    return { ok: false, reason };
  }
  try {
    await deps.storage.put(
      storageKey,
      file.data.bytes,
      file.data.mimeType ?? 'application/octet-stream',
    );
  } catch {
    return { ok: false, reason: 'storage_put' };
  }
  return { ok: true, mimeType: file.data.mimeType, size: file.data.bytes.length };
}

// --- the loop -----------------------------------------------------------------------------

export function startWhatsAppMediaStore(deps: MediaStoreDeps & { tickMs?: number }) {
  let running: Promise<void> | null = null;
  const tick = () => {
    if (running) return running;
    running = storeWhatsAppMedia(deps)
      .then((result) => {
        if (result.queued + result.stored + result.retried + result.failed + result.deleted > 0)
          deps.log({ job: WHATSAPP_MEDIA_JOB, ...result });
      })
      .catch((error: unknown) => {
        deps.log({
          job: WHATSAPP_MEDIA_JOB,
          error: error instanceof Error ? error.message.slice(0, 200) : 'unknown',
        });
      })
      .finally(() => {
        running = null;
      });
    return running;
  };
  const timer = setInterval(() => void tick(), deps.tickMs ?? 60_000);
  timer.unref();
  return { runOnce: tick, stop: () => clearInterval(timer) };
}
