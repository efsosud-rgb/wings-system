/**
 * The wing's points (scripts/wing-points.mjs): little-endian int16 pairs x, y,
 * 4 bytes per point, scaled by 32000, so each coordinate lands in [-0.5, 0.5]
 * with y up. Decoded exactly as the approved page did.
 */
export const WING_POINT_SCALE = 32000;

export function decodeWingPoints(base64: string): Float32Array {
  const bin = atob(base64);
  const count = Math.floor(bin.length / 4);
  const wing = new Float32Array(count * 2);
  for (let i = 0; i < count; i++) {
    const xi = bin.charCodeAt(4 * i) | (bin.charCodeAt(4 * i + 1) << 8);
    const yi = bin.charCodeAt(4 * i + 2) | (bin.charCodeAt(4 * i + 3) << 8);
    wing[2 * i] = ((xi << 16) >> 16) / WING_POINT_SCALE;
    wing[2 * i + 1] = ((yi << 16) >> 16) / WING_POINT_SCALE;
  }
  return wing;
}
