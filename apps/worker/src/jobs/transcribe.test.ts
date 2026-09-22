import { describe, expect, it } from 'vitest';
import type { Job } from '../queue.js';
import { baseContext } from '../test/context.js';
import { createMemoryStorage } from '../test/memory-storage.js';
import type { JobContext } from './types.js';
import { runTranscribeJob, siblingTranscriptKey } from './transcribe.js';

const WHISPER_JSON = JSON.stringify({
  language: 'pt',
  languageProbability: 0.98,
  durationSeconds: 30.5,
  segments: [
    { start: 0, end: 2.5, text: 'Olá, Wings.' },
    { start: 2.5, end: 5, text: 'Este é um teste.' },
  ],
});

function contextWith(overrides: Partial<JobContext> = {}): JobContext {
  return baseContext({
    threads: 2,
    runWhisper: async () => WHISPER_JSON,
    ...overrides,
  });
}

describe('siblingTranscriptKey', () => {
  it('replaces the extension, keeping the same folder', () => {
    expect(siblingTranscriptKey('drive/2026-09/a.mp4')).toBe('drive/2026-09/a.transcript.json');
  });

  it('appends when there is no extension to replace', () => {
    expect(siblingTranscriptKey('drive/2026-09/a')).toBe('drive/2026-09/a.transcript.json');
  });
});

describe('the transcribe job', () => {
  it('downloads the file, runs whisper, and saves the transcript next to it in the Drive', async () => {
    const storage = createMemoryStorage({ 'drive/2026-09/a.mp4': Buffer.from('fake audio bytes') });
    let whisperArgs: { filePath?: string; threads?: number; language?: string } = {};
    const job: Job = {
      id: '1',
      type: 'transcribe',
      input: { storageKey: 'drive/2026-09/a.mp4', language: 'pt' },
      attempts: 1,
    };

    const output = await runTranscribeJob(
      job,
      contextWith({
        storage,
        threads: 4,
        runWhisper: async (filePath, options) => {
          whisperArgs = { filePath, ...options };
          return WHISPER_JSON;
        },
      }),
    );

    expect(whisperArgs).toMatchObject({ threads: 4, language: 'pt' });
    expect(whisperArgs.filePath).toMatch(/wings-transcribe-/);
    expect(output).toEqual({
      outputStorageKey: 'drive/2026-09/a.transcript.json',
      language: 'pt',
      languageProbability: 0.98,
      durationSeconds: 30.5,
      segments: [
        { start: 0, end: 2.5, text: 'Olá, Wings.' },
        { start: 2.5, end: 5, text: 'Este é um teste.' },
      ],
    });

    const saved = await storage.get('drive/2026-09/a.transcript.json');
    expect(saved && JSON.parse(saved.toString())).toEqual({
      language: 'pt',
      languageProbability: 0.98,
      segments: [
        { start: 0, end: 2.5, text: 'Olá, Wings.' },
        { start: 2.5, end: 5, text: 'Este é um teste.' },
      ],
    });
  });

  it('refuses a job whose file is not in storage', async () => {
    const job: Job = { id: '1', type: 'transcribe', input: { storageKey: 'drive/missing.mp4' }, attempts: 1 };
    await expect(runTranscribeJob(job, contextWith())).rejects.toThrow(/not in storage/);
  });
});
