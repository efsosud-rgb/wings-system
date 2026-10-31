import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

const CONTAINERS = {
  // What Chrome and Firefox record: OPUS in WebM or OGG.
  webm: ['-c:a', 'libopus', '-f', 'webm'],
  ogg: ['-c:a', 'libopus', '-f', 'ogg'],
  // What Safari records: AAC in a fragmented MP4 (no index at the start).
  mp4: ['-c:a', 'aac', '-movflags', 'frag_keyframe+empty_moov', '-f', 'mp4'],
} as const;

/**
 * A made-up recording for the voice tests: a stereo tone of the given length, in the container a
 * browser records in. Made with the same ffmpeg the API converts with; no voice, no person.
 */
export async function fakeRecording(
  seconds: number,
  container: keyof typeof CONTAINERS = 'webm',
): Promise<Buffer> {
  const { stdout } = await run(
    'ffmpeg',
    ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi']
      .concat(['-i', `sine=frequency=440:duration=${seconds}`, '-ac', '2'])
      .concat([...CONTAINERS[container], 'pipe:1']),
    { encoding: 'buffer', maxBuffer: 32 * 1024 * 1024 },
  );
  return stdout;
}
