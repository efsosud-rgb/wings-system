import { describe, expect, it } from 'vitest';
import { parseRenderInput, RenderError } from './contract.js';

const validInput = {
  version: 1,
  project: { timeline: { tracks: [] } },
  assets: {
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa': {
      storageKey: 'drive/2026-09/a.mp4',
      mimeType: 'video/mp4',
      byteSize: 1000,
    },
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

describe('parseRenderInput', () => {
  it('accepts a well-formed job input', () => {
    const parsed = parseRenderInput(validInput);
    expect(parsed.output.storageKey).toBe('drive/2026-09/out.mp4');
    expect(parsed.assets['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa']?.byteSize).toBe(1000);
  });

  it.each([
    ['not an object', 'string input'],
    [{ ...validInput, version: 2 }, 'wrong version'],
    [{ ...validInput, project: 'nope' }, 'project not an object'],
    [{ ...validInput, assets: 'nope' }, 'assets not an object'],
    [{ ...validInput, assets: { x: { storageKey: '', mimeType: 'video/mp4', byteSize: 1 } } }, 'asset with empty storageKey'],
    [{ ...validInput, assets: { x: { mimeType: 'video/mp4', byteSize: 1 } } }, 'asset missing storageKey'],
    [{ ...validInput, output: { ...validInput.output, container: 'mov' } }, 'output with a container other than mp4'],
    [{ ...validInput, output: { ...validInput.output, width: '1080' } }, 'output width not a number'],
  ])('rejects %#: %s', (bad: unknown, _description: string) => {
    expect(() => parseRenderInput(bad)).toThrow(RenderError);
    expect(() => parseRenderInput(bad)).toThrow(/^invalid_project:/);
  });
});
