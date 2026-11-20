import type { Env } from "../../env";

/**
 * The Cloudflare OAuth grant this Worker keeps (same model as Dotnote's
 * `cf_grant`). The Relaybase app hands the refresh token over once, at install
 * or on "Reconnect Cloudflare" (`/install/handoff`); the Worker exchanges it at
 * once, so nobody else holds a working copy, and stores the rotated refresh
 * token encrypted with `CF_GRANT_KEY`. Every Cloudflare API call (domains, DNS,
 * Email Routing, Email Sending, D1 status) and every self-update runs on an
 * access token minted from it. There is no Cloudflare API token anywhere.
 */

const TOKEN_URL = "https://dash.cloudflare.com/oauth2/token";
/** Reuse a minted access token until this close to its expiry. */
const ACCESS_REUSE_MARGIN_MS = 2 * 60_000;
/** A renewal holds the row this long; others wait for its result. */
const LOCK_MS = 20_000;
const LOCK_WAIT_MS = 8_000;

export type CloudflareConnection = {
  connected: boolean;
  accountId: string | null;
  scopes: string[];
  updatedAt: string | null;
};

type GrantRow = {
  accountId: string;
  scopes: string;
  refreshCiphertext: string;
  refreshIv: string;
  accessCiphertext: string | null;
  accessIv: string | null;
  accessExpiresAt: string | null;
  lockUntil: string | null;
  updatedAt: string;
};

const BOOTSTRAP = [
  `CREATE TABLE IF NOT EXISTS cf_grant (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    account_id TEXT NOT NULL,
    scopes TEXT NOT NULL,
    refresh_ciphertext TEXT NOT NULL,
    refresh_iv TEXT NOT NULL,
    access_ciphertext TEXT,
    access_iv TEXT,
    access_expires_at TEXT,
    lock_until TEXT,
    updated_at TEXT NOT NULL
  )`,
  "CREATE TABLE IF NOT EXISTS install_state (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS cf_reconnect (code_hash TEXT PRIMARY KEY, expires_at TEXT NOT NULL)",
];

let bootstrapped = false;

function requireDb(env: Env): D1Database {
  if (!env.RELAYBASE_DB) throw new Error("This Relaybase Worker has no RELAYBASE_DB binding.");
  return env.RELAYBASE_DB;
}

/** Tables the grant owns; created here, not by a migration, so the updater can rely on them. */
export async function ensureGrantTables(env: Env): Promise<void> {
  if (bootstrapped) return;
  const db = requireDb(env);
  await db.batch(BOOTSTRAP.map((sql) => db.prepare(sql)));
  bootstrapped = true;
}

function hex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function sha256Hex(value: string): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
}

export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function decodeB64(value: string): Uint8Array {
  const bin = atob(value);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function encodeB64(bytes: Uint8Array): string {
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

async function aesKey(env: Env): Promise<CryptoKey> {
  const raw = env.CF_GRANT_KEY;
  if (!raw) throw new Error("This Relaybase Worker has no key to store Cloudflare access (CF_GRANT_KEY).");
  const bytes = decodeB64(raw);
  if (bytes.byteLength !== 32) throw new Error("The Cloudflare grant key on this Worker is invalid.");
  return crypto.subtle.importKey("raw", bytes, "AES-GCM", false, ["encrypt", "decrypt"]);
}

async function encrypt(env: Env, plaintext: string): Promise<{ ciphertext: string; iv: string }> {
  const key = await aesKey(env);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(plaintext));
  return { ciphertext: encodeB64(new Uint8Array(cipher)), iv: encodeB64(iv) };
}

async function decrypt(env: Env, ciphertext: string, iv: string): Promise<string> {
  const key = await aesKey(env);
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: decodeB64(iv) }, key, decodeB64(ciphertext));
  return new TextDecoder().decode(plain);
}

export async function hmacHex(secret: string, message: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  return hex(await crypto.subtle.sign("HMAC", key, enc.encode(message)));
}

const SELECT_GRANT = `SELECT account_id as accountId, scopes, refresh_ciphertext as refreshCiphertext,
  refresh_iv as refreshIv, access_ciphertext as accessCiphertext, access_iv as accessIv,
  access_expires_at as accessExpiresAt, lock_until as lockUntil, updated_at as updatedAt
  FROM cf_grant WHERE id = 1`;

async function readGrant(env: Env): Promise<GrantRow | null> {
  await ensureGrantTables(env);
  return requireDb(env).prepare(SELECT_GRANT).first<GrantRow>();
}

export async function readConnection(env: Env): Promise<CloudflareConnection> {
  const empty: CloudflareConnection = { connected: false, accountId: null, scopes: [], updatedAt: null };
  try {
    const row = await readGrant(env);
    if (!row) return empty;
    return {
      connected: true,
      accountId: row.accountId,
      scopes: row.scopes.split(/\s+/).filter(Boolean),
      updatedAt: row.updatedAt,
    };
  } catch {
    return empty;
  }
}

type TokenJson = {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  error?: string;
  error_description?: string;
};

async function exchangeRefresh(clientId: string, refreshToken: string): Promise<TokenJson> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: clientId }),
  });
  let json: TokenJson;
  try {
    json = (await res.json()) as TokenJson;
  } catch {
    throw new Error(`Cloudflare token endpoint answered ${res.status}.`);
  }
  if (!res.ok || !json.access_token) {
    throw new Error(json.error_description || json.error || "Cloudflare did not accept the stored permission.");
  }
  return json;
}

async function writeGrant(
  env: Env,
  input: { accountId: string; scopes: string; refreshToken: string; accessToken: string; expiresIn: number },
): Promise<void> {
  const refresh = await encrypt(env, input.refreshToken);
  const access = await encrypt(env, input.accessToken);
  const now = Date.now();
  const accessExpiresAt = new Date(now + Math.max(60, input.expiresIn) * 1000).toISOString();
  await requireDb(env)
    .prepare(
      `INSERT INTO cf_grant (id, account_id, scopes, refresh_ciphertext, refresh_iv, access_ciphertext, access_iv,
         access_expires_at, lock_until, updated_at)
       VALUES (1, ?, ?, ?, ?, ?, ?, ?, NULL, ?)
       ON CONFLICT(id) DO UPDATE SET
         account_id = excluded.account_id,
         scopes = excluded.scopes,
         refresh_ciphertext = excluded.refresh_ciphertext,
         refresh_iv = excluded.refresh_iv,
         access_ciphertext = excluded.access_ciphertext,
         access_iv = excluded.access_iv,
         access_expires_at = excluded.access_expires_at,
         lock_until = NULL,
         updated_at = excluded.updated_at`,
    )
    .bind(
      input.accountId,
      input.scopes,
      refresh.ciphertext,
      refresh.iv,
      access.ciphertext,
      access.iv,
      accessExpiresAt,
      new Date(now).toISOString(),
    )
    .run();
}

/** Store a refresh token the app handed over: exchange it at once (rotating it) and keep the result. */
export async function acceptRefreshToken(
  env: Env,
  input: { refreshToken: string; accountId: string; scopes: string },
): Promise<void> {
  const clientId = env.CF_OAUTH_CLIENT_ID?.trim();
  if (!clientId) throw new Error("This Relaybase Worker has no OAuth client id (CF_OAUTH_CLIENT_ID).");
  const existing = await readGrant(env);
  if (existing && existing.accountId !== input.accountId) {
    throw new Error("This Relaybase Worker is already connected to a different Cloudflare account.");
  }
  const pinned = env.CF_ACCOUNT_ID?.trim();
  if (pinned && pinned !== input.accountId) {
    throw new Error("This Cloudflare account does not own this Relaybase Worker.");
  }
  const minted = await exchangeRefresh(clientId, input.refreshToken);
  await writeGrant(env, {
    accountId: input.accountId,
    scopes: minted.scope || input.scopes,
    refreshToken: minted.refresh_token || input.refreshToken,
    accessToken: minted.access_token!,
    expiresIn: minted.expires_in ?? 3600,
  });
  memo = null;
}

let memo: { token: string; accountId: string; expiresAt: number } | null = null;

function usable(expiresAt: number): boolean {
  return expiresAt - Date.now() > ACCESS_REUSE_MARGIN_MS;
}

async function cachedAccess(env: Env, row: GrantRow): Promise<{ accessToken: string; accountId: string } | null> {
  if (!row.accessCiphertext || !row.accessIv || !row.accessExpiresAt) return null;
  const expiresAt = Date.parse(row.accessExpiresAt);
  if (!usable(expiresAt)) return null;
  try {
    const accessToken = await decrypt(env, row.accessCiphertext, row.accessIv);
    memo = { token: accessToken, accountId: row.accountId, expiresAt };
    return { accessToken, accountId: row.accountId };
  } catch {
    return null;
  }
}

/**
 * A Cloudflare API access token from the stored grant. Reused until close to
 * its expiry; renewing rotates the refresh token, so one request renews at a
 * time (a lease on the row) and the others wait for its token.
 */
export async function mintAccessToken(env: Env): Promise<{ accessToken: string; accountId: string }> {
  if (memo && usable(memo.expiresAt)) return { accessToken: memo.token, accountId: memo.accountId };
  const clientId = env.CF_OAUTH_CLIENT_ID?.trim();
  if (!clientId) throw new Error("This Relaybase Worker has no OAuth client id (CF_OAUTH_CLIENT_ID).");
  const db = requireDb(env);
  const deadline = Date.now() + LOCK_WAIT_MS;

  for (;;) {
    const row = await readGrant(env);
    if (!row) throw new CloudflareNotConnectedError();
    const cached = await cachedAccess(env, row);
    if (cached) return cached;

    const now = new Date().toISOString();
    const until = new Date(Date.now() + LOCK_MS).toISOString();
    const locked = await db
      .prepare("UPDATE cf_grant SET lock_until = ? WHERE id = 1 AND (lock_until IS NULL OR lock_until < ?)")
      .bind(until, now)
      .run();
    if (locked.meta.changes) {
      try {
        const refreshToken = await decrypt(env, row.refreshCiphertext, row.refreshIv);
        const minted = await exchangeRefresh(clientId, refreshToken);
        await writeGrant(env, {
          accountId: row.accountId,
          scopes: minted.scope || row.scopes,
          refreshToken: minted.refresh_token || refreshToken,
          accessToken: minted.access_token!,
          expiresIn: minted.expires_in ?? 3600,
        });
        memo = {
          token: minted.access_token!,
          accountId: row.accountId,
          expiresAt: Date.now() + (minted.expires_in ?? 3600) * 1000,
        };
        return { accessToken: minted.access_token!, accountId: row.accountId };
      } catch (err) {
        await db.prepare("UPDATE cf_grant SET lock_until = NULL WHERE id = 1").run();
        throw err;
      }
    }
    if (Date.now() > deadline) throw new Error("Cloudflare access is already being renewed. Try again.");
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
}

export class CloudflareNotConnectedError extends Error {
  constructor() {
    super("This Relaybase Worker is not connected to Cloudflare yet. Reconnect Cloudflare from the Relaybase app.");
  }
}

/** Whether the stored grant has every scope in `required`. */
export async function grantHasScopes(env: Env, required: string[]): Promise<boolean> {
  const connection = await readConnection(env);
  return connection.connected && required.every((scope) => connection.scopes.includes(scope));
}

/** A stored grant this Worker can still decrypt with its CF_GRANT_KEY. */
export async function grantReadable(env: Env): Promise<boolean> {
  try {
    const row = await readGrant(env);
    if (!row) return false;
    await decrypt(env, row.refreshCiphertext, row.refreshIv);
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether the current setup code was already used. The marker holds the
 * RELAYBASE_HANDOFF hash it consumed, so a reinstall or repair (which puts a
 * new hash) can hand over once more.
 */
export async function handoffConsumed(env: Env): Promise<boolean> {
  try {
    await ensureGrantTables(env);
    const row = await requireDb(env)
      .prepare("SELECT value FROM install_state WHERE key = 'handoff_done'")
      .first<{ value: string }>();
    return !!row?.value && !!env.RELAYBASE_HANDOFF && safeEqual(row.value, env.RELAYBASE_HANDOFF);
  } catch {
    return false;
  }
}

export async function markHandoffConsumed(env: Env): Promise<void> {
  await ensureGrantTables(env);
  await requireDb(env)
    .prepare(
      `INSERT INTO install_state (key, value) VALUES ('handoff_done', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    )
    .bind(env.RELAYBASE_HANDOFF || "1")
    .run();
}

/** One-time code (10 minutes) the signed-in owner gets to hand a new grant over ("Reconnect Cloudflare"). */
export async function issueReconnectCode(env: Env): Promise<string> {
  await ensureGrantTables(env);
  const db = requireDb(env);
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const code = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  await db.prepare("DELETE FROM cf_reconnect WHERE expires_at < ?").bind(new Date().toISOString()).run();
  await db.prepare("INSERT INTO cf_reconnect (code_hash, expires_at) VALUES (?, ?)").bind(await sha256Hex(code), expiresAt).run();
  return code;
}

export async function reconnectCodeMatches(env: Env, code: string): Promise<boolean> {
  await ensureGrantTables(env);
  const db = requireDb(env);
  const codeHash = await sha256Hex(code);
  const row = await db
    .prepare("SELECT expires_at as expiresAt FROM cf_reconnect WHERE code_hash = ?")
    .bind(codeHash)
    .first<{ expiresAt: string }>();
  if (!row) return false;
  if (Date.parse(row.expiresAt) < Date.now()) {
    await db.prepare("DELETE FROM cf_reconnect WHERE code_hash = ?").bind(codeHash).run();
    return false;
  }
  return true;
}

export async function consumeReconnectCode(env: Env, code: string): Promise<void> {
  await requireDb(env).prepare("DELETE FROM cf_reconnect WHERE code_hash = ?").bind(await sha256Hex(code)).run();
}
