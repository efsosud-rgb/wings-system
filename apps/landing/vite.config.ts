import { existsSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig, type Plugin } from 'vite';

/**
 * Static landing pages, one folder per slug: `<slug>/index.html` builds to
 * `dist/<slug>/index.html`, and nginx serves it at `/<slug>` (and at `/` for
 * the hosts LANDING_ROOT_SLUGS names). Shared code lives in `src/lib`, each
 * page's own code in `src/pages/<slug>/`.
 */

const root = import.meta.dirname;
const NOT_PAGES = new Set(['dist', 'e2e', 'node_modules', 'public', 'scripts', 'src']);
const SLUG = /^[a-z0-9][a-z0-9-]*$/;

export function pageInputs(dir: string): Record<string, string> {
  const pages: Record<string, string> = {};
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory() || NOT_PAGES.has(entry.name) || !SLUG.test(entry.name)) continue;
    const html = resolve(dir, entry.name, 'index.html');
    if (existsSync(html)) pages[entry.name] = html;
  }
  return pages;
}

/** Fonts inlined as data URIs, so the first frame already has them (the approved page's choice). */
const INLINE_FONTS = ['limelight-latin-400-normal.woff2', 'nunito-latin-wght-normal.woff2'];

/**
 * The page's module renders nothing until it has run (`blocking="render"`), so
 * the first frame is the finished one: no words that split after a paint, no
 * form line that fills in late. Browsers without the attribute just ignore it.
 */
function renderBlockingEntry(): Plugin {
  return {
    name: 'wings-render-blocking-entry',
    apply: 'build',
    transformIndexHtml: {
      order: 'post',
      handler: (html) =>
        html.replace(
          /<script type="module" crossorigin src=/g,
          '<script type="module" crossorigin blocking="render" src=',
        ),
    },
  };
}

export default defineConfig({
  root,
  base: '/',
  plugins: [renderBlockingEntry()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
    // three.js is the scene chunk (~570 kB, ~160 kB gzip), loaded after the first paint.
    chunkSizeWarningLimit: 650,
    assetsInlineLimit: (file) =>
      INLINE_FONTS.some((name) => file.endsWith(name))
        ? true
        : file.endsWith('.woff2')
          ? false
          : undefined,
    rolldownOptions: {
      input: pageInputs(root),
    },
  },
  server: {
    port: 5174,
    // In development the API runs on :3000; production calls it across origins (LANDING_API_BASE).
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:3000',
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
    },
  },
});
