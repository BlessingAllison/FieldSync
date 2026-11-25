import path from 'node:path';
import { fileURLToPath } from 'node:url';

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

import pkg from './package.json' with { type: 'json' };

const root = path.dirname(fileURLToPath(import.meta.url));
// Host-run API (make dev-api) listens on 8001 so it never collides with other local stacks.
const apiTarget = process.env.FIELDSYNC_API_URL ?? 'http://127.0.0.1:8001';

export default defineConfig({
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  plugins: [
    react(),
    VitePWA({
      // injectManifest: we own the SW source (src/sw.ts) because it runs the sync engine.
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.ts',
      registerType: 'prompt',
      injectRegister: false, // registered by src/pwa/sw-registration.ts (workbox-window)
      manifest: {
        id: '/',
        name: 'FieldSync',
        short_name: 'FieldSync',
        description:
          'Offline-first health data collection for County Health Teams (demonstration).',
        lang: 'en',
        dir: 'ltr',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        orientation: 'portrait',
        theme_color: '#0b4f55',
        background_color: '#f6f6f1',
        categories: ['medical', 'productivity'],
        icons: [
          { src: 'pwa-64x64.png', sizes: '64x64', type: 'image/png' },
          { src: 'pwa-192x192.png', sizes: '192x192', type: 'image/png' },
          { src: 'pwa-512x512.png', sizes: '512x512', type: 'image/png' },
          {
            src: 'maskable-icon-512x512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
      injectManifest: {
        globPatterns: ['**/*.{js,css,html,svg,png,ico,webmanifest}'],
        // Anything larger than this is a bundle-budget bug, not something to precache.
        maximumFileSizeToCacheInBytes: 600 * 1024,
      },
      devOptions: { enabled: false },
    }),
  ],
  resolve: { alias: { '@': path.resolve(root, 'src') } },
  build: {
    // Chrome 87 is the device floor (ADD §4): Android 7–9 handsets are frozen on old Chrome.
    target: ['chrome87', 'edge88', 'firefox78', 'safari14'],
    sourcemap: true,
    assetsInlineLimit: 0, // no data: URIs — keeps CSP img-src tight and caching per-file
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: { '/api': { target: apiTarget, changeOrigin: false } },
  },
  preview: {
    port: 4173,
    strictPort: true,
    proxy: { '/api': { target: apiTarget, changeOrigin: false } },
  },
});
