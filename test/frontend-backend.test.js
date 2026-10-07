// test/frontend-backend.test.js — the two-domain (front-end / back-end) configuration:
// public/js/config.js URL helpers, public/js/net.js defaultWsUrl, public/js/ui/buildGuard.js healthz
// URL, the server's /healthz CORS header, and the browser-only static build output.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, rm, stat } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BACKEND_ORIGIN, backendUrl, backendWsUrl } from '../public/js/config.js';
import { defaultWsUrl } from '../public/js/net.js';
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
