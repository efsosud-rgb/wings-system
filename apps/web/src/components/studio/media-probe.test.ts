import { describe, expect, it } from 'vitest';
import { probeMediaDuration } from './media-probe.js';

/** jsdom never loads media, so the element's events are fired by hand. */
function documentWith(behaviour: (element: HTMLMediaElement) => void): Document {
  const created: HTMLMediaElement[] = [];
  const doc = {
    createElement(kind: string) {
      const element = document.createElement(kind) as HTMLMediaElement;
      created.push(element);
      queueMicrotask(() => behaviour(element));
      return element;
    },
  } as unknown as Document;
  return doc;
}

describe('probeMediaDuration', () => {
  it('answers the duration the metadata carries', async () => {
    const doc = documentWith((element) => {
      Object.defineProperty(element, 'duration', { value: 84.16, configurable: true });
      element.dispatchEvent(new Event('loadedmetadata'));
    });
    expect(await probeMediaDuration('https://x/v', 'video', { document: doc })).toBe(84.16);
  });

  it('answers null for a file the browser cannot read, an endless one, or one that never answers', async () => {
    const failing = documentWith((element) => element.dispatchEvent(new Event('error')));
    expect(await probeMediaDuration('https://x/v', 'video', { document: failing })).toBeNull();

    const endless = documentWith((element) => {
      Object.defineProperty(element, 'duration', { value: Number.POSITIVE_INFINITY, configurable: true });
      element.dispatchEvent(new Event('loadedmetadata'));
    });
    expect(await probeMediaDuration('https://x/v', 'audio', { document: endless })).toBeNull();

    const silent = documentWith(() => undefined);
    expect(await probeMediaDuration('https://x/v', 'video', { document: silent, timeoutMs: 20 })).toBeNull();
  });
});
