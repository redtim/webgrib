/**
 * Cloudflare Worker — CORS proxy for NOAA OPeNDAP / THREDDS and S3.
 *
 * Supports two upstream backends:
 *   /thredds/...  → opendap.co-ops.nos.noaa.gov (OPeNDAP)
 *   /s3/...       → noaa-nos-ofs-pds.s3.amazonaws.com (S3, with Range support)
 *
 * Deploy:  npx wrangler deploy
 * Test:    curl https://<worker>.workers.dev/thredds/dodsC/NOAA/SFBOFS/...
 *          curl -H "Range: bytes=0-1000" https://<worker>.workers.dev/s3/sfbofs/netcdf/...
 */

const UPSTREAMS = {
  '/thredds/': 'https://opendap.co-ops.nos.noaa.gov',
  '/s3/': 'https://noaa-nos-ofs-pds.s3.amazonaws.com',
};

// Allowed origins for CORS — restrict to your app's domains
const ALLOWED_ORIGINS = [
  'https://redtim.github.io',
  'http://localhost:5173',
  'http://localhost:4173',
];

export default {
  async fetch(request) {
    const origin = request.headers.get('Origin') || '';
    const allowOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];

    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: corsHeaders(allowOrigin),
      });
    }

    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response('Method not allowed', { status: 405, headers: corsHeaders(allowOrigin) });
    }

    const url = new URL(request.url);

    // Normalize path and validate — prevent path traversal
    const normalized = new URL(url.pathname, 'https://dummy').pathname;
    if (normalized.includes('..')) {
      return new Response('Not found', { status: 404 });
    }

    // ---- /s3-multi: batch multiple byte-range fetches into one response ----
    // Query params:
    //   file  = S3 key (e.g. sfbofs/netcdf/2026/04/13/sfbofs.t03z...nc)
    //   r     = comma-separated offset:length pairs (e.g. 5879557:182820,7890577:182820)
    // Response: concatenated raw bytes from each range, in order.
    if (normalized === '/s3-multi') {
      return handleS3Multi(url, request.method, allowOrigin);
    }

    // ---- Standard proxy: route to upstream based on path prefix ----
    let upstream = null;
    let strippedPath = normalized;
    for (const [prefix, host] of Object.entries(UPSTREAMS)) {
      if (normalized.startsWith(prefix)) {
        upstream = host;
        // For /thredds/, keep the prefix (it's part of the real path)
        // For /s3/, strip the prefix
        if (prefix === '/s3/') {
          strippedPath = '/' + normalized.slice(prefix.length);
        }
        break;
      }
    }

    if (!upstream) {
      return new Response('Not found', { status: 404 });
    }

    const target = upstream + strippedPath + url.search;

    try {
      // Forward Range header for S3 byte-range requests
      const fetchHeaders = {
        'User-Agent': 'gribwebview-proxy/1.0',
        'Accept': request.headers.get('Accept') || '*/*',
      };
      const rangeHeader = request.headers.get('Range');
      if (rangeHeader) {
        fetchHeaders['Range'] = rangeHeader;
      }

      const upstreamResp = await fetch(target, {
        method: request.method,
        headers: fetchHeaders,
      });

      const responseHeaders = {
        'Content-Type': upstreamResp.headers.get('Content-Type') || 'application/octet-stream',
        'Cache-Control': 'public, max-age=300',
        ...corsHeaders(allowOrigin),
      };
      const contentLength = upstreamResp.headers.get('Content-Length');
      if (contentLength) {
        responseHeaders['Content-Length'] = contentLength;
      }
      const contentRange = upstreamResp.headers.get('Content-Range');
      if (contentRange) {
        responseHeaders['Content-Range'] = contentRange;
      }
      const acceptRanges = upstreamResp.headers.get('Accept-Ranges');
      if (acceptRanges) {
        responseHeaders['Accept-Ranges'] = acceptRanges;
      }

      return new Response(upstreamResp.body, {
        status: upstreamResp.status,
        statusText: upstreamResp.statusText,
        headers: responseHeaders,
      });
    } catch {
      return new Response('Upstream unavailable', {
        status: 502,
        headers: corsHeaders(allowOrigin),
      });
    }
  },
};

/**
 * Batch-fetch multiple byte ranges from a single S3 file in parallel,
 * returning the concatenated bytes in one response.
 *
 * This moves the fan-out from the browser (limited to 6 connections per
 * origin on HTTP/1.1) to the worker (no such limit to S3).
 */
async function handleS3Multi(url, method, allowOrigin) {
  const file = url.searchParams.get('file');
  const ranges = url.searchParams.get('r');
  if (!file || !ranges) {
    return new Response('Missing file or r param', { status: 400, headers: corsHeaders(allowOrigin) });
  }

  // Validate file path — only allow paths under expected S3 prefixes
  if (file.includes('..') || !file.match(/^[a-zA-Z0-9_/.\-]+$/)) {
    return new Response('Invalid file path', { status: 400, headers: corsHeaders(allowOrigin) });
  }

  // Parse ranges: "offset:length,offset:length,..."
  const parts = ranges.split(',');
  const rangeSpecs = [];
  for (const part of parts) {
    const [offStr, lenStr] = part.split(':');
    const offset = parseInt(offStr, 10);
    const length = parseInt(lenStr, 10);
    if (!Number.isFinite(offset) || !Number.isFinite(length) || offset < 0 || length <= 0) {
      return new Response('Invalid range spec', { status: 400, headers: corsHeaders(allowOrigin) });
    }
    rangeSpecs.push({ offset, length });
  }

  const s3Base = UPSTREAMS['/s3/'];
  const s3Url = `${s3Base}/${file}`;

  try {
    // Fetch all ranges in parallel — worker-to-S3 has no connection limit
    const buffers = await Promise.all(
      rangeSpecs.map(({ offset, length }) =>
        fetch(s3Url, {
          headers: {
            'User-Agent': 'gribwebview-proxy/1.0',
            Range: `bytes=${offset}-${offset + length - 1}`,
          },
        }).then((r) => {
          if (!r.ok && r.status !== 206) {
            throw new Error(`S3 returned ${r.status} for range ${offset}:${length}`);
          }
          return r.arrayBuffer();
        }),
      ),
    );

    // Concatenate all buffers
    const totalLength = buffers.reduce((sum, b) => sum + b.byteLength, 0);
    const combined = new Uint8Array(totalLength);
    let pos = 0;
    for (const buf of buffers) {
      combined.set(new Uint8Array(buf), pos);
      pos += buf.byteLength;
    }

    return new Response(combined.buffer, {
      status: 200,
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(totalLength),
        'Cache-Control': 'public, max-age=300',
        ...corsHeaders(allowOrigin),
      },
    });
  } catch (err) {
    return new Response(`S3 multi-range error: ${err.message}`, {
      status: 502,
      headers: corsHeaders(allowOrigin),
    });
  }
}

function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Range',
    'Access-Control-Expose-Headers': 'Content-Range, Accept-Ranges, Content-Length',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
}
