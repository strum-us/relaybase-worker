#!/usr/bin/env node
/**
 * Self-update release (Dotnote's pack-release, for the Relaybase Worker).
 *
 * Builds the Worker bundle and writes dist/release/<channel>/:
 *   manifest.json        latest release (version, notes, rollout, worker hash, migrations)
 *   manifest.json.sig    Ed25519 signature over the exact bytes of manifest.json
 *   worker.js            Worker bundle
 *   archive/<v>/…        the same three files for this version (pinned updates and rollback)
 *
 * With --publish, uploads them to R2 (`relaybase-downloads`, served at
 * https://downloads.relaybase.email) under `release/` (production) or
 * `release-staging/` (--channel staging): the archive first, then worker.js,
 * then the manifest and its signature, so a Worker never sees a manifest
 * whose files are missing. Installed Workers read RELEASE_ORIGIN =
 * https://downloads.relaybase.email/release[-staging].
 *
 *   node scripts/pack-release.mjs [--channel staging] [--publish]
 */
import { spawnSync } from 'node:child_process';
import { createHash, sign } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync, copyFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadSigningKey, publicKeyEntry, readKeys } from './release-key.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const channel = args.includes('--channel') ? args[args.indexOf('--channel') + 1] : 'production';
if (!['production', 'staging'].includes(channel)) throw new Error(`Unknown channel ${channel}`);
const publish = args.includes('--publish');
const prefix = channel === 'staging' ? 'release-staging' : 'release';
const bucket = process.env.RELAYBASE_DOWNLOADS_BUCKET || 'relaybase-downloads';
const downloadsOrigin = (process.env.RELAYBASE_DOWNLOADS_ORIGIN || 'https://downloads.relaybase.email').replace(/\/$/, '');
export const releaseOriginFor = (ch) => `${downloadsOrigin}/${ch === 'staging' ? 'release-staging' : 'release'}`;
const origin = `${downloadsOrigin}/${prefix}`;

function fail(message) {
  console.error(`[pack-release] ${message}`);
  process.exit(1);
}

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const version = pkg.version;

// 1. Signing key must be one the Workers trust.
const privateKey = loadSigningKey();
const entry = publicKeyEntry(privateKey);
if (!readKeys().keys.some((k) => k.id === entry.id && k.publicKey === entry.publicKey)) {
  fail(`signing key ${entry.id} is not in src/lib/update/release-keys.json — run node scripts/release-key.mjs and commit`);
}

// 2. Bundle the Worker (same bundle wrangler deploys).
const buildDir = join(root, 'dist', 'release-build');
rmSync(buildDir, { recursive: true, force: true });
const build = spawnSync(
  'pnpm',
  ['exec', 'wrangler', 'deploy', '--dry-run', '--outdir', buildDir, '--config', 'wrangler.bundle.toml'],
  { cwd: root, stdio: 'inherit' },
);
if (build.status !== 0) fail('wrangler bundle failed');
const workerFile = join(buildDir, 'index.js');
if (!existsSync(workerFile)) fail('wrangler did not produce index.js');
const worker = readFileSync(workerFile);

// 3. Migrations embedded in the Worker (db/migrations.ts), with the release each first shipped in.
const { MIGRATIONS } = await import(pathToFileURL(join(root, 'db', 'migrations.ts')).href);
let previous = null;
try {
  const res = await fetch(`${origin}/manifest.json`);
  if (res.ok) previous = await res.json();
} catch {
  /* first release on this channel */
}
const firstSeen = new Map((previous?.migrations ?? []).map((m) => [`${m.target}/${m.name}`, m.since]));
const migrations = MIGRATIONS.map((m) => ({
  target: m.target,
  name: m.name,
  since: firstSeen.get(`${m.target}/${m.name}`) ?? version,
  sql: m.sql,
}));

// 4. Release notes front matter: date, rollout (percent), auto (false = owner starts it).
const notesFile = join(root, 'release-notes', `${version}.md`);
let notes = null;
let releasedAt = new Date().toISOString();
let rolloutPercent = 100;
let autoUpdate = true;
if (existsSync(notesFile)) {
  const text = readFileSync(notesFile, 'utf8');
  const fm = text.match(/^---\n([\s\S]*?)\n---\n?/);
  notes = (fm ? text.slice(fm[0].length) : text).trim() || null;
  for (const line of fm?.[1].split('\n') ?? []) {
    const [key, ...rest] = line.split(':');
    const value = rest.join(':').trim();
    if (key.trim() === 'date' && value) releasedAt = new Date(value).toISOString();
    if (key.trim() === 'rollout' && value) rolloutPercent = Math.max(0, Math.min(100, Number(value)));
    if (key.trim() === 'auto' && value === 'false') autoUpdate = false;
  }
}

const wranglerToml = readFileSync(join(root, 'wrangler.toml'), 'utf8');
const compatibilityDate = wranglerToml.match(/^compatibility_date\s*=\s*"([^"]+)"/m)?.[1] ?? '2025-06-01';
const flagsLine = wranglerToml.match(/^compatibility_flags\s*=\s*\[([^\]]*)\]/m)?.[1] ?? '';
const compatibilityFlags = [...flagsLine.matchAll(/"([^"]+)"/g)].map((m) => m[1]);

const manifest = {
  schema: 1,
  version,
  releasedAt,
  notes,
  rolloutPercent,
  autoUpdate,
  workerSha256: createHash('sha256').update(worker).digest('hex'),
  sizeBytes: worker.length,
  compatibilityDate,
  compatibilityFlags,
  mainModule: 'index.js',
  migrations,
};
const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
const signature = Buffer.from(
  `${JSON.stringify({ keyId: entry.id, signature: sign(null, manifestBytes, privateKey).toString('base64') })}\n`,
);

// 5. Write dist/release/<channel>/.
const outDir = join(root, 'dist', 'release', channel);
const archiveDir = join(outDir, 'archive', version);
mkdirSync(archiveDir, { recursive: true });
for (const dir of [outDir, archiveDir]) {
  writeFileSync(join(dir, 'manifest.json'), manifestBytes);
  writeFileSync(join(dir, 'manifest.json.sig'), signature);
  copyFileSync(workerFile, join(dir, 'worker.js'));
}
console.log(
  `[pack-release] ${channel} ${version}: worker ${(statSync(workerFile).size / 1024).toFixed(0)} KiB, ` +
    `${migrations.length} migrations, rollout ${rolloutPercent}%, auto ${autoUpdate} → ${outDir}`,
);

if (!publish) {
  console.log(`[pack-release] not published (pass --publish). RELEASE_ORIGIN for this channel: ${origin}`);
  process.exit(0);
}

// 6. Upload: archive, then worker.js, then the manifest + signature last.
function put(key, file, contentType, cacheControl) {
  const res = spawnSync(
    'pnpm',
    [
      'exec', 'wrangler', 'r2', 'object', 'put', `${bucket}/${key}`,
      '--file', file, '--content-type', contentType, '--cache-control', cacheControl, '--remote',
    ],
    { cwd: root, stdio: 'inherit', env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: process.env.CLOUDFLARE_ACCOUNT_ID || '3adf03d991843094a7343eebc0a98007' } },
  );
  if (res.status !== 0) fail(`upload failed: ${key}`);
}
const immutable = 'public, max-age=31536000, immutable';
put(`${prefix}/archive/${version}/worker.js`, join(archiveDir, 'worker.js'), 'application/javascript', immutable);
put(`${prefix}/archive/${version}/manifest.json`, join(archiveDir, 'manifest.json'), 'application/json', 'no-cache');
put(`${prefix}/archive/${version}/manifest.json.sig`, join(archiveDir, 'manifest.json.sig'), 'application/json', 'no-cache');
put(`${prefix}/worker.js`, join(outDir, 'worker.js'), 'application/javascript', 'no-cache');
put(`${prefix}/manifest.json`, join(outDir, 'manifest.json'), 'application/json', 'no-cache');
put(`${prefix}/manifest.json.sig`, join(outDir, 'manifest.json.sig'), 'application/json', 'no-cache');
console.log(`[pack-release] published → ${origin}/manifest.json`);
