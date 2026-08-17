// @ts-check
import { defineConfig } from 'astro/config';
import react from '@astrojs/react';
import { BRAND } from './brand.mjs';
import tailwindcss from '@tailwindcss/vite';
import AstroPWA from '@vite-pwa/astro';

export default defineConfig({
  // The dashboard lives at / (nav: "Panel") — catch the URLs people guess.
  // '/ingreso' is the pre-rename inventory URL — kept so bookmarks and any
  // service-worker-cached link still land (Astro emits a precached meta-refresh stub).
  redirects: {
    '/dashboard': '/',
    '/panel': '/',
    '/ingreso': '/inventario',
  },
  integrations: [
    react(),
    AstroPWA({
      registerType: 'autoUpdate',
      manifest: {
        name: BRAND.name,
        short_name: BRAND.name,
        description: 'CRM e inventario — fábrica textil',
        lang: 'es',
        display: 'standalone',
        theme_color: '#221f1a',
        background_color: '#e8e4dc',
        icons: [{ src: '/favicon.svg', sizes: 'any', type: 'image/svg+xml' }],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,woff2}'],
        // The "Compartir PDF" chunk graph (nota-pdf + html2canvas + dompurify,
        // ~625 kB) is reached only from a dynamic import off the checkout-
        // success button — precaching it blocks every first SW install.
        // Fetched once on first real use, then CacheFirst below.
        globIgnores: [
          '**/_astro/nota-pdf.*.js',
          '**/_astro/html2canvas.esm.*.js',
          '**/_astro/purify.es.*.js',
        ],
        navigateFallback: '/',
        // Never intercept CouchDB traffic — sync must hit the network.
        navigateFallbackDenylist: [/^\/db\//],
        // Query params never pick the page here (they only preselect state,
        // e.g. /venta?color=…), so ignore them ALL when matching the
        // precache — otherwise such a navigation misses the cache and the
        // fallback serves the panel instead of the page asked for.
        ignoreURLParametersMatching: [/.*/],
        runtimeCaching: [
          {
            // Same-origin /_astro/ chunk files ONLY — cannot ever match /db/*.
            urlPattern: /^\/_astro\/(nota-pdf|html2canvas\.esm|purify\.es)\.[^/]+\.js$/,
            handler: 'CacheFirst',
            options: { cacheName: 'pdf-share-chunks' },
          },
        ],
      },
    }),
  ],
  vite: {
    plugins: [tailwindcss()],
    server: {
      // Dev convenience: same-origin /db/* proxied to a local CouchDB, mirroring
      // the production Caddy setup. No CouchDB running → sync simply stays offline.
      proxy: {
        '/db': {
          target: 'http://127.0.0.1:5984',
          rewrite: (path) => path.replace(/^\/db/, ''),
        },
      },
    },
  },
});
