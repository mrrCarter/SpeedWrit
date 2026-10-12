import { PUBLIC_PAGES, PUBLIC_PAGE_CSP } from '../../packages/job-send-ui/src/serve/publicPages';

export const OWNED_ORIGIN = 'https://speedwrit.aidenid.com';
export const UPSTREAM_ORIGIN = 'https://changed-brief-initiative-barrier.trycloudflare.com';
const HEADERS = {
  'content-security-policy': PUBLIC_PAGE_CSP,
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'cache-control': 'no-store, no-transform',
};
// Exact paths exposed by the current app. A future backend route needs explicit review here.
// Methods remain backend-owned, including OAuth/MCP CORS OPTIONS and protocol responses.
const APP_PATHS = new Set([
  '/owner-app', '/owner-app/', '/owner-app/index.html', '/owner-app/app.js',
  '/owner-app/app.css', '/owner-app/config.json',
  '/auth/sign-in', '/auth/google/callback', '/auth/sign-out',
  '/auth/gmail/connect', '/auth/gmail/callback',
  '/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp',
  '/.well-known/oauth-authorization-server',
  '/oauth/register', '/oauth/authorize', '/oauth/token', '/mcp',
  '/owner/me', '/owner/connect', '/owner/jobs', '/owner/pending', '/owner/receipts',
  '/owner/stop', '/owner/agent-connections/revoke',
  '/owner/agent-connections/secret-path', '/owner/agent-connections/secret-path-new',
  '/owner/jobs/confirm', '/owner/versions/approve', '/owner/versions/reject',
  '/owner/dispatches/resolve', '/owner/integrations',
  '/owner/alerts/preferences', '/owner/alerts/test',
]);
// Same path shape as packages/job-send/src/server/secret-path.ts; authentication stays upstream.
const SECRET_PATH = /^\/mcp\/c\/[A-Za-z0-9_-]{43}$/;

// Deployment also requires the application's HOST and Google callbacks to use OWNED_ORIGIN.
// This transport never rewrites Origin, OAuth resources, cookies, response bodies or redirects.
export function createWorker(fetchImpl: typeof fetch = fetch) {
  return {
    async fetch(request: Request): Promise<Response> {
      const url = new URL(request.url);
      if (url.origin !== OWNED_ORIGIN) {
        return new Response(request.method === 'HEAD' ? null : 'Not found', {status:404, headers:HEADERS});
      }
      const page = PUBLIC_PAGES.get(url.pathname);
      if (page || url.pathname === '/') {
        if (request.method !== 'GET' && request.method !== 'HEAD') {
          return new Response('Method not allowed', {status:405, headers:{...HEADERS, allow:'GET, HEAD'}});
        }
        if (url.pathname === '/') {
          return new Response(null, {status:302, headers:{...HEADERS, location:'/owner-app/#/connect'}});
        }
        return new Response(request.method === 'HEAD' ? null : page!.body, {
          status:200, headers:{...HEADERS, 'content-type':page!.contentType},
        });
      }

      if (!APP_PATHS.has(url.pathname) && !SECRET_PATH.test(url.pathname)) {
        return new Response(request.method === 'HEAD' ? null : 'Not found', {status:404, headers:HEADERS});
      }

      // Set pathname/search separately: even a // path, query URL or spoofed Host cannot
      // replace this upstream authority. The fetch layer supplies its correct TLS/Host.
      const target = new URL(UPSTREAM_ORIGIN);
      target.pathname = url.pathname;
      target.search = url.search;
      try {
        const forwarded = new Request(target, request);
        forwarded.headers.delete('host');
        const upstream = await fetchImpl(forwarded, {redirect:'manual', cache:'no-store'});
        // Construct from the response, preserving separate Set-Cookie values and streaming
        // its body. In particular, Google/client 302s are returned, never followed here.
        const response = new Response(upstream.body, upstream);
        response.headers.set('cache-control', 'no-store, no-transform');
        return response;
      } catch {
        // A failed/ambiguous request is never retried and raw errors never reach the client.
        return new Response(request.method === 'HEAD' ? null : 'Upstream unavailable', {
          status:502, headers:HEADERS,
        });
      }
    },
  };
}

export default createWorker();
