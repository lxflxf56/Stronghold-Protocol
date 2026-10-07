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
// Unknown options are errors (exit code 2).

import { realpathSync } from 'node:fs';
import { copyFile, mkdir, readdir, rm, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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
