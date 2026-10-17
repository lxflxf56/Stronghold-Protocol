// test/ui/buildGuard.test.js — public/js/ui/buildGuard.js: the "this page runs an outdated build" guard that lets a
// deploy reach a tab that was already open (a page keeps its imported ES modules for its whole lifetime — the reason a
// client-only battle fix stayed invisible on the reporting player's page).
//
// Review-driven contract: a check that cannot read a build NEVER reloads, a new build is acted on only after two checks
// in a row agree, and a match on screen is never thrown away — the guard waits for it (and its settlement) to end.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkBuildOnce, startBuildGuard, fetchBuild, BUILD_CHECK_MS, BUILD_FETCH_TIMEOUT_MS } from '../../public/js/ui/buildGuard.js';

test('fetchBuild / startBuildGuard: a function backendOrigin is resolved per call (follows a runtime backend switch)', async () => {
  const seen = [];
  let origin = 'https://api.a.com';
  const fetchFn = async (url) => { seen.push(url); return { ok: true, status: 200, json: async () => ({ build: 'same' }) }; };
  assert.equal(await fetchBuild(fetchFn, { backendOrigin: () => origin }), 'same');
  assert.equal(seen[0], 'https://api.a.com/healthz', 'a function origin points /healthz at the chosen backend');
  origin = 'https://api.b.com';
  assert.equal(await fetchBuild(fetchFn, { backendOrigin: () => origin }), 'same');
  assert.equal(seen[1], 'https://api.b.com/healthz', 're-resolved on each call, so a live ?server= switch is followed');
  // startBuildGuard forwards the same option and resolves it per check
  const seen2 = [];
  let origin2 = 'https://api.c.com';
  const guard = startBuildGuard({
    fetchFn: async (url) => { seen2.push(url); return { ok: true, status: 200, json: async () => ({ build: 'same' }) }; },
    reload: () => {}, backendOrigin: () => origin2,
    setInterval: () => 0, clearInterval: () => {},
  });
  await new Promise((r) => setTimeout(r, 0));      // drain the floating first check kicked off by startBuildGuard
  await guard.check();
  assert.equal(seen2[seen2.length - 1], 'https://api.c.com/healthz', 'current value honored on a check');
  origin2 = 'https://api.d.com';
  await guard.check();
  assert.equal(seen2[seen2.length - 1], 'https://api.d.com/healthz', 'the guard re-resolves a function origin per check');
  guard.stop();
});

test('onHealth: told every /healthz body a check reads — what else the page reads of the server before any hello (DESIGN §32 P1a)', async () => {
  const bodies = [];
  const fetchFn = async () => ({ ok: true, json: async () => ({ build: 'aaa', content: { vanilla: 'c'.repeat(64), sets: 0, plugins: 2 } }) });
  assert.equal(await fetchBuild(fetchFn, { onHealth: (b) => bodies.push(b) }), 'aaa');
  assert.deepEqual(bodies.map((b) => b.content.plugins), [2]);
  assert.equal(await fetchBuild(fetchFn, { onHealth: () => { throw new Error('listener trouble'); } }), 'aaa', 'its listener cannot break the check');
  await checkBuildOnce({ fetchFn, onHealth: (b) => bodies.push(b) });
  assert.equal(bodies.length, 2);
  const g = startBuildGuard({ fetchFn, reload: () => {}, setInterval: () => 1, clearInterval: () => {}, onHealth: (b) => bodies.push(b) });
  for (let i = 0; i < 20 && bodies.length < 3; i++) await new Promise((r) => setTimeout(r, 1));
  g.stop();
  assert.equal(bodies.length, 3, 'the guard\'s first check hands it over');
  const main = (await import('node:fs')).readFileSync(new URL('../../public/js/main.js', import.meta.url), 'utf8');
  assert.match(main, /onHealth: \(h\) => \{ const n = pluginCount\(h\.content\); if \(n !== store\.get\(\)\.installedPlugins\) store\.set\(\{ installedPlugins: n \}\); \}/);
});
