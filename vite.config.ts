import { defineConfig } from 'vite';

export default defineConfig({
  base: '/webgrib/',
  root: '.',
  publicDir: 'public',
  build: {
    target: 'es2022',
    sourcemap: true,
  },
  worker: {
    format: 'es',
  },
  server: {
    port: 5173,
    fs: {
      allow: ['.'],
    },
  },
  resolve: {
    alias: {
      '@grib2': '/src/grib2',
      '@renderer': '/src/renderer',
    },
  },
});
