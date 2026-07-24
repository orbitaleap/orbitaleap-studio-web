// @ts-check
import { defineConfig } from 'astro/config';
import tailwindcss from '@tailwindcss/vite';
import node from '@astrojs/node';
import icon from 'astro-icon';

import cloudflare from '@astrojs/cloudflare';

// https://astro.build/config
export default defineConfig({
  adapter: cloudflare(),
  i18n: {
    defaultLocale: 'es',
    locales: ['es', 'en'],
  },
  integrations: [icon()],
  vite: {
    plugins: [tailwindcss()]
  }
});