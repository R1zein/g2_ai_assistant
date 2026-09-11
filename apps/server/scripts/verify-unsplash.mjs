#!/usr/bin/env node
/**
 * Checks a live Unsplash response against what the client actually reads.
 *
 * The client was written against documentation rather than a live call, so
 * every field it depends on is asserted here. Run it once after adding the key:
 *
 *   node apps/server/scripts/verify-unsplash.mjs
 *
 * Costs one request out of the hourly budget.
 */
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

function readEnvFile(file) {
  if (!existsSync(file)) return {};
  const out = {};
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    out[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
  }
  return out;
}

const repoRoot = path.resolve(process.cwd());
const fileEnv = { ...readEnvFile(path.join(repoRoot, '.env')), ...readEnvFile('.env') };
const key = (process.env.UNSPLASH_ACCESS_KEY ?? fileEnv.UNSPLASH_ACCESS_KEY ?? '').trim();

if (!key) {
  console.error('\n  UNSPLASH_ACCESS_KEY is not set in .env or the environment.\n');
  process.exit(1);
}

/** Exactly the fields `RawPhoto` in photos/unsplash.ts reads. */
const REQUIRED = [
  ['id', (p) => typeof p.id === 'string' && p.id.length > 0],
  ['width', (p) => Number.isFinite(p.width)],
  ['height', (p) => Number.isFinite(p.height)],
  ['urls.regular', (p) => typeof p.urls?.regular === 'string'],
  ['urls.small', (p) => typeof p.urls?.small === 'string'],
  ['links.html', (p) => typeof p.links?.html === 'string'],
  ['links.download_location', (p) => typeof p.links?.download_location === 'string'],
  ['user.name', (p) => typeof p.user?.name === 'string'],
  ['user.links.html', (p) => typeof p.user?.links?.html === 'string'],
];

const url = new URL('https://api.unsplash.com/photos/random');
url.searchParams.set('count', '2');
url.searchParams.set('orientation', 'landscape');
url.searchParams.set('content_filter', 'high');

console.log('\n  GET /photos/random?count=2 ...\n');

let response;
try {
  response = await fetch(url, {
    headers: { authorization: `Client-ID ${key}`, 'accept-version': 'v1' },
    signal: AbortSignal.timeout(15_000),
  });
} catch (err) {
  console.error(`  Could not reach api.unsplash.com: ${err.message}\n`);
  process.exit(1);
}

const limit = response.headers.get('x-ratelimit-limit');
const remaining = response.headers.get('x-ratelimit-remaining');

console.log(`  HTTP ${response.status}`);
console.log(`  rate limit  ${limit ?? 'not reported'}  (remaining: ${remaining ?? 'not reported'})`);

if (response.status === 401) {
  console.error('\n  The access key was rejected. Copy it again from the app page.\n');
  process.exit(1);
}
if (!response.ok) {
  console.error(`\n  ${(await response.text()).slice(0, 300)}\n`);
  process.exit(1);
}

const body = await response.json();
const photos = Array.isArray(body) ? body : [body];

console.log(`  shape       ${Array.isArray(body) ? 'array' : 'single object'}, ${photos.length} photo(s)\n`);

let failures = 0;
for (const [index, photo] of photos.entries()) {
  console.log(`  photo ${index + 1}: ${photo.id ?? '(no id)'}`);
  for (const [field, ok] of REQUIRED) {
    const passed = ok(photo);
    if (!passed) failures++;
    console.log(`    ${passed ? 'ok  ' : 'FAIL'} ${field}`);
  }
  console.log(`    by ${photo.user?.name ?? '?'} — ${photo.description ?? photo.alt_description ?? 'no description'}`);
  console.log('');
}

if (failures > 0) {
  console.error(`  ${failures} field(s) the client depends on are missing or the wrong type.`);
  console.error('  Report these — photos/unsplash.ts needs updating.\n');
  process.exit(1);
}

console.log('  Every field the client reads is present. The photo feed should work.\n');
if (remaining !== null && Number(remaining) < 10) {
  console.log(`  Note: only ${remaining} requests left this hour.\n`);
}
