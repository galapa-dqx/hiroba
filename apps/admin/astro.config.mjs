import cloudflare from '@astrojs/cloudflare';
import react from '@astrojs/react';
import { defineConfig } from 'astro/config';

export default defineConfig({
  output: 'server',
  // Keep v6 whitespace handling; the v7 'jsx' default strips the space
  // between adjacent inline elements.
  compressHTML: true,
  adapter: cloudflare({
    imageService: 'compile',
  }),
  integrations: [react()],
});
