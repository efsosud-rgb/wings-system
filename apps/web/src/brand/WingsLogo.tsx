import { LOGO_VIEWBOX, logoPaths, type WingsLogoVariant } from './wings-logo.js';

interface WingsLogoProps {
  /** `principal` on light backgrounds, `negativo` on dark; `simbolo` for small spaces. */
  variant?: WingsLogoVariant;
  /** Height in CSS pixels; the width follows the logo's own proportion (never distorted). */
  height?: number;
  className?: string;
}

/** The official Wings logo as inline SVG. Not editable: pick a variant, nothing else. */
export function WingsLogo({ variant = 'principal', height = 40, className }: WingsLogoProps) {
  const simbolo = variant === 'simbolo';
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox={simbolo ? LOGO_VIEWBOX.simbolo : LOGO_VIEWBOX.full}
      role="img"
      aria-label={simbolo ? 'Wings' : 'Wings Company'}
      height={height}
      className={className}
      style={{ width: 'auto', display: 'block' }}
    >
      {logoPaths(variant).map((path, index) => (
        <path key={index} fill={path.fill} d={path.d} />
      ))}
    </svg>
  );
}
