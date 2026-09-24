import { describe, expect, it } from 'vitest';
import {
  agentTimelineEditProposalSchema,
  checkTimelineOps,
  studioTimelineSnapshotSchema,
  type StudioTimelineSnapshot,
} from './studio-agent.js';

const FILE = '11111111-1111-4111-8111-111111111111';

const snapshot: StudioTimelineSnapshot = {
  aspect: '9:16',
  mode: 'video',
  durationSeconds: 30,
  playheadSeconds: 0,
  selectedClipId: null,
  clips: [
    {
      id: 'v1',
      track: 1,
      type: 'video',
      fileId: FILE,
      name: 'entrevista.mp4',
      start: 0,
      length: 30,
      trim: null,
      text: null,
      position: 'center',
      opacity: 1,
      volume: 1,
    },
    {
      id: 't1',
      track: 0,
      type: 'rich-text',
      fileId: null,
      name: null,
      start: 0,
      length: 5,
      trim: null,
      text: 'Seja franqueado',
      position: 'top',
      opacity: 1,
      volume: null,
    },
  ],
  files: [{ fileId: FILE, name: 'entrevista.mp4', mimeType: 'video/mp4', kind: 'video' }],
};
const files = { [FILE]: { name: 'entrevista.mp4', kind: 'video' as const } };

describe('timeline edit proposals', () => {
  it('describe each operation in Portuguese, walking them in order', () => {
    const { problems, lines } = checkTimelineOps(
      [
        { op: 'split', clipId: 'v1', at: 12 },
        { op: 'set_timing', clipId: 'v1', trim: 2 },
        { op: 'style', clipId: 't1', text: { content: 'Abra sua franquia', color: '#ffffff' } },
        { op: 'add_text', text: 'Link na bio', preset: 'subtitle', start: 25, length: 5 },
        { op: 'add_file', fileId: FILE, start: 30 },
        { op: 'remove', clipId: 't1' },
      ],
      snapshot,
      files,
    );
    expect(problems).toEqual([]);
    expect(lines).toEqual([
      'Divide vídeo "entrevista.mp4" (0,0 s a 30,0 s) em 12,0 s',
      // After the split the first half is 12 s long.
      'vídeo "entrevista.mp4" (0,0 s a 12,0 s): pula os primeiros 2,0 s do arquivo',
      'texto "Seja franqueado" (0,0 s a 5,0 s): texto "Abra sua franquia", cor #ffffff',
      'Novo texto "Link na bio" de 25,0 s a 30,0 s',
      'Adiciona vídeo "entrevista.mp4" em 30,0 s',
      'Remove texto "Abra sua franquia" (0,0 s a 5,0 s)',
    ]);
  });

  it('refuse what cannot be applied, saying why', () => {
    const { problems } = checkTimelineOps(
      [
        { op: 'remove', clipId: 't1' },
        { op: 'remove', clipId: 't1' },
        { op: 'split', clipId: 'v1', at: 40 },
        { op: 'set_timing', clipId: 'nope', start: 1 },
        { op: 'style', clipId: 'v1', caption: { size: 60 } },
        { op: 'add_file', fileId: '22222222-2222-4222-8222-222222222222', start: 0 },
        { op: 'add_file', fileId: FILE, start: 0, length: 3 },
      ],
      snapshot,
      files,
    );
    expect(problems).toHaveLength(6);
    expect(problems[0]).toMatch(/operação 2: .*já foi removido/);
    expect(problems[1]).toMatch(/operação 3: 40,0 s fica fora/);
    expect(problems[2]).toMatch(/operação 4: o clipe "nope"/);
    expect(problems[3]).toMatch(/operação 5: "caption" muda só legendas/);
    expect(problems[4]).toMatch(/operação 6: o arquivo não está/);
    expect(problems[5]).toMatch(/operação 7: vídeo entra com a duração do arquivo/);
  });

  it('take add_file by one id only, and never an empty change', () => {
    const parse = (ops: unknown[]) =>
      agentTimelineEditProposalSchema.safeParse({ explanation: 'x', ops }).success;
    expect(parse([{ op: 'add_file', start: 0 }])).toBe(false);
    expect(parse([{ op: 'add_file', fileId: FILE, mediaAssetId: FILE, start: 0 }])).toBe(false);
    expect(parse([{ op: 'add_file', mediaAssetId: FILE, start: 0 }])).toBe(true);
    expect(parse([{ op: 'set_timing', clipId: 'v1' }])).toBe(false);
    expect(parse([{ op: 'style', clipId: 'v1' }])).toBe(false);
    // Nothing outside the list: a field the schema does not know is refused.
    expect(parse([{ op: 'remove', clipId: 'v1', src: 'https://x' }])).toBe(false);
    expect(parse([{ op: 'generate', prompt: 'x' }])).toBe(false);
  });

  it('accept a view with no link in it and refuse one too big', () => {
    expect(studioTimelineSnapshotSchema.safeParse(snapshot).success).toBe(true);
    const many = { ...snapshot, clips: Array.from({ length: 81 }, () => snapshot.clips[0]) };
    expect(studioTimelineSnapshotSchema.safeParse(many).success).toBe(false);
  });
});
