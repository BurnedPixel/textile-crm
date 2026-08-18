// @ts-check
import { defineConfig } from 'astro/config';
import react from '@astrojs/react';
import { BRAND } from './brand.mjs';
import tailwindcss from '@tailwindcss/vite';
import AstroPWA from '@vite-pwa/astro';

export default defineConfig({
  // CSP note (audit S-1): script-src drops 'unsafe-inline' via sha256 hashes
  // of the inline scripts Astro emits (island bootstrap, HOTKEYS), computed at
  // DEPLOY time by scripts/csp-hashes.py and set in the Caddy header. Astro's
  // experimental.csp was tried and reverted: its <meta> also hashes style-src,
  // and hashes can never cover the style="" ATTRIBUTES the React islands use —
  // the meta policy blocked them on every page (intersection with the header),
  // with no config to opt styles out. Header-only hashing has none of that.
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
        // The "Compartir PDF"/"Imprimir" chunk graph (nota-pdf + informe-pdf +
        // their shared jspdf chunk + html2canvas + dompurify) is reached only
        // from dynamic imports off the checkout-success and informes buttons —
        // precaching it blocks every first SW install. Fetched once on first
        // real use, then CacheFirst below. informe-pdf.ts joining nota-pdf.ts
        // as a second jspdf importer split jspdf into its OWN shared chunk
        // (was bundled inside nota-pdf.*.js before) — both new chunk names
        // needed adding here or ~390 kB silently re-entered precache.
        globIgnores: [
          '**/_astro/nota-pdf.*.js',
          '**/_astro/informe-pdf.*.js',
          '**/_astro/jspdf.es.min.*.js',
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
            urlPattern: /^\/_astro\/(nota-pdf|informe-pdf|jspdf\.es\.min|html2canvas\.esm|purify\.es)\.[^/]+\.js$/,
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
