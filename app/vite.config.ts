import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    // ★ 5180, not 5173. This value had drifted one port down while three other
    //   surfaces kept saying 5180 (`app/README.md`, `.vscode/tasks.json`,
    //   `VendorSiteMap.tsx`), so `npm run dev` served a URL nobody was looking
    //   at. `strictPort` means a stale literal here is a connection refused, not
    //   a silent fallback to 5174 — which is why the drift was invisible.
    port: 5180,
    strictPort: true,
    // The View Builder is the first screen that needs the API from inside the
    // dev server, so this is the first proxy. Without it, /api/views/preview
    // falls through to the SPA and answers index.html with a 200 — the screen
    // then fails parsing HTML as JSON, which reads as a builder bug rather than
    // a missing proxy. See docs/plans/view-builder.md §10.6.
    //
    // `changeOrigin: false` is deliberate: the API runs on 127.0.0.1:5181 and
    // the request is same-machine, so rewriting the Host header buys nothing.
    // The API is separately protected by HOST=127.0.0.1 and the
    // VIEW_BUILDER_ENABLED gate.
    proxy: {
      '/api': { target: 'http://127.0.0.1:5181', changeOrigin: false },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
    // The extract is fetched from /oracle at runtime, not bundled — see scripts/sync-extract.mjs.
    chunkSizeWarningLimit: 900,
  },
});
