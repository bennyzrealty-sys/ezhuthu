import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';
import { precacheManifest } from './scripts/precache';

export default defineConfig({
  // A GitHub Pages project site serves the app from /<repo>/, not from the
  // origin root. Everything the app asks the network for is therefore built
  // relative to `import.meta.env.BASE_URL` rather than to `/` — see ADR-0034.
  // Unset means root, which is what Vercel and `vite dev` want.
  base: process.env.BASE_PATH ?? '/',
  plugins: [react(), precacheManifest()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  build: {
    target: 'es2022',
    sourcemap: true,
  },
  worker: {
    format: 'es',
  },
  preview: {
    // Cross-origin isolation, which `measureUserAgentSpecificMemory()` requires.
    // Preview-only: this is what the perf suite runs against, and the memory
    // budget is otherwise unmeasurable. Not applied to the production build,
    // which has no need for it.
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
});
