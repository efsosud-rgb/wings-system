/**
 * "Só as que o worker tem instaladas" (docs/studio/jobs.md): the render image
 * ships exactly one typeface (`fonts-dejavu-core` in docker/worker.Dockerfile,
 * a font always present on Debian, never downloaded at render time). Any
 * other family name the editor sends is `unsupported` and falls back to it.
 */
export const DEFAULT_FONT_FAMILY = 'DejaVu Sans';
const INSTALLED_FONTS: Record<string, string> = {
  'dejavu sans': '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
  'dejavu sans bold': '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
};
const DEFAULT_FONT_PATH = INSTALLED_FONTS['dejavu sans']!;

export interface ResolvedFont {
  family: string;
  path: string;
  /** Set when `requested` did not name an installed font. */
  fellBack: boolean;
}

export function resolveFont(requested: string | undefined): ResolvedFont {
  if (!requested) return { family: DEFAULT_FONT_FAMILY, path: DEFAULT_FONT_PATH, fellBack: false };
  const path = INSTALLED_FONTS[requested.trim().toLowerCase()];
  if (path) return { family: requested, path, fellBack: false };
  return { family: DEFAULT_FONT_FAMILY, path: DEFAULT_FONT_PATH, fellBack: true };
}
