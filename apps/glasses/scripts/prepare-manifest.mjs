#!/usr/bin/env node
/**
 * Stamps a shippable app.json from the tracked template.
 *
 * The Even App enforces the `network` permission whitelist, so if it does not
 * name the host the app actually calls, every request fails on real hardware
 * while the simulator keeps working. That is the single most common way to ship
 * a broken .ehpk, and it happens because two files have to agree by hand.
 *
 * This derives the whitelist from VITE_API_BASE_URL — the same value the bundle
 * is built with — so they cannot drift. Output goes to app.build.json, leaving
 * the tracked template untouched.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(here, '..');

const TEMPLATE = path.join(appDir, 'app.json');
const OUTPUT = path.join(appDir, 'app.build.json');

/** Minimal .env reader — this runs before the bundler, with no deps available. */
function readEnvFile(file) {
  if (!existsSync(file)) return {};
  const out = {};
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    out[trimmed.slice(0, eq).trim()] = trimmed
      .slice(eq + 1)
      .trim()
      .replace(/^["']|["']$/g, '');
  }
  return out;
}

function fail(message, hint) {
  console.error(`\n  Cannot build a shippable manifest.\n\n  ${message}\n`);
  if (hint) console.error(`  ${hint}\n`);
  process.exit(1);
}

const fileEnv = readEnvFile(path.join(appDir, '.env'));
const baseUrl = (process.env.VITE_API_BASE_URL ?? fileEnv.VITE_API_BASE_URL ?? '').trim();

if (!baseUrl) {
  fail(
    'VITE_API_BASE_URL is not set, so the app does not know which server to call.',
    'Set it in apps/glasses/.env (copy from .env.example).',
  );
}

let origin;
try {
  origin = new URL(baseUrl).origin;
} catch {
  fail(`VITE_API_BASE_URL is not a valid URL: ${baseUrl}`);
}

const url = new URL(origin);
const isLocal = ['localhost', '127.0.0.1', '::1'].includes(url.hostname);

if (url.protocol !== 'https:' && !isLocal) {
  fail(
    `VITE_API_BASE_URL is ${origin}, which is plain HTTP.`,
    'The bearer token and every calendar answer travel over this link. Put the ' +
      'server behind HTTPS before packing — a tunnel (cloudflared, ngrok) is fine.',
  );
}

if (/(^|\.)example\.(com|org|net)$/.test(url.hostname)) {
  fail(
    `VITE_API_BASE_URL still points at the placeholder host ${url.hostname}.`,
    'Point it at your deployed assistant server.',
  );
}

const manifest = JSON.parse(readFileSync(TEMPLATE, 'utf8'));

if (manifest.package_id.startsWith('com.example.')) {
  fail(
    `package_id is still ${manifest.package_id}.`,
    'Pick your own reverse-domain id in app.json — lowercase letters and digits ' +
      'only, no hyphens. Check availability with: npx evenhub pack app.build.json dist -c',
  );
}

const network = (manifest.permissions ?? []).find((p) => p.name === 'network');
if (!network) {
  fail('app.json has no `network` permission, but the app is useless without a server.');
}

// The template's whitelist holds the static third-party hosts the app loads
// directly — photo CDNs and the like. The server origin is prepended here so the
// two can never disagree, and placeholders from the template are dropped.
const extras = (network.whitelist ?? []).filter((entry) => {
  if (typeof entry !== 'string' || entry === origin) return false;
  try {
    return !/(^|\.)example\.(com|org|net)$/.test(new URL(entry).hostname);
  } catch {
    return false;
  }
});

network.whitelist = [origin, ...extras];

writeFileSync(OUTPUT, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

console.log(`  manifest   ${path.relative(process.cwd(), OUTPUT)}`);
console.log(`  package_id ${manifest.package_id}  v${manifest.version}`);
console.log(`  server     ${origin}`);
console.log(
  `  perms      ${(manifest.permissions ?? []).map((p) => p.name).join(', ')}`,
);
if (extras.length > 0) console.log(`  also       ${extras.join(', ')}`);
if (isLocal) {
  console.log('\n  Note: the whitelist points at localhost, so this build only works in the simulator.');
}
