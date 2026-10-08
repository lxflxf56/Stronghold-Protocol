// test/frontend-backend.test.js — the two-domain (front-end / back-end) configuration:
// public/js/config.js URL helpers, public/js/net.js defaultWsUrl, public/js/ui/buildGuard.js healthz
// URL, the server's /healthz CORS header, and the browser-only static build output.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, rm, stat } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BACKEND_ORIGIN, backendUrl, backendWsUrl, SERVER_PARAM,
  normalizeOrigin, parseServerParam, effectiveBackendOrigin, serverParamForLink, setServerInUrl, onDefaultBackend,
} from '../public/js/config.js';
import { defaultWsUrl, Net } from '../public/js/net.js';
import { fetchBuild } from '../public/js/ui/buildGuard.js';
import { parseFrontendOrigin, startServer } from '../server/index.js';
import { buildFrontend, isBrowserSimFile } from '../tools/build-frontend.mjs';

const TEST_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

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

test('config: an empty BACKEND_ORIGIN keeps every URL on the front-end origin', () => {
  assert.equal(BACKEND_ORIGIN, '');
  assert.equal(backendUrl('/healthz'), '/healthz');
  assert.equal(backendWsUrl('/ws'), '');
});

test('config: a configured backend domain produces absolute http(s) / ws(s) URLs', () => {
  assert.equal(backendUrl('/healthz', 'https://api.example.com'), 'https://api.example.com/healthz');
  assert.equal(backendUrl('/data/chess.json', 'http://api.example.com'), 'http://api.example.com/data/chess.json');
  assert.equal(backendWsUrl('/ws', 'https://api.example.com'), 'wss://api.example.com/ws');
  assert.equal(backendWsUrl('/ws', 'http://api.example.com:3001'), 'ws://api.example.com:3001/ws');
});

test('net: defaultWsUrl uses the configured backend domain, not the page domain', () => {
  const page = { protocol: 'https:', host: 'game.example.com' };
  assert.equal(defaultWsUrl(page), 'wss://game.example.com/ws');
  assert.equal(defaultWsUrl(page, 'https://api.example.com'), 'wss://api.example.com/ws');
  assert.equal(defaultWsUrl(page, 'http://api.example.com:3001'), 'ws://api.example.com:3001/ws');
});

test('buildGuard: /healthz moves to the configured backend domain', async () => {
  const urls = [];
  const fetchFn = async (url) => { urls.push(url); return { ok: true, json: async () => ({ build: 'abc' }) }; };
  assert.equal(await fetchBuild(fetchFn), 'abc');
  assert.deepEqual(urls, ['/healthz']);
  assert.equal(await fetchBuild(fetchFn, { backendOrigin: 'https://api.example.com' }), 'abc');
  assert.deepEqual(urls, ['/healthz', 'https://api.example.com/healthz']);
});

test('server: parseFrontendOrigin defaults to * and keeps a configured origin', () => {
  assert.equal(parseFrontendOrigin(), '*');
  assert.equal(parseFrontendOrigin('  '), '*');
  assert.equal(parseFrontendOrigin('https://game.example.com'), 'https://game.example.com');
});

test('server: /healthz answers cross-origin requests with the configured front-end origin', async () => {
  const srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true, frontendOrigin: 'https://game.example.com' });
  try {
    const res = await fetch(`http://127.0.0.1:${srv.port}/healthz`, { headers: { Origin: 'https://game.example.com' } });
    assert.equal(res.ok, true);
    assert.equal(res.headers.get('access-control-allow-origin'), 'https://game.example.com');
    assert.equal(res.headers.get('vary'), 'Origin');
    assert.equal((await res.json()).ok, true);
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

test('static build: refuses to write a source directory', async () => {
  await assert.rejects(buildFrontend({ out: join(TEST_ROOT, 'public'), quiet: true }), /source directory/);
  await assert.rejects(buildFrontend({ out: join(TEST_ROOT, 'server'), quiet: true }), /source directory/);
  await assert.rejects(buildFrontend({ out: join(TEST_ROOT, 'test', 'not-output'), quiet: true }), /test sources/);
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
  // single-origin default (BACKEND_ORIGIN === ''): the page origin IS the default backend
  const g = loc('https://game.example.com/');
  assert.equal(effectiveBackendOrigin('', g), 'https://game.example.com');
  assert.equal(effectiveBackendOrigin('?server=https://api.other.com', g), 'https://api.other.com');
  assert.equal(effectiveBackendOrigin('?server=bogus', g), 'https://game.example.com', 'invalid param → default');
  assert.equal(effectiveBackendOrigin('?server=', g), 'https://game.example.com', 'empty param → default');
  assert.equal(effectiveBackendOrigin(undefined, g), 'https://game.example.com', 'no search → default');
});

test('serverParamForLink: omits the param on the default backend, includes it only for a real override', () => {
  const g = loc('https://game.example.com/');
  assert.equal(serverParamForLink('', g), '', 'on the default backend (page origin) → no param');
  assert.equal(serverParamForLink('?server=https://api.other.com', g), 'https://api.other.com');
  // an override that equals the default backend is still the default → no param
  assert.equal(serverParamForLink('?server=https://game.example.com', g), '', 'override == default → no param');
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
  // switching back to the page origin clears the param (override == default)
  const h3 = fakeHist();
  assert.equal(setServerInUrl('https://game.example.com', h3, withParam), '?room=ABCD');
  assert.equal(h3.__last, '/lobby?room=ABCD');
});

test('setServerInUrl: returns null without a live location', () => {
  assert.equal(setServerInUrl('https://api.example.com'), null);
});

test('net: defaultWsUrl follows a ?server= override and falls back to the page origin on an invalid one', () => {
  const page = (search) => ({ protocol: 'https:', host: 'game.example.com', search });
  assert.equal(defaultWsUrl(page('?server=https://api.example.com')), 'wss://api.example.com/ws');
  assert.equal(defaultWsUrl(page('?server=http://api.example.com:3001')), 'ws://api.example.com:3001/ws');
  assert.equal(defaultWsUrl(page('?server=bogus')), 'wss://game.example.com/ws', 'invalid param → page origin');
  assert.equal(defaultWsUrl(page('?server=javascript:alert(1)')), 'wss://game.example.com/ws', 'script scheme → page origin, never in the socket URL');
  assert.equal(defaultWsUrl(page('')), 'wss://game.example.com/ws', 'no param → page origin (default)');
  assert.equal(defaultWsUrl({ protocol: 'http:', host: 'g.com', search: '' }), 'ws://g.com/ws');
});

// ---- reconnect-token safety: hello must not leak the stored token to a foreign backend ----

test('onDefaultBackend: true only when the connection targets the default backend', () => {
  const g = { origin: 'https://game.example.com', search: '' };
  assert.equal(onDefaultBackend('', g), true, 'single-origin, no override → default');
  assert.equal(onDefaultBackend('?server=https://game.example.com', g), true, 'override equal to the default → default');
  assert.equal(onDefaultBackend('?server=', g), true, 'empty override → default');
  assert.equal(onDefaultBackend('?server=bogus', g), true, 'invalid override falls back to the default');
  assert.equal(onDefaultBackend('?server=https://api.other.com', g), false, 'foreign override → not the default');
  assert.equal(onDefaultBackend(undefined, undefined), true, 'no live location (Node) → default');
});

test('net: hello carries the reconnect token only on the default backend', () => {
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
  assert.equal(drive('?server=https://game.example.com').token, 'tok-1', 'override equal to the default → token sent');
  assert.equal(drive('?server=bogus').token, 'tok-1', 'invalid override falls back to the default → token sent');
  assert.equal(
    drive('?server=https://api.other.com').token, undefined,
    'foreign ?server= backend → NO token: a fresh session instead of leaking the stored one');
  assert.equal(drive('?server=https://api.other.com').name, '凯尔希', 'hello itself is still sent (name only)');
});
