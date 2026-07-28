import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const sharedSrc = fileURLToPath(new URL('./packages/shared/src/index.ts', import.meta.url));
const sharedPure = fileURLToPath(new URL('./packages/shared/src/pure.ts', import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      // Longest first: '@session-radar/shared' would otherwise shadow the subpath.
      '@session-radar/shared/pure': sharedPure,
      '@session-radar/shared': sharedSrc,
    },
  },
  test: {
    environment: 'node',
    include: ['packages/*/src/**/*.test.ts'],
    // Each daemon test opens its own SQLite file in an isolated temp home.
    // Forks keep better-sqlite3 handles from leaking between suites.
    pool: 'forks',
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
