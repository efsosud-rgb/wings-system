import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import type { Job } from '../queue.js';
import type { JobHandler } from './types.js';

/**
 * Reuniões (docs/crm/reunioes-api.md): the recording of a meeting, transcribed
 * on our own server with faster-whisper (the Studio's script), in Portuguese.
 * The text goes into the meeting row, never into the job output or a log; the
 * analysis is then queued for the API, which owns the model and its ceiling.
 *
 * Speaker separation is a later step: until it is on, every segment has
 * `speaker: null` and the row says why.
 */

const inputSchema = z.object({ meetingId: z.uuid() });

const SPEAKERS_OFF =
  'A separação de quem falou ainda não está ligada no servidor; nomeie as vozes quando ela chegar.';

interface WhisperRaw {
  language: string;
  durationSeconds: number;
  segments: { start: number; end: number; text: string }[];
}

export const runTranscribeMeetingJob: JobHandler = async (job: Job, ctx) => {
  const { meetingId } = inputSchema.parse(job.input);
  const found = await ctx.db.query<{ recording_key: string | null }>(
    `update crm_meetings set transcript_state = 'transcrevendo', transcript_error = null, updated_at = now()
      where id = $1 and recording_state = 'guardada' returning recording_key`,
    [meetingId],
  );
  const key = found.rows[0]?.recording_key;
  if (!key) throw new Error('meeting without a stored recording');

  const fail = (reason: string) =>
    ctx.db.query(
      `update crm_meetings set transcript_state = 'falhou', transcript_error = $2, updated_at = now() where id = $1`,
      [meetingId, reason],
    );

  const dir = await mkdtemp(join(tmpdir(), 'wings-meeting-'));
  try {
    const file = join(dir, 'input');
    if (!(await ctx.storage.download(key, file))) {
      await fail('A gravação não está no armazenamento');
      throw new Error('recording missing from storage');
    }
    let output: string;
    try {
      // A meeting can last hours: up to 3 h of CPU time for its transcription.
      output = await ctx.runWhisper(file, {
        threads: ctx.threads,
        language: 'pt',
        timeoutMs: 3 * 3_600_000,
      });
    } catch (error) {
      await fail('A transcrição falhou no servidor; envie a gravação de novo');
      // execFile's message carries whisper's stderr and the error its stdout: only the
      // code goes into the message (the job record keeps the message, never the cause).
      const code = (error as { code?: unknown; signal?: unknown }).code ?? (error as { signal?: unknown }).signal;
      throw new Error(`whisper failed (${typeof code === 'number' || typeof code === 'string' ? code : 'unknown'})`, {
        cause: error,
      });
    }
    let raw: WhisperRaw;
    try {
      raw = JSON.parse(output) as WhisperRaw;
    } catch {
      // A parse error quotes the input, which is the transcript: never into the job record.
      await fail('A transcrição falhou no servidor; envie a gravação de novo');
      throw new Error('whisper output is not the expected JSON');
    }
    const transcript = {
      language: raw.language,
      durationSeconds: Math.round(raw.durationSeconds),
      segments: raw.segments.map((s) => ({
        start: Math.round(s.start * 10) / 10,
        end: Math.round(s.end * 10) / 10,
        speaker: null,
        text: s.text.trim(),
      })),
    };
    await ctx.db.query(
      `update crm_meetings
          set transcript = $2, transcript_state = 'pronta', speakers = '[]'::jsonb, speakers_reason = $3,
              recording_duration_seconds = $4,
              analysis_state = case when analysis_state = 'nenhuma' then 'na_fila' else analysis_state end,
              updated_at = now()
        where id = $1`,
      [meetingId, JSON.stringify(transcript), SPEAKERS_OFF, transcript.durationSeconds],
    );
    // Only numbers in the job's own record: the words stay on the meeting.
    return {
      meetingId,
      segments: transcript.segments.length,
      durationSeconds: transcript.durationSeconds,
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};
