import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

const api = process.env.API_ORIGIN ?? 'http://localhost:3000';
// Same paths the Fastify app serves; the SPA's own routes never start with these.
const apiPaths = [
  '/auth',
  '/oauth',
  '/.well-known',
  '/providers',
  '/graveyard',
  '/stats',
  '/settings',
  '/submissions',
  '/follows',
  '/admin',
  '/telegram',
  '/health',
  '/docs',
  '/openapi.json',
];

export default defineConfig({
  plugins: [react()],
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  server: {
    port: 5173,
    proxy: {
      ...Object.fromEntries(apiPaths.map((path) => [path, { target: api }])),
      '^/mcp(?:\\?|$)': { target: api },
    },
  },
  build: { outDir: 'dist', assetsDir: 'assets' },
});
