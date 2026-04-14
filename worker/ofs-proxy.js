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

    // Route to the correct upstream based on path prefix
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
