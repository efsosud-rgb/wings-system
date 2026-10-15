/**
 * The page's text fonts are data URIs in its CSS (the approved page's choice),
 * but Chrome decodes such a font only once the first layout asks for it: the
 * first frame could show the fallback font and reflow a moment later (a layout
 * shift of the whole hero). Registering the same bytes through the FontFace API
 * from the render-blocking module makes them ready before that first frame.
 * Anything unexpected leaves the CSS to load them as before.
 */

const DATA_WOFF2 = /url\(\s*["']?data:font\/woff2;base64,([A-Za-z0-9+/=]+)["']?\s*\)/;

function bytesOf(base64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

const unquote = (value: string) => value.trim().replace(/^["']|["']$/g, '');

/** Registers the inlined faces of these families; returns how many were added. */
export function primeInlineFonts(families: readonly string[], doc: Document = document): number {
  if (typeof FontFace !== 'function' || !doc.fonts) return 0;
  let added = 0;
  for (const sheet of Array.from(doc.styleSheets)) {
    let rules: CSSRuleList;
    try {
      rules = sheet.cssRules;
    } catch {
      continue;
    }
    for (const rule of Array.from(rules)) {
      if (!(rule instanceof CSSFontFaceRule)) continue;
      const family = unquote(rule.style.getPropertyValue('font-family'));
      const data = DATA_WOFF2.exec(rule.style.getPropertyValue('src'))?.[1];
      if (!families.includes(family) || !data) continue;
      try {
        const face = new FontFace(family, bytesOf(data), {
          weight: rule.style.getPropertyValue('font-weight') || 'normal',
          style: rule.style.getPropertyValue('font-style') || 'normal',
          display: 'swap',
        });
        doc.fonts.add(face);
        added += 1;
      } catch {
        // the CSS face still loads it
      }
    }
  }
  return added;
}
