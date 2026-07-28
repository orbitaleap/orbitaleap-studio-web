// @ts-check
import { defineConfig } from 'astro/config';
import tailwindcss from '@tailwindcss/vite';
import node from '@astrojs/node';
import icon from 'astro-icon';
import sitemap from '@astrojs/sitemap';

// https://astro.build/config
export default defineConfig({
  // Absolute origin for canonical URLs, OpenGraph tags and the sitemap. Without
  // it those fell back to a hardcoded string in Layout.astro.
  site: 'https://orbitaleap.com',
  adapter: node({
    mode: 'standalone'
  }),
  i18n: {
    defaultLocale: 'es',
    locales: ['es', 'en'],
  },
  integrations: [
    icon(),
    // /launch is an ads landing page and carries noindex, so keep it out of
    // the sitemap rather than inviting a crawl that is then told to go away.
    sitemap({ filter: (page) => !page.includes('/launch') }),
  ],
  vite: {
    plugins: [tailwindcss()]
  }
});