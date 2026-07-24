// @ts-check
import { defineConfig } from 'astro/config';
import tailwindcss from '@tailwindcss/vite';
import node from '@astrojs/node';

// https://astro.build/config
export default defineConfig({
  adapter: node({
    mode: 'standalone'
  }),
  i18n: {
    defaultLocale: 'es',
    locales: ['es', 'en'],
  },
  vite: {
    plugins: [tailwindcss()]
  }
});