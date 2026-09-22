import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import dts from 'vite-plugin-dts';
import { aliases } from './vite.shared';

// One ES bundle with every dependency inside (Pixi, mediabunny, howler…), so
// the web app only ever imports "@wings/studio" — lazily, from the Studio tab.
export default defineConfig({
  define: { 'process.env.NODE_ENV': JSON.stringify('production') },
  worker: { format: 'es' },
  resolve: { alias: aliases(import.meta.dirname) },
  plugins: [
    dts({
      rollupTypes: false,
      outDir: 'dist',
      pathsToAliases: true,
      exclude: ['tests', 'vitest.config.ts', 'vite.config.ts', 'vite.shared.ts'],
    }),
  ],
  build: {
    target: 'esnext',
    sourcemap: false,
    minify: true,
    lib: {
      entry: resolve(import.meta.dirname, 'src/index.ts'),
      formats: ['es'],
      fileName: () => 'wings-studio.js',
    },
    rollupOptions: {
      // Node-only entry points of shotstack-canvas; the web entry is aliased in.
      external: (id) => id.startsWith('@napi-rs/') || id === 'canvas',
      output: { inlineDynamicImports: true },
    },
  },
});
