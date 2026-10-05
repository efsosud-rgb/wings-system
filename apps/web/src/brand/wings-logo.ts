import { LOGO, type WingsLogoPath } from './wings-logo-paths.js';

/**
 * The only four forms the brand manual allows: the logo may not be altered,
 * distorted or recoloured beyond these. Light backgrounds take `principal`,
 * dark ones `negativo`; `laranja` is the manual's alternative 2 for black;
 * `simbolo` (the winged S) is for the favicon and the collapsed menu.
 */
export type WingsLogoVariant = 'principal' | 'negativo' | 'laranja' | 'simbolo';

export const BRAND_ORANGE = '#E95228';

const FILL: Record<WingsLogoVariant, (path: WingsLogoPath) => string> = {
  principal: (p) => (p.part === 'S' ? BRAND_ORANGE : '#000000'),
  negativo: (p) => (p.part === 'S' ? BRAND_ORANGE : '#FFFFFF'),
  laranja: () => BRAND_ORANGE,
  simbolo: () => BRAND_ORANGE,
};

export const LOGO_VIEWBOX = {
  full: `0 0 ${LOGO.w} ${LOGO.h}`,
  simbolo: '197.371 0 75.102 69.73',
} as const;

export function logoPaths(variant: WingsLogoVariant): { d: string; fill: string }[] {
  const paths = variant === 'simbolo' ? LOGO.paths.filter((p) => p.part === 'S') : LOGO.paths;
  return paths.map((p) => ({ d: p.d, fill: FILL[variant](p) }));
}

/** The exact markup of the official files (one line, newline at the end). */
export function logoSvgString(variant: WingsLogoVariant): string {
  const simbolo = variant === 'simbolo';
  const viewBox = simbolo ? LOGO_VIEWBOX.simbolo : LOGO_VIEWBOX.full;
  const label = simbolo ? 'Wings' : 'Wings Company';
  const body = logoPaths(variant)
    .map((p) => `<path fill="${p.fill}" d="${p.d}"/>`)
    .join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}" role="img" aria-label="${label}">${body}</svg>\n`;
}
