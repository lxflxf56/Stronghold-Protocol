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
//
// A visitor can override the backend at runtime with a `?server=<origin>` URL parameter (the picker in
// the title screen's Settings modal writes it). That override is the single source of truth for
// which backend this page talks to: it is read by defaultWsUrl (the WebSocket) and by the build guard
// (/healthz), so switching the server never leaves one of those talking to a different backend. When
// the override is absent or invalid the build-time `BACKEND_ORIGIN` is used (and, in a single-origin
// deployment, the page's own origin). Shared invite links only carry `?server=` when the chosen
// origin differs from the default, so a link that targets the default server does not force
// recipients onto a different backend (docs/I18N.md-style note: see DESIGN §2 / §8).

/** Configured game-server origin; empty means the front-end and back-end share one origin. */
export const BACKEND_ORIGIN = '';

/** Query-string parameter that overrides BACKEND_ORIGIN at runtime. */
export const SERVER_PARAM = 'server';

/**
 * Normalise a backend origin typed/pasted by a user (or read from the URL): a full http(s) origin,
 * or '' when the input is not an absolute http(s) URL.
 * @param {string} raw
 * @returns {string}
 */
export function normalizeOrigin(raw) {
  try {
    const u = new URL(String(raw ?? '').trim());
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.origin : '';
  } catch {
    return '';
  }
}

/**
 * Backend origin read from the `?server=` parameter of a search string, or '' when absent/invalid.
 * @param {string} [search] a URL search string (location.search); defaults to the live page's
 * @returns {string}
 */
export function parseServerParam(search) {
  let s = search;
  if (s === undefined || s === null) {
    try { s = globalThis.location?.search ?? ''; } catch { s = ''; }
  }
  try {
    const raw = new URLSearchParams(String(s)).get(SERVER_PARAM);
    return raw ? normalizeOrigin(raw) : '';
  } catch {
    return '';
  }
}

/**
 * The backend origin this page should use: the `?server=` override, else BACKEND_ORIGIN, else the
 * front-end page's own origin (single-origin deployment).
 * @param {string} [search] a URL search string; defaults to the live page's
 * @param {{origin?: string}} [loc] page location (only its origin is used as the fallback)
 * @returns {string}
 */
export function effectiveBackendOrigin(search, loc = globalThis.location) {
  let s = search;
  if (s === undefined || s === null) s = loc?.search ?? '';
  const override = parseServerParam(s);
  if (override) return override;
  if (BACKEND_ORIGIN) return BACKEND_ORIGIN;
  return loc?.origin || '';
}

/**
 * The `?server=` value to embed in a shared link, or '' when this page is already on the default
 * backend — so a default-server link carries no param and its recipient is not forced onto a
 * different backend.
 * @param {string} [search]
 * @param {{origin?: string}} [loc]
 * @returns {string}
 */
export function serverParamForLink(search, loc = globalThis.location) {
  const def = BACKEND_ORIGIN || (loc?.origin || '');
  const eff = effectiveBackendOrigin(search, loc);
  return eff && eff !== def ? eff : '';
}

/**
 * Write (or, when `origin` is empty, drop) the `?server=` parameter, preserving every other query
 * parameter (`room`, `lang`, …) and the hash. `origin` must be a normalised origin ('' = default).
 * Updates the address bar via history.replaceState and returns the new search string (or null when
 * there is no live location to update, e.g. in Node tests).
 * @param {string} origin normalised origin ('') to clear the param (use the default backend)
 * @param {History} [hist]
 * @param {Location} [loc]
 * @returns {string|null}
 */
export function setServerInUrl(origin, hist = globalThis.history, loc = globalThis.location) {
  if (!loc || typeof loc.href !== 'string') return null;
  const url = new URL(loc.href);
  const def = BACKEND_ORIGIN || (loc.origin || '');
  if (origin && origin !== def) url.searchParams.set(SERVER_PARAM, origin);
  else url.searchParams.delete(SERVER_PARAM);
  hist?.replaceState?.(hist.state ?? null, '', url.pathname + url.search + url.hash);
  return url.search;
}

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
