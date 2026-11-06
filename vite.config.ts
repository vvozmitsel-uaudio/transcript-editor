import { defineConfig } from 'vitest/config';

// LUNA loads Add Ons from file:// on Windows, where module scripts are blocked. So the page is
// not a Vite app: src/main.ts and everything it imports build into one classic script (an
// IIFE) at dist/main.js, which index.html loads after vendor/luna.global.js. CSS that src/
// imports lands in dist/main.css; link it from index.html.
export default defineConfig(({ mode }) => ({
  publicDir: false,
  // A library build leaves process.env.NODE_ENV in place, and React and others read it.
  define: { 'process.env.NODE_ENV': JSON.stringify(mode) },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: true, // for LUNA's web inspector; ua-builder pack leaves maps out
    target: 'es2022',
    lib: { entry: 'src/main.ts', formats: ['iife'], name: 'AddOn', fileName: () => 'main.js', cssFileName: 'main' },
  },
  test: { include: ['tests/**/*.test.ts'], environment: 'node', setupFiles: ['tests/setup.ts'] },
}));
