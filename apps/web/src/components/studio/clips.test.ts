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
