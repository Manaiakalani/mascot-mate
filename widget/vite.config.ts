import { defineConfig } from 'vite';
import { resolve } from 'node:path';

export default defineConfig({
  build: {
    lib: {
      entry: resolve(__dirname, 'src/index.ts'),
      name: 'Mascot',
      fileName: (fmt) => (fmt === 'es' ? 'mascot.js' : 'mascot.iife.js'),
      formats: ['es', 'iife'],
    },
    sourcemap: false,
    target: 'es2019',
    minify: 'esbuild',
    rollupOptions: {
      output: { inlineDynamicImports: true },
    },
  },
  server: {
    open: '/demo/index.html',
    // Prevent stale browser cache when sprite sheets / maps are rebuilt.
    headers: {
      'Cache-Control': 'no-store, must-revalidate',
      Pragma: 'no-cache',
      Expires: '0',
    },
  },
});
