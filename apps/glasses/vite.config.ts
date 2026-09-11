import { defineConfig } from 'vite';

export default defineConfig({
  // The Even App loads the bundle from an arbitrary path inside the .ehpk, so
  // every asset reference has to be relative.
  base: './',
  server: {
    // `evenhub qr` points the glasses at this machine's LAN address.
    host: true,
    port: 5173,
  },
  build: {
    target: 'es2020',
    outDir: 'dist',
    emptyOutDir: true,
    // One file is friendlier to the WebView's cold start than a module graph.
    rollupOptions: { output: { manualChunks: undefined } },
  },
});
