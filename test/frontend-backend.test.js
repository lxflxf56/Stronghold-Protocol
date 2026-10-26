// test/frontend-backend.test.js — the two-domain (front-end / back-end) configuration:
// public/js/config.js URL helpers, public/js/net.js defaultWsUrl, public/js/ui/buildGuard.js healthz
// URL, the server's /healthz CORS header, and the browser-only static build output.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile, rm, stat } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  BACKEND_ORIGIN, backendUrl, backendWsUrl, SERVER_PARAM,
  normalizeOrigin, parseServerParam, effectiveBackendOrigin, serverParamForLink, setServerInUrl, onDefaultBackend,
  setSeparationEnabled,
} from '../public/js/config.js';
import { defaultWsUrl, Net } from '../public/js/net.js';
import { fetchBuild } from '../public/js/ui/buildGuard.js';
import { parseFrontendOrigin, parseSeparationEnabled, startServer } from '../server/index.js';
import { DATA_SHIM_JS } from '../server/http/static.js';
import { buildFrontend, isBrowserSimFile } from '../tools/build-frontend.mjs';
import { findSpecifiers } from '../tools/check-imports.mjs';

const TEST_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Run a test body with the build-time separation gate enabled (the un-baked source default is off). */
const withSeparation = (fn) => {
  setSeparationEnabled(true);
  try { return fn(); } finally { setSeparationEnabled(false); };
};

/** The default backend for the test page: the configured BACKEND_ORIGIN (a
 * deployment bakes one in — docs/DEPLOY.md §2.5), else the page origin. */
const DEF = BACKEND_ORIGIN || 'https://game.example.com';

/** Every regular file under `dir`, as file names (the sim tree has no non-JS files). */
async function listFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (entry.isDirectory()) files.push(...(await listFiles(join(dir, entry.name))));
    else if (entry.isFile()) files.push(entry.name);
  }
  return files;
}

/** Every `.js` of a built site, as site-root-relative POSIX paths (`vendor/` is UMD, not a module tree). */
async function siteModules(dir, prefix = '') {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (entry.name === 'vendor') continue;
      files.push(...(await siteModules(join(dir, entry.name), rel)));
    } else if (entry.isFile() && entry.name.endsWith('.js')) files.push(rel);
  }
  return files.sort();
}

/**
 * Where a browser puts a module specifier of `fromPath`, as a site-root-relative path.
 * Resolution is the URL one, so `..` never climbs above the site root (a static host has nothing above it).
 * @param {string} fromPath the importing file, site-root-relative POSIX
 * @param {string} spec the import specifier
 */
function siteResolve(fromPath, spec) {
  const base = new URL(fromPath, 'https://site.invalid/');
  return decodeURIComponent(new URL(spec, base).pathname).replace(/^\//, '');
}

test('config: an empty BACKEND_ORIGIN keeps every URL on the front-end origin', () => {
  assert.equal(backendUrl('/healthz', ''), '/healthz');
  assert.equal(backendWsUrl('/ws', ''), '');
});

test('config: a configured backend domain produces absolute http(s) / ws(s) URLs', () => {
  assert.equal(backendUrl('/healthz', 'https://api.example.com'), 'https://api.example.com/healthz');
  assert.equal(backendUrl('/data/chess.json', 'http://api.example.com'), 'http://api.example.com/data/chess.json');
  assert.equal(backendWsUrl('/ws', 'https://api.example.com'), 'wss://api.example.com/ws');
  assert.equal(backendWsUrl('/ws', 'http://api.example.com:3001'), 'ws://api.example.com:3001/ws');
});

test('net: defaultWsUrl uses the configured backend domain, not the page domain', () => {
  const page = { protocol: 'https:', host: 'game.example.com' };
  assert.equal(defaultWsUrl(page), backendWsUrl('/ws', DEF));
  assert.equal(defaultWsUrl(page, 'https://api.example.com'), 'wss://api.example.com/ws');
  assert.equal(defaultWsUrl(page, 'http://api.example.com:3001'), 'ws://api.example.com:3001/ws');
});

test('buildGuard: /healthz moves to the configured backend domain', async () => {
  const urls = [];
  const fetchFn = async (url) => { urls.push(url); return { ok: true, json: async () => ({ build: 'abc' }) }; };
  assert.equal(await fetchBuild(fetchFn), 'abc');
  assert.deepEqual(urls, [backendUrl('/healthz')]);
  assert.equal(await fetchBuild(fetchFn, { backendOrigin: 'https://api.example.com' }), 'abc');
  assert.deepEqual(urls, [backendUrl('/healthz'), 'https://api.example.com/healthz']);
});

test('server: parseFrontendOrigin defaults to * and keeps a configured origin', () => {
  assert.equal(parseFrontendOrigin(), '*');
  assert.equal(parseFrontendOrigin('  '), '*');
  assert.equal(parseFrontendOrigin('https://game.example.com'), 'https://game.example.com');
});

test('server: parseSeparationEnabled is off by default and only truthy words turn it on', () => {
  assert.equal(parseSeparationEnabled(), false, 'unset → off');
  assert.equal(parseSeparationEnabled(''), false);
  assert.equal(parseSeparationEnabled('0'), false);
  assert.equal(parseSeparationEnabled('false'), false);
  assert.equal(parseSeparationEnabled('off'), false);
  assert.equal(parseSeparationEnabled('no'), false);
  assert.equal(parseSeparationEnabled('1'), true);
  assert.equal(parseSeparationEnabled('true'), true);
  assert.equal(parseSeparationEnabled('on'), true);
  assert.equal(parseSeparationEnabled('  YES  '), true);
});

test('server: /healthz carries no CORS headers and reports separation:false when separation is off (default)', async () => {
  const srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true });
  try {
    const res = await fetch(`http://127.0.0.1:${srv.port}/healthz`, { headers: { Origin: 'https://game.example.com' } });
    assert.equal(res.ok, true);
    assert.equal(res.headers.get('access-control-allow-origin'), null, 'no ACAO header — cross-origin reads are blocked');
    assert.equal(res.headers.get('vary'), null);
    const body = await res.json();
    assert.equal(body.separation, false);
  } finally {
    await srv.close();
  }
});

test('server: /healthz answers cross-origin requests with the configured front-end origin', async () => {
  const srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true, separation: true, frontendOrigin: 'https://game.example.com' });
  try {
    const res = await fetch(`http://127.0.0.1:${srv.port}/healthz`, { headers: { Origin: 'https://game.example.com' } });
    assert.equal(res.ok, true);
    assert.equal(res.headers.get('access-control-allow-origin'), 'https://game.example.com');
    assert.equal(res.headers.get('vary'), 'Origin');
    assert.equal((await res.json()).separation, true);
  } finally {
    await srv.close();
  }
});

test('server: /healthz allows any front-end origin when separation is on and FRONTEND_ORIGIN is unset', async () => {
  const srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true, separation: true });
  try {
    const res = await fetch(`http://127.0.0.1:${srv.port}/healthz`, { headers: { Origin: 'https://game.example.com' } });
    assert.equal(res.ok, true);
    assert.equal(res.headers.get('access-control-allow-origin'), '*');
    assert.equal(res.headers.get('vary'), null, '* needs no Vary');
    assert.equal((await res.json()).separation, true);
  } finally {
    await srv.close();
  }
});

test('static build: browser sim files are selected case-insensitively', () => {
  assert.equal(isBrowserSimFile('constants.js'), true);
  assert.equal(isBrowserSimFile('spec.JS'), true);
  assert.equal(isBrowserSimFile('nodeData.js'), false);
  assert.equal(isBrowserSimFile('NODEDATA.JS'), false);
  assert.equal(isBrowserSimFile('notes.txt'), false);
});

test('static build: output maps public, data, shared and browser-safe sim files', async () => {
  const out = join(TEST_ROOT, 'test', 'e2e', 'out', 'frontend-build');
  try {
    const result = await buildFrontend({ out, quiet: true });

    assert.ok(result.files > 0);
    for (const rel of [
      'index.html',
      'js/config.js',
      'js/net.js',
      'css/theme.css',
      'data/config.json',
      'shared/constants.js',
      'sim/constants.js',
      'sim/spec.js',
      'sim/content/index.js',
    ]) {
      const info = await stat(join(result.outputDir, rel));
      assert.ok(info.isFile(), `missing output file: ${rel}`);
    }

    const simFiles = await listFiles(join(result.outputDir, 'sim'));
    assert.ok(simFiles.length > 0);
    assert.ok(simFiles.every((name) => name.toLowerCase().endsWith('.js')));
    assert.ok(!simFiles.some((name) => name.toLowerCase() === 'nodedata.js'));
  } finally {
    await rm(out, { recursive: true, force: true });
  }
});

test('static build: ships the /data.js stand-in byte for byte', async () => {
  const out = join(TEST_ROOT, 'test', 'e2e', 'out', 'frontend-build-shim');
  try {
    const result = await buildFrontend({ out, quiet: true });
    // /sim/content/support/index.js reaches the game data through '../../../data.js', which a static host only
    // answers when the site root carries the stand-in. The bytes are the server's (server/http/static.js), because
    // the vanilla content hash is computed over them (server/plugins/identity.js) — a rewritten copy would drift.
    assert.equal(await readFile(join(result.outputDir, 'data.js'), 'utf8'), DATA_SHIM_JS);
  } finally {
    await rm(out, { recursive: true, force: true });
  }
});

test('static build: every static relative import of the site resolves to a served file', async () => {
  const out = join(TEST_ROOT, 'test', 'e2e', 'out', 'frontend-build-graph');
  // The two Node-only paths a browser never takes: simdata.js imports ./nodeData.js only under Node (its IS_NODE
  // guard, the file is excluded from the build), and '../../server/sim/detmath.js' is only sandbox.js' default
  // loadMath — the browser worker and the sim-check harness both pass their own loader (/sim/detmath.js).
  const guarded = new Set(['sim/simdata.js\u0000./nodeData.js', 'shared/plugins/sandbox.js\u0000../../server/sim/detmath.js']);
  try {
    const result = await buildFrontend({ out, quiet: true });
    const missing = [];
    let checked = 0;
    for (const rel of await siteModules(result.outputDir)) {
      const specs = findSpecifiers(await readFile(join(result.outputDir, rel), 'utf8'));
      for (const { spec } of specs) {
        if (!spec.startsWith('.')) continue;
        checked++;
        if (guarded.has(`${rel}\u0000${spec}`)) continue;
        const target = siteResolve(rel, spec);
        const info = await stat(join(result.outputDir, target)).catch(() => null);
        if (!info?.isFile()) missing.push(`${rel} -> ${spec} (as /${target})`);
      }
    }
    assert.ok(checked > 100, `the site graph was walked (${checked} relative specifiers)`);
    assert.deepEqual(missing, [], 'a dangling import ships as the host 404 page, which the browser refuses on MIME type');
  } finally {
    await rm(out, { recursive: true, force: true });
  }
});

test('static build: the /data.js stand-in is the module the sim content chain imports', async () => {
  const out = join(TEST_ROOT, 'test', 'e2e', 'out', 'frontend-build-chain');
  try {
    const result = await buildFrontend({ out, quiet: true });
    // The importer's own specifier, resolved as a browser does from the site root: the file the static host must serve.
    const from = 'sim/content/support/index.js';
    const target = siteResolve(from, '../../../data.js');
    assert.equal(target, 'data.js');
    assert.ok((await stat(join(result.outputDir, target))).isFile(), `/data.js is at the site root (${target})`);
    // The shipped text is a module of the site: it imports the sim's own data accessor.
    const shimSrc = await readFile(join(result.outputDir, 'data.js'), 'utf8');
    const shimSpecs = findSpecifiers(shimSrc).map((s) => s.spec);
    assert.deepEqual(shimSpecs, ['./sim/simdata.js'], 'the stand-in imports only /sim/simdata.js');
    assert.ok((await stat(join(result.outputDir, siteResolve('data.js', './sim/simdata.js')))).isFile());
    assert.match(shimSrc, /export function getData\(\)/);
  } finally {
    await rm(out, { recursive: true, force: true });
  }
});

test('static build: refuses to write a source directory', async () => {
  await assert.rejects(buildFrontend({ out: join(TEST_ROOT, 'public'), quiet: true }), /source directory/);
  await assert.rejects(buildFrontend({ out: join(TEST_ROOT, 'server'), quiet: true }), /source directory/);
  await assert.rejects(buildFrontend({ out: join(TEST_ROOT, 'test', 'not-output'), quiet: true }), /test sources/);
});

test('static build: bakes the separation default into js/config.js (on by default for builds)', async () => {
  const out = join(TEST_ROOT, 'test', 'e2e', 'out', 'frontend-build-sep');
  const saved = process.env.ALLOW_SEPARATE_FRONTEND;
  try {
    delete process.env.ALLOW_SEPARATE_FRONTEND; // build default: '1' → separation baked in
    await buildFrontend({ out, quiet: true });
    assert.match(
      await readFile(join(out, 'js', 'config.js'), 'utf8'),
      /let SEPARATION_ENABLED = true;/, 'a default build ships with separation support');
    process.env.ALLOW_SEPARATE_FRONTEND = '0'; // explicit off → baked as false
    await buildFrontend({ out, quiet: true });
    assert.match(
      await readFile(join(out, 'js', 'config.js'), 'utf8'),
      /let SEPARATION_ENABLED = false;/, 'ALLOW_SEPARATE_FRONTEND=0 bakes a separation-free build');
  } finally {
    if (saved === undefined) delete process.env.ALLOW_SEPARATE_FRONTEND;
    else process.env.ALLOW_SEPARATE_FRONTEND = saved;
    await rm(out, { recursive: true, force: true });
  }
});

test('static build: bakes the build-time BACKEND_ORIGIN into js/config.js (empty by default)', async () => {
  const out = join(TEST_ROOT, 'test', 'e2e', 'out', 'frontend-build-origin');
  const saved = process.env.BACKEND_ORIGIN;
  try {
    delete process.env.BACKEND_ORIGIN; // build default: '' → single-origin
    await buildFrontend({ out, quiet: true });
    assert.match(
      await readFile(join(out, 'js', 'config.js'), 'utf8'),
      /export const BACKEND_ORIGIN = "";/, 'a default build stays single-origin');
    process.env.BACKEND_ORIGIN = 'https://api.example.com';
    await buildFrontend({ out, quiet: true });
    assert.match(
      await readFile(join(out, 'js', 'config.js'), 'utf8'),
      /export const BACKEND_ORIGIN = "https:\/\/api.example.com";/, 'BACKEND_ORIGIN is baked into the build');
    const baked = await import(pathToFileURL(join(out, 'js', 'config.js')).href);
    assert.equal(baked.BACKEND_ORIGIN, 'https://api.example.com', 'the baked module exports the configured origin');
    assert.equal(baked.backendUrl('/healthz'), 'https://api.example.com/healthz');
    await assert.rejects(
      () => { process.env.BACKEND_ORIGIN = 'not-a-url'; return buildFrontend({ out, quiet: true }); },
      /BACKEND_ORIGIN must be an http/, 'an invalid origin fails the build instead of shipping a broken config');
  } finally {
    if (saved === undefined) delete process.env.BACKEND_ORIGIN;
    else process.env.BACKEND_ORIGIN = saved;
    await rm(out, { recursive: true, force: true });
  }
});

// ---- ?server=<origin> runtime backend override (title-screen switcher; public/js/config.js) ----

const loc = (href) => { const u = new URL(href); return { href: u.href, origin: u.origin, protocol: u.protocol, host: u.host, pathname: u.pathname, search: u.search, hash: u.hash }; };
/** A fake history that records the replaceState argument. */
const fakeHist = () => ({ state: null, __last: null, replaceState(st, _t, url) { this.__last = url; } });

test('normalizeOrigin: http(s) origins only, strips path/auth; empty otherwise', () => {
  assert.equal(normalizeOrigin('https://api.example.com'), 'https://api.example.com');
  assert.equal(normalizeOrigin('http://api.example.com:3001'), 'http://api.example.com:3001');
  assert.equal(normalizeOrigin('https://user:pass@api.example.com'), 'https://api.example.com');
  assert.equal(normalizeOrigin('https://api.example.com/path'), 'https://api.example.com');
  assert.equal(normalizeOrigin('ftp://x.com'), '', 'non-http(s) scheme → default');
  assert.equal(normalizeOrigin('not-a-url'), '', 'relative / garbage → default');
  assert.equal(normalizeOrigin('javascript:alert(1)'), '', 'script scheme → default');
  assert.equal(normalizeOrigin('JAVASCRIPT:alert(1)'), '', 'uppercase script scheme → default');
  assert.equal(normalizeOrigin('java\tscript:alert(1)'), '', 'control-char evasion → default (URL parser strips it, then rejects)');
  assert.equal(normalizeOrigin('data:text/html,<script>alert(1)</script>'), '', 'data: URL → default');
  assert.equal(normalizeOrigin('vbscript:msgbox(1)'), '', 'vbscript → default');
  assert.equal(normalizeOrigin('blob:https://game.example.com/uuid'), '', 'blob: → default');
  assert.equal(normalizeOrigin('https://api.example.com/any?path=1#frag'), 'https://api.example.com', 'path/query/hash never survive');
  assert.equal(normalizeOrigin(''), '', 'empty → default');
  assert.equal(normalizeOrigin('  https://api.example.com  '), 'https://api.example.com', 'trimmed first');
});

test('parseServerParam: reads `?server=` only; valid http(s) origin or empty', () => {
  assert.equal(SERVER_PARAM, 'server');
  assert.equal(parseServerParam(''), '');
  assert.equal(parseServerParam('?room=ABCD'), '');
  assert.equal(parseServerParam('?server='), '');
  assert.equal(parseServerParam('?server=not-a-url'), '');
  assert.equal(parseServerParam('?server=ftp://x.com'), '');
  assert.equal(parseServerParam('?server=javascript:alert(1)'), '', 'script scheme → default');
  assert.equal(parseServerParam('?server=data:text/html,<script>'), '', 'data: URL → default');
  assert.equal(parseServerParam('?server=https://api.example.com'), 'https://api.example.com');
  assert.equal(parseServerParam('?server=http://api.example.com:3001'), 'http://api.example.com:3001');
  assert.equal(parseServerParam('?server=https://api.example.com/path'), 'https://api.example.com');
  // ignores unrelated params and other query keys
  assert.equal(parseServerParam('?room=ABCD&server=https://api.example.com&lang=en'), 'https://api.example.com');
});

test('effectiveBackendOrigin: override wins, invalid falls back, default is BACKEND_ORIGIN then page origin', () => {
  withSeparation(() => {
    // single-origin default (BACKEND_ORIGIN === ''): the page origin IS the default backend
    const g = loc('https://game.example.com/');
    assert.equal(effectiveBackendOrigin('', g), DEF);
    assert.equal(effectiveBackendOrigin('?server=https://api.other.com', g), 'https://api.other.com');
    assert.equal(effectiveBackendOrigin('?server=bogus', g), DEF, 'invalid param → default');
    assert.equal(effectiveBackendOrigin('?server=', g), DEF, 'empty param → default');
    assert.equal(effectiveBackendOrigin(undefined, g), DEF, 'no search → default');
  });
});

test('effectiveBackendOrigin: a ?server= override is ignored until the server allows separation', () => {
  const g = loc('https://game.example.com/?server=https://api.other.com');
  assert.equal(effectiveBackendOrigin(undefined, g), DEF, 'separation off (default) → override ignored, default backend');
  withSeparation(() => assert.equal(effectiveBackendOrigin(undefined, g), 'https://api.other.com', 'separation on → override wins'));
});

test('serverParamForLink: omits the param on the default backend, includes it only for a real override', () => {
  withSeparation(() => {
    const g = loc('https://game.example.com/');
    assert.equal(serverParamForLink('', g), '', 'on the default backend (page origin) → no param');
    assert.equal(serverParamForLink('?server=https://api.other.com', g), 'https://api.other.com');
    // an override that equals the default backend is still the default → no param
    assert.equal(serverParamForLink('?server=' + DEF, g), '', 'override == default → no param');
  });
});

test('setServerInUrl: writes ?server=, preserves room/lang/hash, clears it for the default', () => {
  const g = loc('https://game.example.com/lobby?room=ABCD&lang=en#top');
  const h1 = fakeHist();
  assert.equal(setServerInUrl('https://api.other.com', h1, g), '?room=ABCD&lang=en&server=https%3A%2F%2Fapi.other.com');
  assert.equal(h1.__last, '/lobby?room=ABCD&lang=en&server=https%3A%2F%2Fapi.other.com#top');
  // clearing: empty origin (default) drops the param, keeps room
  const withParam = loc('https://game.example.com/lobby?room=ABCD&server=https://api.other.com');
  const h2 = fakeHist();
  assert.equal(setServerInUrl('', h2, withParam), '?room=ABCD');
  assert.equal(h2.__last, '/lobby?room=ABCD');
  // switching back to the default backend clears the param (override == default)
  const h3 = fakeHist();
  assert.equal(setServerInUrl(DEF, h3, withParam), '?room=ABCD');
  assert.equal(h3.__last, '/lobby?room=ABCD');
});

test('setServerInUrl: returns null without a live location', () => {
  assert.equal(setServerInUrl('https://api.example.com'), null);
});

test('net: defaultWsUrl follows a ?server= override and falls back to the page origin on an invalid one', () => {
  withSeparation(() => {
    const page = (search) => ({ protocol: 'https:', host: 'game.example.com', search });
    assert.equal(defaultWsUrl(page('?server=https://api.example.com')), 'wss://api.example.com/ws');
    assert.equal(defaultWsUrl(page('?server=http://api.example.com:3001')), 'ws://api.example.com:3001/ws');
    assert.equal(defaultWsUrl(page('?server=bogus')), backendWsUrl('/ws', DEF), 'invalid param → default backend');
    assert.equal(defaultWsUrl(page('?server=javascript:alert(1)')), backendWsUrl('/ws', DEF), 'script scheme → default backend, never in the socket URL');
    assert.equal(defaultWsUrl(page('')), backendWsUrl('/ws', DEF), 'no param → default backend');
    assert.equal(defaultWsUrl({ protocol: 'http:', host: 'g.com', search: '' }, ''), 'ws://g.com/ws', 'no configured backend → derived from the page');
  });
});

// ---- reconnect-token safety: hello must not leak the stored token to a foreign backend ----

test('onDefaultBackend: true only when the connection targets the default backend', () => {
  withSeparation(() => {
    const g = { origin: 'https://game.example.com', search: '' };
    assert.equal(onDefaultBackend('', g), true, 'single-origin, no override → default');
    assert.equal(onDefaultBackend('?server=' + DEF, g), true, 'override equal to the default → default');
    assert.equal(onDefaultBackend('?server=', g), true, 'empty override → default');
    assert.equal(onDefaultBackend('?server=bogus', g), true, 'invalid override falls back to the default');
    assert.equal(onDefaultBackend('?server=https://api.other.com', g), false, 'foreign override → not the default');
    assert.equal(onDefaultBackend(undefined, undefined), true, 'no live location (Node) → default');
  });
});

test('net: hello carries the reconnect token only on the default backend', () => {
  withSeparation(() => {
  const timers = {
    setTimeout: () => 0, clearTimeout: () => {}, setInterval: () => 0, clearInterval: () => {},
  };
  /** Connect with a fake page location; return the hello the socket sent. */
  const drive = (search) => {
    const sockets = [];
    const FakeWS = class {
      constructor(url) { this.url = url; this.readyState = 1; this.sent = []; sockets.push(this); }
      send(data) { this.sent.push(JSON.parse(data)); }
      close() { this.readyState = 3; }
    };
    const saved = globalThis.location;
    globalThis.location = { origin: 'https://game.example.com', protocol: 'https:', host: 'game.example.com', search };
    try {
      const net = new Net({ WebSocket: FakeWS, timers, now: () => 0, random: () => 0.5, getToken: () => 'tok-1' });
      net.setName('凯尔希');
      const sock = sockets.at(-1);
      sock.onopen?.();
      return sock.sent.find((m) => m.t === 'hello');
    } finally {
      if (saved === undefined) delete globalThis.location;
      else globalThis.location = saved;
    }
  };
  assert.equal(drive('').token, 'tok-1', 'default backend (page origin) → token sent');
  assert.equal(drive('?server=' + DEF).token, 'tok-1', 'override equal to the default → token sent');
  assert.equal(drive('?server=bogus').token, 'tok-1', 'invalid override falls back to the default → token sent');
  assert.equal(
    drive('?server=https://api.other.com').token, undefined,
    'foreign ?server= backend → NO token: a fresh session instead of leaking the stored one');
  assert.equal(drive('?server=https://api.other.com').name, '凯尔希', 'hello itself is still sent (name only)');
  });
});
