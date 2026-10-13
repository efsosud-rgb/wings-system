import { describe, expect, it } from 'vitest';
import { FRAME_ANCESTORS, withFrameAncestors } from './frame-guard.js';

describe('withFrameAncestors', () => {
  it('is the whole policy when the route set none', () => {
    expect(withFrameAncestors(undefined)).toBe(FRAME_ANCESTORS);
    expect(withFrameAncestors('')).toBe(FRAME_ANCESTORS);
  });

  it("keeps a route's own policy and adds the frame rule to it", () => {
    // The WhatsApp media route serves files under a sandbox.
    expect(withFrameAncestors("sandbox; default-src 'none'")).toBe(
      "sandbox; default-src 'none'; frame-ancestors 'self'",
    );
  });

  it('leaves a policy that already says who may frame it', () => {
    expect(withFrameAncestors("default-src 'none'; frame-ancestors 'none'")).toBe(
      "default-src 'none'; frame-ancestors 'none'",
    );
  });
});
