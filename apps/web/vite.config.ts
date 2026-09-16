import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist',
    sourcemap: false,
  },
  server: {
    port: 5173,
    // In development the API runs separately; in staging/production Traefik
    // routes /api on the same domain, so the frontend never needs CORS.
    proxy: {
      '/api': 'http://127.0.0.1:3000',
    },
  },
});
