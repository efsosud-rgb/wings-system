const WARMUP = 20; // frames ignored at the start and after each step down
const WINDOW = 60; // frames in one measurement
const MAX_GAP = 250; // ms: a longer gap is a tab in the background, not a slow frame
const SLOW_MEDIAN = 24; // ms: a median over this is under ~40 frames per second

/**
 * The scene's frame-time brake. Call the returned function with each frame's timestamp (ms): it
 * answers true when the median gap of the last 60 frames is over 24 ms, and then warms up again.
 */
export function frameBrake() {
  let prev = 0;
  let warm = 0;
  let gaps: number[] = [];
  return (now: number): boolean => {
    const gap = now - prev;
    prev = now;
    if (gap > MAX_GAP || ++warm <= WARMUP) return false;
    gaps.push(gap);
    if (gaps.length < WINDOW) return false;
    gaps.sort((a, b) => a - b);
    const median = (gaps[WINDOW / 2 - 1]! + gaps[WINDOW / 2]!) / 2;
    gaps = [];
    if (median <= SLOW_MEDIAN) return false;
    warm = 0;
    return true;
  };
}
