import { defineConfig, minimal2023Preset } from '@vite-pwa/assets-generator/config';

// `npm run gen:icons` renders public/icon.svg into the PNG set referenced by the manifest.
export default defineConfig({
  headLinkOptions: { preset: '2023' },
  preset: minimal2023Preset,
  images: ['public/icon.svg'],
});
