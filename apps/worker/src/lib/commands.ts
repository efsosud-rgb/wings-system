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
