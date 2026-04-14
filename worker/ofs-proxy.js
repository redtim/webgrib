/**
 * Cloudflare Worker — CORS proxy for NOAA OPeNDAP / THREDDS.
 *
 * NOAA's THREDDS server has no CORS headers, so browsers can't fetch
 * directly. This worker proxies requests and adds the necessary headers.
 *
 * Deploy:  npx wrangler deploy
 * Test:    curl https://<worker>.workers.dev/thredds/dodsC/NOAA/SFBOFS/...
 */

const UPSTREAM = 'https://opendap.co-ops.nos.noaa.gov';

// Allowed path prefix — only proxy THREDDS endpoints
const ALLOWED_PREFIX = '/thredds/';

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
    if (!normalized.startsWith(ALLOWED_PREFIX) || normalized.includes('..')) {
      return new Response('Not found', { status: 404 });
    }

    const target = UPSTREAM + normalized + url.search;

    try {
      const upstream = await fetch(target, {
        method: request.method,
        headers: {
          'User-Agent': 'gribwebview-proxy/1.0',
          'Accept': request.headers.get('Accept') || '*/*',
        },
      });

      const responseHeaders = {
        'Content-Type': upstream.headers.get('Content-Type') || 'application/octet-stream',
        'Cache-Control': 'public, max-age=300',
        ...corsHeaders(allowOrigin),
      };
      const contentLength = upstream.headers.get('Content-Length');
      if (contentLength) {
        responseHeaders['Content-Length'] = contentLength;
      }

      return new Response(upstream.body, {
        status: upstream.status,
        statusText: upstream.statusText,
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
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
}
