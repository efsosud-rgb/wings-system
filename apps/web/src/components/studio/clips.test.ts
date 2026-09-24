import { STUDIO_ASPECT_KEYS } from '@wings/shared';
import { describe, expect, it, vi } from 'vitest';
import { emptyEdit, friendlyCoreError, withCleanSize } from './clips.js';

/**
 * What the core is handed at "Novo": nothing on the timeline and a size with
 * only width and height. On staging the format's label leaked into
 * `output.size` and the editor refused to open with a wall of JSON.
 */
describe('emptyEdit', () => {
  it('has no track and a size with width and height only, in every format', () => {
    for (const aspect of STUDIO_ASPECT_KEYS) {
      const doc = emptyEdit(aspect) as unknown as {
        timeline: { tracks: unknown[] };
        output: { size: Record<string, unknown> };
      };
      expect(doc.timeline.tracks).toEqual([]);
      expect(Object.keys(doc.output.size).sort()).toEqual(['height', 'width']);
    }
  });

  it('strips whatever a saved file put into output.size', () => {
    const doc = withCleanSize({
      output: { size: { width: 1080, height: 1350, label: 'Retrato (4:5)' } },
    });
    expect(doc.output.size).toEqual({ width: 1080, height: 1350 });
  });
});

describe('friendlyCoreError', () => {
  it("turns the core's JSON issues into one sentence and logs the detail", () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const raw = '[{"code":"too_small","path":["timeline","tracks"],"message":"Too small"}]';
    const text = friendlyCoreError(new Error(raw), 'fallback');
    expect(text).toMatch(/^O projeto não pôde ser montado/);
    expect(text).not.toContain('too_small');
    expect(spy).toHaveBeenCalledWith('studio core validation', raw);
    spy.mockRestore();
  });

  it('leaves an ordinary message alone', () => {
    expect(friendlyCoreError(new Error('O arquivo do projeto não pôde ser lido.'), 'x')).toBe(
      'O arquivo do projeto não pôde ser lido.',
    );
    expect(friendlyCoreError('?', 'fallback')).toBe('fallback');
  });
});

describe('clipFor', () => {
  it('gives a video or audio clip the length the browser measured, and only falls back to auto', async () => {
    const { clipFor } = await import('./clips.js');
    expect(clipFor('video', 'https://x/v', 2, { durationSeconds: 84.16 })).toMatchObject({
      start: 2,
      length: 84.16,
    });
    expect(clipFor('audio', 'https://x/a', 0, { durationSeconds: 12.345 })).toMatchObject({
      length: 12.35,
    });
    expect(clipFor('video', 'https://x/v', 0, { durationSeconds: null })).toMatchObject({
      length: 'auto',
    });
    expect(clipFor('video', 'https://x/v', 0, { durationSeconds: Number.NaN })).toMatchObject({
      length: 'auto',
    });
    // Images never depend on a measurement.
    expect(clipFor('image', 'https://x/i', 0, { durationSeconds: 84 })).toMatchObject({
      length: 5,
    });
  });
});

describe('captions', () => {
  const vertical = { width: 1080, height: 1920 };

  it('are born large, in the lower third, on a translucent band, two lines tall', async () => {
    const { captionClip, captionStyleFor } = await import('./clips.js');
    expect(captionStyleFor(vertical)).toEqual({
      fontFamily: 'Work Sans',
      size: 96,
      color: '#ffffff',
      placement: 'bottom',
      backgroundColor: '#000000',
      backgroundOpacity: 0.55,
    });
    const clip = captionClip('https://x/legenda.srt', vertical) as unknown as Record<
      string,
      unknown
    >;
    expect(clip).toMatchObject({
      start: 0,
      length: 'end',
      width: 972,
      position: 'bottom',
      offset: { x: 0, y: 0.06 },
      asset: {
        type: 'rich-caption',
        src: 'https://x/legenda.srt',
        font: { family: 'Work Sans', size: 96, color: '#ffffff', weight: 600 },
        background: { color: '#000000', opacity: 0.55, wrap: true },
        align: { horizontal: 'center', vertical: 'middle' },
      },
    });
    // Two lines of 96 px at 1.3 line height, plus the padding above and below.
    expect(clip['height']).toBe(Math.round(96 * 1.3 * 2 + 34 * 2));
    // An SRT from the Drive is the same clip.
    const { clipFor } = await import('./clips.js');
    expect(clipFor('subtitle', 'https://x/legenda.srt', 0, { output: vertical })).toEqual(clip);
  });

  it('reads the style back for the panel and writes a patch onto the asset and the box', async () => {
    const { captionClip, captionStyleOf, updatesFor } = await import('./clips.js');
    const clip = captionClip('https://x/legenda.srt', vertical) as unknown as Record<
      string,
      unknown
    >;
    expect(captionStyleOf(clip)).toMatchObject({
      size: 96,
      placement: 'bottom',
      backgroundOpacity: 0.55,
    });

    const updates = updatesFor(
      {
        caption: {
          fontFamily: 'Montserrat',
          size: 60,
          placement: 'top',
          color: '#ffee00',
          backgroundOpacity: 0,
        },
      },
      clip,
      vertical,
    ) as unknown as Record<string, unknown>;
    expect(updates).toMatchObject({
      position: 'top',
      offset: { x: 0, y: -0.06 },
      width: 972,
      asset: {
        font: { family: 'Montserrat', size: 60, color: '#ffee00', weight: 600 },
        background: { color: '#000000', opacity: 0 },
      },
    });
    expect(updates['height']).toBe(Math.round(60 * 1.3 * 2 + 21 * 2));
    // The chosen font reads back for the panel.
    expect(
      captionStyleOf({ ...clip, asset: updates['asset'] as Record<string, unknown> }),
    ).toMatchObject({ fontFamily: 'Montserrat' });
    // A text patch on a caption changes nothing: captions are edited through `caption`.
    expect(updatesFor({ text: { text: 'x' } }, clip, vertical)).toEqual({});
  });
});

describe('captionClip placement', () => {
  it('puts a smart caption file in its zone', async () => {
    const { captionClip } = await import('./clips.js');
    const output = { width: 1080, height: 1920 };
    const top = captionClip('https://x/a.legenda-em-cima.srt', output, 'top') as unknown as {
      position: string;
    };
    const middle = captionClip('https://x/a.legenda-no-meio.srt', output, 'middle') as unknown as {
      position: string;
    };
    const bottom = captionClip('https://x/a.srt', output) as unknown as { position: string };
    expect([top.position, middle.position, bottom.position]).toEqual(['top', 'center', 'bottom']);
  });
});
