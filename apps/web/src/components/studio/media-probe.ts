/**
 * The real length of a video or audio file, read by the browser from the
 * file's own metadata before the clip is made. The clip is then born with
 * that length, instead of the core guessing one while the file still loads
 * (on staging an 83-second video landed as 8 s, then 3 s).
 *
 * `null` when the browser could not read it (a codec it cannot play, a link
 * that expired): the caller falls back to the core's `auto` and says so.
 */
export function probeMediaDuration(
  url: string,
  kind: 'video' | 'audio',
  options: { timeoutMs?: number; document?: Document } = {},
): Promise<number | null> {
  const doc = options.document ?? (typeof document === 'undefined' ? null : document);
  if (!doc) return Promise.resolve(null);
  return new Promise((resolve) => {
    const element = doc.createElement(kind);
    let settled = false;
    const finish = (value: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      element.removeAttribute('src');
      try {
        element.load();
      } catch {
        // Some browsers throw on load() after the source was removed; nothing to keep.
      }
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), options.timeoutMs ?? 15_000);
    element.preload = 'metadata';
    element.crossOrigin = 'anonymous';
    element.addEventListener('loadedmetadata', () => {
      const duration = element.duration;
      finish(Number.isFinite(duration) && duration > 0 ? duration : null);
    });
    element.addEventListener('error', () => finish(null));
    element.src = url;
  });
}
