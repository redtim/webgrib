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

// Allowed path prefixes — only proxy THREDDS endpoints
const ALLOWED = ['/thredds/'];

export default {
  async fetch(request) {
    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: corsHeaders(),
      });
    }

    // Only allow GET and HEAD — CORS headers already restrict to these
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response('Method not allowed', { status: 405, headers: corsHeaders() });
    }

    const url = new URL(request.url);

    // Validate the path is a THREDDS request
    if (!ALLOWED.some((p) => url.pathname.startsWith(p))) {
      return new Response('Not found', { status: 404 });
    }

    const target = UPSTREAM + url.pathname + url.search;

    try {
      const upstream = await fetch(target, {
        method: request.method,
        headers: {
          'User-Agent': 'gribwebview-proxy/1.0',
          'Accept': request.headers.get('Accept') || '*/*',
        },
      });

      // Stream the response back with CORS headers
      const responseHeaders = {
        'Content-Type': upstream.headers.get('Content-Type') || 'application/octet-stream',
        'Cache-Control': 'public, max-age=300', // 5 min cache
        ...corsHeaders(),
      };
      const contentLength = upstream.headers.get('Content-Length');
      if (contentLength) {
        responseHeaders['Content-Length'] = contentLength;
      }

      const resp = new Response(upstream.body, {
        status: upstream.status,
        statusText: upstream.statusText,
        headers: responseHeaders,
      });

      return resp;
    } catch (err) {
      return new Response(`Upstream error: ${err.message}`, {
        status: 502,
        headers: corsHeaders(),
      });
    }
  },
};

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
  };
}
