import { sha256Hex } from "./crypto.ts";
import type { AppDb } from "../../db/app";
import {
  clearAccountMobileConfig as dbClearAccountMobileConfig,
  getAccountMobileConfig as dbGetAccountMobileConfig,
  setAccountMobileConfig as dbSetAccountMobileConfig,
} from "../../db/app/mobile.ts";

/**
 * Mobile access password stored in D1 `mobile_passwords` table.
 *
 * The desktop app generates a password, shows it once, and writes a salted
 * SHA-256 hash here. The Flutter app sends the plain password as a Bearer
 * token to `/mobile/*`; the Worker re-hashes with the stored salt and
 * compares in constant time. The plain password is never persisted.
 */

export type MobileConfig = {
  /** Salted SHA-256 hex of the plain password. */
  passwordHash: string;
  /** Per-install random salt (hex). */
  salt: string;
  /** ISO timestamp of the last set/regenerate. */
  updatedAt: string;
};

/** Shape persisted in D1 (always enabled when present). */
export type StoredMobileConfig = MobileConfig;

export type MobileConfigPublicView = {
  enabled: boolean;
  updatedAt: string | null;
};

/** Per-account public status (no plain password). */
export type AccountMobileConfigPublicView = {
  hasPassword: boolean;
  updatedAt: string | null;
};

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function randomHex(byteLength: number): string {
  return bytesToHex(crypto.getRandomValues(new Uint8Array(byteLength)));
}

/** Character pool for human-friendly account passwords. */
const PASSWORD_ALPHABET =
  "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";

/**
 * Generate a new plain mobile password — a 12-character human-friendly
 * alphanumeric string (no ambiguous chars like O/0/1/l), like a normal
 * account password rather than a long opaque token.
 */
export function generateMobilePassword(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  let out = "";
  for (let i = 0; i < 12; i++) {
    out += PASSWORD_ALPHABET[bytes[i]! % PASSWORD_ALPHABET.length];
  }
  return out;
}

/** Generate a new per-install salt. */
export function generateMobileSalt(): string {
  return randomHex(16);
}

/** Salted SHA-256 hex of the plain password. */
export async function hashMobilePassword(
  password: string,
  salt: string,
): Promise<string> {
  return sha256Hex(`${salt}:${password.trim()}`);
}

/** Constant-time string equality. Returns false for different lengths. */
export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

export function toMobileConfigPublicView(
  config: StoredMobileConfig | null,
): MobileConfigPublicView {
  return config
    ? { enabled: true, updatedAt: config.updatedAt }
    : { enabled: false, updatedAt: null };
}

// ---- Per-account mobile password ----

export async function getAccountMobileConfig(
  db: AppDb,
  email: string,
): Promise<StoredMobileConfig | null> {
  return dbGetAccountMobileConfig(db, email);
}

export async function setAccountMobileConfig(
  db: AppDb,
  email: string,
  config: StoredMobileConfig,
): Promise<void> {
  await dbSetAccountMobileConfig(db, email, config);
}

export async function clearAccountMobileConfig(
  db: AppDb,
  email: string,
): Promise<void> {
  await dbClearAccountMobileConfig(db, email);
}

/** Create a fresh per-account password + salt + hash and persist. Returns the plain password. */
export async function rotateAccountMobileConfig(
  db: AppDb,
  email: string,
): Promise<{ password: string; config: StoredMobileConfig }> {
  const password = generateMobilePassword();
  const salt = generateMobileSalt();
  const passwordHash = await hashMobilePassword(password, salt);
  const config: StoredMobileConfig = {
    passwordHash,
    salt,
    updatedAt: new Date().toISOString(),
  };
  await setAccountMobileConfig(db, email, config);
  return { password, config };
}

export function toAccountMobileConfigPublicView(
  config: StoredMobileConfig | null,
): AccountMobileConfigPublicView {
  return config
    ? { hasPassword: true, updatedAt: config.updatedAt }
    : { hasPassword: false, updatedAt: null };
}
