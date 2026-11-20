#!/usr/bin/env node
/**
 * Release signing key (Ed25519), Dotnote's scheme. Creates
 * ~/.relaybase/release-signing-key.pem (or reads the existing one) and adds
 * its public half to src/lib/update/release-keys.json, which is bundled into
 * the Worker. The private key never goes in a repository.
 *
 *   node scripts/release-key.mjs
 */
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
export const KEYS_PATH = join(root, 'src/lib/update/release-keys.json');
export const DEFAULT_KEY_FILE = join(homedir(), '.relaybase', 'release-signing-key.pem');

/** The signing key: RELAYBASE_RELEASE_SIGNING_KEY (PEM), RELAYBASE_RELEASE_SIGNING_KEY_FILE, or the default file. */
export function loadSigningKey({ create = false } = {}) {
  const pem = process.env.RELAYBASE_RELEASE_SIGNING_KEY?.trim();
  if (pem) return createPrivateKey(pem);
  const file = process.env.RELAYBASE_RELEASE_SIGNING_KEY_FILE?.trim() || DEFAULT_KEY_FILE;
  if (existsSync(file)) return createPrivateKey(readFileSync(file, 'utf8'));
  if (!create) throw new Error(`No release signing key at ${file}. Run: node scripts/release-key.mjs`);
  const { privateKey } = generateKeyPairSync('ed25519');
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  console.log(`[release-key] created ${file}`);
  return privateKey;
}

export function publicKeyEntry(privateKey) {
  const raw = createPublicKey(privateKey).export({ type: 'spki', format: 'der' }).subarray(-32);
  const publicKey = raw.toString('base64');
  const id = createHash('sha256').update(raw).digest('hex').slice(0, 16);
  return { id, publicKey };
}

export function readKeys() {
  return existsSync(KEYS_PATH) ? JSON.parse(readFileSync(KEYS_PATH, 'utf8')) : { keys: [] };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const entry = publicKeyEntry(loadSigningKey({ create: true }));
  const keys = readKeys();
  if (keys.keys.some((k) => k.id === entry.id)) {
    console.log(`[release-key] ${entry.id} is already in release-keys.json`);
  } else {
    keys.keys.push(entry);
    writeFileSync(KEYS_PATH, `${JSON.stringify(keys, null, 2)}\n`);
    console.log(`[release-key] added ${entry.id} to src/lib/update/release-keys.json — commit it and ship a release`);
  }
}
