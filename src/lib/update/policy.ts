import type { Env } from "../../env";
import type { CloudflareConnection } from "../grant/cf-grant";
import type { ReleaseManifest } from "./release-client";

/** Enough to read the script's settings and replace the script. */
export const REQUIRED_SCOPES = ["workers-scripts.write"];

export type UpdateBlockedReason =
  | "development"
  | "no_release_origin"
  | "unconfigured"
  | "not_connected"
  | "missing_scopes";

export type UpdateAccess = {
  credential: "grant" | null;
  accountId: string | null;
  scriptName: string | null;
  connection: CloudflareConnection;
};

type PolicyEnv = Pick<
  Env,
  "RELAYBASE_DEV" | "RELEASE_ORIGIN" | "WORKER_SCRIPT_NAME" | "CF_OAUTH_CLIENT_ID" | "CF_GRANT_KEY" | "CF_ACCOUNT_ID"
>;

export function blockedReason(env: PolicyEnv, access: UpdateAccess): UpdateBlockedReason | null {
  if (env.RELAYBASE_DEV === "1") return "development";
  if (!env.RELEASE_ORIGIN?.trim()) return "no_release_origin";
  if (!env.WORKER_SCRIPT_NAME?.trim() || !env.CF_OAUTH_CLIENT_ID || !env.CF_GRANT_KEY) return "unconfigured";
  if (!access.connection.connected) return "not_connected";
  if (!REQUIRED_SCOPES.every((scope) => access.connection.scopes.includes(scope))) return "missing_scopes";
  return null;
}

/** Stable 0–99 bucket per instance, so a staged rollout reaches the same instances as it widens. */
export function rolloutBucket(key: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) % 100;
}

export function rolloutHeld(
  env: PolicyEnv,
  access: UpdateAccess,
  release: Pick<ReleaseManifest, "rolloutPercent">,
  host: string,
): boolean {
  if (release.rolloutPercent >= 100) return false;
  const key = `${access.accountId ?? env.CF_ACCOUNT_ID ?? ""}:${access.scriptName || env.WORKER_SCRIPT_NAME?.trim() || host}`;
  return rolloutBucket(key) >= release.rolloutPercent;
}

export type AutomaticSkip = "off" | "blocked" | "up_to_date" | "needs_owner" | "rollout_held" | "tried_before";

/** Why a cron run leaves the latest release alone, or null to start it. */
export function automaticSkip(input: {
  enabled: boolean;
  blocked: boolean;
  newer: boolean;
  release: Pick<ReleaseManifest, "autoUpdate">;
  held: boolean;
  triedBefore: boolean;
}): AutomaticSkip | null {
  if (!input.enabled) return "off";
  if (input.blocked) return "blocked";
  if (!input.newer) return "up_to_date";
  if (!input.release.autoUpdate) return "needs_owner";
  if (input.held) return "rollout_held";
  if (input.triedBefore) return "tried_before";
  return null;
}
