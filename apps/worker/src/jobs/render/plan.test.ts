import { wingsDriveRef } from '@wings/shared';
import { describe, expect, it } from 'vitest';
import type { RenderJobInput } from './contract.js';
import { buildRenderPlan } from './plan.js';

const VIDEO_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const IMAGE_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function inputWith(project: unknown, assets: RenderJobInput['assets'] = {}): RenderJobInput {
  return {
    version: 1,
    project,
    assets: {
      [VIDEO_ID]: { storageKey: 'drive/2026-09/a.mp4', mimeType: 'video/mp4', byteSize: 1000 },
      [IMAGE_ID]: { storageKey: 'drive/2026-09/b.png', mimeType: 'image/png', byteSize: 500 },
      ...assets,
    },
    output: {
      storageKey: 'drive/2026-09/out.mp4',
      container: 'mp4',
      width: 1080,
      height: 1920,
      fps: 30,
      videoBitrate: 8_000_000,
      audioBitrate: 192_000,
    },
  };
}

function track(clips: unknown[]) {
  return { clips };
}

describe('buildRenderPlan — structural refusals', () => {
  it('refuses a project without a timeline', () => {
    expect(() => buildRenderPlan(inputWith({}))).toThrow(/invalid_project/);
  });

  it('refuses a track whose clip points at something other than a Drive file', () => {
    const project = { timeline: { tracks: [track([{ start: 0, length: 1, asset: { type: 'video', src: 'https://evil.example/x.mp4' } }])] } };
    expect(() => buildRenderPlan(inputWith(project))).toThrow(/invalid_project/);
  });

  it('refuses a clip whose asset id has no entry in "assets"', () => {
    const missingId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    const project = { timeline: { tracks: [track([{ start: 0, length: 1, asset: { type: 'video', src: wingsDriveRef(missingId) } }])] } };
    expect(() => buildRenderPlan(inputWith(project))).toThrow(/invalid_project/);
  });

  it('refuses a project with nothing renderable', () => {
    const project = { timeline: { tracks: [track([{ start: 0, length: 1, asset: { type: 'shape' } }])] } };
    expect(() => buildRenderPlan(inputWith(project))).toThrow(/invalid_project/);
  });
});

describe('buildRenderPlan — draw order', () => {
  it('composites bottom track first: the array\'s last track draws before its first', () => {
    const project = {
      timeline: {
        tracks: [
          track([{ start: 0, length: 5, asset: { type: 'video', src: wingsDriveRef(VIDEO_ID) } }]), // top
          track([{ start: 0, length: 5, asset: { type: 'image', src: wingsDriveRef(IMAGE_ID) } }]), // bottom
        ],
      },
    };
    const plan = buildRenderPlan(inputWith(project));
    expect(plan.visual.map((clip) => clip.kind)).toEqual(['image', 'video']);
  });
});

describe('buildRenderPlan — what the doc covers', () => {
  it('resolves fit, scale, position, offset, opacity and fade transitions', () => {
    const project = {
      timeline: {
        background: '#112233',
        tracks: [
          track([
            {
              start: 2,
              length: 10,
              asset: { type: 'video', src: wingsDriveRef(VIDEO_ID), trim: 1, volume: 0.5 },
              fit: 'contain',
              scale: 0.5,
              position: 'bottomRight',
              offset: { x: 0.1, y: -0.2 },
              opacity: 0.8,
              transition: { in: 'fade', out: 'fadeFast' },
            },
          ]),
        ],
      },
    };
    const plan = buildRenderPlan(inputWith(project));
    expect(plan.background).toBe('#112233');
    expect(plan.totalDurationSeconds).toBe(12);
    expect(plan.visual).toEqual([
      expect.objectContaining({
        kind: 'video',
        start: 2,
        length: 10,
        trim: 1,
        fit: 'contain',
        scale: 0.5,
        position: 'bottomRight',
        offsetX: 0.1,
        offsetY: -0.2,
        opacity: 0.8,
        transitionIn: 'fade',
        transitionOut: 'fadeFast',
      }),
    ]);
    expect(plan.audio).toEqual([expect.objectContaining({ start: 2, length: 10, trim: 1, volume: 0.5 })]);
    expect(plan.unsupported).toEqual([]);
  });

  it('mutes a video clip\'s own audio at volume 0', () => {
    const project = {
      timeline: {
        tracks: [track([{ start: 0, length: 3, asset: { type: 'video', src: wingsDriveRef(VIDEO_ID), volume: 0 } }])],
      },
    };
    const plan = buildRenderPlan(inputWith(project));
    expect(plan.audio).toEqual([]);
  });
});

describe('buildRenderPlan — unsupported, decorative, never fatal', () => {
  it('marks an unknown clip type unsupported and omits it, without failing the job', () => {
    const project = {
      timeline: {
        tracks: [
          track([
            { start: 0, length: 3, asset: { type: 'video', src: wingsDriveRef(VIDEO_ID) } },
            { start: 0, length: 3, asset: { type: 'luma', src: wingsDriveRef(IMAGE_ID) } },
          ]),
        ],
      },
    };
    const plan = buildRenderPlan(inputWith(project));
    expect(plan.visual).toHaveLength(1);
    expect(plan.unsupported).toEqual([expect.stringContaining('luma')]);
  });

  it('turns an animated (tween) opacity into its first value and notes it', () => {
    const project = {
      timeline: {
        tracks: [
          track([
            {
              start: 0,
              length: 3,
              asset: { type: 'video', src: wingsDriveRef(VIDEO_ID) },
              opacity: [{ from: 0, to: 0.6 }],
            },
          ]),
        ],
      },
    };
    const plan = buildRenderPlan(inputWith(project));
    expect(plan.visual[0]).toMatchObject({ opacity: 0.6 });
    expect(plan.unsupported).toEqual([expect.stringContaining('opacity')]);
  });

  it('falls back an unsupported transition to a hard cut', () => {
    const project = {
      timeline: {
        tracks: [
          track([
            {
              start: 0,
              length: 3,
              asset: { type: 'video', src: wingsDriveRef(VIDEO_ID) },
              transition: { in: 'wipeLeft' },
            },
          ]),
        ],
      },
    };
    const plan = buildRenderPlan(inputWith(project));
    expect(plan.visual[0]).toMatchObject({ transitionIn: 'none' });
    expect(plan.unsupported).toEqual([expect.stringContaining('wipeLeft')]);
  });

  it('falls back an uninstalled font to the default and notes it', () => {
    const project = {
      timeline: {
        tracks: [track([{ start: 0, length: 3, asset: { type: 'text', text: 'Oi', font: { family: 'Comic Sans' } } }])],
      },
    };
    const plan = buildRenderPlan(inputWith(project));
    expect(plan.visual[0]).toMatchObject({ kind: 'text', fontFamily: 'DejaVu Sans' });
    expect(plan.unsupported).toEqual([expect.stringContaining('fonte')]);
  });

  it('drops an empty text clip without touching the rest of the plan', () => {
    const project = {
      timeline: {
        tracks: [
          track([
            { start: 0, length: 3, asset: { type: 'video', src: wingsDriveRef(VIDEO_ID) } },
            { start: 0, length: 3, asset: { type: 'text', text: '' } },
          ]),
        ],
      },
    };
    const plan = buildRenderPlan(inputWith(project));
    expect(plan.visual).toEqual([expect.objectContaining({ kind: 'video' })]);
  });
});
