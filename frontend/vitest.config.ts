import { defineConfig, mergeConfig } from 'vitest/config';

import viteConfig from './vite.config';

export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      include: ['src/**/*.test.{ts,tsx}', 'scripts/**/*.test.mjs'],
      environment: 'jsdom',
      // core/ runs in the SW too: test it in Node (real Web Crypto, no DOM).
      environmentMatchGlobs: [['src/core/**', 'node']],
      setupFiles: ['src/test/setup.ts'],
      restoreMocks: true,
      coverage: { provider: 'v8', include: ['src/**'], exclude: ['src/**/*.gen.*'] },
    },
  }),
);
