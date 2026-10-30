import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { WA_VOICE_MAX_BYTES, WA_VOICE_MAX_SECONDS } from '@wings/shared';

/**
 * A recording from the browser turned into a WhatsApp voice note (docs/whatsapp/cloud-api.md,
 * "Gravar áudio"): OGG with the OPUS codec, mono, the format Meta shows as a voice message
 * ("voice": true). ffmpeg runs on temporary files (Safari's MP4 cannot always be read from a pipe)
 * that are removed whatever happens; its stderr is never logged or returned, since it echoes paths.
 */

const run = promisify(execFile);

/** 20 kbit/s keeps three minutes under the 512 KB Meta plays inline. */
const VOICE_ARGS = ['-vn', '-map_metadata', '-1', '-ac', '1', '-ar', '48000', '-c:a', 'libopus'];
const VOICE_QUALITY = ['-b:a', '20k', '-vbr', 'constrained', '-application', 'voip'];

export type VoiceNote =
  | { ok: true; bytes: Buffer; seconds: number }
  | { ok: false; why: 'unreadable' | 'too_long' | 'too_large' | 'unavailable' };

export async function toVoiceNote(recording: Buffer): Promise<VoiceNote> {
  const dir = await mkdtemp(join(tmpdir(), 'wings-voice-'));
  try {
    const input = join(dir, 'in');
    const output = join(dir, 'out.ogg');
    await writeFile(input, recording);
    try {
      await run(
        'ffmpeg',
        ['-hide_banner', '-loglevel', 'error', '-nostdin', '-i', input]
          // Cut past the limit: enough to see a recording is too long, never an hour converted.
          .concat(['-t', String(WA_VOICE_MAX_SECONDS + 2), ...VOICE_ARGS, ...VOICE_QUALITY])
          .concat(['-f', 'ogg', '-y', output]),
        { timeout: 60_000, maxBuffer: 1024 * 1024 },
      );
    } catch (error) {
      return {
        ok: false,
        why: (error as { code?: unknown }).code === 'ENOENT' ? 'unavailable' : 'unreadable',
      };
    }
    const bytes = await readFile(output);
    const seconds = oggOpusSeconds(bytes);
    if (seconds === null || seconds <= 0) return { ok: false, why: 'unreadable' };
    // The browser stops at the limit; a second of slack covers its timer.
    if (seconds > WA_VOICE_MAX_SECONDS + 1) return { ok: false, why: 'too_long' };
    if (bytes.length > WA_VOICE_MAX_BYTES) return { ok: false, why: 'too_large' };
    return { ok: true, bytes, seconds: Math.round(seconds) };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * The length of an OGG/OPUS file, from its own pages: the last page's granule position (always
 * counted at 48 kHz for OPUS) minus the pre-skip in the OpusHead. Null when it is not OGG/OPUS.
 */
export function oggOpusSeconds(bytes: Buffer): number | null {
  const head = bytes.indexOf('OpusHead');
  if (head < 0 || head + 12 > bytes.length || !bytes.subarray(0, 4).equals(OGG_PAGE)) return null;
  const preSkip = bytes.readUInt16LE(head + 10);
  const last = bytes.lastIndexOf(OGG_PAGE);
  if (last < 0 || last + 14 > bytes.length) return null;
  const granule = bytes.readBigInt64LE(last + 6);
  if (granule < 0n) return null;
  return (Number(granule) - preSkip) / 48_000;
}

const OGG_PAGE = Buffer.from('OggS');

/** "audio-whatsapp-2026-10-30-153012.ogg", in São Paulo time: the name in the deal's files. */
export function voiceFileName(at: Date): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(at);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((p) => p.type === type)?.value ?? '00';
  return `audio-whatsapp-${part('year')}-${part('month')}-${part('day')}-${part('hour')}${part('minute')}${part('second')}.ogg`;
}
