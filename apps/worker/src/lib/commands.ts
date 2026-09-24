import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** stdout is not printed; a Buffer above could carry a person's data if it
 * were logged, so callers only ever see the parsed result. */
const MAX_BUFFER_BYTES = 64 * 1024 * 1024;

/** `ffprobe`, format and streams, as JSON on stdout. */
export async function runFfprobe(filePath: string): Promise<string> {
  const { stdout } = await run(
    'ffprobe',
    ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', filePath],
    { maxBuffer: MAX_BUFFER_BYTES, timeout: 120_000 },
  );
  return stdout;
}

/** `ffmpeg`, for the render job. Resolves on exit 0; on failure, rejects with
 * exactly `ffmpeg exited with status <code>` — never ffmpeg's stderr, which
 * routinely echoes back the temp file paths it was given. Not given a
 * timeout of its own: the render job enforces `RENDER_TIMEOUT_SECONDS`
 * itself, across the whole attempt, not just the encode. */
export async function runFfmpeg(args: string[]): Promise<void> {
  try {
    await run('ffmpeg', args, { maxBuffer: MAX_BUFFER_BYTES });
  } catch (error) {
    const code = (error as { code?: number | string }).code;
    // `cause` is for local debugging only: nothing reads it into the job's
    // stored error, which stays exactly this sanitized message.
    throw new Error(`ffmpeg exited with status ${typeof code === 'number' ? code : 'unknown'}`, { cause: error });
  }
}

const TRANSCRIBE_SCRIPT = resolve(import.meta.dirname, '../../scripts/transcribe.py');

/** faster-whisper, "small" model, CPU: segments and their times, as JSON on stdout. */
export async function runWhisper(
  filePath: string,
  options: { threads: number; language?: string },
): Promise<string> {
  const args = [TRANSCRIBE_SCRIPT, filePath, '--threads', String(options.threads)];
  if (options.language) args.push('--language', options.language);
  const { stdout } = await run('python3', args, {
    maxBuffer: MAX_BUFFER_BYTES,
    // A small-model CPU transcription can run long on a big file.
    timeout: 30 * 60_000,
  });
  return stdout;
}

const CAPTION_LAYOUT_SCRIPT = resolve(import.meta.dirname, '../../scripts/caption_layout.py');

/** YuNet + PP-OCRv3 detection through OpenCV, CPU: per cue, how busy each caption band is, as JSON on stdout.
 * On failure, rejects with the exit status only: the script's stderr may carry a temp path. */
export async function runCaptionLayout(
  filePath: string,
  cuesPath: string,
  options: { threads: number },
): Promise<string> {
  try {
    const { stdout } = await run('python3', [CAPTION_LAYOUT_SCRIPT, filePath, cuesPath, '--threads', String(options.threads)], {
      maxBuffer: MAX_BUFFER_BYTES,
      // A few frames per cue: minutes even on a long video.
      timeout: 30 * 60_000,
    });
    return stdout;
  } catch (error) {
    const code = (error as { code?: number | string }).code;
    throw new Error(`caption layout exited with status ${typeof code === 'number' ? code : 'unknown'}`, { cause: error });
  }
}
