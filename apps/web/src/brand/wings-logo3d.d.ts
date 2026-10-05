/** Types for the vendored wings-logo3d.js (sha256 in the brand hand-off). Since 05/10 its studio environment lives in studio-environment.js, shared with the 3D charts, so the file no longer matches that hash byte for byte. */
export interface WingsLogo3DOptions {
  /** `light` for light backgrounds (WINGS in black), `dark` for dark ones (WINGS in silver). */
  variant?: 'light' | 'dark';
  /** Draw the COMPANY line under the logo. */
  company?: boolean;
  motion?: 'full' | 'subtle';
  intro?: boolean;
  interactive?: boolean;
  /** Share of the canvas the logo fills. */
  fit?: number;
  onFallback?: ((error: unknown) => void) | null;
}

export class WingsLogo3D {
  constructor(canvas: HTMLCanvasElement, options?: WingsLogo3DOptions);
  dispose(): void;
}

export function supportsWebGL(): boolean;
