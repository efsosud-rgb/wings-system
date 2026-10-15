import { describe, expect, it } from 'vitest';
import { WING_POINTS_B64 } from '../generated/wing-points.js';
import { decodeWingPoints } from './wing-points.js';

describe('wing points', () => {
  const wing = decodeWingPoints(WING_POINTS_B64);

  it('hold 6000 points, every coordinate in [-0.5, 0.5]', () => {
    expect(wing.length).toBe(6000 * 2);
    expect(wing.every((value) => Number.isFinite(value) && Math.abs(value) <= 0.5)).toBe(true);
  });

  it('fill the box along its larger side, centred', () => {
    const xs = wing.filter((_, i) => i % 2 === 0);
    const ys = wing.filter((_, i) => i % 2 === 1);
    const span = (values: Float32Array) => Math.max(...values) - Math.min(...values);
    expect(Math.max(span(xs), span(ys))).toBeGreaterThan(0.97);
    expect(Math.abs(Math.max(...xs) + Math.min(...xs))).toBeLessThan(0.02);
    expect(Math.abs(Math.max(...ys) + Math.min(...ys))).toBeLessThan(0.02);
  });

  it('decode little-endian signed pairs as the approved page did', () => {
    // x = -16000 (0x80C1 LE), y = 16000 (0x803E LE)
    const one = btoa(String.fromCharCode(0x80, 0xc1, 0x80, 0x3e));
    expect([...decodeWingPoints(one)]).toEqual([-0.5, 0.5]);
  });
});
