import cloudflare from '@astrojs/cloudflare';
import { defineConfig } from 'astro/config';

export default defineConfig({
  output: 'server',
  // Keep v6 whitespace handling; the v7 'jsx' default strips the space
  // between adjacent inline elements (pagination, nav links, time ranges).
  compressHTML: true,
  adapter: cloudflare({
    // We don't use astro:assets; keep the build-time image service so the
    // adapter doesn't require a Cloudflare Images binding (the v13 default).
    imageService: 'compile',
  }),
});
