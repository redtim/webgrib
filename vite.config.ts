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
    proxy: {
      '/ofs-proxy/thredds': {
        target: 'https://opendap.co-ops.nos.noaa.gov',
        changeOrigin: true,
        rewrite: (path: string) => path.replace(/^\/ofs-proxy/, ''),
      },
      '/ofs-proxy/s3': {
        target: 'https://noaa-nos-ofs-pds.s3.amazonaws.com',
        changeOrigin: true,
        rewrite: (path: string) => path.replace(/^\/ofs-proxy\/s3/, ''),
      },
    },
  },
  resolve: {
    alias: {
      '@grib2': '/src/grib2',
      '@renderer': '/src/renderer',
    },
  },
});
