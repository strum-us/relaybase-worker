import {
  generateApiKey,
  isValidApiKeyFormat,
  isValidDomain,
  keyPrefixFromApiKey,
  sha256Hex,
} from "./crypto";
import type { AppDb } from "../../db/app";
import {
  createKeyRow as dbCreateKeyRow,
  deleteKeyRow as dbDeleteKeyRow,
  listKeys as dbListKeys,
  resolveKeyByHash as dbResolveKeyByHash,
  setKeyActive as dbSetKeyActive,
  updateKeyHash as dbUpdateKeyHash,
} from "../../db/app/keys";

export type KeyRecord = {
  id: string;
  domain: string;
  label: string | null;
  keyPrefix: string;
  createdAt: string;
  active: boolean;
};

export async function createKey(
  db: AppDb,
  params: { domain: string; label?: string | null },
): Promise<{ record: KeyRecord; apiKey: string }> {
  const domain = params.domain.trim().toLowerCase();
  if (!isValidDomain(domain)) {
    throw new Error("domain must be a valid hostname (e.g. example.com)");
  }

  const apiKey = generateApiKey();
  const keyHash = await sha256Hex(apiKey);
  const id = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  const keyPrefix = keyPrefixFromApiKey(apiKey);

  await dbCreateKeyRow(db, {
    id,
    keyHash,
    domain,
    label: params.label?.trim() || null,
    keyPrefix,
  });

  return {
    record: { id, domain, label: params.label?.trim() || null, keyPrefix, createdAt, active: true },
    apiKey,
  };
}

export async function listKeys(db: AppDb): Promise<KeyRecord[]> {
  return dbListKeys(db);
}

export async function resolveKey(
  db: AppDb,
  apiKey: string,
): Promise<KeyRecord | null> {
  if (!isValidApiKeyFormat(apiKey)) return null;
  const keyHash = await sha256Hex(apiKey);
  return dbResolveKeyByHash(db, keyHash);
}

export async function revokeKey(db: AppDb, id: string): Promise<boolean> {
  return dbDeleteKeyRow(db, id);
}

export async function setKeyActive(
  db: AppDb,
  id: string,
  active: boolean,
): Promise<KeyRecord | null> {
  return dbSetKeyActive(db, id, active);
}

export async function rotateKey(
  db: AppDb,
  id: string,
): Promise<{ record: KeyRecord; apiKey: string } | null> {
  if (!db) return null;
  const existing = (await dbListKeys(db)).find((k) => k.id === id);
  if (!existing) return null;

  const apiKey = generateApiKey();
  const keyHash = await sha256Hex(apiKey);
  const keyPrefix = keyPrefixFromApiKey(apiKey);
  await dbUpdateKeyHash(db, id, keyHash, keyPrefix);

  return {
    record: { ...existing, keyPrefix, active: true },
    apiKey,
  };
}
