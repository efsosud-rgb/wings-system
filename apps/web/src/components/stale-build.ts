/**
 * After a deploy, a tab that still holds the previous build asks for chunk
 * files that no longer exist (404) and the screen it tried to open fails
 * to load. The cure is a reload, so the page picks up the new build — once,
 * with a lock in sessionStorage so a genuinely broken build cannot loop.
 */
const LOCK = 'wings:reloaded-for-new-build';

export function isStaleChunkError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? '');
  return (
    /Failed to fetch dynamically imported module/i.test(message) ||
    /Importing a module script failed/i.test(message) ||
    /error loading dynamically imported module/i.test(message) ||
    /Unable to preload CSS/i.test(message)
  );
}

/** Reloads once per session; returns false when the reload already happened. */
export function reloadOnceForNewBuild(): boolean {
  try {
    if (sessionStorage.getItem(LOCK)) return false;
    sessionStorage.setItem(LOCK, String(Date.now()));
  } catch {
    // Storage blocked: reload anyway, the worst case is one extra load.
  }
  window.location.reload();
  return true;
}

/** Called when the app has loaded fine: the next stale build may reload again. */
export function clearReloadLock(): void {
  try {
    sessionStorage.removeItem(LOCK);
  } catch {
    // nothing to clear
  }
}

export function listenForStaleBuild(): void {
  window.addEventListener('vite:preloadError', (event) => {
    event.preventDefault();
    console.error('Chunk from a previous build failed to load; reloading once.', event);
    reloadOnceForNewBuild();
  });
  // Loaded without a chunk error: arm the lock again after a short while.
  window.setTimeout(clearReloadLock, 10_000);
}
