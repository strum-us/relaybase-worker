import type { Env } from "../../env";
import type { MigrationTarget } from "../../../db/migrations";
import releaseKeys from "./release-keys.json";
import { parseSignature, verifySignature, type ReleaseKey } from "./signature";
import { isVersion } from "./version";

export type ReleaseMigration = { target: MigrationTarget; name: string; since: string; sql: string };

/** Manifest from scripts/pack-release.mjs, served at `${RELEASE_ORIGIN}/manifest.json`. */
export type ReleaseManifest = {
  version: string;
  releasedAt: string | null;
  notes: string | null;
  rolloutPercent: number;
  /** False when the release notes say `auto: false`: only the owner starts it. */
  autoUpdate: boolean;
  workerSha256: string;
  sizeBytes: number;
  compatibilityDate: string;
  compatibilityFlags: string[];
  mainModule: string;
  migrations: ReleaseMigration[];
};

const MANIFEST_TTL_MS = 15 * 60 * 1000;
let memo: { url: string; at: number; manifest: ReleaseManifest } | null = null;

const RELEASE_KEYS: ReleaseKey[] = (releaseKeys as { keys: ReleaseKey[] }).keys;

type SignedManifest = { body: string; signature: string };

/** Base URL of this Worker's release channel, e.g. `https://downloads.relaybase.email/release`. */
export function releaseOrigin(env: Env): string | null {
  const origin = env.RELEASE_ORIGIN?.trim().replace(/\/$/, "");
  return origin || null;
}

function requireOrigin(env: Env): string {
  const origin = releaseOrigin(env);
  if (!origin) throw new Error("This Relaybase Worker has no release address (RELEASE_ORIGIN).");
  return origin;
}

function parseManifest(value: unknown): ReleaseManifest {
  const raw = (value ?? {}) as Record<string, unknown>;
  const migrations = Array.isArray(raw.migrations) ? raw.migrations : [];
  const valid =
    typeof raw.version === "string" &&
    isVersion(raw.version) &&
    typeof raw.workerSha256 === "string" &&
    typeof raw.compatibilityDate === "string" &&
    migrations.every(
      (entry) => entry && typeof entry === "object" && "sql" in entry && "target" in entry && "name" in entry,
    );
  if (!valid) throw new Error("The release host sent a release this Worker cannot read.");
  return {
    version: raw.version as string,
    releasedAt: typeof raw.releasedAt === "string" ? raw.releasedAt : null,
    notes: typeof raw.notes === "string" ? raw.notes : null,
    rolloutPercent: typeof raw.rolloutPercent === "number" ? raw.rolloutPercent : 100,
    autoUpdate: raw.autoUpdate !== false,
    workerSha256: raw.workerSha256 as string,
    sizeBytes: typeof raw.sizeBytes === "number" ? raw.sizeBytes : 0,
    compatibilityDate: raw.compatibilityDate as string,
    compatibilityFlags: Array.isArray(raw.compatibilityFlags) ? (raw.compatibilityFlags as string[]) : [],
    mainModule: typeof raw.mainModule === "string" && raw.mainModule ? raw.mainModule : "index.js",
    migrations: migrations as ReleaseMigration[],
  };
}

/** Nothing in the manifest is read before its signature checks out. */
async function openManifest(signed: SignedManifest): Promise<ReleaseManifest> {
  const signature = parseSignature(signed.signature);
  const bytes = new TextEncoder().encode(signed.body);
  if (!signature || !(await verifySignature(RELEASE_KEYS, bytes, signature))) {
    throw new Error("The release host sent a release that is not signed by Relaybase.");
  }
  let json: unknown;
  try {
    json = JSON.parse(signed.body);
  } catch {
    throw new Error("The release host did not send a release manifest.");
  }
  return parseManifest(json);
}

async function fetchSigned(url: string): Promise<SignedManifest | null> {
  const res = await fetch(url, { headers: { accept: "application/json" }, cf: { cacheTtl: 0 } } as RequestInit);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`The release host answered ${res.status} for ${new URL(url).pathname}.`);
  const body = new TextDecoder().decode(await res.arrayBuffer());
  const sig = await fetch(`${url}.sig`, { cf: { cacheTtl: 0 } } as RequestInit);
  if (!sig.ok) throw new Error(`The release host has no signature for ${new URL(url).pathname}.`);
  return { body, signature: await sig.text() };
}

/** The newest release, cached for 15 minutes per isolate. */
export async function latestRelease(env: Env, options: { force?: boolean } = {}): Promise<ReleaseManifest> {
  const url = `${requireOrigin(env)}/manifest.json`;
  if (!options.force && memo && memo.url === url && Date.now() - memo.at < MANIFEST_TTL_MS) return memo.manifest;
  const signed = await fetchSigned(url);
  if (!signed) throw new Error("The release host has no Relaybase Worker release yet.");
  const manifest = await openManifest(signed);
  memo = { url, at: Date.now(), manifest };
  return manifest;
}

/** One exact release: its archived manifest, or the latest one when that is the version asked for. */
export async function releaseManifest(env: Env, version: string): Promise<ReleaseManifest> {
  const origin = requireOrigin(env);
  const archivedSigned = await fetchSigned(`${origin}/archive/${encodeURIComponent(version)}/manifest.json`).catch(
    () => null,
  );
  if (archivedSigned) {
    const archived = await openManifest(archivedSigned);
    if (archived.version === version) return archived;
  }
  const latest = await latestRelease(env, { force: true });
  if (latest.version === version) return latest;
  throw new Error(`The release host no longer has Relaybase Worker ${version}.`);
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** The release's Worker bundle, checked against the manifest's hash before anything uploads it. */
export async function workerSource(env: Env, release: ReleaseManifest): Promise<Uint8Array> {
  const origin = requireOrigin(env);
  const urls = [`${origin}/archive/${encodeURIComponent(release.version)}/worker.js`, `${origin}/worker.js`];
  for (const url of urls) {
    const res = await fetch(url);
    if (!res.ok) continue;
    const bytes = new Uint8Array(await res.arrayBuffer());
    if ((await sha256Hex(bytes)) === release.workerSha256) return bytes;
  }
  throw new Error(`The Worker bundle for Relaybase ${release.version} did not match its manifest.`);
}
