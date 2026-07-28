import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The daemon serves this bundle from its own origin, so everything is relative
// and there is no proxy in production. In dev, Vite proxies the API through.
export default defineConfig({
  plugins: [react()],
  base: './',
  resolve: {
    alias: {
      '@session-radar/shared/pure': fileURLToPath(
        new URL('../shared/src/pure.ts', import.meta.url),
      ),
      '@session-radar/shared': fileURLToPath(new URL('../shared/src/index.ts', import.meta.url)),
    },
  },
  build: { outDir: 'dist', emptyOutDir: true, sourcemap: true },
  server: {
    port: 5173,
    proxy: { '/api': 'http://127.0.0.1:4747' },
  },
});
