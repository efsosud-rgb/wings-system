import { checkTimelineOps } from '@wings/shared';
import { describe, expect, it } from 'vitest';
import { applyTimelineOps, timelineSnapshot, type TimingOf } from './agent-edit.js';
import type { EditDoc } from './clips.js';
import type { StudioAsset } from './session.js';

/**
 * The agent's operations become the next document, and the timeline it reads
 * carries no link. The core is not involved: `replaceEdit` gets the result.
 */

const VIDEO = '11111111-1111-4111-8111-111111111111';
const PHOTO = '22222222-2222-4222-8222-222222222222';
const output = { width: 1080, height: 1920 };

const assets: StudioAsset[] = [
  {
    id: VIDEO,
    name: 'depoimento.mp4',
    mimeType: 'video/mp4',
    url: 'https://r2.example/abc?X-Amz-Signature=secret',
    kind: 'video',
  },
];

function doc(): EditDoc {
  return {
    timeline: {
      background: '#000000',
      tracks: [
        {
          clips: [
            {
              id: 'title',
              asset: { type: 'rich-text', text: 'Seja franqueado', font: { size: 72 } },
              start: 0,
              length: 4,
              position: 'top',
            },
          ],
        },
        {
          clips: [
            {
              id: 'video',
              asset: { type: 'video', src: assets[0]?.url, volume: 1 },
              start: 0,
              // The core's own words for "as long as the file": resolved through `timing`.
              length: 'auto',
              transition: { in: 'fade', out: 'fadeSlow' },
            },
          ],
        },
      ],
    },
    output: { size: output },
  };
}
const timing: TimingOf = (id) => (id === 'video' ? { start: 0, length: 30 } : null);

describe('the timeline the agent reads', () => {
  it('names files by Drive id and name, resolves auto, and carries no link', () => {
    const snapshot = timelineSnapshot({
      doc: doc(),
      timing,
      assets,
      aspect: '9:16',
      mode: 'video',
      durationSeconds: 30,
      playheadSeconds: 3.456,
      selectedClipId: 'video',
    });
    expect(snapshot.clips).toEqual([
      expect.objectContaining({
        id: 'title',
        track: 0,
        type: 'rich-text',
        text: 'Seja franqueado',
      }),
      expect.objectContaining({
        id: 'video',
        track: 1,
        fileId: VIDEO,
        name: 'depoimento.mp4',
        start: 0,
        length: 30,
        trim: 0,
        volume: 1,
      }),
    ]);
    expect(snapshot.playheadSeconds).toBe(3.46);
    expect(snapshot.files).toEqual([
      { fileId: VIDEO, name: 'depoimento.mp4', mimeType: 'video/mp4', kind: 'video' },
    ]);
    expect(JSON.stringify(snapshot)).not.toMatch(/https?:|Signature/);
  });
});

describe('applying the operations', () => {
  it('splits a clip into two with the right trim, keeping the entrance first and the exit last', () => {
    const next = applyTimelineOps(doc(), [{ op: 'split', clipId: 'video', at: 12 }], {
      timing,
      output,
      placed: {},
    });
    const [first, second] = next.timeline?.tracks?.[1]?.clips ?? [];
    expect(first).toMatchObject({ id: 'video', start: 0, length: 12, transition: { in: 'fade' } });
    expect(second).toMatchObject({
      start: 12,
      length: 18,
      asset: { trim: 12 },
      transition: { out: 'fadeSlow' },
    });
    expect(second?.id).toBeUndefined();
    // The input is left as it was: the session still needs it to undo.
    expect(doc().timeline?.tracks?.[1]?.clips).toHaveLength(1);
  });

  it('removes, retimes, restyles, and puts new text and files on tracks of their own on top', () => {
    const ops = [
      { op: 'set_timing', clipId: 'video', trim: 2, length: 28 },
      { op: 'style', clipId: 'title', text: { content: 'Abra sua franquia', color: '#ffee00' } },
      { op: 'style', clipId: 'video', volume: 0.5, transitionOut: 'fade' },
      { op: 'add_text', text: 'Link na bio', preset: 'subtitle', start: 25, length: 5 },
      { op: 'add_file', fileId: PHOTO, start: 0, length: 3 },
      { op: 'remove', clipId: 'title' },
    ] as const;
    const next = applyTimelineOps(doc(), [...ops], {
      timing,
      output,
      placed: {
        [PHOTO]: { url: 'https://r2.example/photo', kind: 'image', durationSeconds: null },
      },
    });
    const tracks = next.timeline?.tracks ?? [];
    // The title was restyled and then removed: its emptied track goes, the schema refuses it.
    expect(tracks).toHaveLength(3);
    expect(tracks[0]?.clips?.[0]).toMatchObject({
      asset: { type: 'image', src: 'https://r2.example/photo' },
      start: 0,
      length: 3,
    });
    expect(tracks[1]?.clips?.[0]).toMatchObject({
      asset: { type: 'rich-text', text: 'Link na bio' },
      start: 25,
      length: 5,
    });
    expect(tracks[2]?.clips?.[0]).toMatchObject({
      id: 'video',
      start: 0,
      length: 28,
      asset: { trim: 2, volume: 0.5 },
      transition: { in: 'fade', out: 'fade' },
    });
  });

  it('agrees with the shared check on what each operation leaves behind', () => {
    const ops = [
      { op: 'split' as const, clipId: 'video', at: 10 },
      { op: 'set_timing' as const, clipId: 'video', length: 8 },
    ];
    const snapshot = timelineSnapshot({
      doc: doc(),
      timing,
      assets,
      aspect: '9:16',
      mode: 'video',
      durationSeconds: 30,
      playheadSeconds: 0,
      selectedClipId: null,
    });
    expect(checkTimelineOps(ops, snapshot, {}).problems).toEqual([]);
    const next = applyTimelineOps(doc(), ops, { timing, output, placed: {} });
    expect(next.timeline?.tracks?.[1]?.clips?.map((clip) => [clip.start, clip.length])).toEqual([
      [0, 8],
      [10, 20],
    ]);
  });

  it('never skips a clip it cannot find', () => {
    expect(() =>
      applyTimelineOps(doc(), [{ op: 'remove', clipId: 'gone' }], { timing, output, placed: {} }),
    ).toThrow();
  });
});
