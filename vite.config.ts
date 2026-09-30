import { defineConfig, type Plugin } from 'vite';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';

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

/**
 * Dev-only endpoint for the icon capture tool (src/demo/iconCapture.ts):
 * POST /__save-icon?id=<layer id> with a JPEG body writes src/demo/icons/<id>.jpg.
 */
function iconSavePlugin(): Plugin {
  const MAX_BYTES = 200_000;
  return {
    name: 'icon-save',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use((req: IncomingMessage, res: ServerResponse, next: () => void) => {
        if (req.method !== 'POST' || !req.url?.startsWith('/__save-icon')) {
          next();
          return;
        }
        const id = new URL(req.url, 'http://localhost').searchParams.get('id') ?? '';
        if (!/^[a-z0-9-]+$/.test(id)) {
          res.writeHead(400);
          res.end('Bad id');
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        req.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size <= MAX_BYTES) chunks.push(chunk);
        });
        req.on('end', () => {
          if (size > MAX_BYTES) {
            res.writeHead(413);
            res.end('Icon too large');
            return;
          }
          mkdir('src/demo/icons', { recursive: true })
            .then(() => writeFile(`src/demo/icons/${id}.jpg`, Buffer.concat(chunks)))
            .then(() => {
              res.writeHead(200);
              res.end('ok');
            })
            .catch((err: Error) => {
              res.writeHead(500);
              res.end(err.message);
            });
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
  plugins: [ofsS3MultiPlugin(), iconSavePlugin()],
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
      '/ofs-proxy/nomads': {
        target: 'https://nomads.ncep.noaa.gov',
        changeOrigin: true,
        rewrite: (path: string) => path.replace(/^\/ofs-proxy\/nomads/, ''),
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
