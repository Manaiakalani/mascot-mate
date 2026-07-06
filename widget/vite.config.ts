import { defineConfig, type Plugin } from 'vite';
import { resolve } from 'node:path';
import { readdirSync, existsSync, mkdirSync, copyFileSync } from 'node:fs';

/**
 * Vite's library mode always base64-inlines statically-imported assets
 * (assetsInlineLimit is ignored in `build.lib`), so importing the mascot
 * sprite sheets via `import.meta.glob(..., { eager: true })` baked every
 * mascot's PNG into the JS bundle regardless of which one is active. Instead,
 * this plugin copies the raw PNGs next to the built JS as sibling files;
 * `src/index.ts` resolves each mascot's sprite URL at runtime relative to the
 * script's own location, so the browser only fetches the sheet for the
 * mascot actually rendered.
 */
function copyMascotSprites(): Plugin {
  const mascotsDir = resolve(__dirname, 'src/mascots');
  let outDir = resolve(__dirname, 'dist');
  return {
    name: 'copy-mascot-sprites',
    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir);
    },
    closeBundle() {
      if (!existsSync(mascotsDir)) return;
      for (const entry of readdirSync(mascotsDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const src = resolve(mascotsDir, entry.name, 'map.png');
        if (!existsSync(src)) {
          console.warn(`[mascot] "${entry.name}" has no map.png — sprite would 404 at runtime.`);
          continue;
        }
        const destDir = resolve(outDir, 'mascots', entry.name);
        mkdirSync(destDir, { recursive: true });
        copyFileSync(src, resolve(destDir, 'map.png'));
      }
    },
  };
}

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
  },
  plugins: [copyMascotSprites()],
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

