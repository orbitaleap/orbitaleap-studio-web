// @ts-check
import { defineConfig } from 'astro/config';
import tailwindcss from '@tailwindcss/vite';
import node from '@astrojs/node';
import icon from 'astro-icon';
import sitemap from '@astrojs/sitemap';

import cloudflare from '@astrojs/cloudflare';

// https://astro.build/config
export default defineConfig({
  // Absolute origin for canonical URLs, OpenGraph tags and the sitemap.
  //
  // studio.orbitaleap.com, not orbitaleap.com. This said the latter, and the
  // consequence was live: every page emitted
  // <link rel="canonical" href="https://orbitaleap.com/<path>">, which tells
  // search engines this site is a duplicate of a DIFFERENT one and should be
  // dropped in its favour. For / that asked for the studio homepage to be
  // de-indexed; for /servicios and the rest it pointed at orbitaleap.com URLs
  // that do not exist, so the canonical target was a 404.
  site: 'https://studio.orbitaleap.com',

  // The legal documents are canonical on the parent domain and are served
  // from there for both sites. These paths are kept as permanent redirects
  // rather than deleted outright, because they are already published — the
  // footer of every page linked them, and the cookie banner still does.
  //
  // One set of documents, one URL each. Two copies on two subdomains split the
  // ranking signal between them and, more practically, drift: the pair here
  // already disagreed with the parent's on which cookies this site sets.
  redirects: {
    '/privacidad': { status: 301, destination: 'https://orbitaleap.com/privacidad/' },
    '/cookies': { status: 301, destination: 'https://orbitaleap.com/cookies/' },
    '/aviso-legal': { status: 301, destination: 'https://orbitaleap.com/aviso-legal/' }
  },
  adapter: cloudflare(),
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