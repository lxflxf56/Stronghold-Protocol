// Front-end / back-end domain configuration (front/back separation).
//
// The browser client is served from the front-end domain. In the default single-origin deployment
// `BACKEND_ORIGIN` is empty and every URL stays on the page's own origin. When the client and the
// game server run on different domains, set `BACKEND_ORIGIN` to the server's http(s) origin (no
// path): the client opens its WebSocket at `/ws` on that origin and asks `/healthz` there.
//
// The server must be reachable at the root of that origin (`/ws`, `/healthz`); it is not mounted
// under a path. `origin` is an injectable parameter so tests can check a configured deployment
// without changing the singleton.

/** Configured game-server origin; empty means the front-end and back-end share one origin. */
export const BACKEND_ORIGIN = '';

/**
 * Absolute backend URL for `path`, or `path` unchanged when no backend domain is configured.
 * @param {string} [path] URL path starting with `/`
 * @param {string} [origin] origin override (defaults to BACKEND_ORIGIN)
 * @returns {string}
 */
export function backendUrl(path = '', origin = BACKEND_ORIGIN) {
  if (!origin) return path;
  return `${new URL(origin).origin}${path}`;
}

/**
 * WebSocket URL for `path` on the backend domain, or '' when no backend domain is configured (the
 * caller then derives the URL from the front-end page origin).
 * @param {string} [path] WebSocket path
 * @param {string} [origin] origin override (defaults to BACKEND_ORIGIN)
 * @returns {string}
 */
export function backendWsUrl(path = '/ws', origin = BACKEND_ORIGIN) {
  if (!origin) return '';
  const { protocol, host } = new URL(origin);
  return `${protocol === 'https:' ? 'wss' : 'ws'}://${host}${path}`;
}
