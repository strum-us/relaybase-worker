import { sha256Hex } from "./crypto.ts";

// ─── passtoken ────────────────────────────────────────────────────────────

const PASSTOKEN_PREFIX = "rb_pass_";
const PASSTOKEN_PREFIX_LENGTH = 10;

function bytesToBase64Url(bytes: Uint8Array): string {
  const bin = Array.from(bytes, (b) => String.fromCharCode(b)).join("");
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function generatePasstoken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return `${PASSTOKEN_PREFIX}${bytesToBase64Url(bytes)}`;
}

export function passtokenPrefix(token: string): string {
  const stripped = token.startsWith(PASSTOKEN_PREFIX)
    ? token.slice(PASSTOKEN_PREFIX.length)
    : token;
  return stripped.slice(0, PASSTOKEN_PREFIX_LENGTH);
}

export function isValidPasstokenFormat(token: string): boolean {
  const trimmed = token.trim();
  if (!trimmed.startsWith(PASSTOKEN_PREFIX)) return false;
  return trimmed.length > PASSTOKEN_PREFIX.length + PASSTOKEN_PREFIX_LENGTH;
}

export function randomSalt(): string {
  return bytesToHex(crypto.getRandomValues(new Uint8Array(16)));
}

/** sha256(pepper || ":" || salt || ":" || passtoken). */
export async function hashPasstoken(
  pepper: string,
  salt: string,
  passtoken: string,
): Promise<string> {
  return sha256Hex(`${pepper}:${salt}:${passtoken.trim()}`);
}

// ─── access token (HMAC-signed, self-contained, no D1 read per request) ──

const ACCESS_SEPARATOR = ".";

function base64UrlEncode(input: string): string {
  return bytesToBase64Url(new TextEncoder().encode(input));
}

function base64UrlDecode(input: string): string {
  const bin = atob(input.replace(/-/g, "+").replace(/_/g, "/"));
  return new TextDecoder().decode(
    Uint8Array.from(bin, (c) => c.charCodeAt(0)),
  );
}

async function hmacSha256Hex(key: string, message: string): Promise<string> {
  const enc = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    enc.encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", cryptoKey, enc.encode(message));
  return bytesToHex(new Uint8Array(sig));
}

export type OwnerScope = "mail" | "console";

export type AccessPayload = {
  sub: string;
  iat: number;
  exp: number;
  jti: string;
  /** Present on tokens minted after the mail/console split. */
  scope?: OwnerScope;
};

export const MAIL_ACCESS_TTL_SECONDS = 60 * 60; // 60 minutes
export const CONSOLE_ACCESS_TTL_SECONDS = 30 * 60; // 30 minutes
export const MAIL_REFRESH_TTL_SECONDS = 90 * 24 * 60 * 60; // 90 days
export const CONSOLE_REFRESH_TTL_SECONDS = 30 * 60; // 30 minutes

/** @deprecated Use scope-specific TTL constants. */
export const ACCESS_TTL_SECONDS = CONSOLE_ACCESS_TTL_SECONDS;

export function sessionLabelForScope(
  scope: OwnerScope,
  deviceLabel: string,
): string {
  const trimmed = deviceLabel.trim() || "desktop";
  return `${scope}:${trimmed}`;
}

export function scopeFromSessionLabel(
  label: string | null | undefined,
): OwnerScope | null {
  if (!label) return null;
  if (label.startsWith("mail:")) return "mail";
  if (label.startsWith("console:")) return "console";
  return null;
}

export async function signAccessToken(
  pepper: string,
  payload: AccessPayload,
): Promise<string> {
  const body = base64UrlEncode(JSON.stringify(payload));
  const sig = await hmacSha256Hex(pepper, body);
  return `${body}${ACCESS_SEPARATOR}${sig}`;
}

export async function verifyAccessToken(
  pepper: string,
  token: string,
): Promise<AccessPayload | null> {
  const parts = token.split(ACCESS_SEPARATOR);
  if (parts.length !== 2) return null;
  const [body, sig] = parts;
  const expected = await hmacSha256Hex(pepper, body);
  if (sig.length !== expected.length) return null;
  let diff = 0;
  for (let i = 0; i < sig.length; i++) {
    diff |= sig.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  if (diff !== 0) return null;
  try {
    const payload = JSON.parse(base64UrlDecode(body)) as AccessPayload;
    if (
      typeof payload.sub !== "string" ||
      typeof payload.exp !== "number" ||
      typeof payload.jti !== "string"
    ) {
      return null;
    }
    if (
      payload.scope !== undefined &&
      payload.scope !== "mail" &&
      payload.scope !== "console"
    ) {
      return null;
    }
    if (payload.exp <= Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

// ─── refresh token (opaque, hash-only in D1) ─────────────────────────────

export function generateRefreshToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return bytesToBase64Url(bytes);
}

