import { defineConfig, type Plugin } from 'vite';
import type { IncomingMessage, ServerResponse } from 'node:http';

/**
 * Vite plugin that handles /ofs-proxy/s3-multi requests by fanning out
 * byte-range fetches to S3 in parallel and returning the concatenated result.
 * This mirrors what the Cloudflare Worker does in production.
 */
function ofsS3MultiPlugin(): Plugin {
  return {
    name: 'ofs-s3-multi',
    configureServer(server) {
      server.middlewares.use((req: IncomingMessage, res: ServerResponse, next: () => void) => {
        if (!req.url?.startsWith('/ofs-proxy/s3-multi')) {
          next();
          return;
        }

        const url = new URL(req.url, 'http://localhost');
        const file = url.searchParams.get('file');
        const ranges = url.searchParams.get('r');
        if (!file || !ranges) {
          res.writeHead(400);
          res.end('Missing file or r param');
          return;
        }

        const specs = ranges.split(',').map((s) => {
          const [o, l] = s.split(':');
          return { offset: parseInt(o!, 10), length: parseInt(l!, 10) };
        });

        const s3Url = `https://noaa-nos-ofs-pds.s3.amazonaws.com/${file}`;

        Promise.all(
          specs.map(({ offset, length }) =>
            globalThis.fetch(s3Url, {
              headers: { Range: `bytes=${offset}-${offset + length - 1}` },
            }).then((r) => r.arrayBuffer()),
          ),
        ).then((buffers) => {
          const total = buffers.reduce((s, b) => s + b.byteLength, 0);
          const combined = new Uint8Array(total);
          let pos = 0;
          for (const buf of buffers) {
            combined.set(new Uint8Array(buf), pos);
            pos += buf.byteLength;
          }
          res.writeHead(200, {
            'Content-Type': 'application/octet-stream',
            'Content-Length': String(total),
          });
          res.end(Buffer.from(combined.buffer));
        }).catch((err: Error) => {
          res.writeHead(502);
          res.end(err.message);
        });
      });
    },
  };
}

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
  plugins: [ofsS3MultiPlugin()],
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
