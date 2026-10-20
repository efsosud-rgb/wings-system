import { describe, expect, it } from 'vitest';
import { frameBrake } from './brake.js';

/** Feeds `count` frames `gap` ms apart, starting at `from`; returns the answers and the last time. */
function feed(brake: (now: number) => boolean, from: number, gap: number, count: number) {
  const answers: boolean[] = [];
  let t = from;
  for (let i = 0; i < count; i++) {
    t += gap;
    answers.push(brake(t));
  }
  return { answers, t };
}

describe('frameBrake', () => {
  it('stays quiet at 60 frames per second', () => {
    const { answers } = feed(frameBrake(), 0, 16.7, 600);
    expect(answers.some(Boolean)).toBe(false);
  });

  it('asks for a step once, after 20 warm-up frames and 60 slow ones (33 ms)', () => {
    const { answers } = feed(frameBrake(), 0, 33, 200);
    expect(answers.indexOf(true)).toBe(20 + 60 - 1); // the 80th frame closes the first window
    expect(answers.filter(Boolean)).toHaveLength(2); // warms up again, then asks again
  });

  it('does not count a gap over 250 ms (tab in the background)', () => {
    const brake = frameBrake();
    const first = feed(brake, 0, 16.7, 100);
    const back = feed(brake, first.t + 5000, 16.7, 100);
    expect([...first.answers, ...back.answers].some(Boolean)).toBe(false);
  });

  it('needs the median over 24 ms, not a few slow frames', () => {
    const brake = frameBrake();
    let t = 0;
    const answers: boolean[] = [];
    for (let i = 0; i < 400; i++) {
      t += i % 4 === 0 ? 100 : 16.7; // one frame in four is slow: median stays 16.7
      answers.push(brake(t));
    }
    expect(answers.some(Boolean)).toBe(false);
  });
});
