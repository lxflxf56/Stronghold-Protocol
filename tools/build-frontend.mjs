#!/usr/bin/env node
// tools/build-frontend.mjs — browser-only static site builder.
//
// The client is a static page, but its browser files live in four repository directories:
// public/ (page, modules, styles, vendored libraries and optional downloaded assets),
// data/ (game JSON), shared/ (shared modules) and server/sim/ (browser simulation modules).
// A static host such as Cloudflare Pages serves one output directory, so this script copies
// them into one tree:
//
//   /            public/
//   /data/       data/
//   /shared/     shared/
//   /sim/        server/sim/*.js, excluding the Node-only nodeData.js
//
// The output is intentionally platform-neutral: no Cloudflare, Wrangler, redirects or host
// configuration is generated here. Build command, output directory, domains and the tunnel are
// configured in the hosting/tunnel environment outside this repository.
//
// Usage: node tools/build-frontend.mjs [--out <dir>] [--quiet]
//   --out  output directory (default: <repo>/dist); must be inside the repository and must not
//          overlap a source directory
//   --quiet suppress the summary line
//   ALLOW_SEPARATE_FRONTEND (build-time, default '1'): the static site ships with front/back-end
//   separation support — the value is baked into js/config.js (the runtime server switcher and
//   the `?server=` override). The server's own ALLOW_SEPARATE_FRONTEND (default off) is a
//   separate runtime switch: it decides whether /healthz carries CORS headers. Set '0' at
//   build time to ship a separation-free build.
//   BACKEND_ORIGIN (build-time, default ''): the game-server origin the static site talks to
//   (an http(s) origin, no path) — baked into js/config.js. Unset keeps the single-origin
//   behaviour (every URL stays on the page's own origin).
// Unknown options are errors (exit code 2).

import { realpathSync } from 'node:fs';
import { copyFile, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSeparationEnabled } from '../server/http/config.js';
import { normalizeOrigin } from '../public/js/config.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const USAGE = 'usage: node tools/build-frontend.mjs [--out <dir>] [--quiet]';

/** Browser files that make the page unusable when a build step was skipped. */
const REQUIRED_FILES = Object.freeze([
  'public/index.html',
  'public/js/config.js',
  'public/js/net.js',
  'public/css/theme.css',
  'public/vendor/pixi.min.js',
  'public/vendor/pixi-spine.js',
  'public/vendor/preact.module.js',
  'public/vendor/hooks.module.js',
  'public/vendor/htm.module.js',
  'data/config.json',
  'shared/constants.js',
  'server/sim/constants.js',
]);

/** Source directory → output prefix. `public/` becomes the site root. */
const MOUNTS = Object.freeze([
  { source: 'public', output: '' },
  { source: 'data', output: 'data' },
  { source: 'shared', output: 'shared' },
  { source: join('server', 'sim'), output: 'sim', browserOnly: true },
]);

/** Directories that must never be used as (or contain) the output tree. */
const PROTECTED_PATHS = Object.freeze([
  'public', 'data', 'shared', 'server', 'tools', 'docs', 'node_modules',
]);
/** The only writable test path: generated test output, never a test source file. */
const TEST_OUTPUT_PREFIX = 'test/e2e/out/';

/**
 * A browser-safe simulation file: a JavaScript module, never the Node-only data loader.
 * Comparison is case-insensitive because the deploy target may be Windows or macOS.
 * @param {string} name file name
 * @returns {boolean}
 */
export function isBrowserSimFile(name) {
  const lower = String(name).toLowerCase();
  return lower.endsWith('.js') && lower !== 'nodedata.js';
}

/** Dot files and editor backups are never part of the served site. @param {string} name */
function isServableName(name) {
  return !name.startsWith('.') && !name.endsWith('~');
}

/**
 * The line in public/js/config.js whose value the build rewrites to the
 * build-time separation default (ALLOW_SEPARATE_FRONTEND, '1' for builds).
 */
const SEPARATION_LINE = 'let SEPARATION_ENABLED = false;';

/**
 * Bake the build-time separation default into the output's js/config.js, so the
 * static site ships with front/back-end separation support (build-time
 * ALLOW_SEPARATE_FRONTEND, '1' unless set otherwise). The server's runtime
 * switch (/healthz `separation`, default off) overrides it at page boot.
 * @param {string} configPath absolute path of the output js/config.js
 * @param {boolean} separation build-time separation default
 */
async function bakeSeparationDefault(configPath, separation) {
  let src;
  try { src = await readFile(configPath, 'utf8'); } catch { throw new Error(`cannot bake the separation default: ${configPath} is not readable`); }
  if (!src.includes(SEPARATION_LINE)) {
    throw new Error(`separation line not found in ${configPath} — update SEPARATION_LINE in tools/build-frontend.mjs`);
  }
  await writeFile(configPath, src.replace(SEPARATION_LINE, `let SEPARATION_ENABLED = ${separation};`));
}

/**
 * The line in public/js/config.js whose value the build rewrites to the
 * build-time BACKEND_ORIGIN ('' for single-origin builds).
 */
const BACKEND_ORIGIN_LINE = `export const BACKEND_ORIGIN = '';`;

/**
 * Bake the build-time BACKEND_ORIGIN into the output's js/config.js, so the
 * static site talks to the configured game-server origin (build-time
 * BACKEND_ORIGIN, '' when unset — single-origin).
 * @param {string} configPath absolute path of the output js/config.js
 * @param {string} backendOrigin normalised backend origin ('' = single-origin)
 */
async function bakeBackendOrigin(configPath, backendOrigin) {
  let src;
  try { src = await readFile(configPath, 'utf8'); } catch { throw new Error(`cannot bake BACKEND_ORIGIN: ${configPath} is not readable`); }
  if (!src.includes(BACKEND_ORIGIN_LINE)) {
    throw new Error(`BACKEND_ORIGIN line not found in ${configPath} — update BACKEND_ORIGIN_LINE in tools/build-frontend.mjs`);
  }
  await writeFile(configPath, src.replace(BACKEND_ORIGIN_LINE, `export const BACKEND_ORIGIN = ${JSON.stringify(backendOrigin)};`));
}

/**
 * Parse the command line strictly.
 * @param {string[]} argv
 * @returns {{out: string, quiet: boolean}}
 */
function parseArgs(argv) {
  const opts = { out: join(ROOT, 'dist'), quiet: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      console.log(USAGE);
      process.exit(0);
    }
    if (arg === '--quiet') {
      opts.quiet = true;
      continue;
    }
    if (arg === '--out' || arg.startsWith('--out=')) {
      const value = arg === '--out' ? argv[++i] : arg.slice('--out='.length);
      if (!value || value.startsWith('--')) throw new Error(`--out needs a path\n${USAGE}`);
      opts.out = value;
      continue;
    }
    throw new Error(`unknown option ${arg}\n${USAGE}`);
  }
  return opts;
}

/**
 * Resolve and validate the output directory.
 * @param {string} out
 * @returns {string} absolute output path
 */
function resolveOutput(out) {
  const outputDir = resolve(ROOT, out);
  const rel = relative(ROOT, outputDir);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`--out must be inside the repository: ${outputDir}`);
  }
  // Windows `relative()` joins segments with '\'; compare on forward slashes.
  const posixRel = rel.split(/[\\/]/).join('/');
  const top = posixRel.split('/')[0];
  if (PROTECTED_PATHS.includes(top)) {
    throw new Error(`--out must not overlap a source directory: ${rel}`);
  }
  if (top === 'test' && !posixRel.startsWith(TEST_OUTPUT_PREFIX)) {
    throw new Error(`--out must not overlap test sources: ${rel}`);
  }
  return outputDir;
}

/**
 * Copy a directory tree, preserving only servable file names.
 * @param {string} src absolute source directory
 * @param {string} dst absolute destination directory
 * @param {(name: string) => boolean} [filter] additional file-name filter
 * @returns {Promise<number>} number of copied files
 */
async function copyTree(src, dst, filter) {
  const info = await stat(src);
  if (!info.isDirectory()) throw new Error(`source directory not found: ${src}`);
  await mkdir(dst, { recursive: true });
  const entries = await readdir(src, { withFileTypes: true });
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  let count = 0;
  for (const entry of entries) {
    if (!isServableName(entry.name)) continue;
    const from = join(src, entry.name);
    const to = join(dst, entry.name);
    if (entry.isDirectory()) {
      count += await copyTree(from, to, filter);
    } else if (entry.isFile()) {
      if (filter && !filter(entry.name)) continue;
      await copyFile(from, to);
      count += 1;
    }
  }
  return count;
}

/**
 * Build the browser-only static site.
 * @param {{out?: string, quiet?: boolean}} [opts]
 * @returns {Promise<{outputDir: string, files: number, counts: Record<string, number>}>}
 */
export async function buildFrontend(opts = {}) {
  const { out = join(ROOT, 'dist'), quiet = false } = opts;
  const outputDir = resolveOutput(out);
  // The static site ships with separation support by default (build-time
  // ALLOW_SEPARATE_FRONTEND, '1' unless set otherwise); the server's runtime
  // switch is read from /healthz at page boot.
  const separation = opts.separation ?? parseSeparationEnabled(process.env.ALLOW_SEPARATE_FRONTEND ?? '1');

  // The build-time backend origin (BACKEND_ORIGIN, '' unless set) is baked into the
  // served config; a non-empty value must be a valid http(s) origin.
  const rawBackendOrigin = process.env.BACKEND_ORIGIN ?? '';
  const backendOrigin = normalizeOrigin(rawBackendOrigin);
  if (rawBackendOrigin.trim() && !backendOrigin) {
    throw new Error(`BACKEND_ORIGIN must be an http(s) origin: ${rawBackendOrigin}`);
  }

  const missing = [];
  for (const rel of REQUIRED_FILES) {
    try { await stat(join(ROOT, rel)); } catch { missing.push(rel); }
  }
  if (missing.length) {
    throw new Error(`missing required browser files (run npm ci / build-data first): ${missing.join(', ')}`);
  }

  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });

  const counts = {};
  let files = 0;
  for (const mount of MOUNTS) {
    const sourceDir = join(ROOT, mount.source);
    const targetDir = mount.output ? join(outputDir, mount.output) : outputDir;
    const count = await copyTree(sourceDir, targetDir, mount.browserOnly ? isBrowserSimFile : undefined);
    counts[mount.source] = count;
    files += count;
  }

  // Bake the build-time separation default into the served config.
  await bakeSeparationDefault(join(outputDir, 'js', 'config.js'), separation);

  // Bake the build-time backend origin into the served config.
  await bakeBackendOrigin(join(outputDir, 'js', 'config.js'), backendOrigin);

  if (!quiet) console.log(`frontend: ${files} files -> ${outputDir}`);
  return { outputDir, files, counts };
}

function isMain() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(`build-frontend: ${e.message}`);
    process.exit(2);
  }
  try {
    await buildFrontend(opts);
  } catch (e) {
    console.error(`build-frontend: ${e.message}`);
    process.exit(1);
  }
}

if (isMain()) main();
